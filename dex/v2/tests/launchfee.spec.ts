// Strong, short anti-snipe launch fee (LAUNCH_DECAY cap raised to 90%, DESIGN.md §5.5): 90% fading
// linearly to 0 over 15 s. Decay second by second (getter == model == execution), a swap at t0 pays
// ~90% + base, after 15 s only the normal fee, the dev buy in the launch transaction stays exempt,
// the protocol / LP split stays exact, and the total can never reach 100% of the input.

import { Address, Cell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import {
    Dex, GRAM, REASON, Pool, expectNoFailures, swapEvents, gramPayouts, expectPoolEquals, encodeSqrtPrice, LaunchOpts,
} from './helpers';
import * as M from './model';

jest.setTimeout(900000);

const JET = toNano('50000000');
const SQRT = encodeSqrtPrice(JET, toNano('1300'));
const LO: LaunchOpts = { tickSpacing: 200n, launchFeePips: 900000n, launchDuration: 15n };
const BASE = 10000n;            // spacing-200 preset base fee (1%)

describe('launch fee: 90% over 15 s', () => {
    let d: Dex;
    let base: any;
    let dave: SandboxContract<TreasuryContract>;
    let key: { token0: Address; token1: Address; tickSpacing: bigint; ext: Cell | null };
    let pool: SandboxContract<Pool>;
    const extM = (): M.ExtModel => ({ ...M.PLAIN_EXT, launchFeePips: 900000n, launchDuration: 15n, initializer: d.alice.address.toString() });
    const launch = (o: LaunchOpts = {}) => d.launch(d.jA, d.alice, JET, SQRT, d.carol.address, d.alice.address, { ...LO, ...o });

    async function swapChecked(sim: M.PoolSim, user: SandboxContract<TreasuryContract>, zfo: boolean, amount: bigint) {
        const exp = sim.swap(zfo, amount, 0n, 24, 0n, false, 0n, BigInt(d.now), true);
        expect(exp.code).toBe(0);
        const res = zfo ? await d.swapNative(user, amount, d.tokA, { tickSpacing: 200n, ext: key.ext })
            : await d.swapJetton(d.jA, user, amount, GRAM, { tickSpacing: 200n, ext: key.ext });
        expectNoFailures(res);
        const ev = swapEvents(res)[0];
        expect([ev.amountOut, ev.feeTotal, ev.protocolFee]).toEqual([exp.out, exp.feeTotal, exp.proto]);
        await expectPoolEquals(pool, sim);
        return { exp, res, ev };
    }

    beforeAll(async () => {
        d = await Dex.create();
        dave = await d.chain.treasury('dave', { balance: toNano('1000000') });
        key = await d.launchKey(d.tokA, d.alice.address, LO);
        pool = d.chain.openContract(Pool.fromAddress(await d.router.getGetLaunchPoolAddress(d.tokA, 200n, d.alice.address,
            900000n, 15n, null, 0n, 0n)));
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('the key is valid at the new cap (900000 pips, 15 s) and refused above it', async () => {
        expect(await d.router.getGetExtValid(key.ext)).toBe(512n);
        const over = await d.launchKey(d.tokA, d.alice.address, { ...LO, launchFeePips: 900001n });
        expect(await d.router.getGetExtValid(over.ext)).toBe(-1n);
    });

    it('decays linearly second by second: getter == model == executed swap fee', async () => {
        expectNoFailures(await launch());
        const sim0 = new M.PoolSim(200, extM());
        sim0.launch(SQRT, JET, BigInt(d.now), M.PRESETS[200]);
        const t0 = Number(sim0.fs.startTs);
        const snap = d.chain.snapshot();
        for (let dt = 0; dt <= 16; dt++) {
            await d.chain.loadFrom(snap);
            d.chain.now = t0 + dt;
            const extra = dt >= 15 ? 0n : (900000n * BigInt(15 - dt)) / 15n;
            expect(M.launchExtra(900000n, 15n, BigInt(t0), BigInt(t0 + dt))).toBe(extra);
            expect([dt, (await pool.getGetPoolState()).feePipsNow]).toEqual([dt, BASE + extra]);
            const sim = new M.PoolSim(200, extM());
            sim.launch(SQRT, JET, BigInt(t0), M.PRESETS[200]);
            const { exp } = await swapChecked(sim, d.bob, true, toNano('2'));
            // first step's fee = base + extra (+ a tiny volatility fee once inside the range)
            expect(exp.lastFee).toBeGreaterThanOrEqual(BASE + extra);
            expect(exp.lastFee).toBeLessThan(BASE + extra + 2000n);
            expect(exp.lastFee).toBeLessThan(950001n);
        }
    });

    it('a buy at t0 pays ~90% + base; protocol share and LP fee growth stay exact; after 15 s only the normal fee', async () => {
        expectNoFailures(await launch());
        const sim = new M.PoolSim(200, extM());
        sim.launch(SQRT, JET, BigInt(d.now), M.PRESETS[200]);
        const amt = toNano('100');
        const jb = await d.jBal(d.jA, d.bob.address);
        const { exp, ev } = await swapChecked(sim, d.bob, true, amt);
        // fee / swapped input in [91%, 92%): the sniper keeps < 9% of the input's value. The PLATFORM
        // FEE (1% of the Gram input, launch key) is taken before the swap, outside the LP fee.
        expect(exp.plat).toBe(amt * M.PLATFORM_FEE_CAP_BPS / 10000n);
        const swapped = amt - exp.plat;
        expect(exp.feeTotal * 1000n).toBeGreaterThanOrEqual(swapped * 910n);
        expect(exp.feeTotal * 1000n).toBeLessThan(swapped * 920n);
        // protocol takes its 10% share of the whole fee (launch extra included), LPs the rest
        expect(ev.protocolFee).toBe(exp.proto);
        expect(exp.proto * 10000n).toBeLessThanOrEqual(exp.feeTotal * 1000n);
        expect(exp.proto * 10000n).toBeGreaterThan(exp.feeTotal * 1000n - 10000n * 4n);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb + exp.out);
        const st = await pool.getGetPoolState();
        expect(st.protocolFees0).toBe(exp.proto);
        expect(st.feeGrowth0X128).toBeGreaterThan(0n);
        await d.checkSolvency([pool]);
        // a sell right after (still t0): the same ~91% applies to the jetton input
        const half = (await d.jBal(d.jA, d.bob.address)) - jb;
        const sell = await swapChecked(sim, d.bob, false, half / 2n);
        expect(sell.exp.feeTotal * 1000n).toBeGreaterThanOrEqual((half / 2n) * 905n);
        expect(gramPayouts(sell.res, d.bob.address).filter((g) => g.reason === REASON.SWAP_OUT).map((g) => g.amount)).toEqual([sell.exp.out]);
        // 15 s later: the normal fee only
        d.chain.now = Number(sim.fs.startTs) + 15;
        const later = await swapChecked(sim, d.carol, true, amt);
        expect(later.exp.lastFee).toBeLessThan(50001n);
        expect(later.exp.feeTotal * 100n).toBeLessThan(amt * 5n);
        await d.checkSolvency([pool]);
    });

    it('the dev buy in the launch transaction is exempt (base fee only); the next buyer pays the 90%', async () => {
        const dev = toNano('100');
        const sim = new M.PoolSim(200, extM());
        const e = sim.launch(SQRT, JET, BigInt(d.now), M.PRESETS[200], { amount: dev, minOut: 0n }) as any;
        expect(e.dev.code).toBe(0);
        const res = await launch({ devBuy: dev, minDevOut: e.dev.out, devReceiver: dave.address });
        expectNoFailures(res);
        const sw = swapEvents(res);
        expect([sw.length, sw[0].amountOut, sw[0].feeTotal]).toEqual([1, e.dev.out, e.dev.feeTotal]);
        expect(e.dev.lastFee).toBeLessThan(13000n);
        expect(e.dev.feeTotal).toBeLessThanOrEqual((dev * 13n) / 1000n);
        await expectPoolEquals(pool, sim);
        const next = await swapChecked(sim, d.bob, true, dev);
        expect(next.exp.lastFee).toBeGreaterThanOrEqual(BASE + 900000n);
        expect(next.exp.out * 5n).toBeLessThan(e.dev.out);
    });

    it('the total fee can never reach 100%: dynamic cap (5%) + launch cap (90%) <= 95% in the model and the step math', () => {
        expect(M.MAX_DYNAMIC_FEE_PIPS + 900000n).toBe(950000n);
        // swapStep at the maximum total fee: input = amountIn + fee, fee = 19x amountIn, nothing overflows
        const st = M.swapStep(M.sqrtAt(0), M.sqrtAt(-1000), 10n ** 24n, toNano('1000'), 950000n);
        expect(st.amountIn + st.fee).toBeLessThanOrEqual(toNano('1000'));
        expect(st.fee).toBeGreaterThan(st.amountIn * 18n);
    });
});
