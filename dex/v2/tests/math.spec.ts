// Math vectors: MathHarness (the Tact code) against the independent BigInt model (model.ts), plus
// a high-precision reference for the tick -> price mapping that does not use the v3 constants.

import { Blockchain, SandboxContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { MathHarness } from '../build/MathHarness_MathHarness';
import * as M from './model';

function rng(seed: number) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
        big: (lo: bigint, hi: bigint) => lo + (BigInt(Math.floor(next() * 2 ** 52)) * (hi - lo + 1n)) / 2n ** 52n,
    };
}

// sqrt(1.0001^t) * 2^96 to ~200 bits of precision, from first principles.
function refSqrtPrice(t: number): bigint {
    const P = 400n;
    const one = 1n << P;
    let base = (one * 10001n) / 10000n;
    let e = Math.abs(t);
    let acc = one;
    while (e > 0) {
        if (e & 1) acc = (acc * base) >> P;
        base = (base * base) >> P;
        e >>= 1;
    }
    if (t < 0) acc = (one * one) / acc;
    // sqrt(acc / 2^P) * 2^96 = sqrt(acc << (192 + P)) >> P, Newton from above (floor).
    const x = acc << (192n + P);
    let r = 1n << BigInt(Math.ceil(x.toString(2).length / 2) + 1);
    for (;;) {
        const nr = (r + x / r) >> 1n;
        if (nr >= r) break;
        r = nr;
    }
    return r >> P;
}

describe('v2 math: harness == model', () => {
    let h: SandboxContract<MathHarness>;

    beforeAll(async () => {
        const bc = await Blockchain.create();
        const u = await bc.treasury('u');
        h = bc.openContract(await MathHarness.fromInit());
        await h.send(u.getSender(), { value: toNano('1') }, null);
    });

    it('tick <-> price: v3 reference values, high-precision reference, round trip', async () => {
        expect(await h.getSqrtAt(0n)).toBe(M.Q96);
        expect(await h.getSqrtAt(-887272n)).toBe(M.MIN_SQRT_RATIO);
        expect(await h.getSqrtAt(887272n)).toBe(M.MAX_SQRT_RATIO);
        expect(await h.getTickAt(M.MIN_SQRT_RATIO)).toBe(-887272n);
        expect(await h.getTickAt(M.MAX_SQRT_RATIO - 1n)).toBe(887271n);
        const r = rng(1);
        const ticks = [-887272, -887271, -1, 1, 2, 60, -60, 887271, 887272];
        for (let i = 0; i < 40; i++) ticks.push(r.int(-887272, 887272));
        for (const t of ticks) {
            const s = await h.getSqrtAt(BigInt(t));
            expect(s).toBe(M.sqrtAt(t));
            // Close to the true value (independent of the v3 constants): within 1 unit (+1e-30
            // relative) for |t| < 200000; v3 itself is only ~1e-19 accurate near the extremes.
            const ref = refSqrtPrice(t);
            const diff = s > ref ? s - ref : ref - s;
            const tol = Math.abs(t) < 200000 ? ref / 10n ** 30n + 1n : ref / 10n ** 18n + 1n;
            expect(diff <= tol).toBe(true);
            if (t < 887272) {
                expect(await h.getTickAt(s)).toBe(BigInt(t));
                if (t > -887272) expect(await h.getTickAt(s - 1n)).toBe(BigInt(t - 1));
            }
        }
        for (let i = 0; i < 20; i++) {
            const p = r.big(M.MIN_SQRT_RATIO, M.MAX_SQRT_RATIO - 1n);
            expect(await h.getTickAt(p)).toBe(BigInt(M.tickAt(p)));
        }
    });

    it('mod 2^256 helpers near the edges', async () => {
        const top = M.MAX_U256;
        for (const [a, b] of [[top, 1n], [top, top], [0n, top], [5n, 7n], [top - 3n, 10n]]) {
            expect(await h.getAddMod(a, b)).toBe(M.addMod(a, b));
            expect(await h.getSubMod(a, b)).toBe(M.subMod(a, b));
            expect(await h.getSubMod(b, a)).toBe(M.subMod(b, a));
        }
    });

    it('swap steps, amount deltas, liquidity math, fees: exact equality on random vectors', async () => {
        const r = rng(7);
        for (let i = 0; i < 60; i++) {
            const t1 = r.int(-200000, 200000);
            const t2 = t1 + r.int(1, 20000);
            const a = M.sqrtAt(t1);
            const b = M.sqrtAt(t2);
            const L = r.big(1n, 2n ** 120n);
            const rem = r.big(1n, 2n ** 110n);
            const fee = BigInt(r.int(0, 250000));
            for (const up of [true, false]) {
                expect(await h.getAmount0Delta(a, b, L, up)).toBe(M.amount0Delta(a, b, L, up));
                expect(await h.getAmount1Delta(a, b, L, up)).toBe(M.amount1Delta(a, b, L, up));
            }
            expect(await h.getNextSqrt0(b, L, rem)).toBe(M.nextSqrt0Up(b, L, rem));
            expect(await h.getNextSqrt1(a, L, rem)).toBe(M.nextSqrt1Down(a, L, rem));
            const down = await h.getSwapStep(b, a, L, rem, fee);
            const md = M.swapStep(b, a, L, rem, fee);
            expect([down.sqrtNext, down.amountIn, down.amountOut, down.fee]).toEqual([md.sqrtNext, md.amountIn, md.amountOut, md.fee]);
            expect(down.amountIn + down.fee).toBeLessThanOrEqual(rem);
            const upS = await h.getSwapStep(a, b, L, rem, fee);
            const mu = M.swapStep(a, b, L, rem, fee);
            expect([upS.sqrtNext, upS.amountIn, upS.amountOut, upS.fee]).toEqual([mu.sqrtNext, mu.amountIn, mu.amountOut, mu.fee]);
            const x = r.big(0n, 2n ** 100n);
            const y = r.big(0n, 2n ** 100n);
            const mid = M.sqrtAt(t1 + 1);
            expect(await h.getLiqForAmounts(mid, a, b, x, y)).toBe(M.liquidityForAmounts(mid, a, b, x, y));
            const p = await h.getAmountsForLiq(BigInt(t1 + 1), mid, BigInt(t1), BigInt(t2), L, true);
            const mp = M.amountsForLiquidity(t1 + 1, mid, t1, t2, L, true);
            expect([p.a, p.b]).toEqual([mp.a, mp.b]);
        }
        for (const [A, va, s] of [[4500n, 350000n, 60n], [400000n, 1n, 1n], [0n, 5n, 10n], [600n, 123456n, 200n]]) {
            expect(await h.getVariableFee(A, va, s)).toBe(M.variableFee(A, va, s));
        }
        expect(await h.getVariableFee(4500n, 350000n, 60n)).toBe(19845n);
        for (const t of [0n, 1n, 1799n, 3599n, 3600n, 5000n]) {
            expect(await h.getLaunchExtra(200000n, 3600n, 0n, t)).toBe(M.launchExtra(200000n, 3600n, 0n, t));
        }
        expect(await h.getMaxLiqPerTick(60n)).toBe(M.maxLiquidityPerTick(60));
    });

    it('graduation price from the deposit ratio', async () => {
        const v = await h.getSqrtFromAmounts(10n ** 12n, 4n * 10n ** 12n);
        expect(v).toBe(2n * M.Q96);
        expect(await h.getSqrtFromAmounts(1n, 2n ** 130n)).toBe(0n);
    });
});
