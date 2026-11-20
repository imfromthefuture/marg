// Marg keeper: every KEEPER_INTERVAL_SEC it looks at each direct launch the indexer lists and
//  1. collects a taxed pool's waiting tax with the Router's CollectTax (attaches COLLECT_GAS 0.2 Gram; the
//     unused part comes back, so a collect costs about 0.08), but only when the tax is worth at least
//     KEEPER_COLLECT_MIN_MULTIPLE x that cost (audit R2-L4, R8A-1/R8B-6). The master's Harvest is not used:
//     since v4 it is always caller-paid at 0.24 Gram for the same job;
//  2. else runs a due buyback (Buyback, refunded);
//  3. pokes a master whose launch fee is still escrowed after the launch settled (audit V3-I2) with a tiny
//     plain transfer: it runs forwardToCreator, which pays the fee. (Plain Gram first tops the master's
//     rent fund up to 0.25, the rest goes to the creator, so only KEEPER_POKE_VALUE is sent.);
//  4. after a change of the basechain gas price (config param 21, persisted in the state file) and once a
//     day anyway, scans the wallets of every v4 holder-rewards token for a master view left stale by a
//     bounced checkpoint (audit R7A-1: acked < 0, or synced / acked != balance, with nothing in flight) and
//     sends SyncRewards (open to anyone in v4; the unused value comes back). It also warns when the sum of
//     the wallets' acked differs from the master's totalShares;
//  5. warns when a DEX Router's balance is below KEEPER_ROUTER_MIN (1 Gram; audit R4A-2: a long-dormant
//     Router's rent eats the PayTo of an LP exit). Each run ends with one "status" line (also in the state file).
// Every send is bounded by KEEPER_MAX_TX per run, the rolling 24 h budget and KEEPER_MIN_BALANCE.
//
// Env: KEEPER_MNEMONIC (EnvironmentFile only, never logged), NETWORK, TONCENTER_API_KEY (the keeper's own
// key, not the web proxy's), INDEXER_URL, LAUNCH_FACTORY (comma-separated allowlist, as the indexer),
// KEEPER_INTERVAL_SEC, KEEPER_MIN_TAX, KEEPER_COLLECT_COST, KEEPER_COLLECT_MIN_MULTIPLE, KEEPER_MIN_BALANCE,
// KEEPER_MAX_TX, KEEPER_GAS_VALUE, KEEPER_POKE_VALUE, KEEPER_MAX_SPEND_PER_DAY, KEEPER_TOKEN_COOLDOWN_SEC,
// KEEPER_SYNC_MARGIN, KEEPER_MAX_SYNC, KEEPER_SCAN_MAX_WALLETS, KEEPER_SCAN_INTERVAL_SEC, KEEPER_ROUTER_MIN,
// KEEPER_STATE_FILE (default $STATE_DIRECTORY/keeper-state.json), KEEPER_DRY_RUN, KEEPER_ONCE.
import { Address, beginCell, Cell, fromNano, internal, SendMode, toNano, TupleReader, type TupleItem } from '@ton/core';
import { TonClient } from '@ton/ton';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LaunchFactory } from '../../../launch/build/Launch_LaunchFactory';
import { LaunchJetton, storeCollectTax, type LaunchInfo } from '../../../launch/build/Launch_LaunchJetton';
import { loadGetterTuplePoolState } from '../../../dex/v2/build/Router_Pool';
import { keysFrom, walletFor } from './wallet';

// Message layouts (launch/contracts/messages.tact): op + queryId:uint64, nothing else.
const OP_BUYBACK = 0x4d4c0036;
const OP_SYNC_REWARDS = 0x4d4c0034;
const COLLECT_GAS = toNano('0.2');                                   // dex/v2 constants.tact (Router CollectTax minimum)

const NETWORK = process.env.NETWORK === 'testnet' ? 'testnet' : 'mainnet';
const API_KEY = process.env.TONCENTER_API_KEY || undefined;
const TONCENTER = `https://${NETWORK === 'testnet' ? 'testnet.' : ''}toncenter.com/api`;
const ENDPOINT = `${TONCENTER}/v2/jsonRPC`;
const INDEXER_URL = process.env.INDEXER_URL ?? 'http://127.0.0.1:8811/api/idx/tokens?kind=dex';
const FACTORIES = new Set((process.env.LAUNCH_FACTORY ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((a) => Address.parse(a).toRawString()));
const INTERVAL = Number(process.env.KEEPER_INTERVAL_SEC ?? 600) * 1000;
const MIN_TAX = toNano(process.env.KEEPER_MIN_TAX ?? '0.5');         // collect from this much waiting tax
const COLLECT_COST = toNano(process.env.KEEPER_COLLECT_COST ?? '0.08'); // what a CollectTax really costs (R8A-1)
// A collect costs the keeper real Gram; only pay it when the tax it moves is worth many times that
// (audit R2-L4: an attacker's own small-tax launches could drain the budget).
const COLLECT_MIN_MULTIPLE = BigInt(process.env.KEEPER_COLLECT_MIN_MULTIPLE ?? process.env.KEEPER_HARVEST_MIN_MULTIPLE ?? 10);
const MIN_BALANCE = toNano(process.env.KEEPER_MIN_BALANCE ?? '1');   // never spend below this
const MAX_TX = Number(process.env.KEEPER_MAX_TX ?? 10);              // sends per run (syncs included)
const GAS_VALUE = toNano(process.env.KEEPER_GAS_VALUE ?? '0.05');    // value of refunded calls (Buyback)
const POKE_VALUE = toNano(process.env.KEEPER_POKE_VALUE ?? '0.02');  // plain transfer that releases an escrowed launch fee
const SYNC_MARGIN = toNano(process.env.KEEPER_SYNC_MARGIN ?? '0.01'); // on top of get_reward_values().sync (refunded)
const MAX_SYNC = Number(process.env.KEEPER_MAX_SYNC ?? 20);          // SyncRewards per scan
const SCAN_MAX_WALLETS = Number(process.env.KEEPER_SCAN_MAX_WALLETS ?? 2000); // wallets read per token per scan
const SCAN_INTERVAL = Number(process.env.KEEPER_SCAN_INTERVAL_SEC ?? 86400) * 1000; // scan at least this often
const ROUTER_MIN = toNano(process.env.KEEPER_ROUTER_MIN ?? '1');      // warn below (README: keep Routers >= 1 Gram)
// Launches are permissionless, so wash-traded tokens could make the keeper spend all day: cap the
// Gram it attaches per rolling 24 h, and act on each token at most once per KEEPER_TOKEN_COOLDOWN_SEC.
const MAX_SPEND_DAY = toNano(process.env.KEEPER_MAX_SPEND_PER_DAY ?? '3');
const TOKEN_COOLDOWN = Number(process.env.KEEPER_TOKEN_COOLDOWN_SEC ?? 3600) * 1000;
const STATE_FILE = process.env.KEEPER_STATE_FILE ?? join(process.env.STATE_DIRECTORY ?? '.', 'keeper-state.json');
const DRY_RUN = !!process.env.KEEPER_DRY_RUN;
const ONCE = !!process.env.KEEPER_ONCE;
const LAUNCH_DEADLINE = 600;                                          // launch/jetton.tact

const spends: { at: number; value: bigint }[] = [];
const lastActed = new Map<string, number>();
const spentToday = () => {
    const since = Date.now() - 86_400_000;
    while (spends.length && spends[0].at < since) spends.shift();
    return spends.reduce((s, x) => s + x.value, 0n);
};

const client = new TonClient({ endpoint: ENDPOINT, apiKey: API_KEY });
const testOnly = NETWORK === 'testnet';
const show = (a: Address) => a.toString({ testOnly });
const errText = (e: any) => String(e?.message ?? e).slice(0, 200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

// toncenter: one call at a time with a gap, retried on rate limits / network errors.
const GAP = API_KEY ? 150 : 1100;
let nextSlot = 0;
async function call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        const at = Math.max(Date.now(), nextSlot);
        nextSlot = at + GAP;
        if (at > Date.now()) await sleep(at - Date.now());
        try {
            return await fn();
        } catch (e) {
            if (attempt < 4 && /429|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|50\d/.test(errText(e))) {
                await sleep(GAP * (attempt + 2));
                continue;
            }
            throw e;
        }
    }
}
const headers = (): Record<string, string> => (API_KEY ? { 'X-API-Key': API_KEY } : {});

// --- persisted state ----------------------------------------------------------------------------------

type State = { gasPrice21: string | null; lastScanAt: number; status?: string; statusAt?: number };
function loadState(): State {
    try {
        const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
        return { gasPrice21: typeof s.gasPrice21 === 'string' ? s.gasPrice21 : null, lastScanAt: Number(s.lastScanAt) || 0 };
    } catch {
        return { gasPrice21: null, lastScanAt: 0 };
    }
}
function saveState(s: State) {
    try {
        writeFileSync(STATE_FILE + '.tmp', JSON.stringify(s, null, 1));
        renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) {
        console.warn(`cannot write ${STATE_FILE}: ${errText(e)}`);
    }
}
const state = loadState();

// --- chain reads --------------------------------------------------------------------------------------

// Basechain gas price (config param 21, in 1/65536 nanoGram per gas unit), as a string; null if unreadable.
// gas_flat_pfx#d1 flat_gas_limit:uint64 flat_gas_price:uint64 other:GasLimitsPrices;
// gas_prices#dd / gas_prices_ext#de gas_price:uint64 ...
async function gasPrice21(): Promise<string | null> {
    try {
        const res = await call(() => fetch(ENDPOINT, {
            method: 'POST', signal: AbortSignal.timeout(15_000),
            headers: { 'Content-Type': 'application/json', ...headers() },
            body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'getConfigParam', params: { config_id: 21 } }),
        }).then(async (r) => {
            if (!r.ok) throw new Error(`toncenter ${r.status}`);
            return r.json() as Promise<any>;
        }));
        const bytes = res?.result?.config?.bytes;
        if (typeof bytes !== 'string') return null;
        const s = Cell.fromBase64(bytes).beginParse();
        let tag = s.loadUint(8);
        if (tag === 0xd1) {
            s.skip(128);
            tag = s.loadUint(8);
        }
        if (tag !== 0xdd && tag !== 0xde) return null;
        return s.loadUintBig(64).toString();
    } catch (e) {
        console.warn(`config param 21: ${errText(e)}`);
        return null;
    }
}

// Only masters the allowlisted factories derive (master == get_token_address(factoryIndex)).
const verified = new Set<string>();
async function isGenuine(t: any, master: Address): Promise<boolean> {
    if (FACTORIES.size === 0) return true;
    if (verified.has(master.toRawString())) return true;
    if (!t.factory || typeof t.factoryIndex !== 'number') return false;
    const factory = Address.parse(t.factory);
    if (!FACTORIES.has(factory.toRawString())) return false;
    const f = client.open(LaunchFactory.fromAddress(factory));
    const derived = await call(() => f.getGetTokenAddress(BigInt(t.factoryIndex)));
    if (!derived.equals(master)) return false;
    verified.add(master.toRawString());
    return true;
}

// Fixed per master: launch info and whether it is a v4 master (get_rewards_data has rentFund).
type Meta = { info: LaunchInfo; v4: boolean };
const metas = new Map<string, Meta>();
async function metaOf(master: Address): Promise<Meta> {
    const k = master.toRawString();
    const hit = metas.get(k);
    if (hit) return hit;
    const m = client.open(LaunchJetton.fromAddress(master));
    const info = await call(() => m.getGetLaunchInfo());
    let v4 = false;
    if (info.rewardsBps > 0n) {
        const r = await call(() => client.runMethod(master, 'get_rewards_data'));
        v4 = r.stack.remaining >= 7;
    }
    const meta = { info, v4 };
    metas.set(k, meta);
    return meta;
}

// get_pool_state of any Router generation: fields were appended at the end (platformFees,
// platformBps); a shorter stack from an older pool is padded with zeros.
async function readPoolState(address: Address) {
    const r = await client.runMethod(address, 'get_pool_state');
    const items = (r.stack as any).items as TupleItem[];
    return loadGetterTuplePoolState(new TupleReader([...items, ...Array.from({ length: 4 }, (): TupleItem => ({ type: 'int', value: 0n }))]));
}

// get_buyback_status read by position (balance, nextAllowedAt, nextAmount, wouldRun, ...): the layout
// grew over the versions, the first four fields never moved.
async function buybackStatus(master: Address) {
    const s = (await call(() => client.runMethod(master, 'get_buyback_status'))).stack;
    const balance = s.readBigNumber();
    s.readBigNumber();
    s.readBigNumber();
    return { balance, wouldRun: s.readBoolean() };
}

// --- planning -----------------------------------------------------------------------------------------

type Action = { kind: 'collect' | 'buyback' | 'fee-poke' | 'sync'; to: Address; key: string; symbol: string; value: bigint; body: Cell | null; note: string; weight: bigint };
type RewardsToken = { master: Address; symbol: string };

async function plan(t: any, out: Action[], rewardsTokens: RewardsToken[], routers: Map<string, Address>) {
    if (!t.address || t.placeholder) return;
    const master = Address.parse(t.address);
    if (!(await isGenuine(t, master))) {
        console.warn(`skip ${t.symbol} ${show(master)}: not from an allowlisted factory`);
        return;
    }
    const symbol = String(t.symbol ?? '?').slice(0, 16);
    const { info, v4 } = await metaOf(master);
    routers.set(info.router.toRawString(), info.router);
    if (info.rewardsBps > 0n && v4) rewardsTokens.push({ master, symbol });
    const m = client.open(LaunchJetton.fromAddress(master));
    // get_launch_state by position: pool, bbFrom, feeEscrow, settled (v4 appends `released`).
    const lsStack = (await call(() => client.runMethod(master, 'get_launch_state'))).stack;
    const ls = { pool: lsStack.readAddress(), bbFrom: lsStack.readBigNumber(), feeEscrow: lsStack.readBigNumber(), settled: lsStack.readBoolean() };

    // V3-I2: the launch fee waits for the next plain message once a tax payout settled the launch. An
    // unsettled launch older than twice the deadline is settled (as a success) by the same message.
    const settles = ls.settled || now() > Number(info.createdAt) + 2 * LAUNCH_DEADLINE;
    if (ls.feeEscrow > 0n && settles) {
        out.push({ kind: 'fee-poke', to: master, key: 'poke:' + master.toRawString(), symbol, value: POKE_VALUE, body: null,
            note: `feeEscrow=${fromNano(ls.feeEscrow)}${ls.settled ? '' : ' (settles now)'}`, weight: ls.feeEscrow });
    }

    // Taxed launches pay their tax to the master itself.
    if (!info.taxRecipient || !info.taxRecipient.equals(master)) return;
    const ps = await call(() => readPoolState(ls.pool));
    const tax = `tax=${fromNano(ps.taxFees)}`;
    const minCollect = COLLECT_COST * COLLECT_MIN_MULTIPLE > MIN_TAX ? COLLECT_COST * COLLECT_MIN_MULTIPLE : MIN_TAX;
    if (ps.taxFees >= minCollect) {
        const key = await call(() => m.getGetPoolKey());
        const body = beginCell().store(storeCollectTax({ $$type: 'CollectTax', queryId: BigInt(Date.now()), key })).endCell();
        out.push({ kind: 'collect', to: info.router, key: master.toRawString(), symbol, value: COLLECT_GAS, body, note: tax, weight: ps.taxFees });
        return;
    }
    if (info.buybackBps > 0n) {
        const st = await buybackStatus(master);
        if (st.wouldRun) {
            const body = beginCell().storeUint(OP_BUYBACK, 32).storeUint(BigInt(Date.now()), 64).endCell();
            out.push({ kind: 'buyback', to: master, key: master.toRawString(), symbol, value: GAS_VALUE, body, note: `${tax} bucket=${fromNano(st.balance)}`, weight: st.balance });
        }
    }
}

// R7A-1 repair: wallets of one rewards token whose master view is stale. Reads toncenter's jetton wallet
// index (all wallets, zero balances included: a wallet that sent everything can still be counted) and
// each wallet's get_reward_state. Returns the wallets to sync and whether the read was complete.
async function scanRewardsToken(rt: RewardsToken): Promise<{ stale: { wallet: Address; why: string }[]; complete: boolean }> {
    const stale: { wallet: Address; why: string }[] = [];
    let sumAcked = 0n;
    let anyInFlight = false;
    let complete = true;
    let read = 0;
    for (let offset = 0; ; offset += 100) {
        if (read >= SCAN_MAX_WALLETS) {
            console.warn(`scan ${rt.symbol}: stopped at KEEPER_SCAN_MAX_WALLETS ${SCAN_MAX_WALLETS}`);
            complete = false;
            break;
        }
        const url = `${TONCENTER}/v3/jetton/wallets?jetton_address=${rt.master.toRawString()}&limit=100&offset=${offset}&sort=asc`;
        const res: any = await call(() => fetch(url, { headers: headers(), signal: AbortSignal.timeout(15_000) }).then(async (r) => {
            if (!r.ok) throw new Error(`toncenter ${r.status}`);
            return r.json();
        }));
        const page: any[] = Array.isArray(res?.jetton_wallets) ? res.jetton_wallets : [];
        for (const w of page) {
            read++;
            let wallet: Address;
            try { wallet = Address.parse(w.address); } catch { continue; }
            let rs: { synced: bigint; acked: bigint; inFlight: bigint };
            try {
                const s = (await call(() => client.runMethod(wallet, 'get_reward_state'))).stack;
                const synced = s.readBigNumber(), acked = s.readBigNumber();
                s.readBigNumber(); s.readBigNumber(); s.readBigNumber();
                rs = { synced, acked, inFlight: s.readBigNumber() };
            } catch (e) {
                complete = false;     // not deployed / unreadable: the sum check below is not reliable
                continue;
            }
            sumAcked += rs.acked;
            if (rs.inFlight !== 0n) { anyInFlight = true; continue; }
            let balance = BigInt(w.balance ?? 0);
            const suspicious = rs.acked < 0n || rs.synced !== balance || rs.acked !== rs.synced;
            if (!suspicious) continue;
            // Untracked wallets (the Router's, the master's own, the creator vault's) never sync: their
            // reward state stays 0 whatever they hold, and the wallet refuses SyncRewards.
            try {
                if (!(await call(() => client.runMethod(wallet, 'get_tracked'))).stack.readBoolean()) continue;
            } catch {
                complete = false;
                continue;
            }
            // Confirm with the wallet itself (the index can lag a few seconds behind).
            try {
                balance = (await call(() => client.runMethod(wallet, 'get_wallet_data'))).stack.readBigNumber();
            } catch { continue; }
            const why = rs.acked < 0n ? `acked=${rs.acked}` : rs.synced !== balance ? `synced=${rs.synced} balance=${balance}`
                : rs.acked !== rs.synced ? `acked=${rs.acked} synced=${rs.synced}` : '';
            if (why) stale.push({ wallet, why });
        }
        if (page.length < 100) break;
    }
    if (complete && !anyInFlight) {
        try {
            const d = (await call(() => client.runMethod(rt.master, 'get_rewards_data'))).stack;
            d.readBigNumber(); d.readBigNumber();
            const totalShares = d.readBigNumber();
            if (totalShares !== sumAcked) console.warn(`ALERT ${rt.symbol} ${show(rt.master)}: sum(acked)=${sumAcked} != totalShares=${totalShares}`);
        } catch (e) {
            console.warn(`scan ${rt.symbol}: get_rewards_data: ${errText(e)}`);
        }
    }
    return { stale, complete };
}

// --- run ----------------------------------------------------------------------------------------------

async function run(secretKey: Buffer, publicKey: Buffer) {
    const wallet = client.open(walletFor(publicKey, NETWORK));
    let balance = await call(() => wallet.getBalance());
    const res = await fetch(INDEXER_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    const tokens = (await res.json()) as any[];
    if (!Array.isArray(tokens)) throw new Error('indexer: not a list');

    // Plan every token first, then act on the largest amounts first (audit R2-L4): many small
    // launches can no longer use up the run's MAX_TX or the daily budget ahead of real ones.
    const planned: Action[] = [];
    const rewardsTokens: RewardsToken[] = [];
    const routers = new Map<string, Address>();
    for (const t of tokens.filter((x) => x?.kind === 'dex')) {
        try {
            await plan(t, planned, rewardsTokens, routers);
        } catch (e) {
            console.error(`check ${t?.symbol} ${t?.address}: ${errText(e)}`);
        }
    }

    // Router rent (R4A-2): a long-dormant Router's rent eats LP exits' PayTo. Keep each >= 1 Gram.
    const routerLines: string[] = [];
    for (const r of routers.values()) {
        try {
            const b = await call(() => client.getBalance(r));
            const low = b < ROUTER_MIN;
            if (low) console.warn(`ALERT Router ${show(r)} balance ${fromNano(b)} < ${fromNano(ROUTER_MIN)}: top it up (plain transfer)`);
            routerLines.push(`${show(r).slice(0, 8)}…=${fromNano(b)}${low ? ' LOW' : ''}`);
        } catch (e) {
            routerLines.push(`${show(r).slice(0, 8)}…=?`);
        }
    }

    // R7A-1: SyncRewards repairs after a gas-price change, and once a day anyway.
    const gp = await gasPrice21();
    const gasChanged = gp !== null && state.gasPrice21 !== null && gp !== state.gasPrice21;
    if (gp !== null && state.gasPrice21 === null) state.gasPrice21 = gp;
    const scanDue = gasChanged || Date.now() - state.lastScanAt >= SCAN_INTERVAL;
    let scanDone = false;
    const syncs: Action[] = [];
    if (scanDue && rewardsTokens.length) {
        if (gasChanged) console.log(`gas price (config 21) changed ${state.gasPrice21} -> ${gp}: scanning rewards wallets`);
        scanDone = true;
        for (const rt of rewardsTokens) {
            try {
                const { stale, complete } = await scanRewardsToken(rt);
                if (!complete) console.warn(`scan ${rt.symbol}: incomplete read`);
                for (const s of stale) {
                    const v = (await call(() => client.runMethod(s.wallet, 'get_reward_values'))).stack;
                    v.readBigNumber(); v.readBigNumber();
                    const value = v.readBigNumber() + SYNC_MARGIN;
                    const body = beginCell().storeUint(OP_SYNC_REWARDS, 32).storeUint(BigInt(Date.now()), 64).endCell();
                    syncs.push({ kind: 'sync', to: s.wallet, key: 'sync:' + s.wallet.toRawString(), symbol: rt.symbol, value, body, note: s.why, weight: 0n });
                }
            } catch (e) {
                scanDone = false;
                console.error(`scan ${rt.symbol} ${show(rt.master)}: ${errText(e)}`);
            }
        }
    } else if (scanDue) {
        scanDone = true;
    }

    planned.sort((x, y) => (y.weight > x.weight ? 1 : y.weight < x.weight ? -1 : 0));
    // Repairs first: they are cheap (refunded) and keep holders' rewards correct.
    const actions = [...syncs.slice(0, MAX_SYNC), ...planned]
        .filter((a) => Date.now() - (lastActed.get(a.key) ?? 0) >= TOKEN_COOLDOWN);
    if (syncs.length > MAX_SYNC) { console.warn(`${syncs.length} wallets to sync, ${MAX_SYNC} per scan (KEEPER_MAX_SYNC): rest next run`); scanDone = false; }
    let sent = 0;
    let syncsLeft = false;
    for (const a of actions) {
        if (sent >= MAX_TX || spentToday() + a.value > MAX_SPEND_DAY || balance - a.value < MIN_BALANCE) {
            if (sent >= MAX_TX) console.log(`max ${MAX_TX} tx per run reached`);
            else if (balance - a.value < MIN_BALANCE) console.warn(`balance ${fromNano(balance)} too low for ${a.kind} ${a.symbol}: stopping`);
            else console.warn(`daily budget ${fromNano(MAX_SPEND_DAY)} reached (spent ${fromNano(spentToday())}): stopping`);
            syncsLeft = actions.slice(actions.indexOf(a)).some((x) => x.kind === 'sync');
            break;
        }
        const line = `${a.kind} ${a.symbol} ${show(a.to)} value=${fromNano(a.value)} ${a.note}`;
        if (DRY_RUN) {
            console.log(`[dry run] ${line}`);
            sent++;
            continue;
        }
        // Plain pokes go bounceable too: a master that refuses sends the value back.
        const ok = await send(wallet, secretKey, a.to, a.value, a.body);
        console.log(`${ok ? 'sent' : 'NOT CONFIRMED'} ${line}`);
        if (!ok) { syncsLeft = true; break; } // seqno did not move: do not stack more sends on it
        sent++;
        lastActed.set(a.key, Date.now());
        // Count what the call really cost (refunded calls cost only gas), once the refund is in.
        await sleep(8000);
        const after = await call(() => wallet.getBalance());
        spends.push({ at: Date.now(), value: balance > after ? balance - after : 0n });
        balance = after;
    }
    // A scan counts as done (and the new gas price as handled) only once all its repairs went out.
    // (A dry run does not mark it done: the repairs were only printed.)
    if (scanDone && !syncsLeft && !(DRY_RUN && syncs.length)) {
        state.lastScanAt = Date.now();
        if (gp !== null) state.gasPrice21 = gp;
    }
    const status = `status: wallet=${fromNano(balance)} sent=${sent} spent24h=${fromNano(spentToday())}/${fromNano(MAX_SPEND_DAY)}`
        + ` gasPrice21=${gp ?? '?'} lastScan=${state.lastScanAt ? new Date(state.lastScanAt).toISOString() : 'never'}`
        + ` syncsPending=${syncsLeft ? 'yes' : 'no'} routers=[${routerLines.join(', ')}]`;
    console.log(status);
    state.status = status;
    state.statusAt = Date.now();
    saveState(state);
}

// One message per external; waits for the seqno to move before returning.
async function send(wallet: any, secretKey: Buffer, to: Address, value: bigint, body: Cell | null): Promise<boolean> {
    const seqno: number = await call(() => wallet.getSeqno());
    await call(() => wallet.sendTransfer({
        seqno, secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [internal({ to, value, bounce: true, body: body ?? undefined })],
    }));
    for (let i = 0; i < 30; i++) {
        await sleep(4000);
        try {
            if ((await call<number>(() => wallet.getSeqno())) > seqno) return true;
        } catch { /* keep waiting */ }
    }
    return false;
}

async function main() {
    const mnemonic = process.env.KEEPER_MNEMONIC;
    if (!mnemonic) throw new Error('KEEPER_MNEMONIC is not set');
    const keys = await keysFrom(mnemonic);
    delete process.env.KEEPER_MNEMONIC;
    const address = walletFor(keys.publicKey, NETWORK).address;
    console.log(`keeper ${show(address)} on ${NETWORK}, every ${INTERVAL / 1000}s, min tax ${fromNano(MIN_TAX)}, max ${MAX_TX} tx, state ${STATE_FILE}${DRY_RUN ? ', DRY RUN' : ''}`);
    if (FACTORIES.size === 0) console.warn('LAUNCH_FACTORY not set: tokens are not checked against the factories');
    if (!API_KEY) console.warn('TONCENTER_API_KEY not set: the keeper should use its own Toncenter key (not the web proxy\'s)');
    for (;;) {
        try {
            const w = client.open(walletFor(keys.publicKey, NETWORK));
            const bal = await call(() => w.getBalance());
            if (bal < MIN_BALANCE) console.warn(`wallet balance ${fromNano(bal)} < ${fromNano(MIN_BALANCE)}: monitoring only this run`);
            await run(keys.secretKey, keys.publicKey);
        } catch (e) {
            console.error('run failed:', errText(e));
        }
        if (ONCE) return;
        await sleep(INTERVAL);
    }
}

main().catch((e: unknown) => {
    console.error(errText(e));
    process.exit(1);
});
