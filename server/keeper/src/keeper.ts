// Marg keeper: every KEEPER_INTERVAL_SEC, for each taxed direct launch, harvests the pool's tax
// (Harvest) when enough has accrued, else runs a due buyback (Buyback). Both are open to anyone;
// the keeper only pays gas (bucket-paid calls refund its whole value; a caller-paid Harvest costs
// get_harvest_value(), most of which pays the Router's CollectTax).
//
// Env: KEEPER_MNEMONIC (EnvironmentFile only, never logged), NETWORK, TONCENTER_API_KEY,
// INDEXER_URL, LAUNCH_FACTORY (comma-separated allowlist, as the indexer), KEEPER_INTERVAL_SEC,
// KEEPER_MIN_TAX, KEEPER_MIN_BALANCE, KEEPER_MAX_TX, KEEPER_GAS_VALUE, KEEPER_DRY_RUN, KEEPER_ONCE.
import { Address, beginCell, Cell, fromNano, internal, SendMode, toNano, TupleBuilder, TupleReader, type TupleItem } from '@ton/core';
import { TonClient } from '@ton/ton';
import { LaunchFactory } from '../../../launch/build/Launch_LaunchFactory';
import { loadGetterTuplePoolState, loadKeyExt } from '../../../dex/v2/build/Router_Pool';
import { keysFrom, walletFor } from './wallet';

// Message layouts (launch/contracts/messages.tact): op + queryId:uint64, nothing else.
const OP_HARVEST = 0x4d4c0035;
const OP_BUYBACK = 0x4d4c0036;

const NETWORK = process.env.NETWORK === 'testnet' ? 'testnet' : 'mainnet';
const API_KEY = process.env.TONCENTER_API_KEY || undefined;
const ENDPOINT = `https://${NETWORK === 'testnet' ? 'testnet.' : ''}toncenter.com/api/v2/jsonRPC`;
const INDEXER_URL = process.env.INDEXER_URL ?? 'http://127.0.0.1:8811/api/idx/tokens?kind=dex';
const FACTORIES = new Set((process.env.LAUNCH_FACTORY ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((a) => Address.parse(a).toRawString()));
const INTERVAL = Number(process.env.KEEPER_INTERVAL_SEC ?? 600) * 1000;
const MIN_TAX = toNano(process.env.KEEPER_MIN_TAX ?? '0.5');         // harvest from this much accrued tax
const MIN_BALANCE = toNano(process.env.KEEPER_MIN_BALANCE ?? '1');   // never spend below this
const MAX_TX = Number(process.env.KEEPER_MAX_TX ?? 10);              // sends per run
const GAS_VALUE = toNano(process.env.KEEPER_GAS_VALUE ?? '0.05');    // value of refunded calls
const MAX_HARVEST_VALUE = toNano(process.env.KEEPER_MAX_HARVEST_VALUE ?? '0.5'); // refuse a pricier caller-paid harvest
// Launches are permissionless, so wash-traded tokens could make the keeper spend all day: cap the
// Gram it attaches per rolling 24 h, and act on each token at most once per KEEPER_TOKEN_COOLDOWN_SEC.
const MAX_SPEND_DAY = toNano(process.env.KEEPER_MAX_SPEND_PER_DAY ?? '3');
const TOKEN_COOLDOWN = Number(process.env.KEEPER_TOKEN_COOLDOWN_SEC ?? 3600) * 1000;
const spends: { at: number; value: bigint }[] = [];
const lastActed = new Map<string, number>();
const spentToday = () => {
    const since = Date.now() - 86_400_000;
    while (spends.length && spends[0].at < since) spends.shift();
    return spends.reduce((s, x) => s + x.value, 0n);
};
const DRY_RUN = !!process.env.KEEPER_DRY_RUN;
const ONCE = !!process.env.KEEPER_ONCE;

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

type Status = { balance: bigint; wouldRun: boolean; harvestDue: boolean; nextHarvestAt: number; nextCallerHarvestAt: number | null };

// get_buyback_status read by position, so masters deployed before nextCallerHarvestAt was added
// still work: balance, nextAllowedAt, nextAmount, wouldRun, harvestDue, nextHarvestAt[, nextCallerHarvestAt].
async function buybackStatus(master: Address, callerHarvest: boolean): Promise<Status> {
    const r = await call(() => client.runMethod(master, 'get_buyback_status'));
    const s = r.stack;
    const balance = s.readBigNumber();
    s.readBigNumber();
    s.readBigNumber();
    const wouldRun = s.readBoolean();
    const harvestDue = s.readBoolean();
    const nextHarvestAt = Number(s.readBigNumber());
    const nextCallerHarvestAt = callerHarvest ? Number(s.readBigNumber()) : null;
    return { balance, wouldRun, harvestDue, nextHarvestAt, nextCallerHarvestAt };
}

// Minimum value of a caller-paid Harvest; null on masters without it (bucket-paid only).
async function harvestValue(master: Address): Promise<bigint | null> {
    try {
        const r = await call(() => client.runMethod(master, 'get_harvest_value', new TupleBuilder().build()));
        return r.stack.readBigNumber();
    } catch (e) {
        if (/exit[_ ]code/i.test(errText(e))) return null; // no such get method (older master)
        throw e;
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

// get_pool_state of any Router generation: fields were appended at the end (platformFees,
// platformBps); a shorter stack from an older pool is padded with zeros.
async function readPoolState(address: Address) {
    const r = await client.runMethod(address, 'get_pool_state');
    const items = (r.stack as any).items as TupleItem[];
    return loadGetterTuplePoolState(new TupleReader([...items, ...Array.from({ length: 4 }, (): TupleItem => ({ type: 'int', value: 0n }))]));
}

type Action = { kind: 'harvest' | 'buyback'; master: Address; symbol: string; value: bigint; note: string };

async function plan(t: any): Promise<Action | null> {
    if (!t.pool || t.placeholder) return null;
    const master = Address.parse(t.address);
    const ps = await call(() => readPoolState(Address.parse(t.pool)));
    // Taxed launches pay their tax to the master itself.
    if (!ps.key.ext) return null;
    const rcpt = loadKeyExt(ps.key.ext.beginParse()).taxRecipient;
    if (!rcpt || !rcpt.equals(master)) return null;
    if (!(await isGenuine(t, master))) {
        console.warn(`skip ${t.symbol} ${show(master)}: not from an allowlisted factory`);
        return null;
    }
    const symbol = String(t.symbol ?? '?').slice(0, 16);
    const hv = await harvestValue(master);
    const st = await buybackStatus(master, hv !== null);
    const tax = `tax=${fromNano(ps.taxFees)} bucket=${fromNano(st.balance)}`;
    if (ps.taxFees >= MIN_TAX) {
        if (st.harvestDue) return { kind: 'harvest', master, symbol, value: GAS_VALUE, note: `${tax} bucket-paid` };
        if (hv !== null && st.nextCallerHarvestAt !== null && now() >= st.nextCallerHarvestAt) {
            if (hv > MAX_HARVEST_VALUE) {
                console.warn(`skip ${symbol}: harvest value ${fromNano(hv)} above KEEPER_MAX_HARVEST_VALUE`);
                return null;
            }
            return { kind: 'harvest', master, symbol, value: hv, note: `${tax} caller-paid` };
        }
    }
    if (st.wouldRun) return { kind: 'buyback', master, symbol, value: GAS_VALUE, note: tax };
    return null;
}

async function run(secretKey: Buffer, publicKey: Buffer) {
    const wallet = client.open(walletFor(publicKey, NETWORK));
    let balance = await call(() => wallet.getBalance());
    if (balance < MIN_BALANCE) {
        console.warn(`wallet balance ${fromNano(balance)} < ${fromNano(MIN_BALANCE)}: skipping this run`);
        return;
    }
    const res = await fetch(INDEXER_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    const tokens = (await res.json()) as any[];
    if (!Array.isArray(tokens)) throw new Error('indexer: not a list');
    let sent = 0;
    for (const t of tokens.filter((x) => x?.kind === 'dex')) {
        if (sent >= MAX_TX) {
            console.log(`max ${MAX_TX} tx per run reached`);
            break;
        }
        let a: Action | null;
        try {
            a = await plan(t);
        } catch (e) {
            console.error(`check ${t?.symbol} ${t?.address}: ${errText(e)}`);
            continue;
        }
        if (!a) continue;
        const mk = a.master.toRawString();
        if (Date.now() - (lastActed.get(mk) ?? 0) < TOKEN_COOLDOWN) continue;
        if (spentToday() + a.value > MAX_SPEND_DAY) {
            console.warn(`daily budget ${fromNano(MAX_SPEND_DAY)} reached (spent ${fromNano(spentToday())}): stopping`);
            break;
        }
        if (balance - a.value < MIN_BALANCE) {
            console.warn(`balance ${fromNano(balance)} too low for ${a.kind} ${a.symbol}: stopping`);
            break;
        }
        const body = beginCell().storeUint(a.kind === 'harvest' ? OP_HARVEST : OP_BUYBACK, 32).storeUint(BigInt(Date.now()), 64).endCell();
        const line = `${a.kind} ${a.symbol} ${show(a.master)} value=${fromNano(a.value)} ${a.note}`;
        if (DRY_RUN) {
            console.log(`[dry run] ${line}`);
            sent++;
            continue;
        }
        const ok = await send(wallet, secretKey, a.master, a.value, body);
        console.log(`${ok ? 'sent' : 'NOT CONFIRMED'} ${line}`);
        if (!ok) break; // seqno did not move: do not stack more sends on it
        sent++;
        spends.push({ at: Date.now(), value: a.value });
        lastActed.set(mk, Date.now());
        balance = await call(() => wallet.getBalance());
    }
    console.log(`run done: ${sent} tx, wallet ${fromNano(balance)}`);
}

// One message per external; waits for the seqno to move before returning.
async function send(wallet: any, secretKey: Buffer, to: Address, value: bigint, body: Cell): Promise<boolean> {
    const seqno: number = await call(() => wallet.getSeqno());
    await call(() => wallet.sendTransfer({
        seqno, secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        messages: [internal({ to, value, bounce: true, body })],
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
    console.log(`keeper ${show(address)} on ${NETWORK}, every ${INTERVAL / 1000}s, min tax ${fromNano(MIN_TAX)}, max ${MAX_TX} tx${DRY_RUN ? ', DRY RUN' : ''}`);
    if (FACTORIES.size === 0) console.warn('LAUNCH_FACTORY not set: tokens are not checked against the factories');
    for (;;) {
        try {
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
