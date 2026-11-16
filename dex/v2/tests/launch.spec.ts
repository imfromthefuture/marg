// Direct launch (§6.11): one jetton transfer from the launch master creates the canonical
// Gram/jetton pool with NO Gram leg. The pool starts at the given price (floored to the spacing),
// the whole deposit is one jetton-only position [minUsable, tU] locked forever for the fee
// claimer, and the optional dev buy runs inside the same Pool transaction. Everything is checked
// against the BigInt model (model.ts PoolSim.launch / swap).

import { Address, beginCell, Cell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, CODES, REASON, OP, Pool, expectNoFailures, modifyEvents, refundCodes, gramPayouts, initEvents,
    launchEvents, swapEvents, simOf, expectPoolEquals, failedAt, findMin, encodeSqrtPrice, gasAt, events, LaunchOpts,
    MIN_SQRT_RATIO, MAX_SQRT_RATIO, rng, opOf, PRINT_FEES,
} from './helpers';
import * as M from './model';

jest.setTimeout(900000);

const JET = toNano('50000000');                    // 50M tokens into the pool
const MCAP = toNano('1300');                        // start market cap of those tokens, in Gram
const SQRT = encodeSqrtPrice(JET, MCAP);            // sqrt(jetton per Gram)
const LO: LaunchOpts = { tickSpacing: 200n, launchFeePips: 100000n, launchDuration: 600n };

describe('direct launch', () => {
    let d: Dex;
    let base: any;
    let dave: SandboxContract<TreasuryContract>;
    let key: { token0: Address; token1: Address; tickSpacing: bigint; ext: Cell | null };
    let pool: SandboxContract<Pool>;
    const extM = (o: LaunchOpts = LO): M.ExtModel => ({
        ...M.PLAIN_EXT, launchFeePips: o.launchFeePips ?? 0n, launchDuration: o.launchDuration ?? 0n,
        initializer: d.alice.address.toString(), buyTaxBps: o.buyTaxBps ?? 0n, sellTaxBps: o.sellTaxBps ?? 0n,
    });

    // alice plays the launch master; carol is the fee claimer (treasury); alice gets refunds.
    const launch = (o: LaunchOpts & { jet?: bigint; claimer?: Address; refundTo?: Address; sqrt?: bigint; who?: any } = {}) =>
        d.launch(d.jA, o.who ?? d.alice, o.jet ?? JET, o.sqrt ?? SQRT, o.claimer ?? d.carol.address, o.refundTo ?? d.alice.address,
            { ...LO, ...o });

    async function swapChecked(sim: M.PoolSim, p: SandboxContract<Pool>, ext: Cell | null, user: SandboxContract<TreasuryContract>,
                               zfo: boolean, amount: bigint) {
        const t = BigInt(d.now);
        const exp0 = sim.swap(zfo, amount, 0n, 24, 0n, false, 0n, t, false);
        const q = await p.getGetQuote(zfo, amount, 0n, 24n, 0n, false);
        expect([q.code, q.amountOut, q.tax, q.feeTotal, q.sqrtPriceAfter, q.platformFee]).toEqual([BigInt(exp0.code), exp0.out, exp0.tax, exp0.feeTotal, exp0.sqrtP, exp0.plat]);
        const exp = sim.swap(zfo, amount, 0n, 24, 0n, false, 0n, t, true);
        expect(exp.code).toBe(0);
        const jb = await d.jBal(d.jA, user.address);
        const res = zfo ? await d.swapNative(user, amount, d.tokA, { tickSpacing: 200n, ext })
            : await d.swapJetton(d.jA, user, amount, GRAM, { tickSpacing: 200n, ext });
        expectNoFailures(res);
        const ev = swapEvents(res)[0];
        expect([ev.amountOut, ev.tax, ev.feeTotal, ev.sqrtPriceX96, ev.platformFee]).toEqual([exp.out, exp.tax, exp.feeTotal, exp.sqrtP, exp.plat]);
        // Direct payouts in the same transaction: the PLATFORM FEE to the treasury (launch key), the
        // tax to its recipient once taxFees reach TAX_MIN_PAYOUT.
        expect(exp.plat).toBe(((zfo ? amount : exp.grossOut) * M.PLATFORM_FEE_CAP_BPS) / 10000n);
        expect(gramPayouts(res, d.treasury.address).map((x) => [x.reason, x.amount])).toEqual(exp.platPaid > 0n ? [[REASON.PLATFORM, exp.platPaid]] : []);
        expect(gramPayouts(res).filter((x) => x.reason === REASON.TAX).map((x) => [x.amount, x.value])).toEqual(
            exp.taxPaid > 0n ? [[exp.taxPaid, exp.taxPaid + M.TAX_PAYOUT_GAS]] : []);
        if (zfo) {
            expect(await d.jBal(d.jA, user.address)).toBe(jb + exp.out);
        } else {
            expect(gramPayouts(res, user.address).filter((x) => x.reason === REASON.SWAP_OUT).map((x) => x.amount)).toEqual([exp.out]);
        }
        await expectPoolEquals(p, sim);
        return { exp, res };
    }

    beforeAll(async () => {
        d = await Dex.create();
        dave = await d.chain.treasury('dave', { balance: toNano('1000000') });
        key = await d.launchKey(d.tokA, d.alice.address, LO);
        pool = d.chain.openContract(Pool.fromAddress(await d.router.getGetLaunchPoolAddress(d.tokA, 200n, d.alice.address,
            100000n, 600n, null, 0n, 0n)));
        expect((await d.poolOf(GRAM, d.tokA, 200n, key.ext)).address.equals(pool.address)).toBe(true);
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('initializes at the floored start tick with one jetton-only position, locked forever, owned by the fee claimer', async () => {
        const jb = await d.jBal(d.jA, d.alice.address);
        const res = await launch();
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        const sim = new M.PoolSim(200, extM());
        const e = sim.launch(SQRT, JET, BigInt(d.now), M.PRESETS[200]) as any;
        expect(e.code).toBe(0);
        await expectPoolEquals(pool, sim);
        // The range sits entirely on the jetton side: tU <= start tick < tU + spacing, no Gram used.
        const t0 = M.tickAt(SQRT);
        expect(e.tU).toBeLessThanOrEqual(t0);
        expect(e.tU).toBeGreaterThan(t0 - 200);
        expect(e.tL).toBe(M.minUsable(200));
        const st = await pool.getGetPoolState();
        expect([st.initialized, st.tick, st.sqrtPriceX96, st.liquidity, st.reserve0, st.reserve1, st.tickCount])
            .toEqual([true, BigInt(e.tU), M.sqrtAt(e.tU), 0n, 0n, e.mint.use1, 2n]);
        // Start market cap: within one spacing (1%) above the requested one.
        const mcap = (JET * Q96 * Q96) / (st.sqrtPriceX96 * st.sqrtPriceX96);
        expect(mcap).toBeGreaterThanOrEqual(MCAP - 1n);
        expect(mcap).toBeLessThan((MCAP * 10201n) / 10000n);
        // Dust (< sqrt(price) units) is booked as protocol fee: the Router wallet is exactly backed.
        expect(e.dust).toBeLessThan(1000n);
        expect(st.protocolFees1).toBe(e.dust);
        expect(e.mint.use1 + e.dust).toBe(JET);
        expect(await d.jBal(d.jA, d.alice.address)).toBe(jb - JET);
        expect(await d.routerHolds(d.tokA)).toBe(JET);
        // Events: InitializeEvent (graduation flag, initializer) + LaunchEvent naming the key.
        const ini = initEvents(res);
        expect([ini.length, ini[0].graduation, ini[0].initializer!.toString(), ini[0].tick]).toEqual([1, true, d.alice.address.toString(), BigInt(e.tU)]);
        const le = launchEvents(res);
        expect(le.length).toBe(1);
        expect([le[0].key.token0.toString(), le[0].key.token1.toString(), le[0].key.tickSpacing, le[0].key.ext!.hash().equals(key.ext!.hash())])
            .toEqual([GRAM.toString(), d.tokA.toString(), 200n, true]);
        expect([le[0].feeClaimer.toString(), le[0].tickLower, le[0].tickUpper, le[0].liquidity, le[0].amount1, le[0].devIn, le[0].devOut])
            .toEqual([d.carol.address.toString(), BigInt(e.tL), BigInt(e.tU), e.mint.liq, e.mint.use1, 0n, 0n]);
        const pd = await (await d.position(pool, 0n)).getGetPositionData();
        expect([pd.owner.toString(), pd.lockedUntil, pd.tickLower, pd.tickUpper, pd.liquidity])
            .toEqual([d.carol.address.toString(), 0xFFFFFFFFn, BigInt(e.tL), BigInt(e.tU), e.mint.liq]);
        // The Gram excess went back to refundTo.
        expect(events(res).filter((x) => x.op === OP.RefundEvent).length).toBe(0);
        await d.checkSolvency([pool]);
    });

    it('buys walk the price up (tick down), sells walk it back; quote == execution == model; launch-decay fee applies then decays', async () => {
        expectNoFailures(await launch());
        const sim = new M.PoolSim(200, extM());
        sim.launch(SQRT, JET, BigInt(d.now), M.PRESETS[200]);
        // t0: base 1% + 10% launch extra (no volatility fee: the reference starts at tU).
        expect((await pool.getGetPoolState()).feePipsNow).toBe(10000n + 100000n);
        let last = (await pool.getGetPoolState()).tick;
        const bob0 = await d.jBal(d.jA, d.bob.address);
        const first = await swapChecked(sim, pool, key.ext, d.bob, true, toNano('10'));
        expect(first.exp.lastFee).toBeGreaterThanOrEqual(110000n);   // + a small volatility fee after entering the range
        expect(first.exp.lastFee).toBeLessThan(111000n);
        expect(first.exp.crossings).toBe(1);   // enters the range at tU
        for (const g of ['25', '40']) {
            d.chain.now = d.now + 30;
            await swapChecked(sim, pool, key.ext, d.bob, true, toNano(g));
            const tk = (await pool.getGetPoolState()).tick;
            expect(tk).toBeLessThan(last);
            last = tk;
        }
        // The launch fee decays linearly: half way through the window it is half.
        d.chain.now = Number(sim.fs.startTs) + 300;
        expect(sim.feePipsNow(BigInt(d.now))).toBe((await pool.getGetPoolState()).feePipsNow);
        const half = await swapChecked(sim, pool, key.ext, d.carol, true, toNano('5'));
        expect(half.exp.lastFee).toBeGreaterThanOrEqual(10000n + 50000n);
        // Sells move the price back down (tick up).
        const bobJ = (await d.jBal(d.jA, d.bob.address)) - bob0;   // what bob bought
        d.chain.now = Number(sim.fs.startTs) + 700;  // window over: base fee (+ volatility)
        for (const frac of [4n, 3n]) {
            await swapChecked(sim, pool, key.ext, d.bob, false, bobJ / frac);
            const tk = (await pool.getGetPoolState()).tick;
            expect(tk).toBeGreaterThan(last);
            last = tk;
        }
        // Selling more than was ever bought cannot cross tU (no liquidity above it): partial or refund.
        const q = await pool.getGetQuote(false, toNano('10000000'), 0n, 24n, 0n, false);
        expect(q.code).toBe(BigInt(CODES.PARTIAL_NOT_ALLOWED));
        await d.checkSolvency([pool]);
    });

    it('dev buy runs inside the initialization transaction (nothing can be ordered before it), launch fee waived', async () => {
        const dev = toNano('100');
        // A swap into the key before the launch is refunded (pool not initialized).
        let res = await d.swapNative(d.bob, toNano('5'), d.tokA, { tickSpacing: 200n, ext: key.ext });
        expect(refundCodes(res)).toEqual([CODES.NOT_INITIALIZED]);
        const sim = new M.PoolSim(200, extM());
        const e = sim.launch(SQRT, JET, BigInt(d.now), M.PRESETS[200], { amount: dev, minOut: 0n }) as any;
        expect(e.dev.code).toBe(0);
        const jb = await d.jBal(d.jA, dave.address);
        res = await launch({ devBuy: dev, minDevOut: e.dev.out, devReceiver: dave.address });
        expectNoFailures(res);
        // One Pool transaction (in: PoolLaunch) emits InitializeEvent, ModifyEvent, SwapEvent, LaunchEvent.
        const poolTxs = res.transactions.filter((tx) => tx.inMessage?.info.dest instanceof Address &&
            tx.inMessage.info.dest.equals(pool.address));
        expect(poolTxs.map((tx) => opOf(tx))).toEqual([OP.PoolLaunch]);
        const outOps = [...poolTxs[0].outMessages.values()].filter((m) => m.info.type === 'external-out')
            .map((m) => m.body.beginParse().preloadUint(32));
        expect(outOps).toEqual([OP.InitializeEvent, 0x4d480072, OP.SwapEvent, OP.LaunchEvent]);
        const sw = swapEvents(res);
        expect(sw.length).toBe(1);
        expect([sw[0].amountIn, sw[0].amountOut, sw[0].feeTotal, sw[0].fromUser.toString()])
            .toEqual([dev, e.dev.out, e.dev.feeTotal, dave.address.toString()]);
        // Base fee (1%, + a small volatility fee), no 10% launch extra.
        expect(e.dev.lastFee).toBeGreaterThanOrEqual(10000n);
        expect(e.dev.lastFee).toBeLessThan(13000n);
        expect(e.dev.feeTotal).toBeLessThanOrEqual((dev * 13n) / 1000n);
        expect(await d.jBal(d.jA, dave.address)).toBe(jb + e.dev.out);
        const le = launchEvents(res)[0];
        expect([le.devIn, le.devOut]).toEqual([dev, e.dev.out]);
        await expectPoolEquals(pool, sim);
        // The first third-party buy pays the launch extra and gets a worse price than the dev.
        const after = await swapChecked(sim, pool, key.ext, d.bob, true, dev);
        expect(after.exp.out).toBeLessThan(e.dev.out);
        expect(after.exp.lastFee).toBeGreaterThanOrEqual(110000n);
        await d.checkSolvency([pool]);
    });

    it('dev buy refused (minDevOut too high): the launch still happens, the dev Gram goes back to refundTo', async () => {
        const dev = toNano('20');
        const sim = new M.PoolSim(200, extM());
        const e = sim.launch(SQRT, JET, BigInt(d.now), M.PRESETS[200], { amount: dev, minOut: 0n }) as any;
        const res = await launch({ devBuy: dev, minDevOut: e.dev.out + 1n, devReceiver: dave.address });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.SLIPPAGE]);
        expect(swapEvents(res)).toEqual([]);
        expect(gramPayouts(res, d.alice.address).filter((x) => x.reason === REASON.SWAP_REFUND).map((x) => x.amount)).toEqual([dev]);
        const s2 = new M.PoolSim(200, extM());
        s2.launch(SQRT, JET, BigInt(d.now), M.PRESETS[200]);
        await expectPoolEquals(pool, s2);
        expect(launchEvents(res)[0].devIn).toBe(0n);
        await d.checkSolvency([pool]);
    });

    it('locked principal (even far in the future); the fee claimer collects Gram and jetton fees (exact); nobody else can', async () => {
        expectNoFailures(await launch());
        d.chain.now = d.now + 1000;
        await d.swapNative(d.bob, toNano('50'), d.tokA, { tickSpacing: 200n, ext: key.ext });
        await d.swapJetton(d.jA, d.bob, toNano('1000000'), GRAM, { tickSpacing: 200n, ext: key.ext });
        const pos = await d.position(pool, 0n);
        const pd = await pos.getGetPositionData();
        let res = await d.decrease(pos, d.carol, 1000n);
        expect(failedAt(res, pos.address).length).toBe(1);
        res = await d.decrease(pos, d.carol, pd.liquidity);
        expect(failedAt(res, pos.address).length).toBe(1);
        const sim = await simOf(pool, extM());
        const e = sim.burn(Number(pd.tickLower), Number(pd.tickUpper), pd.liquidity, 0n, pd.fgLast0, pd.fgLast1);
        expect(e.fees0).toBeGreaterThan(0n);
        expect(e.fees1).toBeGreaterThan(0n);
        const jb = await d.jBal(d.jA, d.carol.address);
        res = await d.decrease(pos, d.carol, 0n);
        expectNoFailures(res);
        expect(gramPayouts(res, d.carol.address).filter((x) => x.reason === REASON.POSITION_OUT).map((x) => x.amount)).toEqual([e.fees0]);
        expect(await d.jBal(d.jA, d.carol.address)).toBe(jb + e.fees1);
        await expectPoolEquals(pool, sim);
        // A different owner cannot collect.
        res = await d.decrease(pos, d.bob, 0n);
        expect(failedAt(res, pos.address).length).toBe(1);
        // Far future (top the NFT up first: decades of rent would otherwise freeze it).
        expectNoFailures(await d.bob.send({ to: pos.address, value: toNano('5') }));
        d.chain.now = 0xFFFFFFF0;
        res = await d.decrease(pos, d.carol, 1n, { deadline: 0xFFFFFFFFn });
        expect(failedAt(res, pos.address).length).toBe(1);
        await d.checkSolvency([pool]);
    });

    it('cannot be initialized twice or by others; squatting the key does not block the launch', async () => {
        // bob cannot initialize alice's key with a normal mint...
        let res = await d.mintJetton(d.jA, d.bob, toNano('1000'), GRAM, -887200n, 0n, 0n, { tickSpacing: 200n, ext: key.ext, sqrtPriceInit: Q96 });
        expect(refundCodes(res)).toEqual([CODES.NOT_INITIALIZER]);
        // ...nor by sending a LaunchPayload himself: that builds HIS key (initializer bob).
        res = await d.launch(d.jA, d.bob, toNano('1000000'), SQRT, d.bob.address, d.bob.address, LO);
        expectNoFailures(res);
        expect((await pool.getGetPoolState()).initialized).toBe(false);
        expect(launchEvents(res)[0].key.ext!.hash().equals(key.ext!.hash())).toBe(false);
        // bob deploys alice's pool uninitialized by swapping into it.
        res = await d.swapNative(d.bob, toNano('1'), d.tokA, { tickSpacing: 200n, ext: key.ext });
        expect(refundCodes(res)).toEqual([CODES.NOT_INITIALIZED]);
        expect(await d.isActive(pool.address)).toBe(true);
        // alice launches anyway.
        res = await launch();
        expectNoFailures(res);
        expect(launchEvents(res).length).toBe(1);
        const sim = await simOf(pool, extM());
        // A second launch (even by alice, with a dev buy) is refunded in full to refundTo.
        const jb = await d.jBal(d.jA, d.bob.address);
        res = await launch({ refundTo: d.bob.address, devBuy: toNano('3') });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.ALREADY_INITIALIZED]);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb + JET);
        expect(gramPayouts(res, d.bob.address).filter((x) => x.reason === REASON.MINT_REFUND).map((x) => x.amount)).toEqual([toNano('3')]);
        await expectPoolEquals(pool, sim);
        await d.checkSolvency([pool]);
    });

    it('bad input: every Router and Pool rejection refunds the jettons (and the dev-buy Gram), no state written', async () => {
        type C = [string, Parameters<typeof launch>[0], number, Address];
        const A = d.alice.address;
        const B = d.bob.address;
        const cases: C[] = [
            ['deadline', { deadline: BigInt(d.now - 1), refundTo: B }, CODES.DEADLINE, B],
            ['spacing 7', { tickSpacing: 7n }, CODES.BAD_TICK_SPACING, A],
            ['launch fee > 90%', { launchFeePips: 900001n }, CODES.BAD_KEY, A],
            ['launch fee without duration', { launchFeePips: 100n, launchDuration: 0n }, CODES.BAD_KEY, A],
            ['buy tax > 10%', { buyTaxBps: 1001n, taxRecipient: B }, CODES.BAD_KEY, A],
            ['tax without recipient', { sellTaxBps: 100n }, CODES.BAD_KEY, A],
            ['recipient without tax', { taxRecipient: B }, CODES.BAD_KEY, A],
            ['Router as fee claimer', { claimer: d.router.address, refundTo: B }, CODES.BAD_RECIPIENT, A],
            ['Router as refundTo', { refundTo: d.router.address }, CODES.BAD_RECIPIENT, A],
            ['Router as dev receiver', { devReceiver: d.router.address, refundTo: B }, CODES.BAD_RECIPIENT, A],
            ['Router as tax recipient', { buyTaxBps: 10n, taxRecipient: d.router.address }, CODES.BAD_KEY, A],
            ['price 0', { sqrt: 0n }, CODES.PRICE_OUT_OF_RANGE, A],
            ['price at MAX', { sqrt: MAX_SQRT_RATIO }, CODES.PRICE_OUT_OF_RANGE, A],
            ['gas', { gas: toNano('0.3') }, CODES.LOW_GAS, A],
            // Pool-side (the dev-buy Gram rides along and comes back too)
            ['start tick below minUsable', { sqrt: MIN_SQRT_RATIO, devBuy: toNano('2'), refundTo: B }, CODES.BAD_TICKS, B],
            ['deposit too small', { jet: 1n, devBuy: toNano('2'), refundTo: B }, CODES.LIQUIDITY_BELOW_MIN, B],
        ];
        for (const [name, o, code, to] of cases) {
            const jb = await d.jBal(d.jA, to);
            const gb = await d.gram(to);
            const jet = o!.jet ?? toNano('1000000');
            const res = await launch({ jet, ...o });
            expectNoFailures(res);
            expect([name, refundCodes(res)]).toEqual([name, [code]]);
            // alice is the sender: when she is also the refund target her balance is unchanged.
            expect([name, await d.jBal(d.jA, to)]).toEqual([name, jb + (to.equals(A) ? 0n : jet)]);
            if (o!.devBuy && !to.equals(A)) {
                expect([name, (await d.gram(to)) - gb >= o!.devBuy]).toEqual([name, true]);
            }
            expect([name, initEvents(res).length]).toEqual([name, 0]);
        }
        expect(await d.routerHolds(d.tokA)).toBe(0n);
        // Creation paused (review issue 3): a launch key bypasses the pause (a refund would strand the
        // supply in the launch master), while an ordinary new pool is still refused.
        expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetCreationPaused', queryId: 0n, paused: true }));
        let res = await d.mintNative(d.bob, toNano('1'), d.tokA, -600n, 600n, { tickSpacing: 200n, sqrtPriceInit: Q96 });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.CREATION_PAUSED]);
        res = await launch({ refundTo: d.bob.address, devBuy: toNano('2') });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        expect(launchEvents(res).length).toBe(1);
        expect((await pool.getGetPoolState()).initialized).toBe(true);
        await d.checkSolvency([pool]);
    });

    it('taxed launch: dev buy and buyers pay the buy tax, sellers the sell tax (exact), CollectTax pays the recipient', async () => {
        const o: LaunchOpts = { ...LO, buyTaxBps: 500n, sellTaxBps: 800n, taxRecipient: dave.address };
        const k = await d.launchKey(d.tokA, d.alice.address, o);
        const p = await d.poolOf(GRAM, d.tokA, 200n, k.ext);
        const sim = new M.PoolSim(200, extM(o));
        const dev = toNano('10');
        const e = sim.launch(SQRT, JET, BigInt(d.now), M.PRESETS[200], { amount: dev, minOut: 0n }) as any;
        expect(e.dev.tax).toBe((dev * 500n) / 10000n);
        expect(e.dev.plat).toBe((dev * 100n) / 10000n);
        const res = await launch({ ...o, devBuy: dev, devReceiver: d.bob.address });
        expectNoFailures(res);
        expect([swapEvents(res)[0].tax, swapEvents(res)[0].platformFee]).toEqual([e.dev.tax, e.dev.plat]);
        // The dev buy's tax (0.5 >= TAX_MIN_PAYOUT) and platform fee are paid inside the launch transaction.
        expect(gramPayouts(res, dave.address).map((x) => [x.reason, x.amount, x.value])).toEqual([[REASON.TAX, e.dev.tax, e.dev.tax + M.TAX_PAYOUT_GAS]]);
        expect(gramPayouts(res, d.treasury.address).map((x) => [x.reason, x.amount])).toEqual([[REASON.PLATFORM, e.dev.plat]]);
        await expectPoolEquals(p, sim);
        d.chain.now = d.now + 700;
        const b = await swapChecked(sim, p, k.ext, d.carol, true, toNano('33'));
        expect(b.exp.tax).toBe((toNano('33') * 500n) / 10000n);
        expect(b.exp.taxPaid).toBe(b.exp.tax);
        const s = await swapChecked(sim, p, k.ext, d.bob, false, toNano('100000'));
        expect(s.exp.tax).toBe((s.exp.grossOut * 800n) / 10000n);
        expect(s.exp.out + s.exp.tax + s.exp.plat).toBe(s.exp.grossOut);
        expect(s.exp.taxPaid).toBe(s.exp.tax);
        expect(sim.taxFees).toBe(0n);
        // Nothing left to collect: CollectTax just returns the caller's value.
        const r2 = await d.collectTax(d.carol, k);
        expectNoFailures(r2);
        expect(gramPayouts(r2, dave.address)).toEqual([]);
        await expectPoolEquals(p, sim);
        await d.checkSolvency([p]);
    });

    it('invariant: 40 seeded random buys/sells over time, chain == model after each; claimer fees <= reserves', async () => {
        const o: LaunchOpts = { ...LO, buyTaxBps: 200n, sellTaxBps: 300n, taxRecipient: dave.address };
        const k = await d.launchKey(d.tokA, d.alice.address, o);
        const p = await d.poolOf(GRAM, d.tokA, 200n, k.ext);
        const sim = new M.PoolSim(200, extM(o));
        sim.launch(SQRT, JET, BigInt(d.now), M.PRESETS[200], { amount: toNano('5'), minOut: 0n });
        expectNoFailures(await launch({ ...o, devBuy: toNano('5') }));
        await expectPoolEquals(p, sim);
        const R = rng(0x1a0c);
        const users = [d.bob, d.carol, dave];
        let done = 0;
        for (let i = 0; i < 40; i++) {
            d.chain.now = d.now + R.pick([1, 10, 40, 200]);
            const u = R.pick(users);
            const buy = R.next() < 0.6;
            // Sells: up to a third of what the pool has sold so far (users also hold unrelated tokens).
            const amount = buy ? R.big(toNano('0.01'), toNano('80')) : R.big(1n, (JET - sim.reserve1) / 3n);
            if (amount <= 0n) continue;
            const t = BigInt(d.now);
            const exp = sim.swap(buy, amount, 0n, 24, 0n, false, 0n, t, false);
            if (exp.code !== 0) continue;
            await swapChecked(sim, p, k.ext, u, buy, amount);
            done += 1;
            if (i % 10 === 9) {
                const pd = await (await d.position(p, 0n)).getGetPositionData();
                const g = await p.getGetPositionAmounts(pd.tickLower, pd.tickUpper, pd.liquidity, pd.fgLast0, pd.fgLast1, pd.liquidity);
                const st = await p.getGetPoolState();
                expect(g.amount0 + g.fees0).toBeLessThanOrEqual(st.reserve0);
                expect(g.amount1 + g.fees1).toBeLessThanOrEqual(st.reserve1);
                await d.checkSolvency([p]);
            }
        }
        expect(done).toBeGreaterThanOrEqual(25);
    });

    it('gas: Router minimum covers the Pool; Pool compute for launch / launch + dev buy / taxed', async () => {
        const min = await findMin(d.chain, toNano('0.3'), toNano('1'), async (g) => !refundCodes(await launch({ gas: g })).includes(CODES.LOW_GAS));
        const minDev = await findMin(d.chain, toNano('0.3'), toNano('1.2'),
            async (g) => !refundCodes(await launch({ gas: g, devBuy: toNano('10') })).includes(CODES.LOW_GAS));
        // At exactly the minimum everything succeeds (no Pool-side LOW_GAS, no failed transaction).
        let res = await launch({ gas: min });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        const g1 = gasAt(res, pool.address, OP.PoolLaunch)[0];
        await d.chain.loadFrom(base);
        res = await launch({ gas: minDev, devBuy: toNano('10') });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        expect(swapEvents(res).length).toBe(1);
        const g2 = gasAt(res, pool.address, OP.PoolLaunch)[0];
        await d.chain.loadFrom(base);
        const o: LaunchOpts = { ...LO, buyTaxBps: 300n, sellTaxBps: 300n, taxRecipient: dave.address };
        const pk = await d.launchKey(d.tokA, d.alice.address, o);
        res = await launch({ ...o, devBuy: toNano('10') });
        expectNoFailures(res);
        const g3 = gasAt(res, (await d.poolOf(GRAM, d.tokA, 200n, pk.ext)).address, OP.PoolLaunch)[0];
        // eslint-disable-next-line no-console
        console.log(`launch gas: min forward value (no dev buy) ${min}, min forward value on top of a dev buy ${minDev}; ` +
            `Pool compute: launch ${g1}, launch + dev buy ${g2}, taxed launch + dev buy ${g3}`);
        expect(g2).toBeLessThan(400000n);
    });
});
