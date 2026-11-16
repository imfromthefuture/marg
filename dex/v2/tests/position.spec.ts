// Position suite: mint entries (a)-(d) in/below/above range and on range edges, validation
// refunds, gas at exactly MINT_GAS, fee accrual across crossings, decrease/collect and every Pool
// reply path (success, deadline, slippage, bad recipient, bounce), the busy race, NFT transfer
// (TEP-62), MIN_LP_LOCK, and the MintAccount legs and refund.

import { Address, beginCell, Cell, toNano } from '@ton/core';
import { createShardAccount, SandboxContract, TreasuryContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, CODES, REASON, Pool, Position, MintAccount, expectNoFailures, modifyEvents, refundCodes,
    gramPayouts, simOf, expectPoolEquals, msg, stepN, drain, failedAt, findMin, extCell, encodeSqrtPrice,
    storePositionDecrease, storeNftTransfer, storePositionSync, storeMintAccountRefund, storeGetStaticData, events, OP,
} from './helpers';
import { TestHook } from '../build/TestHook_TestHook';
import * as M from './model';

jest.setTimeout(900000);

function decBody(delta: bigint, o: { queryId?: bigint; deadline: bigint; min0?: bigint; min1?: bigint; recipient?: Address | null }) {
    return beginCell().store(storePositionDecrease({
        $$type: 'PositionDecrease', queryId: o.queryId ?? 1n, liquidityDelta: delta, amount0Min: o.min0 ?? 0n,
        amount1Min: o.min1 ?? 0n, deadline: o.deadline, recipient: o.recipient ?? null,
    })).endCell();
}
function nftBody(newOwner: Address, resp: Address | null, fwd = 0n) {
    return beginCell().store(storeNftTransfer({
        $$type: 'NftTransfer', queryId: 3n, newOwner, responseDestination: resp, customPayload: null, forwardAmount: fwd,
        forwardPayload: beginCell().storeUint(0, 1).endCell().beginParse(),
    })).endCell();
}

describe('position: mint entries, edges and validation', () => {
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

    async function mintExact(send: () => Promise<any>, tL: number, tU: number, a0: bigint, a1: bigint, extra: { minL?: bigint } = {}) {
        const sim = await simOf(pool);
        const q = await pool.getGetMintQuote(BigInt(tL), BigInt(tU), a0, a1, 0n);
        const e = sim.mint(tL, tU, a0, a1, extra.minL ?? 0n, 0n, BigInt(d.now), M.PRESETS[60]);
        if (extra.minL === undefined) expect([q.code, q.liquidity, q.use0, q.use1]).toEqual([BigInt(e.code), e.liq, e.use0, e.use1]);
        const res = await send();
        expectNoFailures(res);
        if (e.code === 0) {
            const ev = modifyEvents(res);
            expect([ev[0].liquidityDelta, ev[0].amount0, ev[0].amount1]).toEqual([e.liq, e.use0, e.use1]);
        } else {
            expect(refundCodes(res)).toEqual([e.code]);
        }
        await expectPoolEquals(pool, sim);
        return { e, res };
    }

    it('entry (c) Gram only above the price, and on the lower edge at the exact price (only Gram needed, in range)', async () => {
        let o = await mintExact(() => d.mintNative(d.bob, toNano('10'), d.tokA, 60n, 600n), 60, 600, toNano('10'), 0n);
        expect(o.e.use1).toBe(0n);
        expect(o.e.use0).toBeGreaterThan(toNano('9.99'));
        // [0, 600] at sqrtP == sqrtAt(0): in range (L becomes active), yet amount1 = 0.
        const L0 = (await pool.getGetPoolState()).liquidity;
        o = await mintExact(() => d.mintNative(d.bob, toNano('10'), d.tokA, 0n, 600n), 0, 600, toNano('10'), 0n);
        expect(o.e.use1).toBe(0n);
        expect((await pool.getGetPoolState()).liquidity).toBe(L0 + o.e.liq);
    });

    it('entry (a) jetton only below the price, and on the upper edge at the price (out of range)', async () => {
        const jb = await d.jBal(d.jA, d.bob.address);
        let o = await mintExact(() => d.mintJetton(d.jA, d.bob, toNano('10'), GRAM, -600n, -60n, 0n), -600, -60, 0n, toNano('10'));
        expect(o.e.use0).toBe(0n);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb - o.e.use1);
        const L0 = (await pool.getGetPoolState()).liquidity;
        o = await mintExact(() => d.mintJetton(d.jA, d.bob, toNano('10'), GRAM, -600n, 0n, 0n), -600, 0, 0n, toNano('10'));
        expect((await pool.getGetPoolState()).liquidity).toBe(L0); // tick 0 is not < tU = 0
    });

    it('entry (b) dual in range: the unused part of each leg is refunded exactly', async () => {
        const jb = await d.jBal(d.jA, d.bob.address);
        const o = await mintExact(() => d.mintJetton(d.jA, d.bob, toNano('50'), GRAM, -120n, 1200n, toNano('50')), -120, 1200, toNano('50'), toNano('50'));
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb - o.e.use1);
        const back = gramPayouts(o.res, d.bob.address).filter((x) => x.reason === REASON.MINT_REFUND);
        if (o.e.use0 < toNano('50')) expect(back.map((x) => x.amount)).toEqual([toNano('50') - o.e.use0]);
        // A one-sided deposit into an in-range position gives zero liquidity: refunded.
        const r2 = await mintExact(() => d.mintNative(d.bob, toNano('10'), d.tokA, -120n, 120n), -120, 120, toNano('10'), 0n);
        expect(r2.e.code).toBe(CODES.LIQUIDITY_BELOW_MIN);
    });

    it('validation refunds: bad ticks, below min liquidity, minLiquidity, deadline, initialized pool ignores sqrtInit', async () => {
        for (const [tL, tU] of [[600, 600], [600, -600], [-610, 600], [-600, 650], [-887280, 600], [-600, 887280]]) {
            const o = await mintExact(() => d.mintNative(d.bob, toNano('1'), d.tokA, BigInt(tL), BigInt(tU)), tL, tU, toNano('1'), 0n);
            expect(o.e.code).toBe(CODES.BAD_TICKS);
        }
        let o = await mintExact(() => d.mintNative(d.bob, 1n, d.tokA, 60n, 120n), 60, 120, 1n, 0n);
        expect(o.e.code).toBe(CODES.LIQUIDITY_BELOW_MIN);
        const q = await pool.getGetMintQuote(60n, 120n, toNano('1'), 0n, 0n);
        o = await mintExact(() => d.mintNative(d.bob, toNano('1'), d.tokA, 60n, 120n, { minLiquidity: q.liquidity + 1n }), 60, 120, toNano('1'), 0n,
            { minL: q.liquidity + 1n });
        expect(o.e.code).toBe(CODES.LIQUIDITY_BELOW_MIN);
        o = await mintExact(() => d.mintNative(d.bob, toNano('1'), d.tokA, 60n, 120n, { minLiquidity: q.liquidity }), 60, 120, toNano('1'), 0n,
            { minL: q.liquidity });
        expect(o.e.code).toBe(0);
        // sqrtInit on an initialized pool is ignored.
        o = await mintExact(() => d.mintNative(d.bob, toNano('1'), d.tokA, 60n, 120n, { sqrtPriceInit: encodeSqrtPrice(9n, 1n) }), 60, 120, toNano('1'), 0n);
        expect(o.e.code).toBe(0);
        expect((await pool.getGetPoolState()).sqrtPriceX96).toBe(Q96);
        // Router-side deadline (jetton entry refunds; native throws).
        const res = await d.mintJetton(d.jA, d.bob, toNano('1'), GRAM, -600n, -60n, 0n, { deadline: BigInt(d.now - 1) });
        expect(refundCodes(res)).toEqual([CODES.DEADLINE]);
        const r2 = await d.mintNative(d.bob, toNano('1'), d.tokA, 60n, 120n, { deadline: BigInt(d.now - 1) });
        expect(failedAt(r2, d.router.address).length).toBe(1);
    });

    it('initialization: NOT_INITIALIZED without a price, PRICE_OUT_OF_RANGE, then the first price sticks', async () => {
        const p10 = await d.poolOf(GRAM, d.tokA, 10n, null);
        let res: any = await d.mintNative(d.bob, toNano('1'), d.tokA, 10n, 100n, { tickSpacing: 10n });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.NOT_INITIALIZED]);
        expect(gramPayouts(res, d.bob.address).filter((x) => x.reason === REASON.MINT_REFUND).map((x) => x.amount)).toEqual([toNano('1')]);
        for (const bad of [M.MIN_SQRT_RATIO - 1n, M.MAX_SQRT_RATIO]) {
            res = await d.mintNative(d.bob, toNano('1'), d.tokA, 10n, 100n, { tickSpacing: 10n, sqrtPriceInit: bad });
            expect(refundCodes(res)).toEqual([CODES.PRICE_OUT_OF_RANGE]);
        }
        expect((await p10.getGetMintQuote(10n, 100n, toNano('1'), 0n, M.MAX_SQRT_RATIO)).code).toBe(BigInt(CODES.PRICE_OUT_OF_RANGE));
        res = await d.mintNative(d.bob, toNano('1'), d.tokA, 10n, 100n, { tickSpacing: 10n, sqrtPriceInit: M.sqrtAt(-5) });
        expectNoFailures(res);
        const st = await p10.getGetPoolState();
        expect([st.initialized, st.tick, st.sqrtPriceX96, st.fs.baseFeePips, st.fs.startTs]).toEqual([true, -5n, M.sqrtAt(-5), 500n, BigInt(d.now)]);
    });

    it('Router mint validation: owner/refundTo == Router, gramAmount with viaAccount or on a jetton pair, gramAmount not attached', async () => {
        const cases: [() => Promise<any>, number][] = [
            [() => d.mintJetton(d.jA, d.bob, toNano('1'), GRAM, -600n, -60n, 0n, { owner: d.router.address }), CODES.BAD_RECIPIENT],
            [() => d.mintJetton(d.jA, d.bob, toNano('1'), GRAM, -600n, -60n, 0n, { refundTo: d.router.address }), CODES.BAD_RECIPIENT],
            [() => d.mintJetton(d.jA, d.bob, toNano('1'), GRAM, -600n, 600n, toNano('1'), { viaAccount: true }), CODES.BAD_PAYLOAD],
            [() => d.mintJetton(d.jA, d.bob, toNano('1'), GRAM, -600n, -60n, 0n, { viaAccount: true }), CODES.BAD_PAYLOAD],
            [() => d.mintJetton(d.jA, d.bob, toNano('1'), d.tokB, -600n, 600n, toNano('1')), CODES.BAD_PAYLOAD],
            [() => d.mintJetton(d.jA, d.bob, toNano('1'), GRAM, -600n, -60n, 0n, { tickSpacing: 3n }), CODES.BAD_TICK_SPACING],
            [() => d.mintJetton(d.jA, d.bob, toNano('1'), d.tokA, -600n, -60n, 0n), CODES.SAME_TOKEN],
        ];
        for (const [send, code] of cases) {
            const jb = await d.jBal(d.jA, d.bob.address);
            const res = await send();
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([code]);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(jb);
        }
        // Claiming a 1000 Gram leg while attaching ~0.6: LOW_GAS refund, no Gram is ever credited.
        const sim = await simOf(pool);
        const p = d.mintPayload(GRAM, -600n, 600n, toNano('1000'));
        const res = await d.sendJettons(d.jA, d.bob, toNano('1'), toNano('0.6'), beginCell().storeBit(1).storeRef(p).endCell().beginParse());
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.LOW_GAS]);
        await expectPoolEquals(pool, sim);
        // MintNative: owner == Router and refundTo == Router throw (bounce returns the Gram).
        for (const o of [{ owner: d.router.address }, { refundTo: d.router.address }, { tickSpacing: 3n }]) {
            const r = await d.mintNative(d.bob, toNano('1'), d.tokA, 60n, 120n, o);
            expect(failedAt(r, d.router.address).length).toBe(1);
        }
    });
});

describe('position: gas at exactly the minimum (MINT_GAS)', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    let ext: Cell;
    let base: any;

    beforeAll(async () => {
        d = await Dex.create();
        const hook = d.chain.openContract(await TestHook.fromInit(d.carol.address, 0n));
        await hook.send(d.carol.getSender(), { value: toNano('1') }, null);
        ext = extCell({ hook: hook.address, hookFlags: 2n });
        pool = await d.poolOf(GRAM, d.tokA, 60n, ext);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('100'), GRAM, -600n, 600n, toNano('100'), { ext, sqrtPriceInit: Q96 }));
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('MintNative (2 new ticks, hook notify): min - 1 refused by the Router, min mints', async () => {
        const min = await findMin(d.chain, toNano('0.2'), toNano('1'), async (g) => {
            const r = await d.mintNative(d.bob, toNano('5'), d.tokA, 1200n, 1800n, { ext, gas: g });
            return failedAt(r, d.router.address).length === 0;
        });
        let res: any = await d.mintNative(d.bob, toNano('5'), d.tokA, 1200n, 1800n, { ext, gas: min - 1n });
        expect(failedAt(res, d.router.address).length).toBe(1);
        res = await d.mintNative(d.bob, toNano('5'), d.tokA, 1200n, 1800n, { ext, gas: min });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        expect(modifyEvents(res).length).toBe(1);
        expect((await pool.getGetPoolState()).tickCount).toBe(4n);
    });

    it('dual Gram + jetton (two refund legs possible): min - 1 → LOW_GAS refund, min mints', async () => {
        const send = (g: bigint) => d.mintJetton(d.jA, d.bob, toNano('7'), GRAM, -1800n, 1200n, toNano('3'), { ext, gas: g });
        const min = await findMin(d.chain, toNano('0.2'), toNano('1'), async (g) => !refundCodes(await send(g)).includes(CODES.LOW_GAS));
        let res: any = await send(min - 1n);
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.LOW_GAS]);
        res = await send(min);
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        expect(modifyEvents(res).length).toBe(1);
    });

    it('jetton/jetton via MintAccount at the minimum on both legs: the second leg still covers the Pool mint', async () => {
        const pj = await d.poolOf(d.tokA, d.tokB, 60n, ext);
        const leg = (m: any, other: Address, g: bigint, init = 0n) =>
            d.mintJetton(m, d.bob, toNano('9'), other, -600n, 600n, 0n, { ext, viaAccount: true, gas: g, sqrtPriceInit: init });
        const min1 = await findMin(d.chain, toNano('0.2'), toNano('1'), async (g) => !refundCodes(await leg(d.jA, d.tokB, g, Q96)).includes(CODES.LOW_GAS));
        expectNoFailures(await leg(d.jA, d.tokB, min1, Q96));
        const min2 = await findMin(d.chain, toNano('0.2'), toNano('1'), async (g) => !refundCodes(await leg(d.jB, d.tokA, g, Q96)).includes(CODES.LOW_GAS));
        const res = await leg(d.jB, d.tokA, min2, Q96);
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        expect(modifyEvents(res).length).toBe(1);
        expect((await pj.getGetPoolState()).initialized).toBe(true);
        await d.checkSolvency([pj]);
    });
});

describe('position: fees, decrease / collect replies, concurrency, NFT', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    let base: any;
    let pA: SandboxContract<Position>;
    let pB: SandboxContract<Position>;
    let pC: SandboxContract<Position>;

    beforeAll(async () => {
        d = await Dex.create();
        pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        // A: [-600, 600] alice, B: [-120, 120] bob, C: [600, 1200] carol (above the price).
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -600n, 600n, toNano('1000'), { sqrtPriceInit: Q96 }));
        expectNoFailures(await d.mintJetton(d.jA, d.bob, toNano('200'), GRAM, -120n, 120n, toNano('200')));
        expectNoFailures(await d.mintNative(d.carol, toNano('100'), d.tokA, 600n, 1200n));
        pA = await d.position(pool, 0n);
        pB = await d.position(pool, 1n);
        pC = await d.position(pool, 2n);
        // Down through -120, then back up into C's range: C only ever sees jetton-in swaps.
        expectNoFailures(await d.swapNative(d.alice, toNano('150'), d.tokA));
        d.chain.now = d.now + 40;
        const reach = (await simOf(pool)).swap(false, toNano('100000'), M.sqrtAt(900), 24, 0n, true, 0n, BigInt(d.now), false);
        expectNoFailures(await d.swapJetton(d.jA, d.alice, reach.consumed, GRAM));
        expect(Number((await pool.getGetPoolState()).tick)).toBeGreaterThan(600);
        expect(Number((await pool.getGetPoolState()).tick)).toBeLessThan(1200);
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('fee accrual across crossings: every position collects exactly its model share', async () => {
        const sim = await simOf(pool);
        const got: bigint[][] = [];
        for (const [p, who] of [[pA, d.alice], [pB, d.bob], [pC, d.carol]] as const) {
            const pd = await p.getGetPositionData();
            const e = sim.burn(Number(pd.tickLower), Number(pd.tickUpper), pd.liquidity, 0n, pd.fgLast0, pd.fgLast1);
            const res = await d.decrease(p, who, 0n);
            expectNoFailures(res);
            const ev = modifyEvents(res)[0];
            expect([ev.fees0, ev.fees1, ev.amount0, ev.amount1]).toEqual([e.fees0, e.fees1, 0n, 0n]);
            got.push([e.fees0, e.fees1]);
            const after = await p.getGetPositionData();
            expect([after.fgLast0, after.fgLast1, after.liquidity]).toEqual([e.inside0, e.inside1, pd.liquidity]);
        }
        await expectPoolEquals(pool, sim);
        expect(got[0][0]).toBeGreaterThan(0n);
        expect(got[0][1]).toBeGreaterThan(0n);
        expect(got[1][0]).toBeGreaterThan(0n);
        // C was only in range during the jetton-in leg: fees only in token1.
        expect(got[2][0]).toBe(0n);
        expect(got[2][1]).toBeGreaterThan(0n);
    });

    it('decrease partial then full: payouts equal the getter, ticks are released, a second full exit is impossible', async () => {
        const pd = await pA.getGetPositionData();
        const half = pd.liquidity / 3n;
        const g = await pool.getGetPositionAmounts(pd.tickLower, pd.tickUpper, pd.liquidity, pd.fgLast0, pd.fgLast1, half);
        const jb = await d.jBal(d.jA, d.alice.address);
        let res: any = await d.decrease(pA, d.alice, half);
        expectNoFailures(res);
        expect(gramPayouts(res, d.alice.address).filter((x) => x.reason === REASON.POSITION_OUT).map((x) => x.amount)).toEqual([g.amount0 + g.fees0]);
        expect(await d.jBal(d.jA, d.alice.address)).toBe(jb + g.amount1 + g.fees1);
        const rest = pd.liquidity - half;
        expect((await pA.getGetPositionData()).liquidity).toBe(rest);
        const tc = (await pool.getGetPoolState()).tickCount;
        res = await d.decrease(pA, d.alice, rest);
        expectNoFailures(res);
        // -600 is deleted; 600 survives because carol's [600, 1200] still references it.
        expect((await pool.getGetPoolState()).tickCount).toBe(tc - 1n);
        expect(await pool.getGetTick(-600n)).toBeNull();
        expect(await pool.getGetTick(600n)).not.toBeNull();
        // More than the position holds is refused by the Position itself.
        res = await d.decrease(pA, d.alice, 1n);
        expect(failedAt(res, pA.address).length).toBe(1);
        expect(modifyEvents(res)).toEqual([]);
    });

    it('Pool reply paths: DEADLINE and SLIPPAGE answer Sync{ok=false}; position unchanged, unlocked, gas returned', async () => {
        const pd = await pA.getGetPositionData();
        const sim = await simOf(pool);
        for (const [o, code] of [[{ deadline: BigInt(d.now - 1) }, CODES.DEADLINE], [{ min0: toNano('100000') }, CODES.SLIPPAGE],
            [{ min1: toNano('100000') }, CODES.SLIPPAGE]] as const) {
            const before = await d.gram(d.alice.address);
            const res = await d.decrease(pA, d.alice, pd.liquidity, o as any);
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([code]);
            expect(modifyEvents(res)).toEqual([]);
            expect(res.transactions).toHaveTransaction({ from: pool.address, to: pA.address, op: OP.PositionSync, success: true });
            const after = await pA.getGetPositionData();
            expect([after.liquidity, after.fgLast0, after.fgLast1, after.busy]).toEqual([pd.liquidity, pd.fgLast0, pd.fgLast1, false]);
            expect(await d.gram(d.alice.address)).toBeGreaterThan(before - toNano('0.05'));
        }
        await expectPoolEquals(pool, sim);
    });

    it('recipient == Router is refused (BAD_RECIPIENT): funds can never be stranded in the Router', async () => {
        const pd = await pA.getGetPositionData();
        const sim = await simOf(pool);
        const res = await d.decrease(pA, d.alice, pd.liquidity, { recipient: d.router.address });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.BAD_RECIPIENT]);
        expect((await pA.getGetPositionData()).liquidity).toBe(pd.liquidity);
        await expectPoolEquals(pool, sim);
    });

    it('decrease at exactly DECREASE_GAS succeeds (both payout legs); below it the Position refuses', async () => {
        const pd = await pA.getGetPositionData();
        let res: any = await d.decrease(pA, d.alice, pd.liquidity / 2n, { value: toNano('0.25') - 1n });
        expect(failedAt(res, pA.address).length).toBe(1);
        res = await d.decrease(pA, d.alice, pd.liquidity / 2n, { value: toNano('0.25') });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        expect(modifyEvents(res).length).toBe(1);
    });

    it('busy race: a second decrease or an NFT transfer while a PoolBurn is in flight is refused; the first completes', async () => {
        const pd = await pA.getGetPositionData();
        const snap = d.chain.snapshot();
        const second = [
            msg(d.alice.address, pA.address, toNano('0.3'), decBody(pd.liquidity / 2n, { queryId: 12n, deadline: d.deadline() })),
            msg(d.alice.address, pA.address, toNano('0.1'), nftBody(d.bob.address, null)),
        ];
        for (const m2 of second) {
            await d.chain.loadFrom(snap);
            const sim = await simOf(pool);
            sim.burn(Number(pd.tickLower), Number(pd.tickUpper), pd.liquidity, pd.liquidity / 2n, pd.fgLast0, pd.fgLast1);
            const { txs } = await stepN(d.chain, msg(d.alice.address, pA.address, toNano('0.3'),
                decBody(pd.liquidity / 2n, { queryId: 11n, deadline: d.deadline() })), 1);
            expect(txs.length).toBe(1);
            expect((await pA.getGetPositionData()).busy).toBe(true);
            // Queue is now [PoolBurn]; the second message lands at the Position before the Sync.
            const r2 = await d.chain.sendMessage(m2);
            expect(failedAt(r2, pA.address).length).toBe(1);
            expect(modifyEvents(r2).length).toBe(1);
            expect(modifyEvents(r2)[0].liquidityDelta).toBe(-(pd.liquidity / 2n));
            const st = await pA.getGetPositionData();
            expect([st.busy, st.liquidity, st.owner.toString()]).toEqual([false, pd.liquidity - pd.liquidity / 2n, d.alice.address.toString()]);
            await expectPoolEquals(pool, sim);
        }
    });

    it('forged PositionSync from a non-pool, and a Sync with the wrong queryId, are rejected', async () => {
        const pd = await pA.getGetPositionData();
        const forged = beginCell().store(storePositionSync({
            $$type: 'PositionSync', queryId: 0n, ok: true, code: 0n, liquidity: pd.liquidity * 100n, fgInside0: 0n, fgInside1: 0n,
        })).endCell();
        let res: any = await d.chain.sendMessage(msg(d.bob.address, pA.address, toNano('0.1'), forged));
        expect(failedAt(res, pA.address).length).toBe(1);
        // From the real pool address but not busy / wrong query: rejected too.
        res = await d.chain.sendMessage(msg(pool.address, pA.address, toNano('0.1'), forged));
        expect(failedAt(res, pA.address).length).toBe(1);
        expect((await pA.getGetPositionData()).liquidity).toBe(pd.liquidity);
        // In flight with queryId 21: a Sync carrying queryId 22 "from the pool" is rejected; the real one lands.
        const { it } = await stepN(d.chain, msg(d.alice.address, pA.address, toNano('0.3'), decBody(0n, { queryId: 21n, deadline: d.deadline() })), 1);
        const stale = beginCell().store(storePositionSync({
            $$type: 'PositionSync', queryId: 22n, ok: true, code: 0n, liquidity: 1n, fgInside0: 0n, fgInside1: 0n,
        })).endCell();
        res = await d.chain.sendMessage(msg(pool.address, pA.address, toNano('0.1'), stale));
        expect(failedAt(res, pA.address).length).toBe(1);
        await drain(it);
        const after = await pA.getGetPositionData();
        expect([after.busy, after.liquidity]).toEqual([false, pd.liquidity]);
    });

    it('bounce path: if the Pool throws on PoolBurn, the bounce unlocks the Position and nothing changes', async () => {
        const pd = await pA.getGetPositionData();
        const sc = await d.chain.getContract(pool.address);
        const saved = sc.account;
        // Replace the pool's code with a contract that does not know PoolBurn (exit 130 → bounce).
        const hk = await TestHook.fromInit(d.carol.address, 0n);
        await d.chain.setShardAccount(pool.address, createShardAccount({
            address: pool.address, code: hk.init!.code, data: hk.init!.data, balance: saved.account!.storage.balance.coins,
        }));
        const res = await d.decrease(pA, d.alice, pd.liquidity);
        expect(failedAt(res, pool.address).length).toBe(1);
        expect(res.transactions).toHaveTransaction({ from: pool.address, to: pA.address, inMessageBounced: true, success: true });
        // The owner gets the gas back.
        expect(res.transactions).toHaveTransaction({ from: pA.address, to: d.alice.address, op: 0xd53276db });
        await d.chain.setShardAccount(pool.address, saved);
        const after = await pA.getGetPositionData();
        expect([after.busy, after.liquidity, after.fgLast0]).toEqual([false, pd.liquidity, pd.fgLast0]);
        // And it works normally afterwards.
        const r2 = await d.decrease(pA, d.alice, pd.liquidity);
        expectNoFailures(r2);
        expect((await pA.getGetPositionData()).liquidity).toBe(0n);
    });

    it('NFT transfer (TEP-62): new owner decreases, old owner cannot; OwnershipAssigned + excess; static data', async () => {
        const pd = await pB.getGetPositionData();
        let res: any = await d.chain.sendMessage(msg(d.carol.address, pB.address, toNano('0.1'), nftBody(d.carol.address, null)));
        expect(failedAt(res, pB.address).length).toBe(1); // not the owner
        res = await pB.send(d.bob.getSender(), { value: toNano('0.2') }, {
            $$type: 'NftTransfer', queryId: 5n, newOwner: d.carol.address, responseDestination: d.bob.address,
            customPayload: null, forwardAmount: toNano('0.01'), forwardPayload: beginCell().storeUint(7, 8).endCell().beginParse(),
        });
        expectNoFailures(res);
        expect(res.transactions).toHaveTransaction({ from: pB.address, to: d.carol.address, op: 0x05138d91, value: toNano('0.01') });
        expect(res.transactions).toHaveTransaction({ from: pB.address, to: d.bob.address, op: 0xd53276db });
        const nd = await pB.getGetNftData();
        expect([nd.initialized, nd.index, nd.collection.toString(), nd.owner!.toString()])
            .toEqual([true, 1n, pool.address.toString(), d.carol.address.toString()]);
        const c = nd.content!.beginParse();
        expect([c.loadIntBig(24), c.loadIntBig(24)]).toEqual([-120n, 120n]);
        // The old owner can no longer decrease or collect.
        res = await d.decrease(pB, d.bob, 0n);
        expect(failedAt(res, pB.address).length).toBe(1);
        // The new owner withdraws everything (fees accrued under the previous owner included).
        const jb = await d.jBal(d.jA, d.carol.address);
        const g = await pool.getGetPositionAmounts(pd.tickLower, pd.tickUpper, pd.liquidity, pd.fgLast0, pd.fgLast1, pd.liquidity);
        res = await d.decrease(pB, d.carol, pd.liquidity);
        expectNoFailures(res);
        expect(await d.jBal(d.jA, d.carol.address)).toBe(jb + g.amount1 + g.fees1);
        // GetStaticData → ReportStaticData{index, collection}.
        res = await d.chain.sendMessage(msg(d.bob.address, pB.address, toNano('0.05'),
            beginCell().store(storeGetStaticData({ $$type: 'GetStaticData', queryId: 9n })).endCell()));
        const rep = res.transactions.find((t: any) => t.inMessage?.info.dest instanceof Address && t.inMessage.info.dest.equals(d.bob.address))!;
        const b = rep.inMessage!.body.beginParse();
        expect(b.loadUint(32)).toBe(0x8b771735);
        expect(b.loadUintBig(64)).toBe(9n);
        expect(b.loadUintBig(256)).toBe(1n);
        expect(b.loadAddress().equals(pool.address)).toBe(true);
        // Collection getters.
        const cd = await pool.getGetCollectionData();
        expect(cd.nextItemIndex).toBe(3n);
        expect((await pool.getGetNftAddressByIndex(1n)).equals(pB.address)).toBe(true);
        void events;
    });
});

describe('position: MIN_LP_LOCK and MintAccount', () => {
    it('MIN_LP_LOCK: decrease refused until lockedUntil (inclusive boundary), collect always allowed', async () => {
        const d = await Dex.create();
        const ext = extCell({ minLockSecs: 600n });
        const pool = await d.poolOf(GRAM, d.tokA, 60n, ext);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('100'), GRAM, -600n, 600n, toNano('100'), { ext, sqrtPriceInit: Q96 }));
        const t0 = d.now;
        const pos = await d.position(pool, 0n);
        const pd = await pos.getGetPositionData();
        expect(pd.lockedUntil).toBe(BigInt(t0 + 600));
        expectNoFailures(await d.swapNative(d.bob, toNano('5'), d.tokA, { ext }));
        let res: any = await d.decrease(pos, d.alice, 1000n);
        expect(failedAt(res, pos.address).length).toBe(1);
        res = await d.decrease(pos, d.alice, 0n);
        expectNoFailures(res);
        expect(modifyEvents(res)[0].fees0).toBeGreaterThan(0n);
        d.chain.now = t0 + 599;
        res = await d.decrease(pos, d.alice, 1000n);
        expect(failedAt(res, pos.address).length).toBe(1);
        d.chain.now = t0 + 600;
        res = await d.decrease(pos, d.alice, 1000n);
        expectNoFailures(res);
        expect(modifyEvents(res)[0].liquidityDelta).toBe(-1000n);
        // The lock is per position: a new mint gets its own lock.
        expectNoFailures(await d.mintNative(d.bob, toNano('5'), d.tokA, 60n, 120n, { ext }));
        expect((await (await d.position(pool, 1n)).getGetPositionData()).lockedUntil).toBe(BigInt(t0 + 1200));
    });

    it('MintAccount: first leg parks, refund returns it; legs must carry identical params; a stranger cannot refund', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(d.tokA, d.tokB, 60n, null);
        const ma = d.chain.openContract(MintAccount.fromAddress(await d.router.getGetMintAccountAddress(pool.address, d.bob.address)));
        const ja = await d.jBal(d.jA, d.bob.address);
        let res: any = await d.mintJetton(d.jA, d.bob, toNano('10'), d.tokB, -600n, 600n, 0n, { viaAccount: true, sqrtPriceInit: Q96 });
        expectNoFailures(res);
        let md = await ma.getGetMintAccountData();
        const st0 = await pool.getGetPoolState();
        const aIs0 = st0.key.token0.equals(d.tokA);
        expect(aIs0 ? md.pending0 : md.pending1).toBe(toNano('10'));
        expect(md.params!.tickLower).toBe(-600n);
        // Same token again (same params) accumulates.
        expectNoFailures(await d.mintJetton(d.jA, d.bob, toNano('5'), d.tokB, -600n, 600n, 0n, { viaAccount: true, sqrtPriceInit: Q96 }));
        md = await ma.getGetMintAccountData();
        expect(aIs0 ? md.pending0 : md.pending1).toBe(toNano('15'));
        expect(md.params!.tickLower).toBe(-600n);
        // A stranger cannot refund; too little gas is refused.
        const refundBody = beginCell().store(storeMintAccountRefund({ $$type: 'MintAccountRefund', queryId: 1n })).endCell();
        res = await d.chain.sendMessage(msg(d.carol.address, ma.address, toNano('0.3'), refundBody));
        expect(failedAt(res, ma.address).length).toBe(1);
        res = await d.chain.sendMessage(msg(d.bob.address, ma.address, toNano('0.2') - 1n, refundBody));
        expect(failedAt(res, ma.address).length).toBe(1);
        res = await ma.send(d.bob.getSender(), { value: toNano('0.25') }, { $$type: 'MintAccountRefund', queryId: 1n });
        expectNoFailures(res);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(ja);
        md = await ma.getGetMintAccountData();
        expect([md.pending0, md.pending1, md.params]).toEqual([0n, 0n, null]);
        expect(await d.routerHolds(d.tokA)).toBe(0n);
        // A second leg with different params does not pair (review issue 2): both legs refunded.
        const jb = await d.jBal(d.jB, d.bob.address);
        expectNoFailures(await d.mintJetton(d.jB, d.bob, toNano('10'), d.tokA, -1200n, 1200n, 0n, { viaAccount: true, sqrtPriceInit: Q96 }));
        res = await d.mintJetton(d.jA, d.bob, toNano('10'), d.tokB, -60n, 60n, 0n, { viaAccount: true, sqrtPriceInit: encodeSqrtPrice(4n, 1n) });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.MINT_MISMATCH]);
        expect(modifyEvents(res)).toEqual([]);
        expect([await d.jBal(d.jA, d.bob.address), await d.jBal(d.jB, d.bob.address)]).toEqual([ja, jb]);
        md = await ma.getGetMintAccountData();
        expect([md.pending0, md.pending1, md.params]).toEqual([0n, 0n, null]);
        // Now a full two-leg mint with identical params.
        expectNoFailures(await d.mintJetton(d.jB, d.bob, toNano('10'), d.tokA, -1200n, 1200n, 0n, { viaAccount: true, sqrtPriceInit: Q96 }));
        res = await d.mintJetton(d.jA, d.bob, toNano('10'), d.tokB, -1200n, 1200n, 0n, { viaAccount: true, sqrtPriceInit: Q96 });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        const ev = modifyEvents(res)[0];
        expect([ev.tickLower, ev.tickUpper]).toEqual([-1200n, 1200n]);
        const st = await pool.getGetPoolState();
        expect(st.sqrtPriceX96).toBe(Q96);
        await d.checkSolvency([pool]);
        expect(await d.routerHolds(d.tokA) + await d.routerHolds(d.tokB)).toBe(st.reserve0 + st.reserve1);
        void TreasuryContract;
    });
});
