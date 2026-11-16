// Fee suite: Meteora volatility accumulator (growth inside one swap through virtual checkpoints,
// filter and decay periods over time, maxVolAcc cap, 5% cap with an admin-added preset), the
// LAUNCH_DECAY curve, the protocol share (cap, change, accrual, payout to the treasury only), and
// quote_at(atTime) == execution at that time.

import { toNano } from '@ton/core';
import { SandboxContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, CODES, REASON, Pool, expectNoFailures, swapEvents, gramPayouts, simOf, expectPoolEquals,
    failedAt, extCell,
} from './helpers';
import * as M from './model';

jest.setTimeout(900000);

async function poolFullRange(d: Dex, spacing: bigint, ext: any = null, extM: M.ExtModel = M.PLAIN_EXT) {
    const pool = await d.poolOf(GRAM, d.tokA, spacing, ext);
    const s = Number(spacing);
    expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, BigInt(M.minUsable(s)), BigInt(M.maxUsable(s)),
        toNano('1000'), { tickSpacing: spacing, ext, sqrtPriceInit: Q96 }));
    return { pool, extM };
}

describe('fees: volatility accumulator', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;

    beforeAll(async () => {
        d = await Dex.create();
        ({ pool } = await poolFullRange(d, 60n));
    });

    it('va grows step by step inside one swap (virtual checkpoints); stored volAcc == model', async () => {
        const st0 = await pool.getGetPoolState();
        expect(st0.feePipsNow).toBe(3000n);
        const sim = await simOf(pool);
        const e = sim.swap(true, toNano('60'), 0n, 24, 0n, false, 0n, BigInt(d.now));
        expect(e.steps).toBeGreaterThan(2);
        expect(e.lastFee).toBeGreaterThan(3000n);
        const res = await d.swapNative(d.bob, toNano('60'), d.tokA);
        expectNoFailures(res);
        expect(swapEvents(res)[0].feeTotal).toBe(e.feeTotal);
        await expectPoolEquals(pool, sim);
        const st = await pool.getGetPoolState();
        // va = |idxRef - idx(tick)| * 10000 at the last step (volRef = 0 on a fresh pool).
        expect(st.fs.volAcc).toBe(sim.fs.volAcc);
        expect(st.fs.volAcc).toBeGreaterThan(0n);
        expect(st.feePipsNow).toBe(sim.feePipsNow(BigInt(d.now)));
    });

    it('within filterPeriod the references hold (va keeps growing); after it volRef = volAcc * 50%; after decayPeriod 0', async () => {
        const sim0 = await simOf(pool);
        const vol0 = sim0.fs.volAcc;
        // Quotes at future times equal the model at that time.
        for (const dt of [0, 5, 29, 30, 31, 300, 599, 600, 601, 5000]) {
            const t = BigInt(d.now + dt);
            const q = await pool.getGetQuoteAt(true, toNano('5'), 0n, 24n, 0n, false, t);
            const e = (await simOf(pool)).swap(true, toNano('5'), 0n, 24, 0n, false, 0n, t, false);
            expect([dt, q.amountOut, q.feeTotal, q.steps]).toEqual([dt, e.out, e.feeTotal, BigInt(e.steps)]);
        }
        // After 10 s (< filterPeriod 30): a further move keeps accumulating from the same reference.
        d.chain.now = d.now + 10;
        let sim = await simOf(pool);
        sim.swap(true, toNano('20'), 0n, 24, 0n, false, 0n, BigInt(d.now));
        expectNoFailures(await d.swapNative(d.bob, toNano('20'), d.tokA));
        await expectPoolEquals(pool, sim);
        const st1 = await pool.getGetPoolState();
        expect(st1.fs.idxRef).toBe(sim0.fs.idxRef);
        expect(st1.fs.volAcc).toBeGreaterThan(vol0);
        // After 100 s (>= filter, < decay): volRef = volAcc * reductionBps / 1e4, idxRef = current index.
        d.chain.now = d.now + 100;
        sim = await simOf(pool);
        const tickBefore = sim.tick;
        sim.swap(false, toNano('1'), 0n, 24, 0n, false, 0n, BigInt(d.now));
        expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('1'), GRAM));
        await expectPoolEquals(pool, sim);
        const st2 = await pool.getGetPoolState();
        expect(st2.fs.volRef).toBe(st1.fs.volAcc * 5000n / 10000n);
        expect(st2.fs.idxRef).toBe(BigInt(Math.floor(tickBefore / 60)));
        // After >= decayPeriod (600 s): volRef resets to 0.
        d.chain.now = d.now + 600;
        sim = await simOf(pool);
        sim.swap(false, toNano('1'), 0n, 24, 0n, false, 0n, BigInt(d.now));
        expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('1'), GRAM));
        await expectPoolEquals(pool, sim);
        expect((await pool.getGetPoolState()).fs.volRef).toBe(0n);
        // feePipsNow tracks the model over time.
        for (const dt of [0, 10, 40, 700]) {
            d.chain.now = d.now + dt;
            expect((await pool.getGetPoolState()).feePipsNow).toBe((await simOf(pool)).feePipsNow(BigInt(d.now)));
        }
    });

    it('maxVolAcc caps va at 350000 (variable part 19845 pips at spacing 60)', async () => {
        d.chain.now = d.now + 1000;
        const sim = await simOf(pool);
        const e = sim.swap(true, toNano('5000000'), 0n, 24, 0n, true, 0n, BigInt(d.now));
        // Once va pins at maxVolAcc no more checkpoints are needed (finding 7): the swap is not cut at 48 steps.
        expect(e.steps).toBeLessThan(M.MAX_STEPS);
        expectNoFailures(await d.swapNative(d.bob, toNano('5000000'), d.tokA, { allowPartial: true }));
        await expectPoolEquals(pool, sim);
        const st = await pool.getGetPoolState();
        expect(st.fs.volAcc).toBe(350000n);
        expect(M.variableFee(4500n, 350000n, 60n)).toBe(19845n);
        expect(e.lastFee).toBe(3000n + 19845n);
        expect(st.feePipsNow).toBe(3000n + 19845n);
    });

    it('5% cap on base + variable with an admin-added aggressive preset; a preset with A = 0 has a flat fee', async () => {
        let res = await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'AddFeePreset', queryId: 1n, tickSpacing: 50n,
            preset: { $$type: 'FeePreset', baseFeePips: 20000n, varFeeControl: 1000000n, filterPeriod: 10n, decayPeriod: 100n, reductionBps: 5000n, maxVolAcc: 4000000000n },
        });
        expectNoFailures(res);
        res = await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'AddFeePreset', queryId: 1n, tickSpacing: 30n,
            preset: { $$type: 'FeePreset', baseFeePips: 2500n, varFeeControl: 0n, filterPeriod: 10n, decayPeriod: 100n, reductionBps: 5000n, maxVolAcc: 350000n },
        });
        expectNoFailures(res);
        const { pool: p50 } = await poolFullRange(d, 50n);
        const sim = await simOf(p50);
        const e = sim.swap(true, toNano('200'), 0n, 24, 0n, false, 0n, BigInt(d.now));
        expect(e.lastFee).toBe(50000n);
        res = await d.swapNative(d.bob, toNano('200'), d.tokA, { tickSpacing: 50n });
        expectNoFailures(res);
        expect(swapEvents(res)[0].feeTotal).toBe(e.feeTotal);
        await expectPoolEquals(p50, sim);
        expect((await p50.getGetPoolState()).feePipsNow).toBe(50000n);
        // A = 0: no checkpoints, fee stays at base.
        const { pool: p30 } = await poolFullRange(d, 30n);
        const s30 = await simOf(p30);
        const e30 = s30.swap(true, toNano('200'), 0n, 24, 0n, false, 0n, BigInt(d.now));
        expect(e30.steps).toBe(1);
        expect(e30.lastFee).toBe(2500n);
        expectNoFailures(await d.swapNative(d.bob, toNano('200'), d.tokA, { tickSpacing: 30n }));
        await expectPoolEquals(p30, s30);
    });
});

describe('fees: LAUNCH_DECAY plugin', () => {
    it('extra fee decays linearly from launchFeePips to 0 over launchDuration; quote_at == execution at each time', async () => {
        const d = await Dex.create();
        const ext = extCell({ launchFeePips: 200000n, launchDuration: 3600n });
        const extM: M.ExtModel = { ...M.PLAIN_EXT, launchFeePips: 200000n, launchDuration: 3600n };
        const { pool } = await poolFullRange(d, 200n, ext);
        const t0 = d.now;
        const base = d.chain.snapshot();
        for (const [dt, extra] of [[0, 200000n], [1, 199944n], [900, 150000n], [1800, 100000n], [3599, 55n], [3600, 0n], [9999, 0n]] as [number, bigint][]) {
            await d.chain.loadFrom(base);
            d.chain.now = t0 + dt;
            const st = await pool.getGetPoolState();
            expect([dt, st.feePipsNow]).toEqual([dt, 10000n + extra]);
            const q = await pool.getGetQuoteAt(true, toNano('1'), 0n, 24n, 0n, false, BigInt(t0 + dt));
            const sim = await simOf(pool, extM);
            const e = sim.swap(true, toNano('1'), 0n, 24, 0n, false, 0n, BigInt(d.now));
            expect([q.amountOut, q.feeTotal]).toEqual([e.out, e.feeTotal]);
            const res = await d.swapNative(d.bob, toNano('1'), d.tokA, { tickSpacing: 200n, ext });
            expectNoFailures(res);
            expect([swapEvents(res)[0].amountOut, swapEvents(res)[0].feeTotal]).toEqual([q.amountOut, q.feeTotal]);
            await expectPoolEquals(pool, sim);
        }
        // The launch extra sits on top of the 5% cap: at t0 the total exceeds 50000 pips.
        expect(M.launchExtra(200000n, 3600n, BigInt(t0), BigInt(t0)) + 10000n).toBeGreaterThan(50000n);
    });
});

describe('fees: protocol share, accrual and payout', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    let pj: SandboxContract<Pool>;
    let key: any;
    let keyJ: any;

    beforeAll(async () => {
        d = await Dex.create();
        pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -6000n, 6000n, toNano('1000'), { sqrtPriceInit: Q96 }));
        pj = await d.poolOf(d.tokA, d.tokB, 10n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), d.tokB, -1000n, 1000n, 0n, { tickSpacing: 10n, viaAccount: true, sqrtPriceInit: Q96 }));
        expectNoFailures(await d.mintJetton(d.jB, d.alice, toNano('1000'), d.tokA, -1000n, 1000n, 0n, { tickSpacing: 10n, viaAccount: true }));
        const s = await pool.getGetPoolState();
        key = { $$type: 'PoolKey', token0: s.key.token0, token1: s.key.token1, tickSpacing: s.key.tickSpacing, ext: s.key.ext };
        const sj = await pj.getGetPoolState();
        keyJ = { $$type: 'PoolKey', token0: sj.key.token0, token1: sj.key.token1, tickSpacing: sj.key.tickSpacing, ext: sj.key.ext };
    });

    it('default 10%; admin sets 25% (cap) and 0%; 25.01% is refused by the Router; quotes follow at once', async () => {
        expect((await pool.getGetPoolState()).fs.protocolShareBps).toBe(1000n);
        let res = await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetProtocolShare', queryId: 1n, key, shareBps: 2501n });
        expect(failedAt(res, d.router.address).length).toBe(1);
        expect((await pool.getGetPoolState()).fs.protocolShareBps).toBe(1000n);
        res = await d.router.send(d.bob.getSender(), { value: toNano('0.1') }, { $$type: 'SetProtocolShare', queryId: 1n, key, shareBps: 0n });
        expect(failedAt(res, d.router.address).length).toBe(1);
        res = await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetProtocolShare', queryId: 1n, key, shareBps: 2500n });
        expectNoFailures(res);
        expect((await pool.getGetPoolState()).fs.protocolShareBps).toBe(2500n);
        const q = await pool.getGetQuote(true, toNano('10'), 0n, 24n, 0n, false);
        expect(q.steps).toBe(1n);
        expect(q.protocolFee).toBe(q.feeTotal * 2500n / 10000n);
        res = await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetProtocolShare', queryId: 1n, key, shareBps: 0n });
        expectNoFailures(res);
        expect((await pool.getGetQuote(true, toNano('10'), 0n, 24n, 0n, false)).protocolFee).toBe(0n);
        res = await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetProtocolShare', queryId: 1n, key, shareBps: 1000n });
        expectNoFailures(res);
        // Setting the share of a pool that does not exist bounces back to the Router and is swallowed.
        res = await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetProtocolShare', queryId: 1n,
            key: { ...key, tickSpacing: 200n }, shareBps: 100n });
        expect(res.transactions).toHaveTransaction({ to: d.router.address, inMessageBounced: true, success: true });
    });

    it('protocol fees accrue in the input token per step (both directions) and are paid only to the treasury', async () => {
        const sim = await simOf(pool);
        const e1 = sim.swap(true, toNano('30'), 0n, 24, 0n, false, 0n, BigInt(d.now));
        expectNoFailures(await d.swapNative(d.bob, toNano('30'), d.tokA));
        const e2 = sim.swap(false, toNano('70'), 0n, 24, 0n, false, 0n, BigInt(d.now));
        expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('70'), GRAM));
        await expectPoolEquals(pool, sim);
        const st = await pool.getGetPoolState();
        expect([st.protocolFees0, st.protocolFees1]).toEqual([e1.proto, e2.proto]);
        expect(e1.proto).toBeGreaterThan(0n);
        // Anyone triggers; the treasury gets exactly the buckets, the caller only the excess.
        const tj = await d.jBal(d.jA, d.treasury.address);
        let res = await d.router.send(d.carol.getSender(), { value: toNano('0.2') }, { $$type: 'CollectProtocolFees', queryId: 2n, key });
        expectNoFailures(res);
        expect(gramPayouts(res, d.treasury.address).map((x) => [x.reason, x.amount])).toEqual([[REASON.PROTOCOL_FEE, e1.proto]]);
        expect(await d.jBal(d.jA, d.treasury.address)).toBe(tj + e2.proto);
        expect(gramPayouts(res, d.carol.address)).toEqual([]);
        sim.protocolFees0 = 0n;
        sim.protocolFees1 = 0n;
        await expectPoolEquals(pool, sim);
        await d.checkSolvency([pool]);
        // A second collect pays nothing (only the excess goes back to the caller).
        res = await d.router.send(d.carol.getSender(), { value: toNano('0.2') }, { $$type: 'CollectProtocolFees', queryId: 2n, key });
        expectNoFailures(res);
        expect(gramPayouts(res, d.treasury.address)).toEqual([]);
        expect(res.transactions).toHaveTransaction({ from: pool.address, to: d.carol.address, op: 0xd53276db });
        // Too little value is refused at the Router.
        res = await d.router.send(d.carol.getSender(), { value: toNano('0.2') - 1n }, { $$type: 'CollectProtocolFees', queryId: 2n, key });
        expect(failedAt(res, d.router.address).length).toBe(1);
    });

    it('jetton/jetton protocol fees: both tokens to the treasury; the Router wallets keep exactly the reserves', async () => {
        const st0 = await pj.getGetPoolState();
        const aIs0 = st0.key.token0.equals(d.tokA);
        const sim = await simOf(pj);
        const e1 = sim.swap(aIs0, toNano('25'), 0n, 24, 0n, false, 0n, BigInt(d.now));
        expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('25'), d.tokB, { tickSpacing: 10n }));
        const e2 = sim.swap(!aIs0, toNano('40'), 0n, 24, 0n, false, 0n, BigInt(d.now));
        expectNoFailures(await d.swapJetton(d.jB, d.bob, toNano('40'), d.tokA, { tickSpacing: 10n }));
        await expectPoolEquals(pj, sim);
        const ta = await d.jBal(d.jA, d.treasury.address);
        const tb = await d.jBal(d.jB, d.treasury.address);
        expectNoFailures(await d.router.send(d.bob.getSender(), { value: toNano('0.3') }, { $$type: 'CollectProtocolFees', queryId: 2n, key: keyJ }));
        // tokA's fee always comes from the tokA-in swap (e1), whichever token sorts first.
        expect(await d.jBal(d.jA, d.treasury.address)).toBe(ta + e1.proto);
        expect(await d.jBal(d.jB, d.treasury.address)).toBe(tb + e2.proto);
        const st = await pj.getGetPoolState();
        expect(st.protocolFees0 + st.protocolFees1).toBe(0n);
        const poolA = (await pool.getGetPoolState());
        expect(await d.routerHolds(d.tokA)).toBe(poolA.reserve1 + poolA.protocolFees1 + (aIs0 ? st.reserve0 : st.reserve1));
        void CODES;
    });
});
