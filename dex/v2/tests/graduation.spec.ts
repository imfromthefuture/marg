// Graduation suite: one-cell payload (hand-built == generated), price from the deposit ratio,
// full-range position locked forever whose fees stay claimable (and transferable), squat
// resistance, already-initialized / paused / out-of-range refunds of both legs, Router validation,
// and gas at exactly GRADUATE_GAS.

import { Address, beginCell, Cell, toNano } from '@ton/core';
import { SandboxContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, CODES, REASON, Pool, expectNoFailures, modifyEvents, refundCodes, gramPayouts, initEvents,
    simOf, expectPoolEquals, failedAt, findMin, eitherRef, extCell,
} from './helpers';
import * as M from './model';

jest.setTimeout(900000);

const GRAM_LEG = toNano('100');
const JET_LEG = toNano('400000');

function handBuilt(gram: bigint, spacing: number, fee: number, dur: number, claimer: Address, refundTo: Address, deadline: number) {
    return beginCell().storeUint(0x4d480003, 32).storeCoins(gram).storeUint(spacing, 16).storeUint(fee, 32).storeUint(dur, 32)
        .storeAddress(claimer).storeAddress(refundTo).storeUint(deadline, 32).endCell();
}

describe('graduation', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    let base: any;
    let extG: Cell;
    const extM = (fee = 100000n, dur = 3600n): M.ExtModel => ({ ...M.PLAIN_EXT, launchFeePips: fee, launchDuration: dur });

    async function graduate(o: { gram?: bigint; jet?: bigint; claimer?: Address; refundTo?: Address; fee?: bigint; dur?: bigint;
        spacing?: bigint; gas?: bigint; deadline?: bigint; who?: any } = {}) {
        const p = d.graduatePayload(o.gram ?? GRAM_LEG, o.claimer ?? d.carol.address, o.refundTo ?? d.alice.address,
            { launchFeePips: o.fee ?? 100000n, launchDuration: o.dur ?? 3600n, tickSpacing: o.spacing ?? 60n, deadline: o.deadline });
        return d.sendJettons(d.jA, o.who ?? d.alice, o.jet ?? JET_LEG, (o.gram ?? GRAM_LEG) + (o.gas ?? toNano('0.6')), eitherRef(p));
    }

    beforeAll(async () => {
        d = await Dex.create();
        // alice plays the launch master (the jetton owner that sends the graduation transfer).
        pool = d.chain.openContract(Pool.fromAddress(await d.router.getGetGraduationPoolAddress(d.tokA, 60n, d.alice.address, 100000n, 3600n)));
        extG = extCell({ initializer: d.alice.address, launchFeePips: 100000n, launchDuration: 3600n });
        expect((await d.poolOf(GRAM, d.tokA, 60n, extG)).address.equals(pool.address)).toBe(true);
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('the payload is one cell and a hand-built cell is identical to the generated one', async () => {
        const dl = d.now + 3600;
        const gen = d.graduatePayload(GRAM_LEG, d.carol.address, d.alice.address, { launchFeePips: 100000n, launchDuration: 3600n, deadline: BigInt(dl) });
        const hand = handBuilt(Number(GRAM_LEG) === 0 ? 0n : GRAM_LEG, 60, 100000, 3600, d.carol.address, d.alice.address, dl);
        expect(gen.refs.length).toBe(0);
        expect(gen.bits.length).toBeLessThanOrEqual(802);
        expect(hand.hash().equals(gen.hash())).toBe(true);
        // and the hand-built cell graduates (it rides as the Either ref of the transfer payload)
        const res = await d.sendJettons(d.jA, d.alice, JET_LEG, GRAM_LEG + toNano('0.6'), eitherRef(hand));
        expectNoFailures(res);
        expect(initEvents(res).length).toBe(1);
    });

    it('seeds a full-range position at sqrt(jetton/Gram), locked forever, owned by the fee claimer; dust refunded', async () => {
        const jb = await d.jBal(d.jA, d.alice.address);
        const res = await graduate();
        expectNoFailures(res);
        const sqrtP = M.sqrtFromAmounts(GRAM_LEG, JET_LEG);
        const ini = initEvents(res);
        expect([ini[0].sqrtPriceX96, ini[0].tick, ini[0].graduation, ini[0].initializer!.toString()])
            .toEqual([sqrtP, BigInt(M.tickAt(sqrtP)), true, d.alice.address.toString()]);
        const st = await pool.getGetPoolState();
        expect([st.initialized, st.sqrtPriceX96, st.tickCount, st.nextPositionId, st.fs.startTs]).toEqual([true, sqrtP, 2n, 1n, BigInt(d.now)]);
        const sim = new M.PoolSim(60, { ...extM(), initializer: d.alice.address.toString() });
        const e = sim.mint(M.minUsable(60), M.maxUsable(60), GRAM_LEG, JET_LEG, 0n, sqrtP, BigInt(d.now), M.PRESETS[60], { userIsInitializer: true });
        expect(e.code).toBe(0);
        await expectPoolEquals(pool, sim);
        const ev = modifyEvents(res)[0];
        expect([ev.amount0, ev.amount1, ev.liquidityDelta]).toEqual([e.use0, e.use1, e.liq]);
        // Rounding dust of both legs goes back to refundTo (alice).
        expect(await d.jBal(d.jA, d.alice.address)).toBe(jb - e.use1);
        const back = gramPayouts(res, d.alice.address).filter((x) => x.reason === REASON.MINT_REFUND);
        expect(back.map((x) => x.amount)).toEqual(GRAM_LEG > e.use0 ? [GRAM_LEG - e.use0] : []);
        const pos = await d.position(pool, 0n);
        const pd = await pos.getGetPositionData();
        expect([pd.owner.toString(), pd.lockedUntil, pd.tickLower, pd.tickUpper, pd.liquidity])
            .toEqual([d.carol.address.toString(), 0xFFFFFFFFn, BigInt(M.minUsable(60)), BigInt(M.maxUsable(60)), e.liq]);
        // The launch fee is on: 100000 extra pips at t0, and NO volatility fee: the reference
        // index starts at the initial tick (regression: it used to start at 0 → va = maxVolAcc).
        expect(st.fs.idxRef).toBe(BigInt(Math.floor(M.tickAt(sqrtP) / 60)));
        expect(st.feePipsNow).toBe(3000n + 100000n);
        const q = await pool.getGetQuote(true, toNano('1'), 0n, 24n, 0n, false);
        expect(q.feeTotal).toBeLessThanOrEqual(toNano('1') * 103000n / 1000000n + 1n);
        await d.checkSolvency([pool]);
    });

    it('locked forever (even at now = 2^32 - 1), but the fee claimer collects; the NFT moves the fee rights', async () => {
        expectNoFailures(await graduate());
        const pos = await d.position(pool, 0n);
        d.chain.now = d.now + 4000;
        expectNoFailures(await d.swapNative(d.bob, toNano('5'), d.tokA, { ext: extG }));
        expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('20000'), GRAM, { ext: extG }));
        const pd = await pos.getGetPositionData();
        let res = await d.decrease(pos, d.carol, 1000n);
        expect(failedAt(res, pos.address).length).toBe(1);
        const sim = await simOf(pool, extM());
        const e = sim.burn(Number(pd.tickLower), Number(pd.tickUpper), pd.liquidity, 0n, pd.fgLast0, pd.fgLast1);
        const jb = await d.jBal(d.jA, d.carol.address);
        res = await d.decrease(pos, d.carol, 0n);
        expectNoFailures(res);
        expect(gramPayouts(res, d.carol.address).filter((x) => x.reason === REASON.POSITION_OUT).map((x) => x.amount)).toEqual([e.fees0]);
        expect(await d.jBal(d.jA, d.carol.address)).toBe(jb + e.fees1);
        expect(e.fees0).toBeGreaterThan(0n);
        expect(e.fees1).toBeGreaterThan(0n);
        await expectPoolEquals(pool, sim);
        // Transfer the NFT: the new owner (bob) collects, carol cannot.
        res = await pos.send(d.carol.getSender(), { value: toNano('0.1') }, {
            $$type: 'NftTransfer', queryId: 1n, newOwner: d.bob.address, responseDestination: d.carol.address, customPayload: null,
            forwardAmount: 0n, forwardPayload: beginCell().storeBit(0).endCell().beginParse(),
        });
        expectNoFailures(res);
        expectNoFailures(await d.swapNative(d.alice, toNano('5'), d.tokA, { ext: extG }));
        res = await d.decrease(pos, d.carol, 0n);
        expect(failedAt(res, pos.address).length).toBe(1);
        res = await d.decrease(pos, d.bob, 0n);
        expectNoFailures(res);
        expect(modifyEvents(res)[0].fees0).toBeGreaterThan(0n);
        // Far future: still locked. (Top the NFT up first: 80 years of rent would otherwise freeze it.)
        expectNoFailures(await d.bob.send({ to: pos.address, value: toNano('5') }));
        d.chain.now = 0xFFFFFFFF;
        res = await d.decrease(pos, d.bob, 1000n, { deadline: 0xFFFFFFFFn });
        expect(failedAt(res, pos.address).length).toBe(1);
        expect((await pos.getGetPositionData()).liquidity).toBe(pd.liquidity);
    });

    it('squatting: a non-initializer cannot initialize the key; a deployed-but-uninitialized pool does not block', async () => {
        // bob tries to initialize alice's canonical key with a normal mint.
        let res = await d.mintNative(d.bob, toNano('10'), d.tokA, -600n, 600n, { ext: extG, sqrtPriceInit: Q96 * 1000n });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.NOT_INITIALIZER]);
        // bob deploys the pool by swapping into it (refunded, pool exists but is not initialized).
        res = await d.swapNative(d.bob, toNano('1'), d.tokA, { ext: extG });
        expect(refundCodes(res)).toEqual([CODES.NOT_INITIALIZED]);
        expect((await pool.getGetPoolState()).initialized).toBe(false);
        // bob "graduates" jetton A himself: that is a different key (initializer bob), not alice's.
        res = await graduate({ who: d.bob, refundTo: d.bob.address, claimer: d.bob.address, gram: toNano('1'), jet: toNano('1') });
        expectNoFailures(res);
        expect((await pool.getGetPoolState()).initialized).toBe(false);
        const bobPool = await d.router.getGetGraduationPoolAddress(d.tokA, 60n, d.bob.address, 100000n, 3600n);
        expect(bobPool.equals(pool.address)).toBe(false);
        // alice's graduation still works.
        res = await graduate();
        expectNoFailures(res);
        expect(initEvents(res)[0].graduation).toBe(true);
        expect((await pool.getGetPoolState()).initialized).toBe(true);
    });

    it('already initialized → both legs refunded to refundTo; creation paused → a graduation key still initializes', async () => {
        expectNoFailures(await graduate());
        const sim = await simOf(pool, extM());
        const jb = await d.jBal(d.jA, d.bob.address);
        let res = await graduate({ refundTo: d.bob.address });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.ALREADY_INITIALIZED]);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb + JET_LEG);
        expect(gramPayouts(res, d.bob.address).filter((x) => x.reason === REASON.MINT_REFUND).map((x) => x.amount)).toEqual([GRAM_LEG]);
        await expectPoolEquals(pool, sim);
        // Paused (review issue 3): a graduation key (initializer = launch master) bypasses the pause,
        // so a fresh key (different spacing) is still created instead of stranding the legs.
        expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetCreationPaused', queryId: 0n, paused: true }));
        res = await graduate({ spacing: 200n });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        expect(initEvents(res).length).toBe(1);
    });

    it('Router validation: gramAmount 0, Router as claimer/refundTo, deadline, bad spacing, launch fee above cap', async () => {
        const cases: [Parameters<typeof graduate>[0], number, Address][] = [
            [{ gram: 0n }, CODES.BAD_PAYLOAD, d.alice.address],
            [{ claimer: d.router.address }, CODES.BAD_RECIPIENT, d.alice.address],
            [{ refundTo: d.router.address }, CODES.BAD_RECIPIENT, d.alice.address],
            [{ deadline: BigInt(d.now - 1), refundTo: d.bob.address }, CODES.DEADLINE, d.bob.address],
            [{ spacing: 7n }, CODES.BAD_TICK_SPACING, d.alice.address],
            [{ fee: 900001n }, CODES.BAD_KEY, d.alice.address],
            [{ fee: 100n, dur: 0n }, CODES.BAD_KEY, d.alice.address],
        ];
        for (const [o, code, to] of cases) {
            const jb = await d.jBal(d.jA, to);
            const res = await graduate(o);
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([code]);
            expect(await d.jBal(d.jA, to)).toBe(jb + (to.equals(d.alice.address) ? 0n : JET_LEG));
        }
        expect(await d.isActive(pool.address)).toBe(false);
    });

    it('extreme ratios: a far-out price still seeds the full range exactly; dust legs (L < 1000) are refunded', async () => {
        // PRICE_OUT_OF_RANGE needs a ratio beyond 2^128, which coins (< 2^120) cannot express.
        expect(M.sqrtFromAmounts(1n, (1n << 120n) - 1n)).toBeLessThan(M.MAX_SQRT_RATIO);
        expect(M.sqrtFromAmounts((1n << 120n) - 1n, 1n)).toBeGreaterThanOrEqual(M.MIN_SQRT_RATIO);
        const p = d.chain.openContract(Pool.fromAddress(await d.router.getGetGraduationPoolAddress(d.tokA, 60n, d.alice.address, 0n, 0n)));
        const g = 1_000_000n;
        const j = toNano('90000000');
        let res = await graduate({ gram: 1n, jet: 1n, fee: 0n, dur: 0n });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.LIQUIDITY_BELOW_MIN]);
        res = await graduate({ gram: g, jet: j, fee: 0n, dur: 0n });
        expectNoFailures(res);
        const sqrtP = M.sqrtFromAmounts(g, j);
        const st = await p.getGetPoolState();
        expect([st.sqrtPriceX96, Number(st.tick)]).toEqual([sqrtP, M.tickAt(sqrtP)]);
        expect(Number(st.tick)).toBeGreaterThan(250000);
        const sim = new M.PoolSim(60, { ...M.PLAIN_EXT, initializer: d.alice.address.toString() });
        sim.mint(M.minUsable(60), M.maxUsable(60), g, j, 0n, sqrtP, BigInt(d.now), M.PRESETS[60], { userIsInitializer: true });
        await expectPoolEquals(p, sim);
        await d.checkSolvency([p]);
    });

    it('gas at exactly the minimum: min - 1 → LOW_GAS refund of both legs, min graduates', async () => {
        const min = await findMin(d.chain, toNano('0.2'), toNano('1'), async (g) => !refundCodes(await graduate({ gas: g })).includes(CODES.LOW_GAS));
        expect(min).toBeGreaterThan(toNano('0.4'));
        const jb = await d.jBal(d.jA, d.alice.address);
        let res = await graduate({ gas: min - 1n });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.LOW_GAS]);
        expect(await d.jBal(d.jA, d.alice.address)).toBe(jb);
        res = await graduate({ gas: min });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        expect(initEvents(res).length).toBe(1);
        await d.checkSolvency([pool]);
    });
});
