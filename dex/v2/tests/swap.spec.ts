// Swap suite: exact quote == execution == independent model for all three directions, within a
// range, across 1/8/24 initialized ticks, through empty ranges and virtual fee checkpoints; price
// limits; maxCrossings / MAX_STEPS stops with partial fill and continuation; refunds (slippage,
// deadline at the Router and at the Pool, not initialized, no liquidity, bad limit, bad crossings,
// dust); referral on full and partial fills; forward payloads; and gas at exactly the minimum.

import { Address, beginCell, Cell, toNano } from '@ton/core';
import { SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, STOP, CODES, REASON, Pool, expectNoFailures, swapEvents, refundCodes, gramPayouts, simOf,
    expectPoolEquals, msg, stepN, drain, failedAt, findMin, extCell, encodeSqrtPrice, storeSwapNative, gasAt,
    TestJettonWallet, patchMaxVolAcc,
} from './helpers';
import { TestHook } from '../build/TestHook_TestHook';
import * as M from './model';

jest.setTimeout(900000);

// Quote, model and execution of one swap; returns the model outcome. `send` performs the swap.
async function exact(pool: SandboxContract<Pool>, ext: M.ExtModel, zfo: boolean, amount: bigint,
                     o: { limit?: bigint; maxCrossings?: number; refBps?: bigint; allowPartial?: boolean; minOut?: bigint },
                     t: number, send: () => Promise<SendMessageResult>) {
    const sim = await simOf(pool, ext);
    const lim = o.limit ?? 0n;
    const mc = o.maxCrossings ?? 24;
    const rb = o.refBps ?? 0n;
    const ap = o.allowPartial ?? false;
    const q = await pool.getGetQuote(zfo, amount, lim, BigInt(mc), rb, ap);
    const e = sim.swap(zfo, amount, lim, mc, rb, ap, o.minOut ?? 0n, BigInt(t));
    expect([q.amountOut, q.consumed, q.refFee, q.refund, q.feeTotal, q.protocolFee, q.hookFee, q.sqrtPriceAfter, q.tickAfter,
        q.liquidityAfter, q.crossings, q.steps, q.stop]).toEqual([e.out, e.consumed, e.refFee, e.refund, e.feeTotal, e.proto,
        e.hook, e.sqrtP, BigInt(e.tick), e.L, BigInt(e.crossings), BigInt(e.steps), BigInt(e.stop)]);
    const res = await send();
    expectNoFailures(res);
    if (e.code === 0) {
        const ev = swapEvents(res);
        expect(ev.length).toBe(1);
        expect([ev[0].amountOut, ev[0].amountIn, ev[0].refFee, ev[0].feeTotal, ev[0].protocolFee, ev[0].hookFee,
            ev[0].sqrtPriceX96, ev[0].tick, ev[0].liquidity, ev[0].crossings, ev[0].steps, ev[0].stop]).toEqual([
            e.out, e.consumed + e.refFee, e.refFee, e.feeTotal, e.proto, e.hook, e.sqrtP, BigInt(e.tick), e.L,
            BigInt(e.crossings), BigInt(e.steps), BigInt(e.stop)]);
    } else {
        expect(refundCodes(res)).toEqual([e.code]);
        expect(swapEvents(res)).toEqual([]);
    }
    await expectPoolEquals(pool, sim);
    return { e, res, q };
}

// Gram/A spacing 60 at price 1: overlapping ranges around the price, a ladder of adjacent ranges
// below (one initialized tick per spacing from -1560 to -60), a liquidity gap above 1200 and an
// isolated range [3000, 3600] above it.
async function ladderPool(d: Dex) {
    const pool = await d.poolOf(GRAM, d.tokA, 60n, null);
    expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -600n, 600n, toNano('1000'), { sqrtPriceInit: Q96 }));
    expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('500'), GRAM, -1200n, 1200n, toNano('500')));
    expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('300'), GRAM, -240n, 240n, toNano('300')));
    for (let i = -26; i <= -2; i++) {
        expectNoFailures(await d.mintJetton(d.jA, d.bob, toNano('5'), GRAM, BigInt(i * 60), BigInt((i + 1) * 60), 0n));
    }
    expectNoFailures(await d.mintNative(d.carol, toNano('50'), d.tokA, 3000n, 3600n));
    return pool;
}

describe('swap: directions, exactness, crossings', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    let base: any;

    beforeAll(async () => {
        d = await Dex.create();
        pool = await ladderPool(d);
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('Gram -> jetton in range: exact, user receives exactly the quoted jettons', async () => {
        const before = await d.jBal(d.jA, d.bob.address);
        const { e } = await exact(pool, M.PLAIN_EXT, true, toNano('3'), {}, d.now, () => d.swapNative(d.bob, toNano('3'), d.tokA));
        expect(e.crossings).toBe(0);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(before + e.out);
    });

    it('jetton -> Gram in range: exact, GramPayout carries exactly the quoted amount', async () => {
        const before = await d.jBal(d.jA, d.bob.address);
        const { e, res } = await exact(pool, M.PLAIN_EXT, false, toNano('3'), {}, d.now,
            () => d.swapJetton(d.jA, d.bob, toNano('3'), GRAM));
        expect(await d.jBal(d.jA, d.bob.address)).toBe(before - toNano('3'));
        const p = gramPayouts(res, d.bob.address).filter((x) => x.reason === REASON.SWAP_OUT);
        expect(p.map((x) => x.amount)).toEqual([e.out]);
        expect(p[0].value).toBeGreaterThanOrEqual(e.out);
    });

    it('crosses exactly 1, 8 and 24 initialized ticks on the ladder (quote == exec == model)', async () => {
        for (const want of [1, 8, 24]) {
            await d.chain.loadFrom(base);
            // Find an input that crosses `want` ticks with the cap at 24: price limit just past the target tick.
            const sim = await simOf(pool);
            const ticksBelow = [...sim.ticks.keys()].filter((t) => t <= 0).sort((a, b) => b - a);
            const target = ticksBelow[want - 1];
            // Limit exactly on the target tick: v3 crosses it, and the cap check after the 24th
            // crossing does not fire because the limit is reached at the same time.
            const lim = M.sqrtAt(target);
            const reach = sim.swap(true, toNano('100000'), lim, 24, 0n, true, 0n, BigInt(d.now), false);
            expect(reach.stop).toBe(STOP.LIMIT);
            expect(reach.crossings).toBe(want);
            const amount = reach.consumed;
            const { e } = await exact(pool, M.PLAIN_EXT, true, amount, {}, d.now, () => d.swapNative(d.carol, amount, d.tokA));
            expect(e.crossings).toBe(want);
            expect(e.stop).toBe(STOP.FILLED);
        }
    });

    it('jumps through an empty range: L = 0 step is free and lands on the next initialized tick', async () => {
        // Up past 1200 (the last tick of the dense area): from 1200 to 3000 there is no liquidity.
        const sim = await simOf(pool);
        const r = sim.swap(false, toNano('100000'), M.sqrtAt(3300), 24, 0n, true, 0n, BigInt(d.now), false);
        expect(r.stop).toBe(STOP.LIMIT);
        const { e } = await exact(pool, M.PLAIN_EXT, false, r.consumed, {}, d.now, () => d.swapJetton(d.jA, d.carol, r.consumed, GRAM));
        expect(e.tick).toBeGreaterThanOrEqual(3000);
        expect(e.L).toBeGreaterThan(0n);
        // Crossed 240, 600, 1200 (L -> 0) and 3000 (L -> range).
        expect(e.crossings).toBe(4);
        const st = await pool.getGetPoolState();
        expect(st.tick).toBeGreaterThanOrEqual(3000n);
        expect(st.tick).toBeLessThanOrEqual(3300n);
    });

    it('NO_LIQUIDITY: beyond the last initialized tick the swap stops (partial) or refunds (not partial)', async () => {
        const amount = toNano('100000');
        let o = await exact(pool, M.PLAIN_EXT, false, amount, { allowPartial: true }, d.now,
            () => d.swapJetton(d.jA, d.carol, amount, GRAM, { allowPartial: true }));
        expect(o.e.stop).toBe(STOP.NO_LIQUIDITY);
        expect(o.e.L).toBe(0n);
        expect(o.e.refund).toBeGreaterThan(0n);
        // Now the book above is empty: another buy is refunded with NO_LIQUIDITY.
        o = await exact(pool, M.PLAIN_EXT, false, toNano('1'), {}, d.now, () => d.swapJetton(d.jA, d.carol, toNano('1'), GRAM));
        expect(o.e.code).toBe(CODES.NO_LIQUIDITY);
    });

    it('price limit: stops exactly at the limit; equality on an initialized tick crosses it (v3)', async () => {
        // Limit inside a range: stop LIMIT, partial fill refunds the rest.
        const lim = M.sqrtAt(-150) + 12345n;
        let o = await exact(pool, M.PLAIN_EXT, true, toNano('1000'), { limit: lim, allowPartial: true }, d.now,
            () => d.swapNative(d.bob, toNano('1000'), d.tokA, { limit: lim, allowPartial: true }));
        expect(o.e.stop).toBe(STOP.LIMIT);
        expect(o.e.sqrtP).toBe(lim);
        const partial = gramPayouts(o.res, d.bob.address).filter((x) => x.reason === REASON.PARTIAL_REFUND);
        expect(partial.map((x) => x.amount)).toEqual([o.e.refund]);
        // Not partial: same limit → PARTIAL_NOT_ALLOWED refund of the whole input.
        await d.chain.loadFrom(base);
        o = await exact(pool, M.PLAIN_EXT, true, toNano('1000'), { limit: lim }, d.now,
            () => d.swapNative(d.bob, toNano('1000'), d.tokA, { limit: lim }));
        expect(o.e.code).toBe(CODES.PARTIAL_NOT_ALLOWED);
        expect(gramPayouts(o.res, d.bob.address).filter((x) => x.reason === REASON.SWAP_REFUND).map((x) => x.amount)).toEqual([toNano('1000')]);
        // Limit exactly on initialized tick -240: crossed, tick ends at -241 with the range removed.
        await d.chain.loadFrom(base);
        const L0 = (await pool.getGetPoolState()).liquidity;
        const l2 = M.sqrtAt(-240);
        o = await exact(pool, M.PLAIN_EXT, true, toNano('1000'), { limit: l2, allowPartial: true }, d.now,
            () => d.swapNative(d.bob, toNano('1000'), d.tokA, { limit: l2, allowPartial: true }));
        expect(o.e.stop).toBe(STOP.LIMIT);
        expect(o.e.tick).toBe(-241);
        expect(o.e.crossings).toBe(4); // -60, -120, -180 (ladder) and -240 itself
        expect(o.e.L).toBeLessThan(L0);
    });

    it('maxCrossings stop: partial fill + refund; continuation by a second swap picks up exactly there', async () => {
        const amount = toNano('2000');
        const o1 = await exact(pool, M.PLAIN_EXT, true, amount, { maxCrossings: 3, allowPartial: true }, d.now,
            () => d.swapNative(d.bob, amount, d.tokA, { maxCrossings: 3n, allowPartial: true }));
        expect(o1.e.stop).toBe(STOP.CROSSINGS);
        expect(o1.e.crossings).toBe(3);
        expect(o1.e.consumed + o1.e.refund).toBe(amount);
        // Continuation (SDK-side split): the refunded remainder goes in a new swap from the new state.
        const o2 = await exact(pool, M.PLAIN_EXT, true, o1.e.refund, { maxCrossings: 3, allowPartial: true }, d.now,
            () => d.swapNative(d.bob, o1.e.refund, d.tokA, { maxCrossings: 3n, allowPartial: true }));
        expect(o2.e.crossings).toBeGreaterThan(0);
        expect(o2.e.sqrtP).toBeLessThan(o1.e.sqrtP);
        // Not partial: full refund, no state written (exact() also asserts the pool is unchanged).
        const o3 = await exact(pool, M.PLAIN_EXT, true, amount, { maxCrossings: 1 }, d.now,
            () => d.swapNative(d.bob, amount, d.tokA, { maxCrossings: 1n }));
        expect(o3.e.code).toBe(CODES.PARTIAL_NOT_ALLOWED);
        expect(o3.q.stop).toBe(BigInt(STOP.CROSSINGS));
    });

    it('slippage: minOut == quote passes, minOut == quote + 1 refunds everything', async () => {
        const q = await pool.getGetQuote(true, toNano('10'), 0n, 24n, 0n, false);
        let o = await exact(pool, M.PLAIN_EXT, true, toNano('10'), { minOut: q.amountOut + 1n }, d.now,
            () => d.swapNative(d.bob, toNano('10'), d.tokA, { minOut: q.amountOut + 1n }));
        expect(o.e.code).toBe(CODES.SLIPPAGE);
        o = await exact(pool, M.PLAIN_EXT, true, toNano('10'), { minOut: q.amountOut }, d.now,
            () => d.swapNative(d.bob, toNano('10'), d.tokA, { minOut: q.amountOut }));
        expect(o.e.out).toBe(q.amountOut);
    });

    it('referral: full fill pays R = X*bps/1e4; partial fill pays only on the consumed part', async () => {
        const ref = await d.chain.treasury('ref');
        const X = toNano('10');
        let o = await exact(pool, M.PLAIN_EXT, true, X, { refBps: 10n }, d.now,
            () => d.swapNative(d.bob, X, d.tokA, { referral: ref.address, refBps: 10n }));
        expect(o.e.refFee).toBe(X * 10n / 10000n);
        expect(o.e.consumed).toBe(X - o.e.refFee);
        expect(gramPayouts(o.res, ref.address).map((x) => [x.reason, x.amount])).toEqual([[REASON.REFERRAL, o.e.refFee]]);
        // Jetton-in referral is paid in the input jetton.
        const rb = await d.jBal(d.jA, ref.address);
        o = await exact(pool, M.PLAIN_EXT, false, X, { refBps: 7n }, d.now,
            () => d.swapJetton(d.jA, d.bob, X, GRAM, { referral: ref.address, refBps: 7n }));
        expect(await d.jBal(d.jA, ref.address)).toBe(rb + X * 7n / 10000n);
        // Partial fill (maxCrossings 1): referral = min(R, C*bps/(1e4-bps)), refund = X - C - ref.
        const big = toNano('3000');
        o = await exact(pool, M.PLAIN_EXT, true, big, { refBps: 10n, maxCrossings: 1, allowPartial: true }, d.now,
            () => d.swapNative(d.bob, big, d.tokA, { referral: ref.address, refBps: 10n, maxCrossings: 1n, allowPartial: true }));
        expect(o.e.refund).toBeGreaterThan(0n);
        expect(o.e.refFee).toBe(o.e.consumed * 10n / 9990n);
        expect(o.e.refFee).toBeLessThan(big * 10n / 10000n);
        expect(o.e.consumed + o.e.refFee + o.e.refund).toBe(big);
        // refBps without a referral is ignored (forced to 0).
        o = await exact(pool, M.PLAIN_EXT, true, X, {}, d.now, () => d.swapNative(d.bob, X, d.tokA, { refBps: 10n }));
        expect(o.e.refFee).toBe(0n);
    });

    it('dust: a 1-unit swap is refunded (ZERO_OUT) and writes no state; tiny swaps never pay out more than they take', async () => {
        let o = await exact(pool, M.PLAIN_EXT, true, 1n, {}, d.now, () => d.swapNative(d.bob, 1n, d.tokA));
        expect(o.e.code).toBe(CODES.ZERO_OUT);
        o = await exact(pool, M.PLAIN_EXT, false, 1n, {}, d.now, () => d.swapJetton(d.jA, d.bob, 1n, GRAM));
        expect(o.e.code).toBe(CODES.ZERO_OUT);
        for (const a of [2n, 7n, 100n, 1001n, 99999n]) {
            o = await exact(pool, M.PLAIN_EXT, true, a, {}, d.now, () => d.swapNative(d.bob, a, d.tokA));
            if (o.e.code === 0) expect(o.e.out).toBeLessThan(a);
        }
    });

    it('fwdTon / fwdPayload reach the receiver (jetton output notification, Gram output payload)', async () => {
        const recv = await d.chain.treasury('receiver');
        const payload = beginCell().storeUint(0xabcdef, 24).endCell();
        let res = await d.swapNative(d.bob, toNano('5'), d.tokA, { receiver: recv.address, fwdTon: toNano('0.05'), fwdPayload: payload });
        expectNoFailures(res);
        const recvWallet = await d.jWallet(d.jA, recv.address);
        expect(res.transactions).toHaveTransaction({ from: recvWallet.address, to: recv.address, op: 0x7362d09c, value: (v) => v! >= toNano('0.04') });
        res = await d.swapJetton(d.jA, d.bob, toNano('5'), GRAM, { receiver: recv.address, fwdPayload: payload });
        expectNoFailures(res);
        const tx = res.transactions.find((t) => t.inMessage?.info.dest instanceof Address && t.inMessage.info.dest.equals(recv.address))!;
        const b = tx.inMessage!.body.beginParse();
        expect(b.loadUint(32)).toBe(0x4d480061);
        b.loadUintBig(64);
        expect(b.loadUint(8)).toBe(REASON.SWAP_OUT);
        b.loadCoins();
        expect(b.loadMaybeRef()!.equals(payload)).toBe(true);
    });
});

describe('swap: refunds and validation (Router and Pool)', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    let base: any;

    beforeAll(async () => {
        d = await Dex.create();
        pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -600n, 600n, toNano('1000'), { sqrtPriceInit: Q96 }));
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('NOT_INITIALIZED: a swap into a key with no pool deploys it uninitialized and refunds everything', async () => {
        const p2 = await d.poolOf(GRAM, d.tokA, 10n, null);
        const jb = await d.jBal(d.jA, d.bob.address);
        let res = await d.swapJetton(d.jA, d.bob, toNano('5'), GRAM, { tickSpacing: 10n });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.NOT_INITIALIZED]);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb);
        expect((await p2.getGetPoolState()).initialized).toBe(false);
        res = await d.swapNative(d.bob, toNano('5'), d.tokA, { tickSpacing: 10n });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.NOT_INITIALIZED]);
        expect(gramPayouts(res, d.bob.address).map((x) => x.amount)).toEqual([toNano('5')]);
        expect((await p2.getGetQuote(true, 1000n, 0n, 1n, 0n, false)).code).toBe(BigInt(CODES.NOT_INITIALIZED));
    });

    it('BAD_PRICE_LIMIT: on the wrong side, at the current price, or at the extremes', async () => {
        const st = await pool.getGetPoolState();
        for (const [zfo, lim] of [[true, st.sqrtPriceX96], [true, st.sqrtPriceX96 + 1n], [false, st.sqrtPriceX96],
            [false, st.sqrtPriceX96 - 1n], [true, M.MIN_SQRT_RATIO], [false, M.MAX_SQRT_RATIO]] as [boolean, bigint][]) {
            const q = await pool.getGetQuote(zfo, toNano('1'), lim, 24n, 0n, false);
            expect(q.code).toBe(BigInt(CODES.BAD_PRICE_LIMIT));
            const res = zfo ? await d.swapNative(d.bob, toNano('1'), d.tokA, { limit: lim })
                : await d.swapJetton(d.jA, d.bob, toNano('1'), GRAM, { limit: lim });
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([CODES.BAD_PRICE_LIMIT]);
        }
        await expectPoolEquals(pool, await simOf(pool));
    });

    it('Router validation: crossings 0 / 25, refBps 11, same token, bad tick spacing, Router as recipient', async () => {
        const ref = d.carol.address;
        // Jetton entry: refunded with a code.
        const cases: [Partial<Parameters<Dex['swapJetton']>[4]>, Address, number][] = [
            [{ maxCrossings: 0n }, GRAM, CODES.BAD_CROSSINGS],
            [{ maxCrossings: 25n }, GRAM, CODES.BAD_CROSSINGS],
            [{ refBps: 11n, referral: ref }, GRAM, CODES.BAD_REF_BPS],
            [{}, d.tokA, CODES.SAME_TOKEN],
            [{ tickSpacing: 7n }, GRAM, CODES.BAD_TICK_SPACING],
            [{ receiver: d.router.address }, GRAM, CODES.BAD_RECIPIENT],
            [{ refundTo: d.router.address }, GRAM, CODES.BAD_RECIPIENT],
            [{ referral: d.router.address, refBps: 1n }, GRAM, CODES.BAD_RECIPIENT],
            [{ deadline: BigInt(d.now - 1) }, GRAM, CODES.DEADLINE],
        ];
        for (const [o, other, code] of cases) {
            const jb = await d.jBal(d.jA, d.bob.address);
            const res = await d.swapJetton(d.jA, d.bob, toNano('1'), other, o);
            expectNoFailures(res);
            expect([JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), refundCodes(res)])
                .toEqual([JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), [code]]);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(jb);
        }
        // Native entry: the Router throws and the bounce returns the Gram.
        for (const o of [{ maxCrossings: 0n }, { maxCrossings: 25n }, { refBps: 11n }, { tickSpacing: 7n },
            { receiver: d.router.address }, { deadline: BigInt(d.now - 1) }]) {
            const res = await d.swapNative(d.bob, toNano('1'), d.tokA, o);
            expect(failedAt(res, d.router.address).length).toBe(1);
            expect(res.transactions).toHaveTransaction({ from: d.router.address, to: d.bob.address, inMessageBounced: true });
        }
        // amount 0 and otherToken GRAM are refused too.
        let res = await d.swapNative(d.bob, 0n, d.tokA);
        expect(failedAt(res, d.router.address).length).toBe(1);
        res = await d.swapNative(d.bob, toNano('1'), GRAM);
        expect(failedAt(res, d.router.address).length).toBe(1);
        await expectPoolEquals(pool, await simOf(pool));
    });

    it('deadline at the Pool: valid at the Router, expired when the Pool runs → full refund, no state', async () => {
        const sim = await simOf(pool);
        const body = beginCell().store(storeSwapNative({
            $$type: 'SwapNative', queryId: 5n, amount: toNano('2'), otherToken: d.tokA, tickSpacing: 60n, ext: null,
            minOut: 0n, sqrtPriceLimitX96: 0n, maxCrossings: 24n, allowPartial: false, deadline: BigInt(d.now + 10),
            receiver: null, refundTo: null, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null,
        })).endCell();
        const { it, txs } = await stepN(d.chain, msg(d.bob.address, d.router.address, toNano('3'), body), 1);
        expect(txs.length).toBe(1);
        d.chain.now = d.now + 11;
        const rest = await drain(it);
        const res = { transactions: [...txs, ...rest] } as any;
        expect(refundCodes(res)).toEqual([CODES.DEADLINE]);
        expect(gramPayouts(res, d.bob.address).map((x) => x.amount)).toEqual([toNano('2')]);
        await expectPoolEquals(pool, sim);
    });

    it('MAX_STEPS stop on a full-range book with the volatility fee: 48 steps, partial or refund', async () => {
        const d2 = await Dex.create();
        const p = await d2.poolOf(GRAM, d2.tokA, 60n, null);
        expectNoFailures(await d2.mintJetton(d2.jA, d2.alice, toNano('1000'), GRAM, -887220n, 887220n, toNano('1000'), { sqrtPriceInit: Q96 }));
        // A never-pinning maxVolAcc keeps every checkpoint (default presets skip them once va pins).
        await patchMaxVolAcc(d2.chain, p.address, 4_000_000_000n);
        const amount = toNano('5000000');
        let o = await exact(p, M.PLAIN_EXT, true, amount, { allowPartial: true }, d2.now,
            () => d2.swapNative(d2.bob, amount, d2.tokA, { allowPartial: true }));
        expect(o.e.stop).toBe(STOP.STEPS);
        expect(o.e.steps).toBe(M.MAX_STEPS);
        expect(o.e.crossings).toBe(0);
        // The volatility fee rose during the swap: the last step paid more than the first.
        expect(o.e.lastFee).toBeGreaterThan(3000n);
        o = await exact(p, M.PLAIN_EXT, false, amount, {}, d2.now, () => d2.swapJetton(d2.jA, d2.bob, amount, GRAM));
        expect(o.e.code).toBe(CODES.PARTIAL_NOT_ALLOWED);
    });

    it('jetton/jetton pool: both directions exact', async () => {
        const pj = await d.poolOf(d.tokA, d.tokB, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), d.tokB, -1200n, 1200n, 0n, { viaAccount: true, sqrtPriceInit: Q96 }));
        // (audit R6A-6: both legs carry sqrtPriceInit, otherwise the mint is refunded and the pool stays empty)
        expectNoFailures(await d.mintJetton(d.jB, d.alice, toNano('1000'), d.tokA, -1200n, 1200n, 0n, { viaAccount: true, sqrtPriceInit: Q96 }));
        const st = await pj.getGetPoolState();
        expect(st.initialized).toBe(true);
        expect(st.liquidity).toBeGreaterThan(0n);
        const aIs0 = st.key.token0.equals(d.tokA);
        for (const [m, other, zfo] of [[d.jA, d.tokB, aIs0], [d.jB, d.tokA, !aIs0]] as const) {
            const outM = m === d.jA ? d.jB : d.jA;
            const before = await d.jBal(outM, d.bob.address);
            const { e } = await exact(pj, M.PLAIN_EXT, zfo, toNano('20'), {}, d.now, () => d.swapJetton(m, d.bob, toNano('20'), other));
            expect(e.out).toBeGreaterThan(0n);                     // a real swap, not a refund
            expect(await d.jBal(outM, d.bob.address)).toBe(before + e.out);
        }
        await d.checkSolvency([pj, pool]);
    });
});

describe('swap: gas at exactly the Router minimum (worst case: 24 crossings + checkpoints, referral, partial, hook)', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    let ext: Cell;
    let ref: SandboxContract<TreasuryContract>;
    const extM: M.ExtModel = { ...M.PLAIN_EXT, hookShareBps: 500n };
    let base: any;

    beforeEach(async () => {
        if (base) await d.chain.loadFrom(base);
    });

    beforeAll(async () => {
        d = await Dex.create();
        ref = await d.chain.treasury('ref');
        const hook = d.chain.openContract(await TestHook.fromInit(d.carol.address, 0n));
        await hook.send(d.carol.getSender(), { value: toNano('1') }, null);
        ext = extCell({ hook: hook.address, hookFlags: 3n, hookShareBps: 500n });
        pool = await d.poolOf(GRAM, d.tokA, 60n, ext);
        // Crossings every 16 spacings both ways, checkpoints (8 spacings) in between.
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('100'), GRAM, -960n, 960n, toNano('100'), { ext, sqrtPriceInit: Q96 }));
        for (let i = 1; i <= 27; i++) {
            expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('5'), GRAM, BigInt(-(i + 1) * 960), BigInt(-i * 960), 0n, { ext }));
            expectNoFailures(await d.mintNative(d.alice, toNano('5'), d.tokA, BigInt(i * 960), BigInt((i + 1) * 960), { ext }));
        }
        await patchMaxVolAcc(d.chain, pool.address, 4_000_000_000n);
        base = d.chain.snapshot();
    });

    it('native entry: min - 1 is refused by the Router; exactly min runs 20 crossings (the most that fit under the gas stop) to completion', async () => {
        const amount = toNano('100000');
        const o = { maxCrossings: 20n, allowPartial: true, referral: ref.address, refBps: 10n, ext };
        const q = await pool.getGetQuote(true, amount, 0n, 20n, 10n, true);
        expect(q.crossings).toBe(20n);
        expect(q.steps).toBe(40n);
        const min = await findMin(d.chain, toNano('0.3'), toNano('1'), async (g) => {
            const r = await d.swapNative(d.bob, amount, d.tokA, { ...o, gas: g });
            return failedAt(r, d.router.address).length === 0;
        });
        // swapGas = 0.35 + 20 * 0.006 + 0.07 (partial) + 0.07 (referral) + 0.01 (hook) + 2 fwd fees
        expect(min).toBeGreaterThan(toNano('0.62'));
        expect(min).toBeLessThan(toNano('0.636'));
        let res = await d.swapNative(d.bob, amount, d.tokA, { ...o, gas: min - 1n });
        expect(failedAt(res, d.router.address).length).toBe(1);
        expect(swapEvents(res)).toEqual([]);
        const sim = await simOf(pool, extM);
        const e = sim.swap(true, amount, 0n, 20, 10n, true, 0n, BigInt(d.now));
        res = await d.swapNative(d.bob, amount, d.tokA, { ...o, gas: min });
        expectNoFailures(res);
        expect(swapEvents(res)[0].amountOut).toBe(e.out);
        expect(gramPayouts(res, ref.address).map((x) => x.amount)).toEqual([e.refFee]);
        expect(gramPayouts(res, d.bob.address).filter((x) => x.reason === REASON.PARTIAL_REFUND).map((x) => x.amount)).toEqual([e.refund]);
        const g = gasAt(res, pool.address, 0x4d480021)[0];
        expect(g).toBeLessThan(1_000_000n);
        // eslint-disable-next-line no-console
        console.log(`worst-case native swap at the exact minimum value ${min}: pool gas ${g}`);
        await expectPoolEquals(pool, sim);
    });

    it('jetton entry: min - 1 → LOW_GAS refund of the jettons; exactly min runs 20 crossings (the most that fit under the gas stop)', async () => {
        const amount = toNano('100000');
        const o = { maxCrossings: 20n, allowPartial: true, referral: ref.address, refBps: 10n, ext };
        const min = await findMin(d.chain, toNano('0.3'), toNano('1'), async (g) => {
            const r = await d.swapJetton(d.jA, d.bob, amount, GRAM, { ...o, gas: g });
            return !refundCodes(r).includes(CODES.LOW_GAS);
        });
        const jb = await d.jBal(d.jA, d.bob.address);
        let res = await d.swapJetton(d.jA, d.bob, amount, GRAM, { ...o, gas: min - 1n });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.LOW_GAS]);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb);
        const sim = await simOf(pool, extM);
        const e = sim.swap(false, amount, 0n, 20, 10n, true, 0n, BigInt(d.now));
        expect(e.crossings).toBe(20);
        res = await d.swapJetton(d.jA, d.bob, amount, GRAM, { ...o, gas: min });
        expectNoFailures(res);
        expect(swapEvents(res)[0].amountOut).toBe(e.out);
        expect(gramPayouts(res, d.bob.address).filter((x) => x.reason === REASON.SWAP_OUT).map((x) => x.amount)).toEqual([e.out]);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb - amount + e.refund);
        expect(await d.jBal(d.jA, ref.address)).toBe(e.refFee);
        await expectPoolEquals(pool, sim);
        await d.checkSolvency([pool]);
        void TestJettonWallet;
    });
});
