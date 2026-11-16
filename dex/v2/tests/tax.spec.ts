// TAX plugin (KeyExt.taxRecipient / buyTaxBps / sellTaxBps): a buy (Gram in) pays buyTax on its
// Gram input before the swap, a sell (Gram out) pays sellTax on its Gram output after it. The tax
// sits outside the LP fee accounting, accrues in Pool.taxFees (part of keep()) and anyone can
// trigger CollectTax, which always pays the key's taxRecipient. Caps, the Gram-pair rule and the
// initializer rule are enforced by the Router and again by the Pool.

import { Address, beginCell, Cell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, CODES, REASON, OP, Pool, expectNoFailures, refundCodes, gramPayouts, swapEvents, expectPoolEquals,
    extCell, gasAt, failedAt, PoolKey, simOf,
} from './helpers';
import * as M from './model';

jest.setTimeout(900000);

describe('TAX plugin', () => {
    let d: Dex;
    let base: any;
    let taxman: SandboxContract<TreasuryContract>;
    let extT: Cell;        // buy 3%, sell 5%, initializer alice
    let pool: SandboxContract<Pool>;
    let sim: M.PoolSim;
    const BUY = 300n;
    const SELL = 500n;
    const extM = (): M.ExtModel => ({ ...M.PLAIN_EXT, initializer: d.alice.address.toString(), buyTaxBps: BUY, sellTaxBps: SELL });

    async function seed(p: SandboxContract<Pool>, s: M.PoolSim, ext: Cell | null) {
        const t = BigInt(d.now);
        const e = s.mint(-6000, 6000, toNano('1000'), toNano('1000'), 0n, Q96, t, M.PRESETS[60], { userIsInitializer: true });
        expect(e.code).toBe(0);
        const res = await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -6000n, 6000n, toNano('1000'), { ext, sqrtPriceInit: Q96 });
        expectNoFailures(res);
        await expectPoolEquals(p, s);
    }

    beforeAll(async () => {
        d = await Dex.create();
        taxman = await d.chain.treasury('taxman');
        extT = extCell({ initializer: d.alice.address, taxRecipient: taxman.address, buyTaxBps: BUY, sellTaxBps: SELL });
        pool = await d.poolOf(GRAM, d.tokA, 60n, extT);
        sim = new M.PoolSim(60, extM());
        await seed(pool, sim, extT);
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
        sim = await simOf(pool, extM());
    });

    it('validity: caps (10%), recipient iff taxed, initializer required, recipient basechain and not the Router', async () => {
        const H = taxman.address;
        const A = d.alice.address;
        const mc = new Address(-1, Buffer.alloc(32, 7));
        const bad: [string, Cell][] = [
            ['buy 1001', extCell({ initializer: A, taxRecipient: H, buyTaxBps: 1001n })],
            ['sell 1001', extCell({ initializer: A, taxRecipient: H, sellTaxBps: 1001n })],
            ['tax without recipient', extCell({ initializer: A, buyTaxBps: 1n })],
            ['recipient without tax', extCell({ initializer: A, taxRecipient: H })],
            ['tax without initializer', extCell({ taxRecipient: H, sellTaxBps: 1n })],
            ['recipient == Router', extCell({ initializer: A, taxRecipient: d.router.address, buyTaxBps: 1n })],
            ['recipient on masterchain', extCell({ initializer: A, taxRecipient: mc, buyTaxBps: 1n })],
        ];
        for (const [name, e] of bad) {
            expect([name, await d.router.getGetExtValid(e)]).toEqual([name, -1n]);
            const res = await d.swapJetton(d.jA, d.bob, toNano('1'), GRAM, { ext: e });
            expect([name, refundCodes(res)]).toEqual([name, [CODES.BAD_KEY]]);
        }
        // Boundaries: 10% / 10% is valid; the Router marks the key as taxed (bit 8, not a hook flag).
        expect(await d.router.getGetExtValid(extCell({ initializer: A, taxRecipient: H, buyTaxBps: 1000n, sellTaxBps: 1000n }))).toBe(768n);
        expect(await d.router.getGetExtValid(extCell({ initializer: A, taxRecipient: H, sellTaxBps: 1n }))).toBe(768n);
        expect(await d.router.getGetExtValid(extT)).toBe(768n);
    });

    it('only Gram pairs: a taxed key on a jetton/jetton pair is refused by the Router (swap and mint)', async () => {
        const jb = await d.jBal(d.jA, d.bob.address);
        let res = await d.swapJetton(d.jA, d.bob, toNano('1'), d.tokB, { ext: extT });
        expect(refundCodes(res)).toEqual([CODES.BAD_KEY]);
        res = await d.mintJetton(d.jA, d.bob, toNano('1'), d.tokB, -600n, 600n, 0n, { ext: extT, viaAccount: true, sqrtPriceInit: Q96 });
        expect(refundCodes(res)).toEqual([CODES.BAD_KEY]);
        res = await d.mintJetton(d.jA, d.bob, toNano('1'), d.tokB, 600n, 1200n, 0n, { ext: extT, sqrtPriceInit: Q96 });
        expect(refundCodes(res)).toEqual([CODES.BAD_KEY]);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb);
    });

    it('the Pool re-checks at initialization (a Pool whose router is a test wallet): caps, Gram pair, initializer', async () => {
        const fr = await d.chain.treasury('fakeRouter');
        const A = d.alice.address;
        const H = taxman.address;
        const preset = { $$type: 'FeePreset' as const, baseFeePips: 3000n, varFeeControl: 4500n, filterPeriod: 30n, decayPeriod: 600n, reductionBps: 5000n, maxVolAcc: 350000n };
        const params = (owner: Address) => ({
            $$type: 'MintParams' as const, tickLower: -600n, tickUpper: 600n, sqrtPriceInitX96: Q96, minLiquidity: 0n, owner, refundTo: owner,
            deadline: d.deadline(), sqrtPriceMinX96: 0n, sqrtPriceMaxX96: 0n,
        });
        // Keys the Router would never let through, sent straight to the Pool by its (test) router:
        // a taxed jetton/jetton key (launch and mint).
        const key: PoolKey = { $$type: 'PoolKey', token0: d.tokA, token1: d.tokB, tickSpacing: 60n, ext: extCell({ initializer: A, taxRecipient: H, buyTaxBps: 10n }) };
        const p = d.chain.openContract(await Pool.fromInit(fr.address, key));
        const launchBody = {
            $$type: 'PoolLaunch' as const, queryId: 1n, fromUser: A, amount1: toNano('1000'), sqrtPriceX96: Q96, feeClaimer: A, refundTo: A,
            deadline: d.deadline(), devBuy: 0n, minDevOut: 0n, devReceiver: A, allowInit: true, preset, platformBps: 100n, platformTo: A,
        };
        let res = await p.send(fr.getSender(), { value: toNano('1') }, launchBody);
        expect(refundCodes(res)).toEqual([CODES.BAD_KEY]);
        const mintBody = {
            $$type: 'PoolMint' as const, queryId: 1n, fromUser: A, amount0: toNano('1'), amount1: toNano('1'), params: params(A),
            viaAccount: false, allowInit: true, preset,
        };
        res = await p.send(fr.getSender(), { value: toNano('1') }, mintBody);
        expect(refundCodes(res)).toEqual([CODES.BAD_KEY]);
        // Over the cap on a Gram key.
        const k2: PoolKey = { $$type: 'PoolKey', token0: GRAM, token1: d.tokA, tickSpacing: 60n, ext: extCell({ initializer: A, taxRecipient: H, sellTaxBps: 1001n }) };
        const p2 = d.chain.openContract(await Pool.fromInit(fr.address, k2));
        res = await p2.send(fr.getSender(), { value: toNano('3') }, { ...mintBody, amount1: 0n });
        expect(refundCodes(res)).toEqual([CODES.BAD_KEY]);
        res = await p2.send(fr.getSender(), { value: toNano('1') }, launchBody);
        expect(refundCodes(res)).toEqual([CODES.BAD_KEY]);
        // No initializer: refused too.
        const k3: PoolKey = { $$type: 'PoolKey', token0: GRAM, token1: d.tokA, tickSpacing: 60n, ext: extCell({ taxRecipient: H, sellTaxBps: 10n }) };
        const p3 = d.chain.openContract(await Pool.fromInit(fr.address, k3));
        res = await p3.send(fr.getSender(), { value: toNano('3') }, { ...mintBody, amount1: 0n });
        expect(refundCodes(res)).toEqual([CODES.BAD_KEY]);
        expect((await p3.getGetPoolState()).initialized).toBe(false);
        // Only the initializer can initialize a taxed key (bob gets NOT_INITIALIZER on alice's real key).
        const k4 = extCell({ initializer: A, taxRecipient: H, sellTaxBps: 10n });
        res = await d.mintNative(d.bob, toNano('10'), d.tokA, 600n, 1200n, { ext: k4, sqrtPriceInit: Q96 });
        expect(refundCodes(res)).toEqual([CODES.NOT_INITIALIZER]);
    });

    it('buy tax: exact on the Gram input (with referral, quote and event), outside the LP fee accounting', async () => {
        const amount = toNano('37');
        const t = BigInt(d.now);
        const q = await pool.getGetQuote(true, amount, 0n, 24n, 7n, false);
        const exp = sim.swap(true, amount, 0n, 24, 7n, false, 0n, t, true);
        expect([q.code, q.amountOut, q.tax, q.refFee, q.feeTotal, q.consumed, q.platformFee]).toEqual([0n, exp.out, exp.tax, exp.refFee, exp.feeTotal, exp.consumed, exp.plat]);
        expect(exp.tax).toBe((amount * BUY) / 10000n);
        // A taxed key has an initializer: a launch key, so the PLATFORM FEE applies too.
        expect(exp.plat).toBe((amount * M.PLATFORM_FEE_CAP_BPS) / 10000n);
        expect(exp.consumed + exp.refFee + exp.tax + exp.plat).toBe(amount);
        const ref = await d.chain.treasury('ref');
        const res = await d.swapNative(d.bob, amount, d.tokA, { ext: extT, referral: ref.address, refBps: 7n });
        expectNoFailures(res);
        const ev = swapEvents(res)[0];
        expect([ev.amountIn, ev.amountOut, ev.tax, ev.refFee, ev.platformFee]).toEqual([amount, exp.out, exp.tax, exp.refFee, exp.plat]);
        // 1.11 Gram of tax >= TAX_MIN_PAYOUT: paid to the recipient in the same transaction.
        expect(gramPayouts(res, taxman.address).map((x) => [x.reason, x.amount, x.value])).toEqual([[REASON.TAX, exp.tax, exp.tax + M.TAX_PAYOUT_GAS]]);
        await expectPoolEquals(pool, sim);
        await d.checkSolvency([pool]);
    });

    it('sell tax: exact on the Gram output; minOut is checked net of the tax', async () => {
        const amount = toNano('41');
        const t = BigInt(d.now);
        const exp0 = sim.swap(false, amount, 0n, 24, 0n, false, 0n, t, false);
        expect(exp0.tax).toBe((exp0.grossOut * SELL) / 10000n);
        expect(exp0.plat).toBe((exp0.grossOut * M.PLATFORM_FEE_CAP_BPS) / 10000n);
        expect(exp0.out).toBe(exp0.grossOut - exp0.tax - exp0.plat);
        // minOut = net + 1 → SLIPPAGE (refunded); minOut = net → fills.
        let res = await d.swapJetton(d.jA, d.bob, amount, GRAM, { ext: extT, minOut: exp0.out + 1n });
        expect(refundCodes(res)).toEqual([CODES.SLIPPAGE]);
        await expectPoolEquals(pool, sim);
        const exp = sim.swap(false, amount, 0n, 24, 0n, false, exp0.out, t, true);
        res = await d.swapJetton(d.jA, d.bob, amount, GRAM, { ext: extT, minOut: exp0.out });
        expectNoFailures(res);
        expect(gramPayouts(res, d.bob.address).filter((x) => x.reason === REASON.SWAP_OUT).map((x) => x.amount)).toEqual([exp.out]);
        const ev = swapEvents(res)[0];
        expect([ev.amountOut, ev.tax, ev.platformFee]).toEqual([exp.out, exp.tax, exp.plat]);
        await expectPoolEquals(pool, sim);
        await d.checkSolvency([pool]);
    });

    it('partial fill: tax and referral are charged on the filled part only; the refund is exact', async () => {
        const t = BigInt(d.now);
        const limit = M.sqrtAt(-120);
        const amount = toNano('500');
        const exp = sim.swap(true, amount, limit, 24, 5n, true, 0n, t, true);
        expect(exp.refund).toBeGreaterThan(0n);
        expect(exp.consumed + exp.refFee + exp.tax + exp.plat + exp.refund).toBe(amount);
        expect(exp.plat).toBeLessThan((amount * M.PLATFORM_FEE_CAP_BPS) / 10000n);
        expect(exp.tax).toBeLessThan((amount * BUY) / 10000n);
        const ref = await d.chain.treasury('ref');
        const res = await d.swapNative(d.bob, amount, d.tokA, { ext: extT, limit, allowPartial: true, referral: ref.address, refBps: 5n });
        expectNoFailures(res);
        expect(gramPayouts(res, d.bob.address).filter((x) => x.reason === REASON.PARTIAL_REFUND).map((x) => x.amount)).toEqual([exp.refund]);
        expect(swapEvents(res)[0].tax).toBe(exp.tax);
        await expectPoolEquals(pool, sim);
    });

    it('CollectTax: anyone triggers, the recipient gets exactly taxFees; a second collect pays nothing; untaxed pool → excess to caller', async () => {
        const t = BigInt(d.now);
        // Small swaps: the tax stays below TAX_MIN_PAYOUT, so it accrues (no auto-payout).
        sim.swap(true, toNano('1'), 0n, 24, 0n, false, 0n, t, true);
        let r0 = await d.swapNative(d.bob, toNano('1'), d.tokA, { ext: extT });
        expect(gramPayouts(r0, taxman.address)).toEqual([]);
        sim.swap(false, toNano('1'), 0n, 24, 0n, false, 0n, t, true);
        r0 = await d.swapJetton(d.jA, d.bob, toNano('1'), GRAM, { ext: extT });
        expect(gramPayouts(r0, taxman.address)).toEqual([]);
        await expectPoolEquals(pool, sim);
        const owed = sim.taxFees;
        expect(owed).toBeGreaterThan(0n);
        expect(owed).toBeLessThan(M.TAX_MIN_PAYOUT);
        const st = await pool.getGetPoolState();
        let res = await d.collectTax(d.carol, st.key);
        expectNoFailures(res);
        const paid = gramPayouts(res, taxman.address).filter((x) => x.reason === REASON.TAX);
        expect(paid.map((x) => x.amount)).toEqual([owed]);
        expect(paid[0].value).toBeGreaterThanOrEqual(owed);
        sim.taxFees = 0n;
        await expectPoolEquals(pool, sim);
        await d.checkSolvency([pool]);
        res = await d.collectTax(d.carol, st.key);
        expectNoFailures(res);
        expect(gramPayouts(res, taxman.address)).toEqual([]);
        // An untaxed pool: nothing to pay, the value comes back to the caller.
        const plainPool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintNative(d.alice, toNano('10'), d.tokA, 600n, 1200n, { sqrtPriceInit: Q96 }));
        const g0 = await d.gram(d.carol.address);
        res = await d.collectTax(d.carol, (await plainPool.getGetPoolState()).key);
        expectNoFailures(res);
        expect(g0 - (await d.gram(d.carol.address))).toBeLessThan(toNano('0.05'));
        // Too little value: the Router throws (bounce).
        res = await d.collectTax(d.carol, st.key, toNano('0.1'));
        expect(failedAt(res, d.router.address).length).toBe(1);
    });

    it('a 0-tax key behaves exactly like a plain key; tax gas overhead', async () => {
        // Two fresh pools seeded identically: plain (ext null) and taxed; plus a "0-tax ext" pool.
        const zero = extCell({ initializer: d.alice.address });
        const pz = await d.poolOf(GRAM, d.tokA, 60n, zero);
        const sz = new M.PoolSim(60, { ...M.PLAIN_EXT, initializer: d.alice.address.toString() });
        await seed(pz, sz, zero);
        const pp = await d.poolOf(GRAM, d.tokA, 60n, null);
        const sp = new M.PoolSim(60);
        await seed(pp, sp, null);
        const t = BigInt(d.now);
        const gas: Record<string, bigint> = {};
        for (const [name, p, s, ext] of [['plain', pp, sp, null], ['zero', pz, sz, zero], ['taxed', pool, sim, extT]] as const) {
            const eb = (s as M.PoolSim).swap(true, toNano('25'), 0n, 24, 0n, false, 0n, t, true);
            let res = await d.swapNative(d.bob, toNano('25'), d.tokA, { ext });
            expectNoFailures(res);
            gas[name + ' buy'] = gasAt(res, p.address, OP.PoolSwap)[0];
            expect(swapEvents(res)[0].amountOut).toBe(eb.out);
            const es = (s as M.PoolSim).swap(false, toNano('25'), 0n, 24, 0n, false, 0n, t, true);
            res = await d.swapJetton(d.jA, d.bob, toNano('25'), GRAM, { ext });
            expectNoFailures(res);
            gas[name + ' sell'] = gasAt(res, p.address, OP.PoolSwap)[0];
            expect(swapEvents(res)[0].amountOut).toBe(es.out);
            await expectPoolEquals(p, s as M.PoolSim);
            if (name !== 'taxed') {
                expect([eb.tax, es.tax]).toEqual([0n, 0n]);
            }
        }
        // Same pool state and same outputs for plain and 0-tax keys when both pay the same PLATFORM
        // FEE (all Gram pools); with launch-keys-only the 0-tax key (an initializer) pays it, plain doesn't.
        const a = await pp.getGetPoolState();
        const b = await pz.getGetPoolState();
        if (sp.charged === sz.charged) {
            expect([a.sqrtPriceX96, a.reserve0, a.reserve1, a.feeGrowth0X128, a.taxFees]).toEqual([b.sqrtPriceX96, b.reserve0, b.reserve1, b.feeGrowth0X128, b.taxFees]);
        } else {
            expect([sp.charged, sz.charged]).toEqual([false, true]);
            expect(b.reserve0).toBeLessThan(a.reserve0);
        }
        // eslint-disable-next-line no-console
        console.log('swap gas (Pool compute): ' + Object.entries(gas).map(([k, v]) => `${k} ${v}`).join(', '));
        // The taxed swaps also send the tax auto-payout (one more message).
        expect(gas['taxed buy'] - gas['zero buy']).toBeLessThan(5000n);
        expect(gas['taxed sell'] - gas['zero sell']).toBeLessThan(5000n);
    });
});
