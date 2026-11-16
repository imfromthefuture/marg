// PLATFORM FEE (pump.fun style): launch keys (ext.initializer != null) of Gram pools pay a share of
// the Gram side of every swap (buy: of the Gram input; sell: of the Gram output) straight to the
// Router's treasury, in the same transaction. One global rate in the Router (initially and at most
// PLATFORM_FEE_CAP_BPS = 1%), admin-settable in [0, cap], passed to the pool with every swap.
// Below PLATFORM_MIN_PAYOUT (0.01 Gram) the fee is carried in Pool.platformFees (part of keep()).
// Also: the creator TAX auto-payout once taxFees reach TAX_MIN_PAYOUT.
//
// Scope switch: constants.tact PLATFORM_FEE_ALL_GRAM_POOLS (model.ts reads it). Every expectation
// about WHICH pools pay goes through M.platformCharged(), so flipping the switch flips the tests.
//
// Launch pools use the 0.05% preset (tickSpacing 10).

import { Address, Cell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, CODES, REASON, Pool, expectNoFailures, refundCodes, gramPayouts, swapEvents, expectPoolEquals,
    encodeSqrtPrice, extCell, failedAt, findMin, txOk, LaunchOpts,
} from './helpers';
import * as M from './model';

jest.setTimeout(900000);

const JET = toNano('50000000');
const MCAP = toNano('1300');
const SQRT = encodeSqrtPrice(JET, MCAP);
const S = 10;                                       // launch preset: 0.05%
const LO: LaunchOpts = { tickSpacing: BigInt(S) };
const BPS = 10000n;

type Key = { token0: Address; token1: Address; tickSpacing: bigint; ext: Cell | null };

describe('PLATFORM FEE', () => {
    let d: Dex;
    let base: any;
    let dave: SandboxContract<TreasuryContract>;
    let key: Key;
    let pool: SandboxContract<Pool>;
    let sim: M.PoolSim;
    const extM = (o: LaunchOpts = LO): M.ExtModel => ({
        ...M.PLAIN_EXT, initializer: d.alice.address.toString(), buyTaxBps: o.buyTaxBps ?? 0n, sellTaxBps: o.sellTaxBps ?? 0n,
    });
    const pk = (k: Key) => ({ $$type: 'PoolKey' as const, token0: k.token0, token1: k.token1, tickSpacing: k.tickSpacing, ext: k.ext });
    const setFee = (from: SandboxContract<TreasuryContract>, bps: bigint) =>
        d.router.send(from.getSender(), { value: toNano('0.1') }, { $$type: 'SetPlatformFee', queryId: 0n, bps });
    const collectPlatform = (from: SandboxContract<TreasuryContract>, k: Key, value = toNano('0.3')) =>
        d.router.send(from.getSender(), { value }, { $$type: 'CollectPlatformFees', queryId: 4n, key: pk(k) });
    const platPayouts = (res: any) => gramPayouts(res, d.treasury.address).filter((x) => x.reason === REASON.PLATFORM);

    async function launchPool(o: LaunchOpts = LO) {
        const k = await d.launchKey(d.tokA, d.alice.address, o);
        const p = await d.poolOf(GRAM, d.tokA, BigInt(S), k.ext);
        const s = new M.PoolSim(S, extM(o));
        expect(s.launch(SQRT, JET, BigInt(d.now), M.PRESETS[S]).code).toBe(0);
        expectNoFailures(await d.launch(d.jA, d.alice, JET, SQRT, d.carol.address, d.alice.address, o));
        await expectPoolEquals(p, s);
        return { k, p, s };
    }

    // quote (get_quote, and get_quote2 at the Router's rate) == model == execution, incl. the fee and
    // its direct payout.
    async function swapChecked(s: M.PoolSim, p: SandboxContract<Pool>, k: Key, user: SandboxContract<TreasuryContract>,
                               zfo: boolean, amount: bigint, o: { allowPartial?: boolean; limit?: bigint } = {}) {
        const t = BigInt(d.now);
        const rate = await d.router.getGetPlatformFee();
        const exp0 = s.swap(zfo, amount, o.limit ?? 0n, 24, 0n, o.allowPartial ?? false, 0n, t, false, rate);
        const q2 = await p.getGetQuote2(zfo, amount, o.limit ?? 0n, 24n, 0n, o.allowPartial ?? false, rate);
        expect([q2.code, q2.amountOut, q2.platformFee, q2.tax, q2.refund, q2.sqrtPriceAfter])
            .toEqual([BigInt(exp0.code), exp0.out, exp0.plat, exp0.tax, exp0.refund, exp0.sqrtP]);
        if ((await p.getGetPoolState()).platformBps === rate) {
            const q = await p.getGetQuote(zfo, amount, o.limit ?? 0n, 24n, 0n, o.allowPartial ?? false);
            expect([q.amountOut, q.platformFee]).toEqual([exp0.out, exp0.plat]);
        }
        const exp = s.swap(zfo, amount, o.limit ?? 0n, 24, 0n, o.allowPartial ?? false, 0n, t, true, rate);
        expect(exp.code).toBe(0);
        const so = { tickSpacing: k.tickSpacing, ext: k.ext, allowPartial: o.allowPartial, limit: o.limit };
        const res = zfo ? await d.swapNative(user, amount, d.tokA, so) : await d.swapJetton(d.jA, user, amount, GRAM, so);
        expectNoFailures(res);
        const ev = swapEvents(res)[0];
        expect([ev.amountOut, ev.platformFee, ev.tax]).toEqual([exp.out, exp.plat, exp.tax]);
        if (zfo) expect(ev.amountIn).toBe(amount - exp.refund);
        // Same transaction: the treasury gets exactly the due platform fee (value == amount).
        expect(platPayouts(res).map((x) => [x.amount, x.value])).toEqual(exp.platPaid > 0n ? [[exp.platPaid, exp.platPaid]] : []);
        expect(gramPayouts(res).filter((x) => x.reason === REASON.TAX).map((x) => [x.amount, x.value]))
            .toEqual(exp.taxPaid > 0n ? [[exp.taxPaid, exp.taxPaid + M.TAX_PAYOUT_GAS]] : []);
        if (!zfo) {
            expect(gramPayouts(res, user.address).filter((x) => x.reason === REASON.SWAP_OUT).map((x) => x.amount)).toEqual([exp.out]);
        }
        await expectPoolEquals(p, s);
        await d.checkSolvency([p]);
        return { exp, res };
    }

    beforeAll(async () => {
        d = await Dex.create();
        dave = await d.chain.treasury('dave', { balance: toNano('1000000') });
        ({ k: key, p: pool } = await launchPool());
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
        sim = new M.PoolSim(S, extM());
        sim.launch(SQRT, JET, BigInt(d.now), M.PRESETS[S]);
        await expectPoolEquals(pool, sim);
    });

    it('defaults: 1% (= cap), the launch key is charged, the pool knows the rate from the launch', async () => {
        expect(await d.router.getGetPlatformFee()).toBe(100n);
        expect(sim.charged).toBe(true);
        const st = await pool.getGetPoolState();
        expect([st.platformBps, st.platformFees]).toEqual([100n, 0n]);
        // Router flags: LAUNCH_FLAG (512) marks an initializer key.
        expect(await d.router.getGetExtValid(key.ext)).toBe(512n);
    });

    it('buy: exactly 1% of the Gram input goes to the treasury in the same transaction; quote == execution', async () => {
        const amount = toNano('10');
        const { exp } = await swapChecked(sim, pool, key, d.bob, true, amount);
        expect(exp.plat).toBe((amount * 100n) / BPS);
        expect(exp.platPaid).toBe(exp.plat);
        expect(exp.consumed + exp.plat).toBe(amount);
        expect((await pool.getGetPoolState()).platformFees).toBe(0n);
    });

    it('sell: exactly 1% of the Gram output goes to the treasury; the seller gets the rest', async () => {
        await swapChecked(sim, pool, key, d.bob, true, toNano('50'));
        const { exp } = await swapChecked(sim, pool, key, d.bob, false, toNano('500000'));
        expect(exp.plat).toBe((exp.grossOut * 100n) / BPS);
        expect(exp.out).toBe(exp.grossOut - exp.plat);
        expect(exp.platPaid).toBe(exp.plat);
    });

    it('partial fill: the fee is charged on the filled part only; the refund is exact', async () => {
        const amount = toNano('5000');
        const limit = M.sqrtAt(sim.tick - 40 * S);
        const { exp } = await swapChecked(sim, pool, key, d.bob, true, amount, { allowPartial: true, limit });
        expect(exp.refund).toBeGreaterThan(0n);
        expect(exp.plat).toBeLessThan((amount * 100n) / BPS);
        expect(exp.consumed + exp.plat + exp.refund).toBe(amount);
    });

    it('a plain key and an ext key without initializer pay nothing (unless the scope switch says all Gram pools)', async () => {
        for (const ext of [null, extCell({ minLockSecs: 60n })]) {
            const p = await d.poolOf(GRAM, d.tokA, 60n, ext);
            const s = new M.PoolSim(60, { ...M.PLAIN_EXT, minLockSecs: ext ? 60n : 0n });
            expect(s.charged).toBe(M.platformCharged(true, null));
            const t = BigInt(d.now);
            expect(s.mint(-6000, 6000, toNano('100'), toNano('100'), 0n, Q96, t, M.PRESETS[60]).code).toBe(0);
            expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('100'), GRAM, -6000n, 6000n, toNano('100'), { ext, sqrtPriceInit: Q96 }));
            for (const zfo of [true, false]) {
                const amount = toNano('5');
                const q = await p.getGetQuote2(zfo, amount, 0n, 24n, 0n, false, 100n);
                const e = s.swap(zfo, amount, 0n, 24, 0n, false, 0n, t, true, 100n);
                expect([q.platformFee, q.amountOut]).toEqual([e.plat, e.out]);
                expect(e.plat).toBe(s.charged ? ((zfo ? amount : e.grossOut) * 100n) / BPS : 0n);
                const res = zfo ? await d.swapNative(d.bob, amount, d.tokA, { ext })
                    : await d.swapJetton(d.jA, d.bob, amount, GRAM, { ext });
                expectNoFailures(res);
                expect(swapEvents(res)[0].platformFee).toBe(e.plat);
                expect(platPayouts(res).map((x) => x.amount)).toEqual(e.platPaid > 0n ? [e.platPaid] : []);
            }
            await expectPoolEquals(p, s);
        }
    });

    it('sub-minimum fees are carried (in keep()) and paid with the next qualifying swap', async () => {
        // 0.5 Gram buy: fee 0.005 < PLATFORM_MIN_PAYOUT, carried.
        const a = await swapChecked(sim, pool, key, d.bob, true, toNano('0.5'));
        expect([a.exp.plat, a.exp.platPaid]).toEqual([toNano('0.005'), 0n]);
        let st = await pool.getGetPoolState();
        expect(st.platformFees).toBe(toNano('0.005'));
        expect(await d.gram(pool.address)).toBeGreaterThanOrEqual(st.reserve0 + st.protocolFees0 + st.platformFees);
        // 0.4 Gram: 0.009 carried in total, still below.
        const b = await swapChecked(sim, pool, key, d.carol, true, toNano('0.4'));
        expect(b.exp.platPaid).toBe(0n);
        // 0.2 Gram: 0.011 >= 0.01 → the whole carried amount goes out with this swap.
        const c = await swapChecked(sim, pool, key, d.bob, true, toNano('0.2'));
        expect(c.exp.platPaid).toBe(toNano('0.011'));
        st = await pool.getGetPoolState();
        expect(st.platformFees).toBe(0n);
    });

    it('carried fees cannot be swept by other payouts; CollectPlatformFees pays them (anyone) to the treasury', async () => {
        await swapChecked(sim, pool, key, d.bob, true, toNano('0.7'));     // 0.007 carried
        const carried = (await pool.getGetPoolState()).platformFees;
        expect(carried).toBe(toNano('0.007'));
        // reserveForCaller paths: protocol collect, tax collect on an untaxed key, a Gram donation.
        let res = await d.router.send(d.carol.getSender(), { value: toNano('0.3') }, { $$type: 'CollectProtocolFees', queryId: 3n, key: pk(key) });
        expectNoFailures(res);
        expect(gramPayouts(res, d.treasury.address).filter((x) => x.reason === REASON.PROTOCOL_FEE).map((x) => x.amount)).toEqual([sim.protocolFees0]);
        sim.protocolFees0 = 0n;
        sim.protocolFees1 = 0n;
        const g0 = await d.gram(d.carol.address);
        res = await d.collectTax(d.carol, key);
        expectNoFailures(res);
        expect(await d.gram(d.carol.address)).toBeLessThanOrEqual(g0);     // the caller gains nothing
        expectNoFailures(await d.carol.send({ to: pool.address, value: toNano('1') }));
        let st = await pool.getGetPoolState();
        expect(st.platformFees).toBe(carried);
        expect(await d.gram(pool.address)).toBeGreaterThanOrEqual(st.reserve0 + st.protocolFees0 + st.platformFees + st.endowment);
        await expectPoolEquals(pool, sim);
        // Anyone flushes it; always to the treasury, exactly the carried amount.
        res = await collectPlatform(dave, key);
        expectNoFailures(res);
        expect(platPayouts(res).map((x) => x.amount)).toEqual([carried]);
        sim.platformFees = 0n;
        await expectPoolEquals(pool, sim);
        res = await collectPlatform(dave, key);
        expectNoFailures(res);
        expect(platPayouts(res)).toEqual([]);
        // Too little value: the Router throws (bounce).
        res = await collectPlatform(dave, key, toNano('0.1'));
        expect(failedAt(res, d.router.address).length).toBe(1);
        st = await pool.getGetPoolState();
        expect(st.platformFees).toBe(0n);
    });

    it('SetPlatformFee: admin only, any rate in [0, 100]; applies to existing pools at once; get_quote2 is exact before the next swap', async () => {
        let res = await setFee(d.bob, 50n);
        expect(failedAt(res, d.router.address).length).toBe(1);
        res = await setFee(d.admin, 101n);
        expect(failedAt(res, d.router.address).length).toBe(1);
        expect(await d.router.getGetPlatformFee()).toBe(100n);

        expectNoFailures(await setFee(d.admin, 30n));
        expect(await d.router.getGetPlatformFee()).toBe(30n);
        // The pool still shows the last-seen rate in get_quote; get_quote2 with the Router's rate is exact.
        const amount = toNano('20');
        const stale = await pool.getGetQuote(true, amount, 0n, 24n, 0n, false);
        expect(stale.platformFee).toBe((amount * 100n) / BPS);
        const { exp } = await swapChecked(sim, pool, key, d.bob, true, amount);
        expect(exp.plat).toBe((amount * 30n) / BPS);
        expect((await pool.getGetPoolState()).platformBps).toBe(30n);
        expect((await pool.getGetQuote(true, amount, 0n, 24n, 0n, false)).platformFee).toBe((amount * 30n) / BPS);

        expectNoFailures(await setFee(d.admin, 0n));
        const z = await swapChecked(sim, pool, key, d.bob, false, toNano('100000'));
        expect([z.exp.plat, z.exp.platPaid]).toEqual([0n, 0n]);

        // Raising back is allowed (up to the cap).
        expectNoFailures(await setFee(d.admin, 100n));
        const r = await swapChecked(sim, pool, key, d.carol, true, amount);
        expect(r.exp.plat).toBe((amount * 100n) / BPS);
        // A getter rate above the cap is refused by the quote (code), never charged.
        expect((await pool.getGetQuote2(true, amount, 0n, 24n, 0n, false, 101n)).code).toBe(BigInt(CODES.BAD_REF_BPS));
    });

    it('treasury change applies to the next payout (the Router passes the recipient with every swap)', async () => {
        expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetTreasury', queryId: 0n, treasury: dave.address }));
        const res = await d.swapNative(d.bob, toNano('10'), d.tokA, { tickSpacing: key.tickSpacing, ext: key.ext });
        expectNoFailures(res);
        expect(gramPayouts(res, dave.address).filter((x) => x.reason === REASON.PLATFORM).map((x) => x.amount)).toEqual([toNano('0.1')]);
    });

    it('creator TAX auto-payout: accrues below TAX_MIN_PAYOUT, then the whole taxFees goes to the recipient (reason TAX, + TAX_PAYOUT_GAS)', async () => {
        const o: LaunchOpts = { ...LO, buyTaxBps: 300n, sellTaxBps: 500n, taxRecipient: dave.address, launchFeePips: 0n };
        const { k, p, s } = await launchPool(o);
        // 2 Gram buy: 0.06 tax < 0.1, accrues.
        const a = await swapChecked(s, p, k, d.bob, true, toNano('2'));
        expect([a.exp.tax, a.exp.taxPaid]).toEqual([toNano('0.06'), 0n]);
        expect((await p.getGetPoolState()).taxFees).toBe(toNano('0.06'));
        // another 2 Gram: 0.12 >= 0.1 → paid out in this swap, the whole amount, to the recipient.
        const b = await swapChecked(s, p, k, d.carol, true, toNano('2'));
        expect(b.exp.taxPaid).toBe(toNano('0.12'));
        const paid = gramPayouts(b.res, dave.address);
        expect(paid.map((x) => [x.reason, x.amount, x.value])).toEqual([[REASON.TAX, toNano('0.12'), toNano('0.12') + M.TAX_PAYOUT_GAS]]);
        // ... and the platform fee of the same swap went to the treasury.
        expect(platPayouts(b.res).map((x) => x.amount)).toEqual([toNano('0.02')]);
        expect((await p.getGetPoolState()).taxFees).toBe(0n);
        // A large sell pays its tax at once too.
        const c = await swapChecked(s, p, k, d.bob, false, toNano('100000'));
        expect(c.exp.taxPaid).toBe(c.exp.tax);
        expect(c.exp.out + c.exp.tax + c.exp.plat).toBe(c.exp.grossOut);
    });

    it('gas: the Router requires the payout gas; a taxed launch swap at exactly the minimum pays both fees and never fails', async () => {
        const plain = await d.router.getGetSwapGas(24n, false, 0n, null, true);
        const launch = await d.router.getGetSwapGas(24n, false, 0n, key.ext, true);
        const o: LaunchOpts = { ...LO, buyTaxBps: 300n, sellTaxBps: 500n, taxRecipient: dave.address };
        const kt = await d.launchKey(d.tokA, d.alice.address, o);
        const taxed = await d.router.getGetSwapGas(24n, false, 0n, kt.ext, true);
        const all = M.PLATFORM_FEE_ALL_GRAM_POOLS ? M.PAYOUT_MSG_GAS : 0n;
        expect(launch - plain).toBe(M.PAYOUT_MSG_GAS - all);
        expect(taxed - launch).toBe(M.PAYOUT_MSG_GAS + M.TAX_PAYOUT_GAS);
        expect(await d.router.getGetSwapGas(24n, false, 0n, key.ext, false)).toBe(plain - all);   // jetton/jetton: no Gram side

        const { k, p } = await launchPool(o);
        const amount = toNano('20');                   // tax 0.6 and fee 0.2: both paid in the swap
        const ok = async (g: bigint) => {
            const res = await d.swapNative(d.bob, amount, d.tokA, { tickSpacing: k.tickSpacing, ext: k.ext, gas: g });
            return !failedAt(res, d.router.address).length && refundCodes(res).length === 0;
        };
        const min = await findMin(d.chain, toNano('0.3'), toNano('1'), ok);
        expect(min).toBeGreaterThanOrEqual(taxed);
        expect(min - taxed).toBeLessThan(toNano('0.02'));         // only the 2 forward fees on top
        const res = await d.swapNative(d.bob, amount, d.tokA, { tickSpacing: k.tickSpacing, ext: k.ext, gas: min });
        expect(res.transactions.every((tx) => txOk(tx))).toBe(true);
        expect(gramPayouts(res, dave.address).map((x) => [x.reason, x.amount])).toEqual([[REASON.TAX, toNano('0.6')]]);
        expect(platPayouts(res).map((x) => x.amount)).toEqual([toNano('0.2')]);
        expect(gramPayouts(res, d.bob.address)).toEqual([]);      // nothing refunded, the jettons are the output
        await d.checkSolvency([p]);
    });
});
