// Observation and notifying ops (DESIGN.md §6.14): PoolObserve against the reference model and the
// getters (spot, TWAP accumulator extrapolated to now, fee growth inside with v3's uninitialized-tick
// rule), min-value refusal, pure-read; PositionDecreaseNotify (BurnReceipt == model burn, notified
// jetton leg, failure and bounce receipts, ordering); notifying mints (MintReceipt == model mint,
// notified refunds, Pool and Router refusals, gas minimums). Old messages are covered, unchanged, by
// the other suites.

import { Address, beginCell, Cell, toNano } from '@ton/core';
import { BlockchainTransaction, createShardAccount, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, CODES, REASON, Pool, Position, expectNoFailures, modifyEvents, refundCodes, gramPayouts, simOf,
    expectPoolEquals, allTicks, msg, stepN, drain, failedAt, rng, gasAt, eitherRef,
    storePoolObserve, loadPoolObservation, loadBurnReceipt, loadMintReceipt, storePositionDecreaseNotify,
    storeMintNotifyPayload, storeMintNativeNotify, storePositionSyncNotify,
} from './helpers';
import { TestHook } from '../build/TestHook_TestHook';
import * as M from './model';

jest.setTimeout(900000);

const OPN = {
    PoolObserve: 0x4d480081, PoolObservation: 0x4d480082, BurnReceipt: 0x4d480083, MintReceipt: 0x4d480084,
    PoolBurnNotify: 0x4d48004a, PositionSyncNotify: 0x4d48004b, JettonNotification: 0x7362d09c, JettonExcesses: 0xd53276db,
};
const OBSERVE_VALUE = toNano('0.03');
const NOTIFY_FWD_TON = toNano('0.01');
const DECREASE_NOTIFY_GAS = toNano('0.3');
const MINT_GAS = toNano('0.6');
const MINT_NOTIFY_GAS = toNano('0.05');
const NANO_PER_GAS = 400n;
const BURN_BOUNCED = 233;

const dst = (tx: BlockchainTransaction) => (tx.inMessage?.info.dest instanceof Address ? tx.inMessage.info.dest : null);
const src = (tx: BlockchainTransaction) => (tx.inMessage?.info.src instanceof Address ? tx.inMessage.info.src : null);
const opOf = (tx: BlockchainTransaction) => {
    const b = tx.inMessage?.body.beginParse();
    return b && b.remainingBits >= 32 ? b.preloadUint(32) : -1;
};
function txsTo(res: { transactions: BlockchainTransaction[] }, to: Address, op: number) {
    return res.transactions.filter((tx) => dst(tx)?.equals(to) && opOf(tx) === op);
}
function observations(res: SendMessageResult, to: Address) {
    return txsTo(res, to, OPN.PoolObservation).map((tx) => ({ tx, o: loadPoolObservation(tx.inMessage!.body.beginParse()) }));
}
function burnReceipts(res: SendMessageResult, to: Address) {
    return txsTo(res, to, OPN.BurnReceipt).map((tx) => ({ tx, r: loadBurnReceipt(tx.inMessage!.body.beginParse()) }));
}
function mintReceipts(res: SendMessageResult, to: Address) {
    return txsTo(res, to, OPN.MintReceipt).map((tx) => ({ tx, r: loadMintReceipt(tx.inMessage!.body.beginParse()) }));
}
// Jetton notifications delivered to `owner` by its wallet: amount, forward value, sender, queryId.
function jettonNotes(res: SendMessageResult, owner: Address) {
    return txsTo(res, owner, OPN.JettonNotification).map((tx) => {
        const b = tx.inMessage!.body.beginParse();
        b.loadUint(32);
        const queryId = b.loadUintBig(64);
        const amount = b.loadCoins();
        const sender = b.loadAddress();
        const value = tx.inMessage!.info.type === 'internal' ? tx.inMessage!.info.value.coins : 0n;
        return { queryId, amount, sender, value, from: src(tx)! };
    });
}

function observeBody(tL: bigint, tU: bigint, queryId = 9n, payload: Cell | null = null) {
    return beginCell().store(storePoolObserve({ $$type: 'PoolObserve', queryId, tickLower: tL, tickUpper: tU, payload })).endCell();
}
async function observe(d: Dex, pool: SandboxContract<Pool>, from: SandboxContract<TreasuryContract>, tL: bigint, tU: bigint,
                       o: { value?: bigint; queryId?: bigint; payload?: Cell | null } = {}) {
    return d.chain.sendMessage(msg(from.address, pool.address, o.value ?? OBSERVE_VALUE, observeBody(tL, tU, o.queryId ?? 9n, o.payload ?? null)));
}

function decNotifyBody(delta: bigint, o: { queryId?: bigint; deadline: bigint; min0?: bigint; min1?: bigint; recipient?: Address | null }) {
    return beginCell().store(storePositionDecreaseNotify({
        $$type: 'PositionDecreaseNotify', queryId: o.queryId ?? 1n, liquidityDelta: delta, amount0Min: o.min0 ?? 0n,
        amount1Min: o.min1 ?? 0n, deadline: o.deadline, recipient: o.recipient ?? null,
    })).endCell();
}

async function decreaseNotify(d: Dex, pos: SandboxContract<Position>, from: SandboxContract<TreasuryContract>, delta: bigint,
                              o: { queryId?: bigint; deadline?: bigint; min0?: bigint; min1?: bigint; recipient?: Address | null; value?: bigint } = {}) {
    return d.chain.sendMessage(msg(from.address, pos.address, o.value ?? DECREASE_NOTIFY_GAS,
        decNotifyBody(delta, { ...o, deadline: o.deadline ?? d.deadline() })));
}

function mintNotifyPayload(d: Dex, otherToken: Address, tL: bigint, tU: bigint, gramAmount: bigint,
                           o: { sqrtInit?: bigint; minL?: bigint; owner?: Address | null; refundTo?: Address | null; deadline?: bigint; sqrtMin?: bigint; sqrtMax?: bigint } = {}) {
    return beginCell().store(storeMintNotifyPayload({
        $$type: 'MintNotifyPayload', otherToken, tickSpacing: 60n, ext: null, tickLower: tL, tickUpper: tU, gramAmount,
        sqrtPriceInitX96: o.sqrtInit ?? 0n, minLiquidity: o.minL ?? 0n, owner: o.owner ?? null, refundTo: o.refundTo ?? null,
        deadline: o.deadline ?? d.deadline(), sqrtPriceMinX96: o.sqrtMin ?? 0n, sqrtPriceMaxX96: o.sqrtMax ?? 0n,
    })).endCell();
}

async function mintNativeNotify(d: Dex, from: SandboxContract<TreasuryContract>, amount: bigint, tL: bigint, tU: bigint,
                                o: { gas?: bigint; sqrtMin?: bigint; sqrtMax?: bigint; deadline?: bigint; refundTo?: Address | null; owner?: Address | null } = {}) {
    return d.router.send(from.getSender(), { value: amount + (o.gas ?? toNano('0.7')) }, {
        $$type: 'MintNativeNotify', queryId: 77n, amount, otherToken: d.tokA, tickSpacing: 60n, ext: null, tickLower: tL, tickUpper: tU,
        sqrtPriceInitX96: 0n, minLiquidity: 0n, owner: o.owner ?? null, refundTo: o.refundTo ?? null, deadline: o.deadline ?? d.deadline(),
        sqrtPriceMinX96: o.sqrtMin ?? 0n, sqrtPriceMaxX96: o.sqrtMax ?? 0n,
    });
}

// Gram/tokA pool at price 1 with a full-ish base range and two narrower ranges (initialized ticks).
async function setup() {
    const d = await Dex.create();
    const pool = await d.poolOf(GRAM, d.tokA, 60n, null);
    expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -6000n, 6000n, toNano('1000'), { sqrtPriceInit: Q96 }));
    expectNoFailures(await d.mintJetton(d.jA, d.bob, toNano('300'), GRAM, -600n, 600n, toNano('300')));
    expectNoFailures(await d.mintNative(d.carol, toNano('200'), d.tokA, 120n, 2400n));
    return { d, pool };
}

describe('PoolObserve', () => {
    it('equals the reference model and the getters across random swaps and time (spot, TWAP accumulator, fee growth inside)', async () => {
        const { d, pool } = await setup();
        const r = rng(4242);
        // Independent accumulator: Σ tick·dt from the pool's tick after every swap.
        let cum = (await pool.getGetObserve()).tickCumulative;
        let lastT = BigInt(d.now);
        let tick = (await pool.getGetPoolState()).tick;
        const ranges: [bigint, bigint][] = [[-6000n, 6000n], [-600n, 600n], [120n, 2400n], [-600n, 2400n], [120n, 600n]];
        for (let i = 0; i < 24; i++) {
            d.chain.now = d.now + r.int(1, 900);
            cum += tick * (BigInt(d.now) - lastT);
            lastT = BigInt(d.now);
            const zfo = r.next() < 0.5;
            const amt = r.big(toNano('1'), toNano('60'));
            const sw = zfo ? await d.swapNative(d.alice, amt, d.tokA, { allowPartial: true })
                : await d.swapJetton(d.jA, d.alice, amt, GRAM, { allowPartial: true });
            expectNoFailures(sw);
            tick = (await pool.getGetPoolState()).tick;
            d.chain.now = d.now + r.int(0, 300);

            const [tL, tU] = r.pick(ranges);
            const payload = beginCell().storeUint(i, 32).endCell();
            const sim = await simOf(pool);
            const ticks = await allTicks(pool);
            const st = await pool.getGetPoolState();
            const res = await observe(d, pool, d.bob, tL, tU, { queryId: BigInt(1000 + i), payload });
            expectNoFailures(res);
            const obs = observations(res, d.bob.address);
            expect(obs.length).toBe(1);
            const o = obs[0].o;
            expect(o.queryId).toBe(BigInt(1000 + i));
            expect(o.payload!.equals(payload)).toBe(true);
            expect([o.initialized, o.sqrtPriceX96, o.tick, o.liquidity]).toEqual([true, st.sqrtPriceX96, st.tick, st.liquidity]);
            expect(o.time).toBe(BigInt(d.now));
            expect(o.tickCumulative).toBe(cum + tick * (BigInt(d.now) - lastT));
            expect(o.tickCumulative).toBe((await pool.getGetObserve()).tickCumulative);
            const inside = M.feeGrowthInside(ticks, Number(st.tick), Number(tL), Number(tU), sim.fg0, sim.fg1);
            expect([o.tickLower, o.tickUpper, o.rangeOk, o.feeGrowthInside0X128, o.feeGrowthInside1X128]).toEqual([tL, tU, true, inside.a, inside.b]);
            // The getter is the same function.
            const g = await pool.getGetPoolObservation(tL, tU);
            expect([g.tickCumulative, g.feeGrowthInside0X128, g.feeGrowthInside1X128]).toEqual([o.tickCumulative, o.feeGrowthInside0X128, o.feeGrowthInside1X128]);
            // The reply is non-bounceable and carries the remaining value.
            const info: any = obs[0].tx.inMessage!.info;
            expect(info.bounce).toBe(false);
            expect(info.value.coins).toBeGreaterThan(OBSERVE_VALUE / 2n);
            expect(info.value.coins).toBeLessThan(OBSERVE_VALUE);
        }
        // Uncollected fees from the observation == what a collect pays (and the model burn).
        const pos = await d.position(pool, 1n);
        const pd = await pos.getGetPositionData();
        const res = await observe(d, pool, d.bob, pd.tickLower, pd.tickUpper);
        const o = observations(res, d.bob.address)[0].o;
        const fees0 = (pd.liquidity * M.subMod(o.feeGrowthInside0X128, pd.fgLast0)) >> 128n;
        const fees1 = (pd.liquidity * M.subMod(o.feeGrowthInside1X128, pd.fgLast1)) >> 128n;
        const pa = await pool.getGetPositionAmounts(pd.tickLower, pd.tickUpper, pd.liquidity, pd.fgLast0, pd.fgLast1, 0n);
        expect([fees0, fees1]).toEqual([pa.fees0, pa.fees1]);
        expect(fees0 + fees1).toBeGreaterThan(0n);
        const col = await decreaseNotify(d, pos, d.bob, 0n);
        expectNoFailures(col);
        const rc = burnReceipts(col, d.bob.address)[0].r;
        expect([rc.fees0, rc.fees1]).toEqual([fees0, fees1]);
    });

    it('uninitialized ticks and invalid ranges: rangeOk = false and no fee growth (v3 snapshotCumulativesInside rule)', async () => {
        const { d, pool } = await setup();
        await d.swapNative(d.alice, toNano('30'), d.tokA);
        // one tick initialized (-600), the other not (660); neither; bad spacing; reversed; out of bounds
        for (const [tL, tU] of [[-600n, 660n], [-660n, 660n], [-610n, 600n], [600n, -600n], [-887280n, 600n], [600n, 600n]]) {
            const res = await observe(d, pool, d.bob, tL, tU);
            expectNoFailures(res);
            const o = observations(res, d.bob.address)[0].o;
            expect([o.rangeOk, o.feeGrowthInside0X128, o.feeGrowthInside1X128]).toEqual([false, 0n, 0n]);
            expect(o.initialized).toBe(true);
            expect(o.sqrtPriceX96).toBe((await pool.getGetPoolState()).sqrtPriceX96);
        }
        // A range whose ticks were initialized by OTHER positions is a live range: reported.
        const res = await observe(d, pool, d.bob, -600n, 2400n);
        expect(observations(res, d.bob.address)[0].o.rangeOk).toBe(true);
    });

    it('an uninitialized pool answers initialized = false with zero price fields', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(GRAM, d.tokB, 60n, null);
        // deploy the pool without initializing it (a refused mint deploys it)
        await d.mintNative(d.alice, toNano('1'), d.tokB, -60n, 60n);
        expect((await pool.getGetPoolState()).initialized).toBe(false);
        const res = await observe(d, pool, d.bob, -60n, 60n);
        expectNoFailures(res);
        const o = observations(res, d.bob.address)[0].o;
        expect([o.initialized, o.sqrtPriceX96, o.tick, o.liquidity, o.tickCumulative, o.rangeOk, o.time])
            .toEqual([false, 0n, 0n, 0n, 0n, false, BigInt(d.now)]);
    });

    it('below OBSERVE_VALUE the request is refused (bounced); an observation never changes the pool', async () => {
        const { d, pool } = await setup();
        await d.swapNative(d.alice, toNano('30'), d.tokA);
        const sim = await simOf(pool);
        const bal = await d.gram(pool.address);
        const low = await observe(d, pool, d.bob, -600n, 600n, { value: OBSERVE_VALUE - 1n });
        expect(failedAt(low, pool.address).length).toBe(1);
        expect(low.transactions).toHaveTransaction({ from: pool.address, to: d.bob.address, inMessageBounced: true });
        expect(observations(low, d.bob.address).length).toBe(0);
        for (let i = 0; i < 5; i++) expectNoFailures(await observe(d, pool, d.carol, -600n, 600n, { value: toNano('1') }));
        await expectPoolEquals(pool, sim);
        // The pool keeps nothing from an observation (the reply takes the remaining value).
        expect(await d.gram(pool.address)).toBeGreaterThanOrEqual(bal - toNano('0.001'));
        expect(await d.gram(pool.address)).toBeLessThanOrEqual(bal + toNano('0.001'));
    });

    it('gas: OBSERVE_VALUE >= 1.5x (compute at 400 nanoGram/gas + the reply forward fee), on a pool with many ticks', async () => {
        const { d, pool } = await setup();
        for (let i = 0; i < 40; i++) {
            const t = BigInt(-3000 + i * 120);
            expectNoFailures(await d.mintNative(d.carol, toNano('1'), d.tokA, t + 3000n, t + 3600n));
        }
        await d.swapNative(d.alice, toNano('50'), d.tokA);
        const res = await observe(d, pool, d.bob, 120n, 2400n, { payload: beginCell().storeUint(1, 256).storeUint(2, 256).endCell() });
        expectNoFailures(res);
        const gas = gasAt(res, pool.address, OPN.PoolObserve)[0];
        const tx = res.transactions.find((t) => dst(t)?.equals(pool.address))!;
        const fwd = (tx.description as any).actionPhase?.totalFwdFees ?? 0n;
        // eslint-disable-next-line no-console
        if (process.env.PRINT_GAS) console.log('PoolObserve gas', gas, 'reply fwd fee', fwd);
        expect((gas * NANO_PER_GAS + fwd) * 3n).toBeLessThanOrEqual(OBSERVE_VALUE * 2n);
    });
});

describe('PositionDecreaseNotify', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    let pos: SandboxContract<Position>;
    let base: any;

    beforeAll(async () => {
        ({ d, pool } = await setup());
        pos = await d.position(pool, 1n);         // bob's [-600, 600]
        for (let i = 0; i < 4; i++) {
            await d.swapNative(d.alice, toNano('20'), d.tokA);
            await d.swapJetton(d.jA, d.alice, toNano('25'), GRAM);
        }
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('decrease: BurnReceipt == model burn == ModifyEvent; Gram leg GramPayout, jetton leg NOTIFIED (forward_ton_amount > 0)', async () => {
        const pd = await pos.getGetPositionData();
        for (const delta of [pd.liquidity / 3n, pd.liquidity - pd.liquidity / 3n]) {
            const cur = await pos.getGetPositionData();
            const sim = await simOf(pool);
            const e = sim.burn(Number(cur.tickLower), Number(cur.tickUpper), cur.liquidity, delta, cur.fgLast0, cur.fgLast1);
            const res = await decreaseNotify(d, pos, d.bob, delta, { queryId: 31n, recipient: d.carol.address });
            expectNoFailures(res);
            await expectPoolEquals(pool, sim);
            const rs = burnReceipts(res, d.bob.address);
            expect(rs.length).toBe(1);
            const r = rs[0].r;
            expect([r.queryId, r.index, r.ok, r.code, r.liquidityDelta, r.liquidity]).toEqual([31n, 1n, true, 0n, delta, cur.liquidity - delta]);
            expect([r.amount0, r.amount1, r.fees0, r.fees1]).toEqual([e.amount0, e.amount1, e.fees0, e.fees1]);
            expect([r.fgInside0, r.fgInside1]).toEqual([e.inside0, e.inside1]);
            const after = await pos.getGetPositionData();
            expect([after.liquidity, after.fgLast0, after.fgLast1, after.busy]).toEqual([r.liquidity, r.fgInside0, r.fgInside1, false]);
            const ev = modifyEvents(res)[0];
            expect([ev.amount0, ev.amount1, ev.fees0, ev.fees1]).toEqual([r.amount0, r.amount1, r.fees0, r.fees1]);
            // payouts to the recipient: Gram as GramPayout, the jetton leg notified to carol
            const g = gramPayouts(res, d.carol.address).filter((x) => x.reason === REASON.POSITION_OUT);
            expect(g.map((x) => x.amount)).toEqual([e.amount0 + e.fees0]);
            const notes = jettonNotes(res, d.carol.address);
            expect(notes.length).toBe(1);
            expect(notes[0].amount).toBe(e.amount1 + e.fees1);
            expect(notes[0].value).toBe(NOTIFY_FWD_TON);
            expect(notes[0].sender.equals(d.router.address)).toBe(true);
            expect(notes[0].queryId).toBe(31n);
            // no JettonExcesses from the Position: the receipt replaces it
            expect(txsTo(res, d.bob.address, OPN.JettonExcesses).filter((tx) => src(tx)?.equals(pos.address)).length).toBe(0);
        }
    });

    it('ordering: the receipt is sent by the Position in the transaction that frees it (after the Pool committed)', async () => {
        const pd = await pos.getGetPositionData();
        const res = await decreaseNotify(d, pos, d.bob, pd.liquidity / 2n);
        expectNoFailures(res);
        const syncTx = res.transactions.find((tx) => dst(tx)?.equals(pos.address) && opOf(tx) === OPN.PositionSyncNotify)!;
        expect(syncTx).toBeDefined();
        const out = [...syncTx.outMessages.values()].filter((m) => m.info.type === 'internal');
        expect(out.length).toBe(1);
        expect(out[0].body.beginParse().preloadUint(32)).toBe(OPN.BurnReceipt);
        expect((out[0].info as any).dest.equals(d.bob.address)).toBe(true);
        // the pool's burn transaction precedes it
        const burnTx = res.transactions.find((tx) => dst(tx)?.equals(pool.address) && opOf(tx) === OPN.PoolBurnNotify)!;
        expect(burnTx.lt).toBeLessThan(syncTx.lt);
        // a second op while the first is in flight is refused by the Position, the first completes
        const { it } = await stepN(d.chain, msg(d.bob.address, pos.address, DECREASE_NOTIFY_GAS, decNotifyBody(1000n, { queryId: 41n, deadline: d.deadline() })), 1);
        const r2 = await decreaseNotify(d, pos, d.bob, 1000n, { queryId: 42n });
        expect(failedAt(r2, pos.address).length).toBe(1);
        // (the sandbox queue is global: the first op's trace completes inside r2)
        const rest = await drain(it);
        const all = [...r2.transactions, ...rest].filter((tx) => dst(tx)?.equals(d.bob.address) && opOf(tx) === OPN.BurnReceipt);
        expect(all.map((tx) => loadBurnReceipt(tx.inMessage!.body.beginParse()).queryId)).toEqual([41n]);
        expect((await pos.getGetPositionData()).busy).toBe(false);
    });

    it('collect (delta 0): fees equal get_position_amounts; plain PositionDecrease still answers with JettonExcesses (unchanged)', async () => {
        const pd = await pos.getGetPositionData();
        const pa = await pool.getGetPositionAmounts(pd.tickLower, pd.tickUpper, pd.liquidity, pd.fgLast0, pd.fgLast1, 0n);
        const res = await decreaseNotify(d, pos, d.bob, 0n);
        expectNoFailures(res);
        const r = burnReceipts(res, d.bob.address)[0].r;
        expect([r.ok, r.amount0, r.amount1, r.fees0, r.fees1, r.liquidityDelta, r.liquidity]).toEqual([true, 0n, 0n, pa.fees0, pa.fees1, 0n, pd.liquidity]);
        await d.chain.loadFrom(base);
        const plain = await d.decrease(pos, d.bob, 0n);
        expectNoFailures(plain);
        expect(burnReceipts(plain, d.bob.address).length).toBe(0);
        expect(txsTo(plain, d.bob.address, OPN.JettonExcesses).filter((tx) => src(tx)?.equals(pos.address)).length).toBe(1);
        expect(jettonNotes(plain, d.bob.address).length).toBe(0);      // plain payouts stay silent
    });

    it('Pool refusals (deadline, slippage, bad recipient) answer a BurnReceipt{ok = false, code}; nothing moves', async () => {
        const pd = await pos.getGetPositionData();
        const sim = await simOf(pool);
        for (const [o, code] of [[{ deadline: BigInt(d.now - 1) }, CODES.DEADLINE], [{ min0: toNano('100000') }, CODES.SLIPPAGE],
            [{ recipient: d.router.address }, CODES.BAD_RECIPIENT]] as const) {
            const res = await decreaseNotify(d, pos, d.bob, pd.liquidity, { queryId: 5n, ...(o as any) });
            expectNoFailures(res);
            const rs = burnReceipts(res, d.bob.address);
            expect(rs.length).toBe(1);
            const r = rs[0].r;
            expect([r.queryId, r.ok, Number(r.code), r.liquidityDelta, r.liquidity, r.amount0, r.amount1, r.fees0, r.fees1])
                .toEqual([5n, false, code, 0n, pd.liquidity, 0n, 0n, 0n, 0n]);
            expect([r.fgInside0, r.fgInside1]).toEqual([pd.fgLast0, pd.fgLast1]);
            expect(modifyEvents(res)).toEqual([]);
            expect((await pos.getGetPositionData()).busy).toBe(false);
        }
        await expectPoolEquals(pool, sim);
    });

    it('bounce path: if the Pool throws, the Position answers BurnReceipt{ok = false, BURN_BOUNCED} and is free', async () => {
        const pd = await pos.getGetPositionData();
        const sc = await d.chain.getContract(pool.address);
        const saved = sc.account;
        const hk = await TestHook.fromInit(d.carol.address, 0n);
        await d.chain.setShardAccount(pool.address, createShardAccount({
            address: pool.address, code: hk.init!.code, data: hk.init!.data, balance: saved.account!.storage.balance.coins,
        }));
        const res = await decreaseNotify(d, pos, d.bob, pd.liquidity, { queryId: 66n });
        expect(failedAt(res, pool.address).length).toBe(1);
        const rs = burnReceipts(res, d.bob.address);
        expect(rs.length).toBe(1);
        expect(src(rs[0].tx)!.equals(pos.address)).toBe(true);
        const r = rs[0].r;
        expect([r.queryId, r.ok, Number(r.code), r.liquidity]).toEqual([66n, false, BURN_BOUNCED, pd.liquidity]);
        await d.chain.setShardAccount(pool.address, saved);
        expect((await pos.getGetPositionData()).busy).toBe(false);
        expectNoFailures(await decreaseNotify(d, pos, d.bob, pd.liquidity));
        expect((await pos.getGetPositionData()).liquidity).toBe(0n);
    });

    it('value: below DECREASE_NOTIFY_GAS the Position refuses; at it both legs (one notified) are paid', async () => {
        const pd = await pos.getGetPositionData();
        const low = await decreaseNotify(d, pos, d.bob, pd.liquidity, { value: DECREASE_NOTIFY_GAS - 1n });
        expect(failedAt(low, pos.address).length).toBe(1);
        const res = await decreaseNotify(d, pos, d.bob, pd.liquidity, { value: DECREASE_NOTIFY_GAS });
        expectNoFailures(res);
        const r = burnReceipts(res, d.bob.address)[0].r;
        expect(r.ok).toBe(true);
        expect(jettonNotes(res, d.bob.address).map((n) => n.amount)).toEqual([r.amount1 + r.fees1]);
        expect(gramPayouts(res, d.bob.address).map((g) => g.amount)).toEqual([r.amount0 + r.fees0]);
        // the receipt still carries value to the owner (it is the Position's excess)
        const v = (burnReceipts(res, d.bob.address)[0].tx.inMessage!.info as any).value.coins;
        expect(v).toBeGreaterThan(toNano('0.005'));
    });

    it('a Position whose storage buffer was eaten by rent still delivers a funded receipt (RECEIPT_FLOOR); gas of the relay', async () => {
        const sc = await d.chain.getContract(pos.address);
        const acc = sc.account;
        const st: any = acc.account!.storage.state;
        // drain the Position's own balance to 1 nanoGram (years of rent)
        await d.chain.setShardAccount(pos.address, createShardAccount({
            address: pos.address, code: st.state.code!, data: st.state.data!, balance: 1n,
        }));
        const pd = await pos.getGetPositionData();
        const res = await decreaseNotify(d, pos, d.bob, pd.liquidity / 2n);
        expectNoFailures(res);
        const rs = burnReceipts(res, d.bob.address);
        expect(rs.length).toBe(1);
        expect(rs[0].r.ok).toBe(true);
        expect((rs[0].tx.inMessage!.info as any).value.coins).toBeGreaterThanOrEqual(toNano('0.005'));
        const relay = gasAt(res, pos.address, OPN.PositionSyncNotify)[0];
        const burnGas = gasAt(res, pool.address, OPN.PoolBurnNotify)[0];
        // eslint-disable-next-line no-console
        if (process.env.PRINT_GAS) console.log('PositionSyncNotify gas', relay, 'PoolBurnNotify gas', burnGas);
        expect(relay * NANO_PER_GAS * 3n).toBeLessThanOrEqual(toNano('0.02') * 2n);     // POSITION_SYNC_VALUE pays it
    });

    it('forged PositionSyncNotify (non-pool sender, or wrong queryId) is rejected', async () => {
        const pd = await pos.getGetPositionData();
        const forged = beginCell().store(storePositionSyncNotify({
            $$type: 'PositionSyncNotify', queryId: 0n, ok: true, code: 0n, liquidity: pd.liquidity * 9n, fgInside0: 0n, fgInside1: 0n,
            liquidityDelta: 0n, amount0: 1n, amount1: 1n, fees0: 1n, fees1: 1n,
        })).endCell();
        const mallory = await d.chain.treasury('mallory');
        let res = await d.chain.sendMessage(msg(mallory.address, pos.address, toNano('0.1'), forged));
        expect(failedAt(res, pos.address).length).toBe(1);
        res = await d.chain.sendMessage(msg(pool.address, pos.address, toNano('0.1'), forged));
        expect(failedAt(res, pos.address).length).toBe(1);
        expect((await pos.getGetPositionData()).liquidity).toBe(pd.liquidity);
    });
});

describe('notifying mints', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    let base: any;

    beforeAll(async () => {
        ({ d, pool } = await setup());
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('dual jetton mint: MintReceipt to the payer == model mint; refunds paid to refundTo, the jetton one notified', async () => {
        const sim = await simOf(pool);
        const e = sim.mint(-1200, 1200, toNano('50'), toNano('80'), 0n, 0n, BigInt(d.now), M.PRESETS[60]);
        expect(e.code).toBe(0);
        const p = mintNotifyPayload(d, GRAM, -1200n, 1200n, toNano('50'), { refundTo: d.carol.address, owner: d.alice.address });
        const res = await d.sendJettons(d.jA, d.bob, toNano('80'), toNano('50') + MINT_GAS + MINT_NOTIFY_GAS + toNano('0.05'), eitherRef(p));
        expectNoFailures(res);
        await expectPoolEquals(pool, sim);
        const rs = mintReceipts(res, d.bob.address);
        expect(rs.length).toBe(1);
        expect(src(rs[0].tx)!.equals(pool.address)).toBe(true);
        const r = rs[0].r;
        const idx = sim.nextPositionId - 1n;
        expect([r.ok, r.code, r.index, r.tickLower, r.tickUpper, r.liquidity, r.amount0, r.amount1])
            .toEqual([true, 0n, idx, -1200n, 1200n, e.liq, e.use0, e.use1]);
        expect(r.owner.equals(d.alice.address)).toBe(true);
        expect([r.refund0, r.refund1]).toEqual([toNano('50') - e.use0, toNano('80') - e.use1]);
        expect([r.fgInside0, r.fgInside1]).toEqual([e.inside0, e.inside1]);
        const nft = await (await d.position(pool, idx)).getGetPositionData();
        expect([nft.liquidity, nft.fgLast0, nft.fgLast1]).toEqual([e.liq, e.inside0, e.inside1]);
        // nothing to the owner, refunds to refundTo
        expect(mintReceipts(res, d.alice.address).length).toBe(0);
        if (r.refund1 > 0n) {
            const n = jettonNotes(res, d.carol.address);
            expect(n.map((x) => [x.amount, x.value])).toEqual([[r.refund1, NOTIFY_FWD_TON]]);
        }
        if (r.refund0 > 0n) expect(gramPayouts(res, d.carol.address).map((g) => g.amount)).toEqual([r.refund0]);
        expect(r.refund0 + r.refund1).toBeGreaterThan(0n);
        // the receipt precedes the Gram refund on the Pool -> payer channel (FIFO): same tx, lower lt
        const poolTx = res.transactions.find((tx) => dst(tx)?.equals(pool.address) && opOf(tx) === 0x4d480028)!;
        const outs = [...poolTx.outMessages.values()].filter((m) => m.info.type === 'internal').map((m) => m.body.beginParse().preloadUint(32));
        expect(outs.indexOf(OPN.MintReceipt)).toBeLessThan(outs.lastIndexOf(0x4d480061) === -1 ? 99 : outs.lastIndexOf(0x4d480061));
    });

    it('native mint: receipt == model; MINT_GAS + MINT_NOTIFY_GAS is the Router minimum', async () => {
        const sim = await simOf(pool);
        const e = sim.mint(600, 1800, toNano('10'), 0n, 0n, 0n, BigInt(d.now), M.PRESETS[60]);
        // the Router minimum (forward fees ride on top, as for MintNative)
        const low = await mintNativeNotify(d, d.bob, toNano('10'), 600n, 1800n, { gas: MINT_GAS + MINT_NOTIFY_GAS - 1n });
        expect(failedAt(low, d.router.address).length).toBe(1);
        const res = await mintNativeNotify(d, d.bob, toNano('10'), 600n, 1800n, { gas: MINT_GAS + MINT_NOTIFY_GAS + toNano('0.01') });
        expectNoFailures(res);
        await expectPoolEquals(pool, sim);
        const r = mintReceipts(res, d.bob.address)[0].r;
        expect([r.ok, r.liquidity, r.amount0, r.amount1, r.refund0, r.refund1, r.index]).toEqual([true, e.liq, e.use0, 0n, toNano('10') - e.use0, 0n, sim.nextPositionId - 1n]);
        // eslint-disable-next-line no-console
        if (process.env.PRINT_GAS) console.log('PoolMintNotify gas (2 new ticks)', gasAt(res, pool.address, 0x4d480028)[0]);
    });

    it('Pool refusal (price band): MintReceipt{ok = false, SLIPPAGE} first, both legs refunded, the jetton one notified', async () => {
        const sim = await simOf(pool);
        const st = await pool.getGetPoolState();
        const p = mintNotifyPayload(d, GRAM, -1200n, 1200n, toNano('5'), { sqrtMin: st.sqrtPriceX96 + 1n });
        const jb = await d.jBal(d.jA, d.bob.address);
        const res = await d.sendJettons(d.jA, d.bob, toNano('7'), toNano('5') + toNano('0.7'), eitherRef(p));
        expectNoFailures(res);
        await expectPoolEquals(pool, sim);
        expect(refundCodes(res)).toEqual([CODES.SLIPPAGE]);
        const r = mintReceipts(res, d.bob.address)[0].r;
        expect([r.ok, Number(r.code), r.liquidity, r.refund0, r.refund1]).toEqual([false, CODES.SLIPPAGE, 0n, toNano('5'), toNano('7')]);
        expect(jettonNotes(res, d.bob.address).map((n) => [n.amount, n.value])).toEqual([[toNano('7'), NOTIFY_FWD_TON]]);
        expect(gramPayouts(res, d.bob.address).filter((g) => g.reason === REASON.MINT_REFUND).map((g) => g.amount)).toEqual([toNano('5')]);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb);
        expect(modifyEvents(res)).toEqual([]);
    });

    it('Router refusal (deadline) of a notifying jetton mint refunds with a notification; a malformed payload too', async () => {
        const jb = await d.jBal(d.jA, d.bob.address);
        const p = mintNotifyPayload(d, GRAM, -1200n, 1200n, 0n, { deadline: BigInt(d.now - 1) });
        const res = await d.sendJettons(d.jA, d.bob, toNano('7'), toNano('0.7'), eitherRef(p));
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.DEADLINE]);
        expect(jettonNotes(res, d.bob.address).map((n) => [n.amount, n.value])).toEqual([[toNano('7'), NOTIFY_FWD_TON]]);
        const bad = beginCell().storeUint(0x4d480005, 32).storeUint(1, 8).endCell();
        const r2 = await d.sendJettons(d.jA, d.bob, toNano('3'), toNano('0.3'), eitherRef(bad));
        expectNoFailures(r2);
        expect(refundCodes(r2)).toEqual([CODES.BAD_PAYLOAD]);
        expect(jettonNotes(r2, d.bob.address).map((n) => n.amount)).toEqual([toNano('3')]);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb);
        // a plain MintPayload refusal stays silent (unchanged)
        const plain = await d.mintJetton(d.jA, d.bob, toNano('2'), GRAM, -1200n, 1200n, 0n, { deadline: BigInt(d.now - 1) });
        expect(jettonNotes(plain, d.bob.address).length).toBe(0);
    });

    it('only the payer gets a receipt: a mint FOR someone else (owner = victim) sends nothing to the victim', async () => {
        const res = await mintNativeNotify(d, d.bob, toNano('3'), 600n, 1800n, { owner: d.carol.address, refundTo: d.bob.address });
        expectNoFailures(res);
        expect(mintReceipts(res, d.carol.address).length).toBe(0);
        expect(mintReceipts(res, d.bob.address).length).toBe(1);
    });
});
