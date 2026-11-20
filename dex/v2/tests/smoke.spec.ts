// End-to-end smoke test of the v2 tick engine: create a Gram/jetton pool, add range liquidity,
// swap both directions inside the range and across several initialized ticks, partial fills,
// remove liquidity and collect fees, with quote == execution checked on every swap.
// Also measures gas per swap and per crossed tick (printed; recorded in DESIGN.md §15).

import { beginCell, toNano } from '@ton/core';
import { SandboxContract, SendMessageResult } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, STOP, Pool, Position, Quote,
    expectNoFailures, swapEvents, modifyEvents, initEvents, refundCodes, gramPayouts, gasAt, fees,
    eitherRef as eitherRefOf, extCell, storeHookSetFee, storeHookCollectFees, patchMaxVolAcc,
} from './helpers';
import { TestHook } from '../build/TestHook_TestHook';
import * as M from './model';

jest.setTimeout(300000);

type Snap = { sqrtPriceX96: bigint; tick: bigint; liquidity: bigint; reserve0: bigint; reserve1: bigint };

async function snap(pool: SandboxContract<Pool>): Promise<Snap> {
    const s = await pool.getGetPoolState();
    return { sqrtPriceX96: s.sqrtPriceX96, tick: s.tick, liquidity: s.liquidity, reserve0: s.reserve0, reserve1: s.reserve1 };
}

// Read the whole pool into the independent BigInt model (model.ts).
async function modelOf(pool: SandboxContract<Pool>): Promise<M.PoolModel> {
    const s = await pool.getGetPoolState();
    const ticks = new Map<number, M.TickInfo>();
    let from = -887272n;
    for (;;) {
        const page = await pool.getGetTicks(from, 64n, true);
        const keys = [...page.keys()].sort((a, b) => a - b);
        for (const k of keys) {
            const v = page.get(k)!;
            ticks.set(k, { liqGross: v.liqGross, liqNet: v.liqNet, fgOut0: v.fgOut0, fgOut1: v.fgOut1 });
        }
        if (keys.length < 64) break;
        from = BigInt(keys[keys.length - 1] + 1);
    }
    return {
        sqrtP: s.sqrtPriceX96, tick: Number(s.tick), L: s.liquidity, fg0: s.feeGrowth0X128, fg1: s.feeGrowth1X128,
        ticks, fs: { ...s.fs }, spacing: Number(s.key.tickSpacing), launchFeePips: 0n, launchDuration: 0n, hookShareBps: 0n,
    };
}

// The model's swap agrees with the on-chain quote (independent engine check).
function expectModelMatches(m: M.PoolModel, q: Quote, zfo: boolean, amountIn: bigint, limit: bigint, maxCrossings: number, t: bigint) {
    const lim = limit === 0n ? (zfo ? M.MIN_SQRT_RATIO + 1n : M.MAX_SQRT_RATIO - 1n) : limit;
    const r = M.computeSwap(m, zfo, amountIn, lim, maxCrossings, t);
    expect(r.out).toBe(q.amountOut);
    expect(amountIn - r.remaining).toBe(q.consumed);
    expect(r.feeTotal).toBe(q.feeTotal);
    expect(r.proto).toBe(q.protocolFee);
    expect(r.sqrtP).toBe(q.sqrtPriceAfter);
    expect(BigInt(r.tick)).toBe(q.tickAfter);
    expect(r.L).toBe(q.liquidityAfter);
    expect(BigInt(r.crossings)).toBe(q.crossings);
    expect(BigInt(r.steps)).toBe(q.steps);
    expect(BigInt(r.stop)).toBe(q.stop);
}

// The executed swap matches the quote taken just before, field by field.
async function expectExecutionMatchesQuote(res: SendMessageResult, q: Quote, pool: SandboxContract<Pool>) {
    expect(q.code).toBe(0n);
    const evs = swapEvents(res);
    expect(evs.length).toBe(1);
    const ev = evs[0];
    expect(ev.amountOut).toBe(q.amountOut);
    expect(ev.amountIn).toBe(q.consumed + q.refFee);
    expect(ev.refFee).toBe(q.refFee);
    expect(ev.feeTotal).toBe(q.feeTotal);
    expect(ev.protocolFee).toBe(q.protocolFee);
    expect(ev.hookFee).toBe(q.hookFee);
    expect(ev.sqrtPriceX96).toBe(q.sqrtPriceAfter);
    expect(ev.tick).toBe(q.tickAfter);
    expect(ev.liquidity).toBe(q.liquidityAfter);
    expect(ev.crossings).toBe(q.crossings);
    expect(ev.steps).toBe(q.steps);
    expect(ev.stop).toBe(q.stop);
    const s = await snap(pool);
    expect(s.sqrtPriceX96).toBe(q.sqrtPriceAfter);
    expect(s.tick).toBe(q.tickAfter);
    expect(s.liquidity).toBe(q.liquidityAfter);
}

describe('v2 smoke: Gram/jetton concentrated liquidity', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    const positions: SandboxContract<Position>[] = [];
    const gas: Record<string, bigint> = {};

    beforeAll(async () => {
        d = await Dex.create();
        pool = await d.poolOf(GRAM, d.tokA, 60n, null);
    });

    afterAll(() => {
        // eslint-disable-next-line no-console
        console.log('measured gas (Pool compute phase):\n' +
            Object.entries(gas).map(([k, v]) => `  ${k}: ${v}`).join('\n'));
    });

    it('creates the pool and adds liquidity in a range (dual Gram + jetton mint)', async () => {
        // Price 1 jetton unit per Gram unit: sqrtP = 2^96, tick 0. Range [-600, 600] is about +-6%.
        const res = await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -600n, 600n, toNano('1000'),
            { sqrtPriceInit: Q96 });
        expectNoFailures(res);
        fees(res, 'first mint');
        gas['mint (init pool + 2 ticks + Position deploy)'] = gasAt(res, pool.address)[0];

        const ini = initEvents(res);
        expect(ini.length).toBe(1);
        expect(ini[0].sqrtPriceX96).toBe(Q96);
        expect(ini[0].tick).toBe(0n);

        const s = await pool.getGetPoolState();
        expect(s.initialized).toBe(true);
        expect(s.tick).toBe(0n);
        expect(s.sqrtPriceX96).toBe(Q96);
        expect(s.tickCount).toBe(2n);
        expect(s.nextPositionId).toBe(1n);
        expect(s.liquidity).toBeGreaterThan(0n);
        // Symmetric range at price 1 uses (almost) equal amounts; the rest is refunded.
        expect(s.reserve0).toBeLessThanOrEqual(toNano('1000'));
        expect(s.reserve1).toBeLessThanOrEqual(toNano('1000'));
        expect(s.reserve0).toBeGreaterThan(toNano('999'));
        expect(s.reserve1).toBeGreaterThan(toNano('999'));

        const m = modifyEvents(res)[0];
        expect(m.liquidityDelta).toBe(s.liquidity);
        expect(m.amount0).toBe(s.reserve0);
        expect(m.amount1).toBe(s.reserve1);

        const pos = await d.position(pool, 0n);
        const pd = await pos.getGetPositionData();
        expect(pd.initialized).toBe(true);
        expect(pd.owner.equals(d.alice.address)).toBe(true);
        expect(pd.tickLower).toBe(-600n);
        expect(pd.tickUpper).toBe(600n);
        expect(pd.liquidity).toBe(s.liquidity);
        positions.push(pos);
        await d.checkSolvency([pool]);
    });

    it('adds more ranges: wider, narrower, above (Gram only) and below (jetton only) the price', async () => {
        // index 1: [-1200, 1200]
        const q1 = await pool.getGetMintQuote(-1200n, 1200n, toNano('500'), toNano('500'), 0n);
        expect(q1.code).toBe(0n);
        let res = await d.mintJetton(d.jA, d.alice, toNano('500'), GRAM, -1200n, 1200n, toNano('500'));
        expectNoFailures(res);
        expect(modifyEvents(res)[0].liquidityDelta).toBe(q1.liquidity);
        expect(modifyEvents(res)[0].amount0).toBe(q1.use0);
        expect(modifyEvents(res)[0].amount1).toBe(q1.use1);
        // index 2: [-240, 240]
        res = await d.mintJetton(d.jA, d.alice, toNano('300'), GRAM, -240n, 240n, toNano('300'));
        expectNoFailures(res);
        // index 3: [60, 480] above the price: Gram only, via MintNative
        const q3 = await pool.getGetMintQuote(60n, 480n, toNano('200'), 0n, 0n);
        expect(q3.use1).toBe(0n);
        res = await d.mintNative(d.alice, toNano('200'), d.tokA, 60n, 480n);
        expectNoFailures(res);
        expect(modifyEvents(res)[0].amount0).toBe(q3.use0);
        expect(modifyEvents(res)[0].amount1).toBe(0n);
        // index 4: [-480, -60] below the price: jetton only
        const q4 = await pool.getGetMintQuote(-480n, -60n, 0n, toNano('200'), 0n);
        expect(q4.use0).toBe(0n);
        res = await d.mintJetton(d.jA, d.bob, toNano('200'), GRAM, -480n, -60n, 0n);
        expectNoFailures(res);
        gas['mint (2 new ticks + Position deploy)'] = gasAt(res, pool.address)[0];
        expect(modifyEvents(res)[0].amount1).toBe(q4.use1);
        expect(modifyEvents(res)[0].amount0).toBe(0n);

        for (let i = 1n; i <= 4n; i++) positions.push(await d.position(pool, i));
        expect((await positions[4].getGetPositionData()).owner.equals(d.bob.address)).toBe(true);

        const s = await pool.getGetPoolState();
        expect(s.tickCount).toBe(10n);
        expect(s.nextPositionId).toBe(5n);
        // Active L = positions 0, 1, 2 (3 is above, 4 below the current tick 0).
        let active = 0n;
        for (const i of [0, 1, 2]) active += (await positions[i].getGetPositionData()).liquidity;
        expect(s.liquidity).toBe(active);

        const ticks = await pool.getGetTicks(-887272n, 64n, true);
        expect([...ticks.keys()].sort((a, b) => a - b)).toEqual([-1200, -600, -480, -240, -60, 60, 240, 480, 600, 1200]);
        // TEP-62 collection view
        const cd = await pool.getGetCollectionData();
        expect(cd.nextItemIndex).toBe(5n);
        expect((await pool.getGetNftAddressByIndex(3n)).equals(positions[3].address)).toBe(true);
        await d.checkSolvency([pool]);
    });

    it('swaps Gram -> jetton inside the range (no crossing); quote == execution', async () => {
        const before = await d.jBal(d.jA, d.bob.address);
        const q = await pool.getGetQuote(true, toNano('1'), 0n, 24n, 0n, false);
        expect(q.code).toBe(0n);
        expect(q.crossings).toBe(0n);
        expect(q.stop).toBe(BigInt(STOP.FILLED));
        const res = await d.swapNative(d.bob, toNano('1'), d.tokA);
        expectNoFailures(res);
        fees(res, 'swap native in-range');
        gas['swap Gram->jetton, 0 crossings'] = gasAt(res, pool.address, 0x4d480021)[0];
        await expectExecutionMatchesQuote(res, q, pool);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(before + q.amountOut);
        // ~1 jetton minus the 0.3% base fee and a little price impact
        expect(q.amountOut).toBeGreaterThan(toNano('0.99'));
        expect(q.amountOut).toBeLessThan(toNano('0.997'));
        expect(q.protocolFee).toBe(q.feeTotal * 1000n / 10000n);
        await d.checkSolvency([pool]);
    });

    it('swaps jetton -> Gram inside the range; quote == execution', async () => {
        const q = await pool.getGetQuote(false, toNano('2'), 0n, 24n, 0n, false);
        expect(q.code).toBe(0n);
        expect(q.crossings).toBe(0n);
        const res = await d.swapJetton(d.jA, d.bob, toNano('2'), GRAM);
        expectNoFailures(res);
        gas['swap jetton->Gram, 0 crossings'] = gasAt(res, pool.address, 0x4d480021)[0];
        await expectExecutionMatchesQuote(res, q, pool);
        const pays = gramPayouts(res, d.bob.address).filter((p) => p.reason === 1);
        expect(pays.length).toBe(1);
        expect(pays[0].amount).toBe(q.amountOut);
        expect(pays[0].value).toBeGreaterThanOrEqual(q.amountOut);
        await d.checkSolvency([pool]);
    });

    it('swaps Gram -> jetton across several initialized ticks; quote == execution == model', async () => {
        // Size the input to stop just short of tick -900: crosses -60, -240, -480, -600.
        const reach = await pool.getGetQuote(true, toNano('100000'), M.sqrtAt(-900), 24n, 0n, true);
        expect(reach.stop).toBe(BigInt(STOP.LIMIT));
        const amount = reach.consumed * 98n / 100n;
        const q = await pool.getGetQuote(true, amount, 0n, 24n, 0n, false);
        expect(q.code).toBe(0n);
        expect(q.stop).toBe(BigInt(STOP.FILLED));
        expect(q.crossings).toBe(4n);
        expect(q.tickAfter).toBeLessThan(-600n);
        expectModelMatches(await modelOf(pool), q, true, amount, 0n, 24, BigInt(d.now));
        const before = await d.jBal(d.jA, d.carol.address);
        const res = await d.swapNative(d.carol, amount, d.tokA);
        expectNoFailures(res);
        fees(res, 'swap native multi-cross');
        gas[`swap Gram->jetton, ${q.crossings} crossings, ${q.steps} steps`] = gasAt(res, pool.address, 0x4d480021)[0];
        await expectExecutionMatchesQuote(res, q, pool);
        expect(await d.jBal(d.jA, d.carol.address)).toBe(before + q.amountOut);
        // Below -600 only the wide position [-1200, 1200] is active.
        expect((await snap(pool)).liquidity).toBe((await positions[1].getGetPositionData()).liquidity);
        await d.checkSolvency([pool]);
    });

    it('swaps jetton -> Gram back up across several ticks; quote == execution == model', async () => {
        d.chain.now = d.now + 60; // past the filter period: the volatility references refresh
        const reach = await pool.getGetQuote(false, toNano('100000'), M.sqrtAt(900), 24n, 0n, true);
        expect(reach.stop).toBe(BigInt(STOP.LIMIT));
        const amount = reach.consumed * 99n / 100n;
        const q = await pool.getGetQuote(false, amount, 0n, 24n, 0n, false);
        expect(q.code).toBe(0n);
        expect(q.crossings).toBe(8n);
        expect(q.tickAfter).toBeGreaterThan(600n);
        expectModelMatches(await modelOf(pool), q, false, amount, 0n, 24, BigInt(d.now));
        const res = await d.swapJetton(d.jA, d.carol, amount, GRAM);
        expectNoFailures(res);
        gas[`swap jetton->Gram, ${q.crossings} crossings, ${q.steps} steps`] = gasAt(res, pool.address, 0x4d480021)[0];
        await expectExecutionMatchesQuote(res, q, pool);
        const pays = gramPayouts(res, d.carol.address).filter((p) => p.reason === 1);
        expect(pays[0].amount).toBe(q.amountOut);
        // The volatility accumulator moved with the price.
        expect((await pool.getGetPoolState()).fs.volAcc).toBeGreaterThan(0n);
        await d.checkSolvency([pool]);
    });

    it('bounds a swap by maxCrossings: partial fill refunds the rest, otherwise full refund', async () => {
        const amount = toNano('3000');
        const qp = await pool.getGetQuote(true, amount, 0n, 1n, 0n, true);
        expect(qp.code).toBe(0n);
        expect(qp.stop).toBe(BigInt(STOP.CROSSINGS));
        expect(qp.crossings).toBe(1n);
        expect(qp.refund).toBeGreaterThan(0n);
        expect(qp.consumed + qp.refund).toBe(amount);

        // Not allowed to be partial: full refund, no state written.
        const s0 = await snap(pool);
        let res = await d.swapNative(d.bob, amount, d.tokA, { maxCrossings: 1n });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([222]);
        expect(await snap(pool)).toEqual(s0);
        const refund = gramPayouts(res, d.bob.address);
        expect(refund.length).toBe(1);
        expect(refund[0].amount).toBe(amount);

        // Partial allowed: the filled part executes exactly as quoted, the rest comes back.
        res = await d.swapNative(d.bob, amount, d.tokA, { maxCrossings: 1n, allowPartial: true });
        expectNoFailures(res);
        await expectExecutionMatchesQuote(res, qp, pool);
        const partial = gramPayouts(res, d.bob.address).filter((p) => p.reason === 10);
        expect(partial.length).toBe(1);
        expect(partial[0].amount).toBe(qp.refund);
        await d.checkSolvency([pool]);
    });

    it('removes liquidity (partial, then full) and collects fees; amounts match the getter', async () => {
        // Partial decrease of position 0.
        const p0 = positions[0];
        let pd = await p0.getGetPositionData();
        const half = pd.liquidity / 2n;
        let exp = await pool.getGetPositionAmounts(pd.tickLower, pd.tickUpper, pd.liquidity, pd.fgLast0, pd.fgLast1, half);
        expect(exp.fees0 + exp.fees1).toBeGreaterThan(0n);
        const jBefore = await d.jBal(d.jA, d.alice.address);
        let res = await d.decrease(p0, d.alice, half);
        expectNoFailures(res);
        gas['decrease (Pool side, 0 ticks deleted)'] = gasAt(res, pool.address, 0x4d480043)[0];
        let m = modifyEvents(res)[0];
        expect(m.liquidityDelta).toBe(-half);
        expect(m.amount0).toBe(exp.amount0);
        expect(m.amount1).toBe(exp.amount1);
        expect(m.fees0).toBe(exp.fees0);
        expect(m.fees1).toBe(exp.fees1);
        const g = gramPayouts(res, d.alice.address).filter((p) => p.reason === 11);
        expect(g[0].amount).toBe(exp.amount0 + exp.fees0);
        expect(await d.jBal(d.jA, d.alice.address)).toBe(jBefore + exp.amount1 + exp.fees1);
        pd = await p0.getGetPositionData();
        expect(pd.liquidity).toBe(half + ((await p0.getGetPositionData()).liquidity - half));
        expect(pd.busy).toBe(false);

        // Full removal of position 2 [-240, 240]: its two ticks are deleted.
        const p2 = positions[2];
        const pd2 = await p2.getGetPositionData();
        const tc = (await pool.getGetPoolState()).tickCount;
        exp = await pool.getGetPositionAmounts(pd2.tickLower, pd2.tickUpper, pd2.liquidity, pd2.fgLast0, pd2.fgLast1, pd2.liquidity);
        res = await d.decrease(p2, d.alice, pd2.liquidity);
        expectNoFailures(res);
        gas['decrease (Pool side, 2 ticks deleted)'] = gasAt(res, pool.address, 0x4d480043)[0];
        m = modifyEvents(res)[0];
        expect(m.amount0 + m.fees0).toBe(exp.amount0 + exp.fees0);
        expect(m.amount1 + m.fees1).toBe(exp.amount1 + exp.fees1);
        expect((await p2.getGetPositionData()).liquidity).toBe(0n);
        expect((await pool.getGetPoolState()).tickCount).toBe(tc - 2n);
        expect(await pool.getGetTick(240n)).toBeNull();

        // Collect only on position 1 (wide range, in range during every swap).
        const p1 = positions[1];
        const pd1 = await p1.getGetPositionData();
        exp = await pool.getGetPositionAmounts(pd1.tickLower, pd1.tickUpper, pd1.liquidity, pd1.fgLast0, pd1.fgLast1, 0n);
        expect(exp.fees0).toBeGreaterThan(0n);
        expect(exp.fees1).toBeGreaterThan(0n);
        res = await d.decrease(p1, d.alice, 0n);
        expectNoFailures(res);
        gas['collect (Pool side)'] = gasAt(res, pool.address, 0x4d480043)[0];
        m = modifyEvents(res)[0];
        expect(m.fees0).toBe(exp.fees0);
        expect(m.fees1).toBe(exp.fees1);
        expect((await p1.getGetPositionData()).liquidity).toBe(pd1.liquidity);
        // A second collect right away yields nothing.
        exp = await pool.getGetPositionAmounts(pd1.tickLower, pd1.tickUpper, pd1.liquidity,
            (await p1.getGetPositionData()).fgLast0, (await p1.getGetPositionData()).fgLast1, 0n);
        expect(exp.fees0 + exp.fees1).toBe(0n);
        await d.checkSolvency([pool]);
    });

    it('everyone can exit: all positions withdrawn, the pool stays solvent', async () => {
        for (const [i, pos] of positions.entries()) {
            const pd = await pos.getGetPositionData();
            if (pd.liquidity === 0n) continue;
            const owner = pd.owner.equals(d.alice.address) ? d.alice : d.bob;
            const res = await d.decrease(pos, owner, pd.liquidity);
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([]);
            expect((await pos.getGetPositionData()).liquidity).toBe(0n);
            void i;
        }
        const s = await pool.getGetPoolState();
        expect(s.liquidity).toBe(0n);
        expect(s.tickCount).toBe(0n);
        // Only rounding dust (in the pool's favour) remains.
        expect(s.reserve0).toBeLessThan(1000n);
        expect(s.reserve1).toBeLessThan(1000n);
        await d.checkSolvency([pool]);
        // An empty book refunds a swap.
        const res = await d.swapNative(d.bob, toNano('1'), d.tokA);
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([223]);
    });
});

describe('v2 gas: per crossed tick and worst case', () => {
    const PRICE = 400n;                     // nanoGram per gas assumed by the constants (DESIGN §10)
    const SWAP_BASE_GAS = toNano('0.35');
    const CROSS_GAS = toNano('0.006');

    it('measures swaps crossing 1..24 adjacent initialized ticks', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        let res = await d.mintJetton(d.jA, d.alice, toNano('100'), GRAM, -60n, 60n, toNano('100'), { sqrtPriceInit: Q96 });
        expectNoFailures(res);
        // Adjacent ranges [i*60, (i+1)*60] below the price: one initialized tick per spacing.
        for (let i = -26; i <= -2; i++) {
            res = await d.mintJetton(d.jA, d.alice, toNano('5'), GRAM, BigInt(i * 60), BigInt((i + 1) * 60), 0n);
            expectNoFailures(res);
        }
        expect((await pool.getGetPoolState()).tickCount).toBe(27n);
        const base = d.chain.snapshot();
        const rows: bigint[][] = [];
        for (const k of [1, 2, 4, 8, 16, 24]) {
            await d.chain.loadFrom(base);
            const amount = toNano('10000');
            const q = await pool.getGetQuote(true, amount, 0n, BigInt(k), 0n, true);
            expect(q.crossings).toBe(BigInt(k));
            const need = SWAP_BASE_GAS + BigInt(k) * CROSS_GAS + toNano('0.07');
            res = await d.swapNative(d.bob, amount, d.tokA, { maxCrossings: BigInt(k), allowPartial: true, gas: need + toNano('0.03') });
            expectNoFailures(res);
            expect(swapEvents(res)[0].amountOut).toBe(q.amountOut);
            const g = gasAt(res, pool.address, 0x4d480021)[0];
            rows.push([BigInt(k), q.steps, g]);
            // At 400 nanoGram/gas the Router's requirement still covers the compute fee.
            expect(g * PRICE).toBeLessThan(SWAP_BASE_GAS + BigInt(k) * CROSS_GAS);
        }
        const perCross = (rows[rows.length - 1][2] - rows[0][2]) / 23n;
        // eslint-disable-next-line no-console
        console.log('crossings | steps | gas\n' + rows.map((r) => r.join(' | ')).join('\n') + `\nper crossing ~ ${perCross} gas (27-tick map)`);
    });

    it('48-step swap (virtual fee checkpoints only) stays bounded', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        let res = await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -887220n, 887220n, toNano('1000'), { sqrtPriceInit: Q96 });
        expectNoFailures(res);
        // A never-pinning maxVolAcc keeps every checkpoint (default presets skip them once va pins).
        await patchMaxVolAcc(d.chain, pool.address, 4_000_000_000n);
        const amount = toNano('5000000');
        const q = await pool.getGetQuote(true, amount, 0n, 1n, 0n, true);
        expect(q.steps).toBe(48n);
        expect(q.stop).toBe(BigInt(STOP.STEPS));
        res = await d.swapNative(d.bob, amount, d.tokA, { maxCrossings: 1n, allowPartial: true, gas: toNano('0.45') });
        expectNoFailures(res);
        expect(swapEvents(res)[0].amountOut).toBe(q.amountOut);
        const g = gasAt(res, pool.address, 0x4d480021)[0];
        // eslint-disable-next-line no-console
        console.log(`48-step swap: steps ${q.steps}, stop ${q.stop}, gas ${g}, per step ~ ${(g - 100000n) / 47n}`);
        expect(g * PRICE).toBeLessThan(SWAP_BASE_GAS + CROSS_GAS);
    });

    it('20 crossings + 20 checkpoints (the most under the gas stop) on a ~300-tick map stays below 1M gas', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        // Seed [-960, 960], then ranges [i*960, (i+1)*960] below: a crossing every 16 spacings with
        // a checkpoint (every 8 spacings) in between, so a long downward swap alternates
        // checkpoint, crossing, checkpoint, crossing ...
        let res = await d.mintJetton(d.jA, d.alice, toNano('100'), GRAM, -960n, 960n, toNano('100'), { sqrtPriceInit: Q96 });
        expectNoFailures(res);
        for (let i = -27; i <= -2; i++) {
            res = await d.mintJetton(d.jA, d.alice, toNano('5'), GRAM, BigInt(i * 960), BigInt((i + 1) * 960), 0n);
            expectNoFailures(res);
        }
        // Make the tick map bigger with small ranges far above the price (Gram only).
        for (let j = 0; j < 140; j++) {
            res = await d.mintNative(d.alice, toNano('1'), d.tokA, BigInt(2040 + j * 120), BigInt(2100 + j * 120));
            expectNoFailures(res);
        }
        const tc = (await pool.getGetPoolState()).tickCount;
        expect(tc).toBeGreaterThanOrEqual(300n);
        await patchMaxVolAcc(d.chain, pool.address, 4_000_000_000n);
        const amount = toNano('100000');
        const q = await pool.getGetQuote(true, amount, 0n, 20n, 0n, true);
        expect(q.crossings).toBe(20n);
        expect(q.steps).toBe(40n);
        const need = SWAP_BASE_GAS + 20n * CROSS_GAS + toNano('0.07');
        res = await d.swapNative(d.bob, amount, d.tokA, { maxCrossings: 20n, allowPartial: true, gas: need + toNano('0.03') });
        expectNoFailures(res);
        expect(swapEvents(res)[0].amountOut).toBe(q.amountOut);
        const g = gasAt(res, pool.address, 0x4d480021)[0];
        // eslint-disable-next-line no-console
        console.log(`worst case (24 crossings + 24 checkpoints, ${tc} ticks): gas ${g}`);
        expect(g).toBeLessThan(1_000_000n);
        expect(g * PRICE).toBeLessThan(SWAP_BASE_GAS + 20n * CROSS_GAS);
    });
});

describe('v2 smoke: other entry points (graduation, hooks, jetton/jetton via MintAccount, protocol fees)', () => {
    it('graduation: one jetton transfer seeds a locked full-range position whose fees stay claimable', async () => {
        const d = await Dex.create();
        // alice plays the launch master; carol is the fee claimer.
        const gram = toNano('100');
        const jet = toNano('400000');
        const payload = d.graduatePayload(gram, d.carol.address, d.alice.address,
            { launchFeePips: 100000n, launchDuration: 3600n });
        expect(payload.bits.length).toBeLessThanOrEqual(1023);
        expect(payload.refs.length).toBe(0);
        const poolAddr = await d.router.getGetGraduationPoolAddress(d.tokA, 60n, d.alice.address, 100000n, 3600n);
        const pool = d.chain.openContract(Pool.fromAddress(poolAddr));
        let res = await d.sendJettons(d.jA, d.alice, jet, gram + toNano('0.6'), eitherRefOf(payload));
        expectNoFailures(res);
        const ini = initEvents(res);
        expect(ini.length).toBe(1);
        expect(ini[0].graduation).toBe(true);
        const s = await pool.getGetPoolState();
        expect(s.initialized).toBe(true);
        // price = 4000 jetton per Gram -> tick ~ ln(4000)/ln(1.0001) = 82944
        expect(Number(s.tick)).toBeGreaterThanOrEqual(82940);
        expect(Number(s.tick)).toBeLessThanOrEqual(82946);
        const pos = await d.position(pool, 0n);
        const pd = await pos.getGetPositionData();
        expect(pd.owner.equals(d.carol.address)).toBe(true);
        expect(pd.lockedUntil).toBe(0xFFFFFFFFn);
        expect(pd.tickLower).toBe(-887220n);
        expect(pd.tickUpper).toBe(887220n);
        // Launch fee is active right after graduation and decays to 0 after an hour.
        expect((await pool.getGetPoolState()).feePipsNow).toBeGreaterThan(100000n);

        // Squatting: a second graduation into the same key refunds; a plain mint by bob cannot
        // initialize a key whose initializer is alice (it is already initialized anyway).
        res = await d.sendJettons(d.jA, d.alice, jet, gram + toNano('0.6'), eitherRefOf(payload));
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([231]);

        // A swap generates fees; the locked position cannot withdraw but carol can collect.
        d.chain.now = d.now + 4000;
        res = await d.swapNative(d.bob, toNano('1'), d.tokA, { ext: s.key.ext });
        expectNoFailures(res);
        res = await d.decrease(pos, d.carol, 1000n);
        expect(res.transactions).toHaveTransaction({ to: pos.address, success: false });
        expect((await pos.getGetPositionData()).liquidity).toBe(pd.liquidity);
        const before = await d.gram(d.carol.address);
        res = await d.decrease(pos, d.carol, 0n);
        expectNoFailures(res);
        const m = modifyEvents(res)[0];
        expect(m.fees0).toBeGreaterThan(0n);
        expect(await d.gram(d.carol.address)).toBeGreaterThan(before - toNano('0.3') + m.fees0);
        await d.checkSolvency([pool]);
    });

    it('hooks: after-swap / after-modify notifications, hook fee share, hook-set fee, broken hook is harmless', async () => {
        const d = await Dex.create();
        const hook = d.chain.openContract(await TestHook.fromInit(d.carol.address, 0n));
        await hook.send(d.carol.getSender(), { value: toNano('1') }, null);
        const ext = extCell({ hook: hook.address, hookFlags: 7n, hookShareBps: 1000n, hookFeeMin: 1000n, hookFeeMax: 5000n });
        expect(await d.router.getGetExtValid(ext)).toBe(7n);
        const pool = await d.poolOf(GRAM, d.tokB, 60n, ext);
        let res = await d.mintJetton(d.jB, d.alice, toNano('1000'), GRAM, -600n, 600n, toNano('1000'), { ext, sqrtPriceInit: Q96 });
        expectNoFailures(res);
        const q = await pool.getGetQuote(true, toNano('10'), 0n, 24n, 0n, false);
        expect(q.hookFee).toBeGreaterThan(0n);
        res = await d.swapNative(d.bob, toNano('10'), d.tokB, { ext });
        expectNoFailures(res);
        expect(swapEvents(res)[0].hookFee).toBe(q.hookFee);
        expect(await hook.getCounts()).toBe(1_000_001n);
        expect((await hook.getLastSwap())!.amountOut).toBe(q.amountOut);
        expect((await pool.getGetPoolState()).hookFees0).toBe(q.hookFee);

        // FEE_CONTROL within the key bounds, effective from the next swap.
        res = await hook.send(d.carol.getSender(), { value: toNano('0.2') }, {
            $$type: 'HookCmd', target: pool.address, value: toNano('0.05'), bounce: true,
            body: beginCell().store(storeHookSetFee({ $$type: 'HookSetFee', queryId: 0n, feePips: 5000n })).endCell(),
        });
        expectNoFailures(res);
        const st = await pool.getGetPoolState();
        expect(st.fs.hookFeeSet).toBe(true);
        expect(st.fs.hookFeePips).toBe(5000n);
        // Out of bounds is refused (the pool throws, the hook gets a bounce).
        res = await hook.send(d.carol.getSender(), { value: toNano('0.2') }, {
            $$type: 'HookCmd', target: pool.address, value: toNano('0.05'), bounce: true,
            body: beginCell().store(storeHookSetFee({ $$type: 'HookSetFee', queryId: 0n, feePips: 6000n })).endCell(),
        });
        expect(res.transactions).toHaveTransaction({ to: pool.address, success: false });
        expect((await pool.getGetPoolState()).fs.hookFeePips).toBe(5000n);

        // The hook collects its share.
        res = await hook.send(d.carol.getSender(), { value: toNano('0.5') }, {
            $$type: 'HookCmd', target: pool.address, value: toNano('0.3'), bounce: true,
            body: beginCell().store(storeHookCollectFees({ $$type: 'HookCollectFees', queryId: 0n })).endCell(),
        });
        expectNoFailures(res);
        const paid = gramPayouts(res, hook.address).filter((p) => p.reason === 12);
        expect(paid[0].amount).toBe(q.hookFee);
        expect((await pool.getGetPoolState()).hookFees0).toBe(0n);

        // A hook that throws on every notification cannot affect swaps.
        const bad = d.chain.openContract(await TestHook.fromInit(d.carol.address, 1n));
        await bad.send(d.carol.getSender(), { value: toNano('1') }, null);
        const ext2 = extCell({ hook: bad.address, hookFlags: 3n });
        const pool2 = await d.poolOf(GRAM, d.tokB, 60n, ext2);
        res = await d.mintJetton(d.jB, d.alice, toNano('100'), GRAM, -600n, 600n, toNano('100'), { ext: ext2, sqrtPriceInit: Q96 });
        expectNoFailures(res, (tx) => tx.inMessage?.info.dest?.toString() === bad.address.toString());
        const q2 = await pool2.getGetQuote(true, toNano('1'), 0n, 24n, 0n, false);
        res = await d.swapNative(d.bob, toNano('1'), d.tokB, { ext: ext2 });
        expectNoFailures(res, (tx) => tx.inMessage?.info.dest?.toString() === bad.address.toString());
        expect(swapEvents(res)[0].amountOut).toBe(q2.amountOut);
        await d.checkSolvency([pool, pool2]);

        // An invalid ext (flags without a hook) is refused with BAD_KEY.
        const badExt = extCell({ hookFlags: 1n });
        expect(await d.router.getGetExtValid(badExt)).toBe(-1n);
        res = await d.swapJetton(d.jB, d.bob, toNano('1'), GRAM, { ext: badExt });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([227]);
    });

    it('jetton/jetton in-range mint via MintAccount, swap, protocol fee collection to the treasury', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(d.tokA, d.tokB, 60n, null);
        let res = await d.mintJetton(d.jA, d.alice, toNano('1000'), d.tokB, -600n, 600n, 0n, { viaAccount: true, sqrtPriceInit: Q96 });
        expectNoFailures(res);
        expect((await pool.getGetPoolState()).initialized).toBe(false);
        res = await d.mintJetton(d.jB, d.alice, toNano('1000'), d.tokA, -600n, 600n, 0n, { viaAccount: true, sqrtPriceInit: Q96 });
        expectNoFailures(res);
        const s = await pool.getGetPoolState();
        expect(s.initialized).toBe(true);
        expect(s.nextPositionId).toBe(1n);
        expect(s.reserve0).toBeGreaterThan(toNano('999'));
        expect(s.reserve1).toBeGreaterThan(toNano('999'));

        const aIs0 = s.key.token0.equals(d.tokA);
        const q = await pool.getGetQuote(aIs0, toNano('10'), 0n, 24n, 0n, false);
        const before = await d.jBal(d.jB, d.bob.address);
        res = await d.swapJetton(d.jA, d.bob, toNano('10'), d.tokB);
        expectNoFailures(res);
        expect(await d.jBal(d.jB, d.bob.address)).toBe(before + q.amountOut);
        await d.checkSolvency([pool]);

        // Anyone may trigger protocol fee collection; the fees only ever go to the treasury.
        const key = { $$type: 'PoolKey' as const, token0: s.key.token0, token1: s.key.token1, tickSpacing: 60n, ext: null };
        const tBefore = await d.jBal(d.jA, d.treasury.address);
        res = await d.router.send(d.carol.getSender(), { value: toNano('0.35') }, { $$type: 'CollectProtocolFees', queryId: 0n, key });
        expectNoFailures(res);
        expect(await d.jBal(d.jA, d.treasury.address)).toBe(tBefore + q.protocolFee);
        const after = await pool.getGetPoolState();
        expect(after.protocolFees0 + after.protocolFees1).toBe(0n);
        await d.checkSolvency([pool]);
    });
});
