// Marg direct launch: tax split (holder rewards / tax wallet / buyback and burn) and the per-launch
// anti-snipe fee. Sandbox only, against the real dex/v2 Router and Pool.

import * as fs from 'fs';
import * as path from 'path';
import { Blockchain, BlockchainTransaction, SandboxContract, TreasuryContract, SendMessageResult, internal } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import '@ton/test-utils';
import { LaunchFactory, LaunchParams } from '../build/Launch_LaunchFactory';
import {
    LaunchJetton, loadTaxSplitEvent, loadBurnEvent, loadBuybackEvent,
    storeSwapNative as storeSwapNativeL, storeCollectTax as storeCollectTaxL, storeGramPayout as storeGramPayoutL,
} from '../build/Launch_LaunchJetton';
import {
    LaunchWallet, storeJettonTransfer, storeJettonBurn, storeClaimRewards, storeSyncRewards, storeRewardAck,
} from '../build/Launch_LaunchWallet';
import {
    Router, storeSwapPayload, storeMintPayload, storeSwapNative as storeSwapNativeD, storeCollectTax as storeCollectTaxD, storeGramPayout as storeGramPayoutD,
} from '../../dex/v2/build/Router_Router';
import { Pool } from '../../dex/v2/build/Router_Pool';
import { txOk, events, swapEvents, refundCodes, opOf, gramPayouts, REASON, CODES } from '../../dex/v2/tests/helpers';

jest.setTimeout(900000);

const GRAM = new Address(0, Buffer.alloc(32));
const SUPPLY = 10n ** 18n;
const SCALE = 10n ** 18n;
const T0 = 1_800_000_000;
const PARAMS: LaunchParams = { $$type: 'LaunchParams', startMcap: toNano('2600'), tickSpacing: 10n };
// Low = PARAMS (what the existing tests launch on); mid and high are deeper pools.
const TIERS = { $$type: 'LaunchTiers' as const, low: PARAMS,
    mid: { $$type: 'LaunchParams' as const, startMcap: toNano('10000'), tickSpacing: 10n },
    high: { $$type: 'LaunchParams' as const, startMcap: toNano('30000'), tickSpacing: 10n } };
const LAUNCH_FEE = toNano('1.5');
const OPS = {
    checkpoint: 0x4d4c0030, claim: 0x4d4c0031, ack: 0x4d4c0032, taxSplit: 0x4d4c0022, buyback: 0x4d4c0023, burn: 0x4d4c0024,
    gramPayout: 0x4d480061,
};
// Code constants, read from the contract sources (launch/contracts/jetton.tact, dex/v2/contracts/constants.tact).
function tactConst(file: string, n: string): bigint {
    const k = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const m = k.match(new RegExp(`const ${n}: Int = (?:ton\\("([0-9.]+)"\\)|([0-9]+));`));
    if (!m) throw new Error(`${n} not found in ${file}`);
    return m[1] ? toNano(m[1]) : BigInt(m[2]);
}
const J = (n: string) => tactConst('../contracts/jetton.tact', n);
const D = (n: string) => tactConst('../../dex/v2/contracts/constants.tact', n);
const C = {
    CHECKPOINT_VALUE: J('CHECKPOINT_VALUE'), TAX_IN_GAS: J('TAX_IN_GAS'), BUYBACK_GAS: J('BUYBACK_GAS'), KEEPER_FEE: J('KEEPER_FEE'),
    HARVEST_VALUE: J('HARVEST_VALUE'), BUYBACK_MIN: J('BUYBACK_MIN'), INTERVAL: Number(J('BUYBACK_INTERVAL')),
    HARVEST_INTERVAL: Number(J('HARVEST_INTERVAL')), MIN_STORAGE: J('MASTER_MIN_STORAGE'), BURN_FWD: J('BURN_FWD'),
    // DEX: the tax auto-payout threshold and the value each payout carries on top of the tax.
    TAX_MIN_PAYOUT: D('TAX_MIN_PAYOUT'), TAX_PAYOUT_GAS: D('TAX_PAYOUT_GAS'),
};
const PLATFORM_BPS = 100n;   // Router.platformBps default (1%)

function content(name: string): Cell {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    for (const [k, v] of [['name', name], ['symbol', 'MARG'], ['decimals', '9']]) {
        dict.set(BigInt('0x' + sha256_sync(k).toString('hex')), beginCell().storeUint(0, 8).storeStringTail(v).endCell());
    }
    return beginCell().storeUint(0, 8).storeDict(dict).endCell();
}

const dst = (tx: BlockchainTransaction) => (tx.inMessage?.info.dest instanceof Address ? tx.inMessage.info.dest : undefined);
const src = (tx: BlockchainTransaction) => (tx.inMessage?.info.src instanceof Address ? tx.inMessage.info.src : undefined);
const valueIn = (tx: BlockchainTransaction) => (tx.inMessage!.info as any).value.coins as bigint;
const exitCode = (tx: BlockchainTransaction) => (tx.description as any).computePhase?.exitCode;

function expectNoFailures(res: { transactions: BlockchainTransaction[] }, allow?: (tx: BlockchainTransaction) => boolean) {
    const bad = res.transactions.filter((tx) => !txOk(tx) && !(allow && allow(tx)));
    expect(bad.map((tx) => [exitCode(tx), opOf(tx)?.toString(16)])).toEqual([]);
}

// Comment payments ("Marg holder rewards" / "Marg tax") from `from` to `to`.
function comments(txs: BlockchainTransaction[], from: Address, to: Address | undefined, text: string): bigint[] {
    const out: bigint[] = [];
    for (const tx of txs) {
        const s = src(tx), d = dst(tx);
        if (!s || !d || !s.equals(from) || (to && !d.equals(to))) continue;
        const b = tx.inMessage!.body.beginParse();
        if (b.remainingBits < 32 || b.loadUint(32) !== 0) continue;
        if (b.loadStringTail() !== text) continue;
        out.push(valueIn(tx));
    }
    return out;
}

function splitEvents(txs: BlockchainTransaction[]) {
    return events({ transactions: txs } as any).filter((e) => e.op === OPS.taxSplit).map((e) => loadTaxSplitEvent(e.body.clone()));
}

// Deterministic PRNG (mulberry32).
function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('Marg direct launch: tax split, holder rewards, buyback and burn, anti-snipe', () => {
    let chain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let treasury: SandboxContract<TreasuryContract>;
    let creator: SandboxContract<TreasuryContract>;
    let holders: SandboxContract<TreasuryContract>[];
    let mallory: SandboxContract<TreasuryContract>;
    let router: SandboxContract<Router>;
    let factory: SandboxContract<LaunchFactory>;
    let base: any;

    type CreateOpts = {
        devBuy?: bigint; buyTaxBps?: bigint; sellTaxBps?: bigint; taxWallet?: Address | null;
        rewardsBps?: bigint; walletBps?: bigint; buybackBps?: bigint; antiSnipePips?: bigint; antiSnipeDuration?: bigint; value?: bigint;
    };
    async function create(o: CreateOpts = {}) {
        const devBuy = o.devBuy ?? 0n;
        const value = o.value ?? await factory.getGetCreateValue(devBuy);
        const p = (await factory.getGetFactoryData()).tiers.low;
        return factory.send(creator.getSender(), { value }, {
            $$type: 'CreateToken', queryId: 7n, content: content('Tax Test'), devBuy, minDevOut: 0n,
            buyTaxBps: o.buyTaxBps ?? 0n, sellTaxBps: o.sellTaxBps ?? 0n, taxWallet: o.taxWallet ?? null,
            rewardsBps: o.rewardsBps ?? 0n, walletBps: o.walletBps ?? 0n, buybackBps: o.buybackBps ?? 0n,
            antiSnipePips: o.antiSnipePips ?? 0n, antiSnipeDuration: o.antiSnipeDuration ?? 0n,
            startMcap: p.startMcap, tickSpacing: p.tickSpacing, vaultBps: 0n, vaultLock: 0n, vaultVest: 0n,
        });
    }

    async function opened(index: bigint) {
        const master = chain.openContract(LaunchJetton.fromAddress(await factory.getGetTokenAddress(index)));
        const key = await master.getGetPoolKey();
        const pool = chain.openContract(Pool.fromAddress(await router.getGetPoolAddress(key.token0, key.token1, key.tickSpacing, key.ext)));
        return { master, key, pool };
    }

    async function launch(o: CreateOpts = {}) {
        const res = await create(o);
        expectNoFailures(res);
        const idx = (await factory.getGetFactoryData()).nextIndex - 1n;
        return { res, ...(await opened(idx)) };
    }

    const walletOf = async (master: SandboxContract<LaunchJetton>, owner: Address) =>
        chain.openContract(LaunchWallet.fromAddress(await master.getGetWalletAddress(owner)));
    const active = async (a: Address) => (await chain.getContract(a)).accountState?.type === 'active';
    const jBal = async (master: SandboxContract<LaunchJetton>, owner: Address) => {
        const w = await walletOf(master, owner);
        return (await active(w.address)) ? (await w.getGetWalletData()).balance : 0n;
    };
    const rState = async (master: SandboxContract<LaunchJetton>, owner: Address) => {
        const w = await walletOf(master, owner);
        return (await active(w.address)) ? await w.getGetRewardState() : null;
    };
    const pending = async (master: SandboxContract<LaunchJetton>, owner: Address) => {
        const s = await rState(master, owner);
        if (!s) return 0n;
        return master.getGetPendingRewards(s.acked, s.lastAcc, s.frac, s.owed);
    };
    const balOf = async (a: Address) => (await chain.getContract(a)).balance;

    function swapNativeBody(key: any, amount: bigint, queryId = 1n) {
        return {
            $$type: 'SwapNative' as const, queryId, amount, otherToken: key.token1, tickSpacing: key.tickSpacing, ext: key.ext, minOut: 0n,
            sqrtPriceLimitX96: 0n, maxCrossings: 24n, allowPartial: false, deadline: BigInt(chain.now! + 600), receiver: null,
            refundTo: null, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null,
        };
    }
    const buy = (who: SandboxContract<TreasuryContract>, key: any, amount: bigint) =>
        router.send(who.getSender(), { value: amount + toNano('0.7') }, swapNativeBody(key, amount));

    function sellBody(key: any, amount: bigint, who: Address) {
        const p = beginCell().store(storeSwapPayload({
            $$type: 'SwapPayload', otherToken: GRAM, tickSpacing: key.tickSpacing, ext: key.ext, minOut: 0n, sqrtPriceLimitX96: 0n,
            maxCrossings: 24n, allowPartial: false, deadline: BigInt(chain.now! + 600), receiver: null, refundTo: null, referral: null,
            refBps: 0n, fwdTon: 0n, fwdPayload: null,
        })).endCell();
        return {
            $$type: 'JettonTransfer' as const, queryId: 2n, amount, destination: router.address, responseDestination: who,
            customPayload: null, forwardTonAmount: toNano('0.7'), forwardPayload: beginCell().storeBit(1).storeRef(p).endCell().beginParse(),
        };
    }
    const sell = async (who: SandboxContract<TreasuryContract>, master: SandboxContract<LaunchJetton>, key: any, amount: bigint) =>
        (await walletOf(master, who.address)).send(who.getSender(), { value: toNano('0.8') }, sellBody(key, amount, who.address));

    const xferBody = (to: Address, amount: bigint, resp: Address) => ({
        $$type: 'JettonTransfer' as const, queryId: 3n, amount, destination: to, responseDestination: resp, customPayload: null,
        forwardTonAmount: 0n, forwardPayload: beginCell().storeBit(0).endCell().beginParse(),
    });
    const transfer = async (master: SandboxContract<LaunchJetton>, from: SandboxContract<TreasuryContract>, to: Address, amount: bigint, value = toNano('0.12')) =>
        (await walletOf(master, from.address)).send(from.getSender(), { value }, xferBody(to, amount, from.address));

    const collect = (key: any, who = mallory, value = toNano('0.3')) =>
        router.send(who.getSender(), { value }, { $$type: 'CollectTax', queryId: 0n, key: { ...key, $$type: 'PoolKey' } });
    const claim = async (master: SandboxContract<LaunchJetton>, who: SandboxContract<TreasuryContract>, value = toNano('0.05')) =>
        (await walletOf(master, who.address)).send(who.getSender(), { value }, { $$type: 'ClaimRewards', queryId: 9n });
    const sync = async (master: SandboxContract<LaunchJetton>, who: SandboxContract<TreasuryContract>) =>
        (await walletOf(master, who.address)).send(who.getSender(), { value: toNano('0.05') }, { $$type: 'SyncRewards', queryId: 9n });

    beforeAll(async () => {
        chain = await Blockchain.create();
        chain.now = T0;
        admin = await chain.treasury('admin');
        treasury = await chain.treasury('treasury');
        creator = await chain.treasury('creator', { balance: toNano('1000000') });
        holders = [];
        for (const n of ['h0', 'h1', 'h2', 'h3', 'h4']) holders.push(await chain.treasury(n, { balance: toNano('1000000') }));
        mallory = await chain.treasury('mallory', { balance: toNano('1000000') });
        router = chain.openContract(await Router.fromInit(admin.address, treasury.address));
        await router.send(admin.getSender(), { value: toNano('1') }, null);
        factory = chain.openContract(await LaunchFactory.fromInit(admin.address, treasury.address, router.address, LAUNCH_FEE, TIERS));
        await factory.send(admin.getSender(), { value: toNano('0.5') }, null);
        base = chain.snapshot();
    });
    beforeEach(async () => {
        await chain.loadFrom(base);
        chain.now = T0;
    });

    // -----------------------------------------------------------------------

    it('the DEX messages the master sends/receives are byte-identical copies (SwapNative, CollectTax, GramPayout)', async () => {
        const key = { $$type: 'PoolKey' as const, token0: GRAM, token1: creator.address, tickSpacing: 200n, ext: beginCell().storeUint(5, 8).endCell() };
        const sw = { ...swapNativeBody(key, 123n, 77n), receiver: creator.address, refundTo: treasury.address, fwdTon: 5n, deadline: 99n };
        const eq = (a: Cell, b: Cell) => expect(a.hash().equals(b.hash())).toBe(true);
        eq(beginCell().store(storeSwapNativeL(sw)).endCell(), beginCell().store(storeSwapNativeD(sw)).endCell());
        const ct = { $$type: 'CollectTax' as const, queryId: 5n, key };
        eq(beginCell().store(storeCollectTaxL(ct)).endCell(), beginCell().store(storeCollectTaxD(ct)).endCell());
        const gp = { $$type: 'GramPayout' as const, queryId: 5n, reason: 14n, amount: 1234n, payload: null };
        eq(beginCell().store(storeGramPayoutL(gp)).endCell(), beginCell().store(storeGramPayoutD(gp)).endCell());
    });

    it('split config: stored immutably, in the event and getters; the key pays the master; wallets tracked only with rewards', async () => {
        const { res, master, key } = await launch({ buyTaxBps: 300n, sellTaxBps: 500n, rewardsBps: 5000n, walletBps: 3000n, buybackBps: 2000n, taxWallet: holders[4].address });
        const info = await master.getGetLaunchInfo();
        expect([info.rewardsBps, info.walletBps, info.buybackBps, info.taxWallet!.equals(holders[4].address), info.taxRecipient!.equals(master.address),
            info.buybackCap]).toEqual([5000n, 3000n, 2000n, true, true, toNano('26')]);
        const td = await master.getGetTaxData();
        expect([td.rewardsBps, td.walletBps, td.buybackBps, td.taxIn]).toEqual([5000n, 3000n, 2000n, 0n]);
        const ev = events(res).filter((e) => e.op === 0x4d4c0021)[0].body;
        expect(ev).toBeDefined();
        // Router wallet (the pool's liquidity) and the master's own wallet are never tracked.
        const rw = await walletOf(master, router.address);
        expect(rw.address.equals(key.token1)).toBe(true);
        expect(await rw.getGetTracked()).toBe(false);
        expect((await master.getGetRewardsData()).totalShares).toBe(0n);
        await buy(holders[0], key, toNano('50'));
        expect(await (await walletOf(master, holders[0].address)).getGetTracked()).toBe(true);
        expect((await master.getGetRewardsData()).totalShares).toBe(await jBal(master, holders[0].address));
        // No rewards share: wallets are plain (untracked), no checkpoints at all.
        // Dev buy with rewards on, at exactly get_create_value: no failure; the creator is tracked from the start.
        const t3 = await launch({ buyTaxBps: 300n, sellTaxBps: 300n, rewardsBps: 10000n, devBuy: toNano('20') });
        const cs = await rState(t3.master, creator.address);
        expect(cs!.synced).toBe(await jBal(t3.master, creator.address));
        expect((await t3.master.getGetRewardsData()).totalShares).toBe(cs!.synced);
        const t2 = await launch({ buyTaxBps: 300n, walletBps: 5000n, buybackBps: 5000n });
        const r = await buy(holders[0], t2.key, toNano('50'));
        expect(await (await walletOf(t2.master, holders[0].address)).getGetTracked()).toBe(false);
        expect(r.transactions.filter((tx) => opOf(tx) === OPS.checkpoint).length).toBe(0);
    });

    it('payout split with exact amounts (rewards / wallet / buyback); dust and gas leftovers documented', async () => {
        const { master, key, pool } = await launch({ buyTaxBps: 300n, sellTaxBps: 500n, rewardsBps: 3333n, walletBps: 3334n, buybackBps: 3333n, taxWallet: holders[4].address });
        const mb = await balOf(master.address);
        // The tax (>= TAX_MIN_PAYOUT) is paid to the master and split inside the buy itself.
        const res = await buy(holders[0], key, toNano('17.123456789'));
        expectNoFailures(res);
        const owed = (toNano('17.123456789') * 300n) / 10000n;
        expect(owed).toBeGreaterThanOrEqual(C.TAX_MIN_PAYOUT);
        expect(swapEvents(res)[0].tax).toBe(owed);
        expect((await pool.getGetPoolState()).taxFees).toBe(0n);
        expect(gramPayouts(res, master.address).filter((x) => x.reason === REASON.TAX).map((x) => [x.amount, x.value]))
            .toEqual([[owed, owed + C.TAX_PAYOUT_GAS]]);
        const [sp] = splitEvents(res.transactions);
        const r = (owed * 3333n) / 10000n, w = (owed * 3334n) / 10000n;
        expect([sp.amount, sp.rewards, sp.wallet, sp.buyback]).toEqual([owed, r, w, owed - r - w]);
        // The wallet gets exactly its share (buyback is on, so the gas leftover goes to the bucket).
        expect(comments(res.transactions, master.address, holders[4].address, 'Marg tax')).toEqual([w]);
        const rd = await master.getGetRewardsData();
        expect(rd.accrued + rd.carry).toBe(r);
        const st = await master.getGetBuybackStatus();
        expect(st.balance).toBeGreaterThanOrEqual(owed - r - w);
        expect(st.count).toBe(0n);   // below BUYBACK_MIN + BUYBACK_GAS: no buyback yet
        // Everything is held: master balance >= storage + rewards + bucket.
        expect(await balOf(master.address)).toBeGreaterThanOrEqual(C.MIN_STORAGE + r + st.balance);
        const td = await master.getGetTaxData();
        expect([td.taxIn, td.walletPaid]).toEqual([owed, w]);
        // eslint-disable-next-line no-console
        console.log(`split ${owed}: rewards ${r}, wallet ${w}, buyback ${owed - r - w}; bucket also got ${st.balance - (owed - r - w)} of gas leftover; master +${(await balOf(master.address)) - mb}`);

        // walletBps only (no buyback): the wallet gets its share plus the leftover; dust to the wallet.
        // Below TAX_MIN_PAYOUT the tax stays in the pool (no payout in the swap) until CollectTax.
        const t2 = await launch({ buyTaxBps: 300n, rewardsBps: 5001n, walletBps: 4999n, taxWallet: holders[4].address });
        const rb = await buy(holders[1], t2.key, toNano('3.000000007'));
        expect(gramPayouts(rb, t2.master.address).filter((x) => x.reason === REASON.TAX)).toEqual([]);
        expect(splitEvents(rb.transactions)).toEqual([]);
        const owed2 = (await t2.pool.getGetPoolState()).taxFees;
        expect(owed2).toBe((toNano('3.000000007') * 300n) / 10000n);
        expect(owed2).toBeLessThan(C.TAX_MIN_PAYOUT);
        const res2 = await collect(t2.key);
        expect(gramPayouts(res2, t2.master.address).filter((x) => x.reason === REASON.TAX).map((x) => x.amount)).toEqual([owed2]);
        const [sp2] = splitEvents(res2.transactions);
        expect([sp2.rewards, sp2.wallet, sp2.buyback]).toEqual([(owed2 * 5001n) / 10000n, owed2 - (owed2 * 5001n) / 10000n, 0n]);
        const paid = comments(res2.transactions, t2.master.address, holders[4].address, 'Marg tax');
        expect(paid.length).toBe(1);
        expect(paid[0]).toBeGreaterThanOrEqual(sp2.wallet);
        expect(paid[0]).toBeLessThan(sp2.wallet + toNano('0.3'));

        // A forged GramPayout claiming a huge tax splits only what it carries (minus the split's own gas).
        const res3 = await chain.sendMessage(internal({
            from: mallory.address, to: master.address, value: toNano('1'),
            body: beginCell().store(storeGramPayoutL({ $$type: 'GramPayout', queryId: 0n, reason: 14n, amount: toNano('1000'), payload: null })).endCell(),
        }));
        const [sp3] = splitEvents(res3.transactions);
        expect(sp3.amount).toBe(toNano('1') - C.TAX_IN_GAS);
    });

    it('rewards are pro-rata to tracked balances across transfers interleaved with accruals; late receivers get nothing earlier', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 10000n });
        const [a, b, c] = holders;
        const owners = [a, b, c];
        // Model, replayed in the master's own transaction order (the tracker view): checkpoints move
        // shares, each tax split (auto-paid in a swap once >= TAX_MIN_PAYOUT, or by CollectTax) accrues
        // r * share / T (exact rationals in floats, compared with integer results). While T = 0 the
        // accrual is carried to the next one, as in the master.
        const model = new Map<string, number>();
        const shares = new Map<string, bigint>();
        let T = 0n, carry = 0n, accruals = 0;
        const run = async (p: Promise<SendMessageResult>) => {
            const res = await p;
            expectNoFailures(res);
            for (const tx of res.transactions) {
                if (!dst(tx)?.equals(master.address) || !txOk(tx)) continue;
                const op = opOf(tx);
                if (op === OPS.checkpoint || op === OPS.claim) {
                    const bd = tx.inMessage!.body.beginParse();
                    bd.loadUint(32); bd.loadUint(64);
                    const delta = bd.loadIntBig(64);
                    const owner = bd.loadAddress().toString();
                    shares.set(owner, (shares.get(owner) ?? 0n) + delta);
                    T += delta;
                    continue;
                }
                for (const sp of splitEvents([tx])) {
                    // rewardsBps = 100%: the gas leftover (extra) also goes to rewards.
                    const r = sp.rewards + sp.extra + carry;
                    if (r === 0n) continue;
                    if (T === 0n) { carry = r; continue; }
                    carry = 0n;
                    accruals++;
                    for (const [o, sh] of shares) model.set(o, (model.get(o) ?? 0) + Number(r) * Number(sh) / Number(T));
                }
            }
            // After each operation the tracker view equals the real balances.
            const bals = await Promise.all(owners.map((o) => jBal(master, o.address)));
            owners.forEach((o, i) => expect(shares.get(o.address.toString()) ?? 0n).toBe(bals[i]));
            expect((await master.getGetRewardsData()).totalShares).toBe(T);
            return res;
        };
        // a's buy pays 5 Gram of tax to the master in the same transaction chain, before a's own jettons arrive
        // (T = 0: carried); b's buy accrues it to a.
        const r0 = await run(buy(a, key, toNano('100')));
        expect(splitEvents(r0.transactions).length).toBe(1);
        await run(buy(b, key, toNano('50')));
        expect(accruals).toBe(1);
        // A sub-threshold tax stays in the pool until CollectTax.
        await run(buy(b, key, toNano('1')));
        await run(collect(key));
        expect(accruals).toBe(2);
        // c receives tokens AFTER these accruals: nothing from them.
        await run(transfer(master, a, c.address, (await jBal(master, a.address)) / 3n));
        expect(await pending(master, c.address)).toBe(0n);
        await run(buy(c, key, toNano('10')));
        await run(transfer(master, b, a.address, (await jBal(master, b.address)) / 2n));
        await run(sell(c, master, key, (await jBal(master, c.address)) / 2n));
        await run(buy(a, key, toNano('20')));
        expect(accruals).toBe(5);
        let total = 0n;
        for (const h of [a, b, c]) {
            const p = await pending(master, h.address);
            const m = model.get(h.address.toString())!;
            expect(Math.abs(Number(p) - m)).toBeLessThanOrEqual(accruals + 1e-6 * m);   // ≤ 1 nanoGram per accrual (float model: + 1e-6 rel.)
            const before = await balOf(h.address);
            const res = await claim(master, h);
            expectNoFailures(res);
            // One payment: the rewards plus the rest of the claim's value (minus fees).
            const got = comments(res.transactions, master.address, h.address, 'Marg holder rewards');
            expect(got.length).toBe(1);
            expect(got[0]).toBeGreaterThan(p + toNano('0.05') - toNano('0.02'));
            expect(got[0]).toBeLessThan(p + toNano('0.05'));
            expect(await pending(master, h.address)).toBe(0n);
            total += p;
            expect(await balOf(h.address)).toBeGreaterThan(before + p - toNano('0.02'));
        }
        const rd = await master.getGetRewardsData();
        expect(rd.claimed).toBe(total);
        expect(total).toBeLessThanOrEqual(rd.accrued);
        expect(rd.accrued - total).toBeLessThanOrEqual(BigInt(accruals));   // the floor dust stays in the master
    });

    it('claim is idempotent; a second claim while one is in flight is rejected; forged reward messages fail', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 10000n });
        const [a, b] = holders;
        await buy(a, key, toNano('100'));
        await buy(b, key, toNano('100'));
        await collect(key);
        const p = await pending(master, a.address);
        expect(p).toBeGreaterThan(0n);
        const w = await walletOf(master, a.address);
        // Two claims sent back to back: the second reaches the wallet while the first is in flight.
        const it = await chain.sendMessageIter(internal({ from: a.address, to: w.address, value: toNano('0.05'),
            body: beginCell().store(storeClaimRewards({ $$type: 'ClaimRewards', queryId: 1n })).endCell() }));
        const first: BlockchainTransaction[] = [];
        first.push((await it.next()).value);   // wallet: claim sent, inFlight = 1
        // The 2nd claim is queued right behind the first claim's RewardClaim: it reaches the wallet before the ack.
        const r2 = await chain.sendMessage(internal({ from: a.address, to: w.address, value: toNano('0.05'),
            body: beginCell().store(storeClaimRewards({ $$type: 'ClaimRewards', queryId: 2n })).endCell() }));
        const all = [...first, ...r2.transactions];
        const rejected = all.filter((tx) => dst(tx)?.equals(w.address) && !txOk(tx));
        expect(rejected.length).toBe(1);
        expect((await master.getGetRewardsData()).claimed).toBe(p);
        expect(comments(all, master.address, a.address, 'Marg holder rewards').length).toBe(1);
        // Claiming again pays nothing.
        const r3 = await claim(master, a);
        expectNoFailures(r3);
        const back = comments(r3.transactions, master.address, a.address, 'Marg holder rewards');
        expect(back.length).toBe(1);
        expect(back[0]).toBeLessThan(toNano('0.05'));   // only the claim's own value comes back
        expect((await master.getGetRewardsData()).claimed).toBe(p);
        // Forged: a checkpoint / claim from a non-wallet, an ack from a non-master.
        const fake = [
            { to: master.address, body: beginCell().storeUint(OPS.checkpoint, 32).storeUint(0, 64).storeInt(10n ** 17n, 64).storeAddress(mallory.address).endCell() },
            { to: master.address, body: beginCell().storeUint(OPS.claim, 32).storeUint(0, 64).storeInt(0, 64).storeAddress(mallory.address)
                .storeCoins(SUPPLY).storeUint(0, 256).storeUint(0, 64).storeCoins(toNano('100')).endCell() },
            { to: w.address, body: beginCell().store(storeRewardAck({ $$type: 'RewardAck', queryId: 0n, acc: 10n ** 40n, delta: 0n, claim: false, frac: 0n })).endCell() },
        ];
        const rd = await master.getGetRewardsData();
        for (const f of fake) {
            const res = await chain.sendMessage(internal({ from: mallory.address, to: f.to, value: toNano('0.1'), body: f.body }));
            expect(res.transactions.filter((tx) => dst(tx)?.equals(f.to) && !txOk(tx)).length).toBe(1);
        }
        expect(await master.getGetRewardsData()).toEqual(rd);
        // Also from a real holder's own (sender = holder, not its wallet).
        const res = await chain.sendMessage(internal({ from: a.address, to: master.address, value: toNano('0.1'), body: fake[0].body }));
        expect(res.transactions.filter((tx) => dst(tx)?.equals(master.address) && !txOk(tx)).length).toBe(1);
    });

    it('a bounced checkpoint is re-reported: the wallet stays consistent and SyncRewards repairs the master view', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 10000n });
        const [a, b] = holders;
        await buy(a, key, toNano('100'));
        const wa = await walletOf(master, a.address);
        // Transfer a -> b, but the checkpoint from a's wallet "fails" at the master: we deliver a bounce instead.
        const it = await chain.sendMessageIter(internal({ from: a.address, to: wa.address, value: toNano('0.12'),
            body: beginCell().store(storeJettonTransfer(xferBody(b.address, 1000n, a.address))).endCell() }));
        const tx1: BlockchainTransaction = (await it.next()).value;
        const q = (chain as any).defaultQueueManager.messageQueue as any[];
        const i = q.findIndex((m) => m.info.dest.equals(master.address));
        const [cp] = q.splice(i, 1);
        const body = cp.body.beginParse();
        const bounceBody = beginCell().storeUint(0xffffffff, 32).storeBits(body.loadBits(Math.min(256, body.remainingBits))).endCell();
        for (let r = await it.next(); !r.done; r = await it.next()) { /* deliver the rest */ }
        expect(tx1).toBeDefined();
        await chain.sendMessage(internal({ from: master.address, to: wa.address, value: toNano('0.005'), bounce: false, bounced: true, body: bounceBody } as any));
        const s = (await wa.getGetRewardState());
        const bal = await jBal(master, a.address);
        expect(s.inFlight).toBe(0n);
        expect(s.synced).toBe(bal + 1000n);          // the -1000 was not applied: still owed to the master
        expect((await master.getGetRewardsData()).totalShares).toBe(bal + 1000n + 1000n);   // a's old view + b
        expectNoFailures(await sync(master, a));
        expect((await wa.getGetRewardState()).synced).toBe(bal);
        expect((await master.getGetRewardsData()).totalShares).toBe(bal + 1000n);
    });

    // A message scheduler that delivers queued messages in a random order, keeping only TON's
    // guarantee: messages between the same (sender, receiver) pair arrive in the order sent.
    for (const seed of [1, 2, 3, 4]) {
        it(`random async interleaving (seed ${seed}, 240 ops): claimed <= accrued, each holder == tracker-view model within rounding`, async () => {
            const { master, key } = await launch({ buyTaxBps: 400n, sellTaxBps: 500n, rewardsBps: 6000n, walletBps: 1000n, buybackBps: 3000n, taxWallet: creator.address });
            const R = rng(seed);
            const H = holders.slice(0, 4);
            const qm = (chain as any).defaultQueueManager;
            const log: BlockchainTransaction[] = [];
            const pk = (m: any) => `${m.info.src?.toString()}>${m.info.dest?.toString()}`;
            const step = async () => {
                const q = qm.messageQueue as any[];
                const seen = new Set<string>();
                const elig: number[] = [];
                q.forEach((m, i) => { const k = pk(m); if (!seen.has(k)) { seen.add(k); elig.push(i); } });
                const i = elig[Math.floor(R() * elig.length)];
                const [m] = q.splice(i, 1);
                q.unshift(m);
                const r = await qm.runQueueIter(true).next();
                if (r.value) log.push(r.value);
            };
            const push = async (from: Address, to: Address, value: bigint, body: Cell) =>
                qm.pushMessage(internal({ from, to, value, body, bounce: true }));
            const wallets = await Promise.all(H.map((h) => walletOf(master, h.address)));
            for (const h of H) {
                await push(h.address, router.address, toNano('40.7'), beginCell().store(storeSwapNativeD(swapNativeBody(key, toNano('40')))).endCell());
            }
            while (qm.messageQueue.length > 0) await step();
            let ops = 0;
            while (ops < 240) {
                const k = Math.floor(R() * H.length);
                const h = H[k];
                const x = R();
                const bal = await jBal(master, h.address);
                if (x < 0.3 && bal > 0n) {
                    const to = H[(k + 1 + Math.floor(R() * (H.length - 1))) % H.length];
                    await push(h.address, wallets[k].address, toNano('0.12'),
                        beginCell().store(storeJettonTransfer(xferBody(to.address, BigInt(Math.floor(R() * 1e6)) * bal / 2000000n + 1n, h.address))).endCell());
                } else if (x < 0.45) {
                    const amt = toNano(String(1 + Math.floor(R() * 20)));
                    await push(h.address, router.address, amt + toNano('0.7'),
                        beginCell().store(storeSwapNativeD(swapNativeBody(key, amt))).endCell());
                } else if (x < 0.55 && bal > 0n) {
                    await push(h.address, wallets[k].address, toNano('0.8'),
                        beginCell().store(storeJettonTransfer(sellBody(key, bal / 5n + 1n, h.address))).endCell());
                } else if (x < 0.72) {
                    await push(mallory.address, router.address, toNano('0.3'),
                        beginCell().store(storeCollectTaxD({ $$type: 'CollectTax', queryId: 0n, key: { ...key, $$type: 'PoolKey' } })).endCell());
                } else if (x < 0.85) {
                    await push(h.address, wallets[k].address, toNano('0.05'),
                        beginCell().store(storeClaimRewards({ $$type: 'ClaimRewards', queryId: BigInt(ops) })).endCell());
                } else if (x < 0.92 && bal > 0n) {
                    await push(h.address, wallets[k].address, toNano('0.1'),
                        beginCell().store(storeJettonBurn({ $$type: 'JettonBurn', queryId: 0n, amount: bal / 50n + 1n, responseDestination: h.address, customPayload: null })).endCell());
                } else {
                    await push(h.address, wallets[k].address, toNano('0.05'),
                        beginCell().store(storeSyncRewards({ $$type: 'SyncRewards', queryId: 0n })).endCell());
                }
                ops++;
                const n = Math.floor(R() * 12);
                for (let s = 0; s < n && qm.messageQueue.length > 0; s++) await step();
                if (R() < 0.1) chain.now! += 120;
            }
            while (qm.messageQueue.length > 0) await step();
            // Final sync so every wallet's `owed` is current.
            for (let k = 0; k < H.length; k++) {
                await push(H[k].address, wallets[k].address, toNano('0.05'), beginCell().store(storeSyncRewards({ $$type: 'SyncRewards', queryId: 0n })).endCell());
            }
            while (qm.messageQueue.length > 0) await step();

            // Only user requests may fail (in-flight claims, balances spent by an earlier in-flight transfer).
            const holderSet = new Set(H.map((h) => h.address.toString()));
            const bad = log.filter((tx) => !txOk(tx) && !(src(tx) && holderSet.has(src(tx)!.toString()) && wallets.some((w) => dst(tx)!.equals(w.address))));
            expect(bad.map((tx) => [exitCode(tx), opOf(tx)?.toString(16), dst(tx)!.toString()])).toEqual([]);

            // Reference model: replay the master's own transaction order (the tracker view).
            const shares = new Map<string, bigint>();
            const earned = new Map<string, bigint>();   // in 1e-27 nanoGram units
            const P = 10n ** 27n;
            let T = 0n, carry = 0n, accruals = 0;
            const claimedBy = new Map<string, bigint>();
            for (const tx of log) {
                if (!dst(tx)?.equals(master.address) || !txOk(tx)) continue;
                const op = opOf(tx);
                if (op === OPS.checkpoint || op === OPS.claim) {
                    const b = tx.inMessage!.body.beginParse();
                    b.loadUint(32); b.loadUint(64);
                    const delta = b.loadIntBig(64);
                    const owner = b.loadAddress().toString();
                    shares.set(owner, (shares.get(owner) ?? 0n) + delta);
                    T += delta;
                    if (op === OPS.claim) {
                        // paid = owed + (acked * (acc - lastAcc) + frac) / SCALE, acc from the ack it sent
                        const acked = b.loadCoins(), lastAcc = b.loadUintBig(256), frac = b.loadUintBig(64), owed = b.loadCoins();
                        const ack = [...tx.outMessages.values()].find((m) => m.body.beginParse().preloadUint(32) === OPS.ack)!.body.beginParse();
                        ack.loadUint(32); ack.loadUint(64);
                        const acc = ack.loadUintBig(256);
                        const paid = owed + (acked * (acc - lastAcc) + frac) / SCALE;
                        claimedBy.set(owner, (claimedBy.get(owner) ?? 0n) + paid);
                    }
                } else {
                    const sp = splitEvents([tx]);
                    if (sp.length === 0 || sp[0].rewards === 0n) continue;
                    const r = sp[0].rewards + carry;
                    if (T === 0n) { carry = r; continue; }
                    carry = 0n;
                    accruals++;
                    for (const [o, s] of shares) earned.set(o, (earned.get(o) ?? 0n) + (r * s * P) / T);
                }
            }
            const rd = await master.getGetRewardsData();
            expect(rd.totalShares).toBe(T);
            let claimedAll = 0n, sumBal = 0n;
            for (let k = 0; k < H.length; k++) {
                const o = H[k].address;
                const claimed = claimedBy.get(o.toString()) ?? 0n;
                const st = await wallets[k].getGetRewardState();
                const bal = await jBal(master, o);
                expect([st.inFlight, st.synced, st.acked]).toEqual([0n, bal, shares.get(o.toString()) ?? 0n]);
                sumBal += bal;
                const got = claimed + st.owed;
                const want = earned.get(o.toString()) ?? 0n;
                // Never more than the model (+1 for the carried remainder), at most 1 nanoGram short per accrual.
                expect(got * P).toBeLessThanOrEqual(want + P);
                expect(want - got * P).toBeLessThanOrEqual(BigInt(accruals + 1) * P);
                claimedAll += claimed;
            }
            expect(sumBal).toBe(T);   // after the final sync every tracked balance is reported exactly
            expect(rd.claimed).toBe(claimedAll);
            expect(claimedAll).toBeLessThanOrEqual(rd.accrued);
            const bs = await master.getGetBuybackStatus();
            expect(await balOf(master.address)).toBeGreaterThanOrEqual(rd.accrued + rd.carry - rd.claimed + bs.balance);
            // Supply accounting: burns (holders + buybacks) reduce totalSupply exactly.
            const jd = await master.getGetJettonData();
            const routerBal = await jBal(master, router.address);
            expect(jd.totalSupply).toBe(sumBal + routerBal + (await jBal(master, master.address)));
            // eslint-disable-next-line no-console
            console.log(`seed ${seed}: ${log.length} txs, ${accruals} accruals, accrued ${rd.accrued}, claimed ${claimedAll}, ` +
                `buybacks ${bs.count}, burned ${bs.burned}`);
        });
    }

    it('buyback and burn: auto-run on a tax payout, supply decreases, interval / cap / minimum enforced, gas paid from the bucket within its cap', async () => {
        const { master, key, pool } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, buybackBps: 10000n });
        const taxPays = (r: SendMessageResult) => gramPayouts(r, master.address).filter((x) => x.reason === REASON.TAX).map((x) => [x.amount, x.value]);
        const into = (r: SendMessageResult) => splitEvents(r.transactions).reduce((x, sp) => x + sp.buyback + sp.extra, 0n);
        // Below TAX_MIN_PAYOUT (0.1 Gram) the tax stays in the pool: no payout, no split.
        let res = await buy(holders[0], key, toNano('1'));
        expectNoFailures(res);
        expect([taxPays(res), splitEvents(res.transactions).length]).toEqual([[], 0]);
        expect((await pool.getGetPoolState()).taxFees).toBe(toNano('0.05'));
        let st = await master.getGetBuybackStatus();
        expect([st.balance, st.wouldRun, st.cap]).toEqual([0n, false, toNano('26')]);
        // The swap that brings it to the threshold pays the whole accrued tax to the master, which splits it there.
        res = await buy(holders[0], key, toNano('1'));
        expectNoFailures(res);
        expect(taxPays(res)).toEqual([[toNano('0.1'), toNano('0.1') + C.TAX_PAYOUT_GAS]]);
        const [sp0] = splitEvents(res.transactions);
        expect([sp0.amount, sp0.buyback]).toEqual([toNano('0.1'), toNano('0.1')]);
        expect((await pool.getGetPoolState()).taxFees).toBe(0n);
        st = await master.getGetBuybackStatus();
        expect([st.count, st.wouldRun]).toEqual([0n, false]);   // bucket < BUYBACK_MIN + BUYBACK_GAS
        const bal0 = st.balance;
        // A 600 Gram buy: 30 Gram of tax, paid in the swap; the payout runs the buyback (capped) in the same chain.
        const supply0 = (await master.getGetJettonData()).totalSupply;
        res = await buy(holders[1], key, toNano('600'));
        expectNoFailures(res);
        const bb = events(res).filter((e) => e.op === OPS.buyback).map((e) => loadBuybackEvent(e.body.clone()));
        const burns = events(res).filter((e) => e.op === OPS.burn).map((e) => loadBurnEvent(e.body.clone()));
        expect(bb.length).toBe(1);
        expect(bb[0].amount).toBe(toNano('26'));   // capped at 1% of the start market cap
        const sw = swapEvents(res).filter((e) => e.fromUser.equals(master.address));
        expect(sw.length).toBe(1);
        // The buyback swap pays the buy tax and the platform fee like any buy; its tax comes straight back (split again).
        expect([sw[0].amountIn, sw[0].tax, sw[0].platformFee]).toEqual([toNano('26'), toNano('1.3'), toNano('0.26')]);
        expect(taxPays(res).map((x) => x[0])).toEqual([toNano('30'), toNano('1.3')]);
        expect(splitEvents(res.transactions).map((x) => x.amount)).toEqual([toNano('30'), toNano('1.3')]);
        expect(burns.map((b) => b.amount)).toEqual([sw[0].amountOut]);
        const jd = await master.getGetJettonData();
        expect(jd.totalSupply).toBe(supply0 - sw[0].amountOut);
        expect(await jBal(master, master.address)).toBe(0n);
        st = await master.getGetBuybackStatus();
        expect([st.burned, st.spent, st.count, st.nextAllowedAt]).toEqual([sw[0].amountOut, toNano('26'), 1n, BigInt(T0 + C.INTERVAL)]);
        // Bucket: in = splits (tax + gas leftovers); out = amount + the buyback chain's net gas (<= BUYBACK_GAS).
        const netGas = bal0 + into(res) - toNano('26') - st.balance;
        expect(netGas).toBeGreaterThan(0n);
        expect(netGas).toBeLessThanOrEqual(C.BUYBACK_GAS);
        // eslint-disable-next-line no-console
        console.log(`buyback 26 Gram: tokens burned ${sw[0].amountOut}, bucket after ${st.balance}, buyback chain net gas ${netGas} (BUYBACK_GAS ${C.BUYBACK_GAS})`);

        // Interval: another payout within 300 s does not buy back; the manual trigger is rejected.
        res = await buy(holders[3], key, toNano('100'));
        expectNoFailures(res);
        expect(splitEvents(res.transactions).map((x) => x.amount)).toEqual([toNano('5')]);
        st = await master.getGetBuybackStatus();
        expect(st.count).toBe(1n);
        expect(st.wouldRun).toBe(false);
        const bal1 = st.balance;
        let r = await master.send(mallory.getSender(), { value: toNano('0.05') }, { $$type: 'Buyback', queryId: 1n });
        expect(r.transactions).toHaveTransaction({ to: master.address, success: false });
        expect((await master.getGetBuybackStatus()).balance).toBe(bal1);
        // After the interval: the manual trigger runs it, refunds the caller's whole value, charges KEEPER_FEE.
        chain.now = T0 + C.INTERVAL;
        st = await master.getGetBuybackStatus();
        expect(st.wouldRun).toBe(true);
        const mb = await balOf(mallory.address);
        const supply1 = (await master.getGetJettonData()).totalSupply;
        r = await master.send(mallory.getSender(), { value: toNano('0.05') }, { $$type: 'Buyback', queryId: 1n });
        expectNoFailures(r);
        const amt2 = events(r).filter((e) => e.op === OPS.buyback).map((e) => loadBuybackEvent(e.body.clone()))[0].amount;
        expect(amt2).toBe(bal1 - C.KEEPER_FEE - C.BUYBACK_GAS < toNano('26') ? bal1 - C.KEEPER_FEE - C.BUYBACK_GAS : toNano('26'));
        expect(st.nextAmount).toBe(amt2 + C.KEEPER_FEE < toNano('26') ? amt2 + C.KEEPER_FEE : toNano('26'));   // status = automatic-run amount
        const after = await master.getGetBuybackStatus();
        // Gas reimbursement never drains more than BUYBACK_GAS + KEEPER_FEE beyond the swapped amount.
        // (The buyback's own buy tax comes back through a split: added back here.)
        const drained = bal1 - after.balance - amt2 + into(r);
        expect(drained).toBeGreaterThan(0n);
        expect(drained).toBeLessThanOrEqual(C.BUYBACK_GAS + C.KEEPER_FEE);
        expect((await master.getGetJettonData()).totalSupply).toBeLessThan(supply1);
        // Caller: refunded its whole attached value (it pays only its own sending fee, which the sandbox does not charge).
        expect(mb - (await balOf(mallory.address))).toBeLessThan(toNano('0.001'));   // only the treasury wallet's own send fee
        const mg = (rr: SendMessageResult) => rr.transactions.filter((tx) => dst(tx)?.equals(master.address))
            .map((tx) => `${opOf(tx)?.toString(16)}:${(tx.description as any).computePhase.gasUsed}`).join(' ');
        // eslint-disable-next-line no-console
        console.log(`master gas (op:gas): payout+auto-buyback chain [${mg(res)}]; manual trigger chain [${mg(r)}]`);
        // eslint-disable-next-line no-console
        console.log(`manual buyback ${amt2}: bucket drained ${drained} beyond the amount (cap ${C.BUYBACK_GAS + C.KEEPER_FEE})`);
        // Minimum: a small bucket never buys back.
        chain.now = T0 + 2 * C.INTERVAL;
        if (after.balance < C.BUYBACK_MIN + C.BUYBACK_GAS + C.KEEPER_FEE) {
            r = await master.send(mallory.getSender(), { value: toNano('0.05') }, { $$type: 'Buyback', queryId: 1n });
            expect(r.transactions).toHaveTransaction({ to: master.address, success: false });
        }
        // Forged notification (not from the master's own wallet): nothing is burned.
        const s2 = (await master.getGetJettonData()).totalSupply;
        await chain.sendMessage(internal({ from: mallory.address, to: master.address, value: toNano('0.1'),
            body: beginCell().storeUint(0x7362d09c, 32).storeUint(0, 64).storeCoins(10n ** 15n).storeAddress(mallory.address).storeBit(0).endCell() }));
        expect((await master.getGetJettonData()).totalSupply).toBe(s2);
    });

    it('keeper bot: Harvest is paid from the bucket (rate-limited), refunds the caller, collects the sub-threshold tax and auto-runs the buyback', async () => {
        const { master, key, pool } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 2000n, buybackBps: 8000n });
        let r0 = await buy(holders[0], key, toNano('200'));       // 10 Gram tax, paid in the swap: 8 into the bucket (< 26 cap, > 1 min) -> buyback runs
        expectNoFailures(r0);
        let st = await master.getGetBuybackStatus();
        expect(st.count).toBe(1n);
        expect(st.harvestDue).toBe(st.balance >= C.HARVEST_VALUE + C.KEEPER_FEE);
        chain.now = T0 + 10;
        expectNoFailures(await buy(holders[1], key, toNano('300')));   // 15 Gram paid and split; inside the interval: no buyback
        expect((await master.getGetBuybackStatus()).count).toBe(1n);
        expectNoFailures(await buy(holders[2], key, toNano('1')));     // 0.05 Gram: below TAX_MIN_PAYOUT, stays in the pool
        const owed = (await pool.getGetPoolState()).taxFees;
        expect(owed).toBe(toNano('0.05'));
        // harvestLast = 0, so the first harvest is due right away; the buyback is due after the interval.
        chain.now = T0 + C.INTERVAL;
        st = await master.getGetBuybackStatus();
        expect([st.harvestDue, st.wouldRun]).toEqual([true, true]);
        const bot = holders[4];
        const bb = await balOf(bot.address);
        const bal0 = st.balance;
        const res = await master.send(bot.getSender(), { value: toNano('0.03') }, { $$type: 'Harvest', queryId: 5n });
        expectNoFailures(res);
        // The harvested tax, then (in the buyback swap the payout triggered) the buyback's own buy tax.
        const bbSwap = swapEvents(res).filter((e) => e.fromUser.equals(master.address));
        expect(bbSwap.length).toBe(1);
        expect(gramPayouts(res, master.address).filter((x) => x.reason === REASON.TAX).map((x) => x.amount)).toEqual([owed, bbSwap[0].tax]);
        expect((await pool.getGetPoolState()).taxFees).toBe(0n);
        expect(bb - (await balOf(bot.address))).toBeLessThan(toNano('0.001'));   // whole value refunded: the bot pays only its own send fee
        st = await master.getGetBuybackStatus();
        expect(st.count).toBe(2n);                      // the payout ran the buyback
        const [sp] = splitEvents(res.transactions);
        expect(sp.amount).toBe(owed);
        expect(st.nextHarvestAt).toBe(BigInt(T0 + C.INTERVAL + C.HARVEST_INTERVAL));
        // A second harvest inside the interval is rejected (the bot can read harvestDue first).
        expect(st.harvestDue).toBe(false);
        const r2 = await master.send(bot.getSender(), { value: toNano('0.03') }, { $$type: 'Harvest', queryId: 6n });
        expect(r2.transactions).toHaveTransaction({ to: master.address, success: false });
        // eslint-disable-next-line no-console
        console.log(`harvest: bucket ${bal0} -> ${st.balance}, split buyback ${sp.buyback} + extra ${sp.extra}, buybacks ${st.count}`);

        // Drain bound, on a token whose buyback pays no tax (sell tax only): a due harvest that finds no tax
        // costs the bucket at most HARVEST_VALUE + KEEPER_FEE, and in practice only the fees.
        const t2 = await launch({ buyTaxBps: 0n, sellTaxBps: 500n, buybackBps: 10000n });
        await chain.sendMessage(internal({ from: mallory.address, to: t2.master.address, value: toNano('3'),
            body: beginCell().store(storeGramPayoutL({ $$type: 'GramPayout', queryId: 0n, reason: 14n, amount: toNano('3'), payload: null })).endCell() }));
        const s2 = await t2.master.getGetBuybackStatus();
        expect(s2.count).toBe(1n);
        expect(s2.harvestDue).toBe(true);
        const r3 = await t2.master.send(bot.getSender(), { value: toNano('0.03') }, { $$type: 'Harvest', queryId: 7n });
        expectNoFailures(r3);
        // eslint-disable-next-line no-console
        console.log(`harvest chains master gas: [${res.transactions.filter((tx) => dst(tx)?.equals(master.address)).map((tx) => `${opOf(tx)?.toString(16)}:${(tx.description as any).computePhase.gasUsed}`).join(' ')}] ` +
            `[${r3.transactions.filter((tx) => dst(tx)?.equals(t2.master.address)).map((tx) => `${opOf(tx)?.toString(16)}:${(tx.description as any).computePhase.gasUsed}`).join(' ')}]`);
        const s3 = await t2.master.getGetBuybackStatus();
        expect(s3.count).toBe(1n);
        const cost = s2.balance - s3.balance;
        expect(cost).toBeGreaterThan(0n);
        expect(cost).toBeLessThanOrEqual(C.HARVEST_VALUE + C.KEEPER_FEE);
        // eslint-disable-next-line no-console
        console.log(`harvest with no tax: bucket cost ${cost} (cap ${C.HARVEST_VALUE + C.KEEPER_FEE})`);
    });

    it('buyback uses the DEX max crossings with allowPartial: BUYBACK_GAS covers the Router minimum for it (launch key: platform payout; taxed: tax payout)', async () => {
        // Router swapGas(maxCrossings = 24, allowPartial) on a (taxed) launch key + fwdTon (BURN_FWD), from the DEX constants file.
        expect(D('MAX_CROSSINGS_CAP')).toBe(24n);
        const plain = D('SWAP_BASE_GAS') + 24n * D('CROSS_GAS') + D('JETTON_PAYOUT_VALUE');
        const launchKey = plain + D('PAYOUT_MSG_GAS');                                   // platform fee payout
        const taxedKey = launchKey + D('PAYOUT_MSG_GAS') + D('TAX_PAYOUT_GAS');          // + tax auto-payout
        // ... and the Router's own getter agrees, on real launch keys.
        const untaxed = await launch({});
        const taxed = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, buybackBps: 10000n });
        expect(await router.getGetSwapGas(24n, true, 0n, untaxed.key.ext, true)).toBe(launchKey);
        expect(await router.getGetSwapGas(24n, true, 0n, taxed.key.ext, true)).toBe(taxedKey);
        const need = taxedKey + C.BURN_FWD;
        const margin = C.BUYBACK_GAS - need;
        // eslint-disable-next-line no-console
        console.log(`BUYBACK_GAS ${C.BUYBACK_GAS}: Router minimum on a taxed launch key ${taxedKey} + BURN_FWD ${C.BURN_FWD} = ${need}, margin ${margin} (before 2 forward fees)`);
        expect(margin).toBeGreaterThanOrEqual(toNano('0.1'));
        // In practice: a due buyback at exactly bucket = BUYBACK_GAS + BUYBACK_MIN on the taxed key is not refunded by the Router.
        await chain.sendMessage(internal({ from: mallory.address, to: taxed.master.address, value: C.BUYBACK_MIN + C.BUYBACK_GAS + C.TAX_IN_GAS,
            body: beginCell().store(storeGramPayoutL({ $$type: 'GramPayout', queryId: 0n, reason: 14n, amount: C.BUYBACK_MIN + C.BUYBACK_GAS, payload: null })).endCell() }));
        // (the forged payout above credited the bucket, and that was the auto-run; check it was a real swap)
        const st = await taxed.master.getGetBuybackStatus();
        expect(st.count).toBe(1n);
        expect(st.burned).toBeGreaterThan(0n);
    });

    it('dust LP ticks above the price cannot block the buyback (24 crossings, allowPartial): on spacing 10 it crosses them all and fills', async () => {
        // Default spacing-10 launch. The first payout runs a buyback right away; the next one is due after the interval.
        const { master, key, pool } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, buybackBps: 10000n });
        expectNoFailures(await buy(holders[0], key, toNano('200')));      // 10 Gram tax -> first buyback (count 1)
        expectNoFailures(await buy(holders[1], key, toNano('600')));      // 30 Gram more into the bucket (> 26 cap), inside the interval
        expect((await master.getGetBuybackStatus()).count).toBe(1n);
        // Griefer: 30 adjacent one-spacing jetton-only positions just below the current tick, on the buyback's path (31 initialized ticks).
        const ps0 = await pool.getGetPoolState();
        const top = ps0.tick - (((ps0.tick % 10n) + 10n) % 10n) - 10n;
        const w = await walletOf(master, holders[0].address);
        for (let i = 0n; i < 30n; i++) {
            const mp = beginCell().store(storeMintPayload({
                $$type: 'MintPayload', otherToken: GRAM, tickSpacing: key.tickSpacing, ext: key.ext, tickLower: top - 10n * i - 10n, tickUpper: top - 10n * i,
                gramAmount: 0n, viaAccount: false, sqrtPriceInitX96: 0n, minLiquidity: 0n, owner: null, refundTo: null,
                deadline: BigInt(chain.now! + 600), sqrtPriceMinX96: 0n, sqrtPriceMaxX96: 0n,
            })).endCell();
            const r = await w.send(holders[0].getSender(), { value: toNano('0.9') }, {
                $$type: 'JettonTransfer', queryId: 4n, amount: toNano('1'), destination: router.address, responseDestination: holders[0].address,
                customPayload: null, forwardTonAmount: toNano('0.8'), forwardPayload: beginCell().storeBit(1).storeRef(mp).endCell().beginParse(),
            });
            expectNoFailures(r);
        }
        expect((await pool.getGetPoolState()).tickCount - ps0.tickCount).toBe(31n);
        // The old setting (4 crossings, no partial) is refunded on this pool.
        const old = await router.send(mallory.getSender(), { value: toNano('26.7') }, { ...swapNativeBody(key, toNano('26')), maxCrossings: 4n });
        expect(refundCodes(old)).toEqual([CODES.PARTIAL_NOT_ALLOWED]);
        chain.now = T0 + C.INTERVAL;
        const { balance: bal0, spent: spent0, burned: burned0 } = await master.getGetBuybackStatus();
        const supply0 = (await master.getGetJettonData()).totalSupply;
        const res = await master.send(mallory.getSender(), { value: toNano('0.05') }, { $$type: 'Buyback', queryId: 1n });
        expectNoFailures(res);
        const sw = swapEvents(res).filter((e) => e.fromUser.equals(master.address));
        expect(sw.length).toBe(1);
        expect(sw[0].amountOut).toBeGreaterThan(0n);
        // On spacing 10 a capped buyback (1% of the start mcap) moves the price by at most ~2% (~200 ticks) even
        // at the start price, so it can cross at most ~20 initialized ticks: below BUYBACK_CROSSINGS (24), it
        // always fills completely (allowPartial stays as the safety net for any denser case).
        expect(sw[0].crossings).toBeGreaterThanOrEqual(10n);
        expect(sw[0].crossings).toBeLessThan(24n);
        expect(gramPayouts(res, master.address).filter((x) => x.reason === REASON.PARTIAL_REFUND)).toEqual([]);
        expect(sw[0].amountIn).toBe(toNano('26'));
        const burns = events(res).filter((e) => e.op === OPS.burn).map((e) => loadBurnEvent(e.body.clone()));
        expect(burns.map((b) => b.amount)).toEqual([sw[0].amountOut]);
        expect((await master.getGetJettonData()).totalSupply).toBe(supply0 - sw[0].amountOut);
        const st = await master.getGetBuybackStatus();
        expect([st.count, st.spent, st.burned]).toEqual([2n, spent0 + toNano('26'), burned0 + sw[0].amountOut]);
        expect(st.balance).toBeGreaterThan(bal0 - toNano('26') - C.BUYBACK_GAS - C.KEEPER_FEE);
        // eslint-disable-next-line no-console
        console.log(`buyback past 30 dust positions (spacing 10): swapped ${sw[0].amountIn}, crossings ${sw[0].crossings}, burned ${sw[0].amountOut}`);
    });

    it('Harvest works on every split: caller-paid (>= HARVEST_VALUE + KEEPER_FEE, rest refunded, 60 s spacing) when the bucket cannot pay', async () => {
        const bot = holders[4];
        const HV = C.HARVEST_VALUE + C.KEEPER_FEE;
        const harvest = (m: SandboxContract<LaunchJetton>, value: bigint, q = 5n) => m.send(bot.getSender(), { value }, { $$type: 'Harvest', queryId: q });
        // Untaxed token: nothing to harvest.
        const t0 = await launch();
        expect((await harvest(t0.master, toNano('0.5'))).transactions).toHaveTransaction({ to: t0.master.address, success: false });

        // "Holders" split (no buyback bucket at all).
        const { master, key, pool } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 10000n });
        expect(await master.getGetHarvestValue()).toBe(HV);
        // 10 Gram of tax is paid in the swap itself; Harvest is for what stays below TAX_MIN_PAYOUT.
        const rb = await buy(holders[0], key, toNano('200'));
        expect(splitEvents(rb.transactions).map((x) => x.amount)).toEqual([toNano('10')]);
        await buy(holders[0], key, toNano('1.5'));
        let owed = (await pool.getGetPoolState()).taxFees;
        expect(owed).toBe(toNano('0.075'));
        expect((await harvest(master, toNano('0.03'))).transactions).toHaveTransaction({ to: master.address, success: false });
        expect((await harvest(master, HV - 1n)).transactions).toHaveTransaction({ to: master.address, success: false });
        const b0 = await balOf(bot.address);
        let res = await harvest(master, toNano('1'));
        expectNoFailures(res);
        expect(gramPayouts(res, master.address).filter((x) => x.reason === REASON.TAX).map((x) => x.amount)).toEqual([owed]);
        const cost = b0 - (await balOf(bot.address));
        expect(cost).toBeLessThanOrEqual(HV + toNano('0.002'));      // the bot pays at most HARVEST_VALUE + KEEPER_FEE
        expect(cost).toBeGreaterThanOrEqual(HV - toNano('0.001'));
        const [sp] = splitEvents(res.transactions);
        expect([sp.amount, sp.rewards]).toEqual([owed, owed]);
        expect((await master.getGetRewardsData()).accrued).toBeGreaterThanOrEqual(sp.rewards);
        expect((await pool.getGetPoolState()).taxFees).toBe(0n);
        // 60 s spacing between caller-paid harvests.
        await buy(holders[1], key, toNano('1'));
        expect((await harvest(master, toNano('1'))).transactions).toHaveTransaction({ to: master.address, success: false });
        let st = await master.getGetBuybackStatus();
        expect(st.nextCallerHarvestAt).toBe(BigInt(T0 + 60));
        chain.now = T0 + 60;
        owed = (await pool.getGetPoolState()).taxFees;
        expect(owed).toBe(toNano('0.05'));
        res = await harvest(master, toNano('1'));
        expectNoFailures(res);
        expect(gramPayouts(res, master.address).filter((x) => x.reason === REASON.TAX).map((x) => x.amount)).toEqual([owed]);
        // eslint-disable-next-line no-console
        console.log(`caller-paid harvest (holders split): bot cost ${cost}, master gas [${res.transactions.filter((tx) => dst(tx)?.equals(master.address)).map((tx) => `${opOf(tx)?.toString(16)}:${(tx.description as any).computePhase.gasUsed}`).join(' ')}]`);

        // Wallet split: the tax wallet is paid by a caller-paid harvest.
        const tw = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, walletBps: 10000n, taxWallet: mallory.address });
        await buy(holders[0], tw.key, toNano('1'));
        owed = (await tw.pool.getGetPoolState()).taxFees;
        expect(owed).toBe(toNano('0.05'));
        res = await harvest(tw.master, toNano('0.3'));
        expectNoFailures(res);
        const paid = comments(res.transactions, tw.master.address, mallory.address, 'Marg tax');
        expect(paid.length).toBe(1);
        expect(paid[0]).toBeGreaterThanOrEqual(owed);

        // Buyback split: bucket-paid when due (caller refunded); inside HARVEST_INTERVAL a caller-paid
        // harvest still works after 60 s and does not charge the bucket.
        const tb = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 5000n, buybackBps: 5000n });
        expectNoFailures(await buy(holders[0], tb.key, toNano('200')));   // 10 Gram paid in the swap: 5 into the bucket, buyback runs
        expect((await tb.master.getGetBuybackStatus()).count).toBe(1n);
        await buy(holders[1], tb.key, toNano('200'));
        st = await tb.master.getGetBuybackStatus();
        expect(st.harvestDue).toBe(true);
        const B = chain.now!;
        let bb = await balOf(bot.address);
        expectNoFailures(await harvest(tb.master, toNano('0.03')));   // bucket-paid, caller's 0.03 refunded
        expect(bb - (await balOf(bot.address))).toBeLessThan(toNano('0.001'));
        st = await tb.master.getGetBuybackStatus();
        expect(st.harvestDue).toBe(false);
        await buy(holders[2], tb.key, toNano('200'));
        await buy(holders[2], tb.key, toNano('1'));         // 0.05 Gram left in the pool for the next harvest
        expect((await harvest(tb.master, toNano('0.5'))).transactions).toHaveTransaction({ to: tb.master.address, success: false });  // < 60 s
        chain.now = B + 60;
        expect((await harvest(tb.master, toNano('0.03'))).transactions).toHaveTransaction({ to: tb.master.address, success: false });  // bucket not due, too little attached
        const bal0 = st.balance;
        owed = (await tb.pool.getGetPoolState()).taxFees;
        expect(owed).toBe(toNano('0.05'));
        bb = await balOf(bot.address);
        res = await harvest(tb.master, toNano('0.5'));
        expectNoFailures(res);
        expect(gramPayouts(res, tb.master.address).filter((x) => x.reason === REASON.TAX).map((x) => x.amount)).toEqual([owed]);
        expect(bb - (await balOf(bot.address))).toBeLessThanOrEqual(HV + toNano('0.002'));
        st = await tb.master.getGetBuybackStatus();
        expect(st.balance).toBeGreaterThan(bal0);           // the bucket only gained (its buyback share + gas leftover)
        expect(st.nextHarvestAt).toBe(BigInt(B + 60 + C.HARVEST_INTERVAL));
    });

    it('sandwich bound: a capped buyback moves the price ~2% at most; front-run + back-run loses money to fees and taxes', async () => {
        const { master, key, pool } = await launch({ buyTaxBps: 100n, sellTaxBps: 100n, buybackBps: 10000n });
        await buy(holders[0], key, toNano('2000'));      // 20 Gram of tax, paid in the swap: the first buyback runs at once
        expect((await master.getGetBuybackStatus()).count).toBe(1n);
        await buy(holders[1], key, toNano('3000'));      // 30 more: the bucket holds > 26 (cap), the next buyback is due at T0 + 300
        chain.now = T0 + C.INTERVAL;
        const att = mallory;
        const g0 = await balOf(att.address);
        // Front-run: the attacker's own buy pays 5 Gram of tax, which runs the due buyback right behind it.
        const res = await buy(att, key, toNano('500'));
        expectNoFailures(res);
        expect((await master.getGetBuybackStatus()).count).toBe(2n);
        const evs = swapEvents(res);
        expect(evs.length).toBe(2);
        expect([evs[0].fromUser.equals(att.address), evs[1].fromUser.equals(master.address), evs[1].amountIn]).toEqual([true, true, toNano('26')]);
        const p0 = evs[0].sqrtPriceX96, p1 = evs[1].sqrtPriceX96;
        const impact = Number(p0 * p0 - p1 * p1) / Number(p0 * p0);    // Gram price up = jetton-per-Gram sqrt price down
        expect(impact).toBeGreaterThan(0);
        expect(impact).toBeLessThan(0.025);
        await sell(att, master, key, await jBal(master, att.address));   // back-run
        const pnl = (await balOf(att.address)) - g0;
        expect(pnl).toBeLessThan(0n);
        expect((await pool.getGetPoolState()).initialized).toBe(true);
        // eslint-disable-next-line no-console
        console.log(`sandwich around a 26 Gram buyback at ~2.6k mcap: price impact ${(impact * 100).toFixed(2)}%, attacker PnL ${pnl} (500 Gram in)`);
    });

    it('no-tax token: plain wallets, no master in a transfer chain; gas of a transfer with and without rewards', async () => {
        const plain = await launch({});
        const taxed = await launch({ buyTaxBps: 300n, sellTaxBps: 300n, rewardsBps: 10000n });
        const [a, b] = holders;
        await buy(a, plain.key, toNano('50'));
        await buy(a, taxed.key, toNano('50'));
        await buy(b, taxed.key, toNano('5'));
        const plainW = await walletOf(plain.master, a.address);
        expect(await plainW.getGetTracked()).toBe(false);
        expect((await plain.master.getGetRewardsData()).totalShares).toBe(0n);
        const measure = async (master: SandboxContract<LaunchJetton>) => {
            const res = await transfer(master, a, b.address, 1000n);
            expectNoFailures(res);
            const fees = res.transactions.slice(1).reduce((x, tx) => x + tx.totalFees.coins, 0n);
            const gas = (addr: Address) => res.transactions.filter((tx) => dst(tx)?.equals(addr))
                .map((tx) => ((tx.description as any).computePhase.gasUsed as bigint));
            const fwd = res.transactions.slice(1).reduce((x, tx) => x + [...tx.outMessages.values()]
                .reduce((y, m) => y + (m.info.type === 'internal' ? m.info.forwardFee : 0n), 0n), 0n);
            return { res, fees, fwd, n: res.transactions.length - 1, gas, master };
        };
        // The value a transfer needs: unchanged for plain wallets; + 2 checkpoints for tracked -> tracked.
        let low = await transfer(plain.master, a, b.address, 1000n, toNano('0.06'));
        expectNoFailures(low);
        low = await transfer(taxed.master, a, b.address, 1000n, toNano('0.1'));
        expect(low.transactions).toHaveTransaction({ to: (await walletOf(taxed.master, a.address)).address, success: false });
        const p = await measure(plain.master);
        const t = await measure(taxed.master);
        expect(p.res.transactions.some((tx) => dst(tx)?.equals(plain.master.address))).toBe(false);
        expect(t.res.transactions.filter((tx) => dst(tx)?.equals(taxed.master.address)).length).toBe(2);   // two checkpoints
        const wa = await walletOf(taxed.master, a.address), wb = await walletOf(taxed.master, b.address);
        const pa = await walletOf(plain.master, a.address), pb = await walletOf(plain.master, b.address);
        // The round trip must stay well under CHECKPOINT_VALUE (1.5x margin).
        const cpTx = t.res.transactions.filter((tx) => dst(tx)?.equals(taxed.master.address));
        const ackTx = t.res.transactions.filter((tx) => opOf(tx) === OPS.ack);
        // At the mainnet basis of 400 nanoGram/gas (the sandbox charges ~66.7): gas * 400 + forward fees, x1.5 margin.
        const g = (tx: BlockchainTransaction) => BigInt((tx.description as any).computePhase.gasUsed);
        const roundTrip = (g(cpTx[0]) + g(ackTx[0])) * 400n + toNano('0.0015');
        expect(roundTrip * 3n / 2n).toBeLessThanOrEqual(C.CHECKPOINT_VALUE);
        // eslint-disable-next-line no-console
        console.log([
            `transfer, no rewards: ${p.n} txs, gas sender ${p.gas(pa.address)} receiver ${p.gas(pb.address)}, fees+fwd ${p.fees + p.fwd}`,
            `transfer, rewards on: ${t.n} txs, gas sender ${t.gas(wa.address)} receiver ${t.gas(wb.address)} master ${t.gas(taxed.master.address)}, fees+fwd ${t.fees + t.fwd}`,
            `checkpoint round trip at 400 nanoGram/gas ${roundTrip} (CHECKPOINT_VALUE ${C.CHECKPOINT_VALUE})`,
        ].join('\n'));
        // Claim gas.
        await collect(taxed.key);
        const c = await claim(taxed.master, a);
        expectNoFailures(c);
        // eslint-disable-next-line no-console
        console.log(`claim: wallet ${c.transactions.filter((tx) => dst(tx)?.equals(wa.address)).map((tx) => (tx.description as any).computePhase.gasUsed)}, ` +
            `master ${c.transactions.filter((tx) => dst(tx)?.equals(taxed.master.address)).map((tx) => (tx.description as any).computePhase.gasUsed)}, ` +
            `fees ${c.transactions.slice(1).reduce((x, tx) => x + tx.totalFees.coins, 0n)}`);
    });

    // -----------------------------------------------------------------------
    // Anti-snipe fee per launch
    // -----------------------------------------------------------------------

    it('anti-snipe off: no extra fee at t0; the key carries 0/0', async () => {
        const { key, pool, master } = await launch({});
        const info = await master.getGetLaunchInfo();
        expect([info.launchFeePips, info.launchDuration]).toEqual([0n, 0n]);
        const st = await pool.getGetPoolState();
        expect(st.feePipsNow).toBeLessThanOrEqual(10000n + 30000n);   // the base 1% (+ variable), no launch extra
        const r = await buy(holders[0], key, toNano('10'));
        expectNoFailures(r);
        expect(swapEvents(r)[0].amountOut).toBeGreaterThan((toNano('10') * SUPPLY / toNano('2600')) * 97n / 100n);
    });

    it('anti-snipe 15% over 15 s: decays to 0; the dev buy is exempt', async () => {
        const { res, key, pool, master } = await launch({ antiSnipePips: 150000n, antiSnipeDuration: 15n, devBuy: toNano('10') });
        expect(swapEvents(res)[0].amountOut).toBeGreaterThan((toNano('10') * SUPPLY / toNano('2600')) * 97n / 100n);   // exempt
        const f0 = (await pool.getGetPoolState()).feePipsNow;
        chain.now = T0 + 15;
        const f1 = (await pool.getGetPoolState()).feePipsNow;
        expect(f0 - f1).toBeGreaterThanOrEqual(140000n);
        const info = await master.getGetLaunchInfo();
        expect([info.launchFeePips, info.launchDuration]).toEqual([150000n, 15n]);
        expect(key.ext).not.toBeNull();
    });

    it('anti-snipe 90% over 15 s (needs the DEX cap at 90%; otherwise the DEX refunds the launch)', async () => {
        const res = await create({ antiSnipePips: 900000n, antiSnipeDuration: 15n, devBuy: toNano('10') });
        expectNoFailures(res);
        const { master, key, pool } = await opened(0n);
        if (refundCodes(res).length > 0) {
            // dex/v2 build still has MAX_LAUNCH_FEE_PIPS = 20%: the Router refunds the launch.
            // eslint-disable-next-line no-console
            console.warn('SKIPPED (partially): dex/v2 build still caps the launch fee at 20%; the 90% launch was refunded as documented.');
            expect((await pool.getGetPoolState()).initialized).toBe(false);
            return;
        }
        const devOut = swapEvents(res)[0].amountOut;
        expect(devOut).toBeGreaterThan((toNano('10') * SUPPLY / toNano('2600')) * 97n / 100n);   // dev buy exempt
        const r1 = await buy(holders[0], key, toNano('10'));                                         // t0: ~90% fee
        const out1 = swapEvents(r1)[0].amountOut;
        expect(out1).toBeLessThan(devOut / 5n);
        chain.now = T0 + 15;
        const r2 = await buy(holders[1], key, toNano('10'));                                         // after 15 s: base fee only
        expect(swapEvents(r2)[0].amountOut).toBeGreaterThan(out1 * 5n);
        expect((await master.getGetLaunchInfo()).launchFeePips).toBe(900000n);
    });

    it('anti-snipe 90% / 1 h: no buyback inside the window (bucket keeps filling); the first one runs after it ends', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, buybackBps: 10000n, antiSnipePips: 900000n, antiSnipeDuration: 3600n });
        const info = await master.getGetLaunchInfo();
        expect([info.launchFeePips, info.launchDuration]).toEqual([900000n, 3600n]);
        const bbEvents = (r: SendMessageResult) => events(r).filter((e) => e.op === OPS.buyback);
        // 600 Gram buy at t0: 30 Gram of tax into the bucket (> cap 26 + gas), but no buyback.
        let res = await buy(holders[0], key, toNano('600'));
        expectNoFailures(res);
        expect(splitEvents(res.transactions).map((x) => x.buyback)).toEqual([toNano('30')]);
        expect(bbEvents(res)).toEqual([]);
        let st = await master.getGetBuybackStatus();
        expect(st.count).toBe(0n);
        expect(st.balance).toBeGreaterThan(toNano('26') + C.BUYBACK_GAS + C.KEEPER_FEE);
        expect(st.wouldRun).toBe(false);
        let r = await master.send(mallory.getSender(), { value: toNano('0.05') }, { $$type: 'Buyback', queryId: 1n });
        expect(r.transactions).toHaveTransaction({ to: master.address, success: false });
        // Late in the window (fee still > 0): another taxed buy, still no buyback.
        chain.now = T0 + 3599;
        res = await buy(holders[1], key, toNano('200'));
        expectNoFailures(res);
        expect(splitEvents(res.transactions).length).toBeGreaterThan(0);
        expect(bbEvents(res)).toEqual([]);
        expect((await master.getGetBuybackStatus()).count).toBe(0n);
        r = await master.send(mallory.getSender(), { value: toNano('0.05') }, { $$type: 'Buyback', queryId: 1n });
        expect(r.transactions).toHaveTransaction({ to: master.address, success: false });
        // Window over: due; the trigger runs a capped buyback that pays only the base fee.
        chain.now = T0 + 3600;
        st = await master.getGetBuybackStatus();
        expect(st.wouldRun).toBe(true);
        const supply = (await master.getGetJettonData()).totalSupply;
        r = await master.send(mallory.getSender(), { value: toNano('0.05') }, { $$type: 'Buyback', queryId: 1n });
        expectNoFailures(r);
        const bb = bbEvents(r).map((e) => loadBuybackEvent(e.body.clone()));
        expect(bb.length).toBe(1);
        expect(bb[0].amount).toBe(toNano('26'));
        const sw = swapEvents(r).filter((e) => e.fromUser.equals(master.address));
        expect(sw.length).toBe(1);
        expect((await master.getGetJettonData()).totalSupply).toBe(supply - sw[0].amountOut);
        expect((await master.getGetBuybackStatus()).count).toBe(1n);
    });
});
