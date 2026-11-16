import { Address, beginCell, toNano } from '@ton/core';
import { SandboxContract } from '@ton/sandbox';
import {
    CODE_CREATION_PAUSED, CODE_DEADLINE, CODE_LOW_GAS, CODE_LP_BELOW_MIN, CODE_SLIPPAGE, Dex, ERR, expectNoFailures, fees,
    GRAM, gramPayouts, isqrt, LP_ACCOUNT_MIN_STORAGE, modelAdd, modelBurn, OP, opOf, Pool, PROVIDE_GAS, readForwardFee,
    REASON_BURN_OUT, REASON_LP_ACCOUNT_REFUND, REASON_LP_EXCESS, REASON_PROVIDE_REFUND, refundCodes, txsBetween,
} from './helpers';

// Add liquidity (two-step through LpAccount, and the one-message dual deposit), remove
// liquidity (LP burn), LP jetton transfers, and the creation pause.

describe('liquidity', () => {
    let d: Dex;
    let pools: SandboxContract<Pool>[];

    beforeEach(async () => {
        d = await Dex.create();
        pools = [];
    });

    afterEach(async () => {
        await d.checkSolvency(pools, true);
    });

    describe('first deposit', () => {
        it('native, Gram first then jetton: LP = isqrt(a0*a1) - 1000, MIN_LIQUIDITY locked', async () => {
            const g = toNano('250');
            const t = toNano('1234567');
            const p = await d.poolOf(GRAM, d.tokA);
            pools.push(p);
            const r1 = await d.provideNative(d.alice, g, d.tokA, { minLpOut: 1n });
            fees(r1, 'provide native, first side');
            expectNoFailures(r1);
            const acc = await d.lpAccount(p, d.alice.address);
            let a = await acc.getGetLpAccountData();
            expect(a.pending0).toBe(g);
            expect(a.pending1).toBe(0n);
            expect(a.isNative).toBe(true);
            // The LpAccount holds the pending Gram itself.
            expect(await d.gram(acc.address)).toBeGreaterThanOrEqual(g + LP_ACCOUNT_MIN_STORAGE);
            expect((await p.getGetPoolData()).totalSupply).toBe(0n);

            const r2 = await d.provideJetton(d.jA, d.alice, t, GRAM, { minLpOut: isqrt(g * t) - 1000n });
            fees(r2, 'provide jetton, completing side');
            expectNoFailures(r2);
            a = await acc.getGetLpAccountData();
            expect(a.pending0).toBe(0n);
            expect(a.pending1).toBe(0n);
            const pd = await p.getGetPoolData();
            expect(pd.reserve0).toBe(g);
            expect(pd.reserve1).toBe(t);
            expect(pd.totalSupply).toBe(isqrt(g * t));
            expect(await d.lpBal(p, d.alice.address)).toBe(isqrt(g * t) - 1000n);
            // Gram moved from the LpAccount to the Pool; the LpAccount keeps only its storage buffer.
            expect(await d.gram(acc.address)).toBeLessThan(LP_ACCOUNT_MIN_STORAGE + toNano('0.001'));
        });

        it('native, jetton first then Gram, LP to a third party', async () => {
            const g = toNano('10');
            const t = toNano('777');
            const p = await d.poolOf(GRAM, d.tokA);
            pools.push(p);
            expectNoFailures(await d.provideJetton(d.jA, d.alice, t, GRAM));
            expect((await d.pending(p, d.alice.address)).pending1).toBe(t);
            const r = await d.provideNative(d.alice, g, d.tokA, { lpReceiver: d.carol.address });
            expectNoFailures(r);
            expect(await d.lpBal(p, d.carol.address)).toBe(isqrt(g * t) - 1000n);
            expect(await d.lpBal(p, d.alice.address)).toBe(0n);
        });

        it('jetton/jetton two-step', async () => {
            const a = toNano('3000');
            const b = toNano('12000');
            const p = await d.poolOf(d.tokA, d.tokB);
            pools.push(p);
            expectNoFailures(await d.provideJetton(d.jB, d.bob, b, d.tokA));
            const pend = await d.pending(p, d.bob.address);
            expect(pend.isNative).toBe(false);
            expectNoFailures(await d.provideJetton(d.jA, d.bob, a, d.tokB));
            const pd = await p.getGetPoolData();
            expect(pd.isNative).toBe(false);
            expect(pd.totalSupply).toBe(isqrt(a * b));
            expect(await d.lpBal(p, d.bob.address)).toBe(isqrt(a * b) - 1000n);
            expect(await d.routerHolds(d.tokA)).toBe(a);
            expect(await d.routerHolds(d.tokB)).toBe(b);
        });

        it('same side twice accumulates in the LpAccount', async () => {
            const p = await d.poolOf(d.tokA, d.tokB);
            pools.push(p);
            expectNoFailures(await d.provideJetton(d.jA, d.bob, 100n * 10n ** 9n, d.tokB));
            expectNoFailures(await d.provideJetton(d.jA, d.bob, 50n * 10n ** 9n, d.tokB));
            const pd = await p.getGetPoolData();
            const pend = await d.pending(p, d.bob.address);
            expect(pend.pending0 + pend.pending1).toBe(150n * 10n ** 9n);
            expect(pd.totalSupply).toBe(0n);
        });

        it('refunds both legs when isqrt(a0*a1) <= MIN_LIQUIDITY (two-step and dual)', async () => {
            const p = await d.poolOf(GRAM, d.tokA);
            pools.push(p);
            // Dual: 1000 * 1000 -> isqrt = 1000, not above the minimum.
            const aliceA = await d.jBal(d.jA, d.alice.address);
            const r = await d.provideBoth(d.jA, d.alice, 1000n, 1000n);
            expectNoFailures(r);
            expect(refundCodes(r)).toEqual([Number(CODE_LP_BELOW_MIN)]);
            expect(gramPayouts(r, d.alice.address).find((x) => x.reason === Number(REASON_PROVIDE_REFUND))!.amount).toBe(1000n);
            expect(await d.jBal(d.jA, d.alice.address)).toBe(aliceA);
            expect((await p.getGetPoolData()).totalSupply).toBe(0n);

            // Two-step: 1001 * 1001 -> isqrt = 1001 is just enough.
            expectNoFailures(await d.provideNative(d.alice, 1001n, d.tokA));
            const r2 = await d.provideJetton(d.jA, d.alice, 1001n, GRAM);
            expectNoFailures(r2);
            expect(await d.lpBal(p, d.alice.address)).toBe(1n);
        });
    });

    describe('later deposits', () => {
        let p: SandboxContract<Pool>;
        beforeEach(async () => {
            p = await d.seedNative(d.jA, toNano('1000'), toNano('5000000'));
            pools.push(p);
            // Move the price off the round ratio so rounding is exercised.
            expectNoFailures(await d.swapNative(d.bob, toNano('13.37'), d.tokA));
        });

        it('two-step with too much Gram: uses the ratio, refunds the unused Gram, LP equals the getter', async () => {
            const pd = await p.getGetPoolData();
            const g = toNano('100');
            const t = toNano('100000');            // worth ~20 Gram: Gram side is in excess
            const m = modelAdd(g, t, pd.reserve0, pd.reserve1, pd.totalSupply);
            const q = await p.getGetExpectedLp(g, t);
            expect(q.lp).toBe(m.lp);
            expect(q.use0).toBe(m.use0);
            expect(q.use1).toBe(t);
            expect(m.use0).toBeLessThan(g);
            expectNoFailures(await d.provideJetton(d.jA, d.carol, t, GRAM));
            const r = await d.provideNative(d.carol, g, d.tokA, { minLpOut: m.lp });
            fees(r, 'completing deposit with a Gram refund');
            expectNoFailures(r);
            expect(await d.lpBal(p, d.carol.address)).toBe(m.lp);
            const ex = gramPayouts(r, d.carol.address).find((x) => x.reason === Number(REASON_LP_EXCESS))!;
            expect(ex.amount).toBe(g - m.use0);
            const after = await p.getGetPoolData();
            expect(after.reserve0).toBe(pd.reserve0 + m.use0);
            expect(after.reserve1).toBe(pd.reserve1 + m.use1);
            expect(after.totalSupply).toBe(pd.totalSupply + m.lp);
        });

        it('dual deposit with too many jettons: refunds the unused jettons', async () => {
            const pd = await p.getGetPoolData();
            const g = toNano('10');
            const t = toNano('900000');
            const m = modelAdd(g, t, pd.reserve0, pd.reserve1, pd.totalSupply);
            expect(m.use0).toBe(g);
            expect(m.use1).toBeLessThan(t);
            const carolA = await d.jBal(d.jA, d.carol.address);
            const r = await d.provideBoth(d.jA, d.carol, t, g, { minLpOut: m.lp });
            fees(r, 'dual deposit with a jetton refund');
            expectNoFailures(r);
            expect(await d.lpBal(p, d.carol.address)).toBe(m.lp);
            expect(await d.jBal(d.jA, d.carol.address)).toBe(carolA - m.use1);
            const after = await p.getGetPoolData();
            expect(after.reserve0).toBe(pd.reserve0 + g);
            expect(after.reserve1).toBe(pd.reserve1 + m.use1);
        });

        it('minLpOut not met: both legs are refunded (two-step, Gram held by the LpAccount)', async () => {
            const pd = await p.getGetPoolData();
            const g = toNano('5');
            const t = toNano('25000');
            const m = modelAdd(g, t, pd.reserve0, pd.reserve1, pd.totalSupply);
            const carolA = await d.jBal(d.jA, d.carol.address);
            expectNoFailures(await d.provideNative(d.carol, g, d.tokA));
            const r = await d.provideJetton(d.jA, d.carol, t, GRAM, { minLpOut: m.lp + 1n });
            expectNoFailures(r);
            expect(refundCodes(r)).toEqual([Number(CODE_SLIPPAGE)]);
            expect(gramPayouts(r, d.carol.address).find((x) => x.reason === Number(REASON_PROVIDE_REFUND))!.amount).toBe(g);
            expect(await d.jBal(d.jA, d.carol.address)).toBe(carolA);
            const after = await p.getGetPoolData();
            expect(after.reserve0).toBe(pd.reserve0);
            expect(after.totalSupply).toBe(pd.totalSupply);
            const pend = await d.pending(p, d.carol.address);
            expect(pend.pending0 + pend.pending1).toBe(0n);
        });

        it('minLpOut not met: dual deposit refunds both legs to refundTo', async () => {
            const pd = await p.getGetPoolData();
            const m = modelAdd(toNano('5'), toNano('25000'), pd.reserve0, pd.reserve1, pd.totalSupply);
            const treasA = await d.jBal(d.jA, d.treasury.address);
            const r = await d.provideBoth(d.jA, d.carol, toNano('25000'), toNano('5'), { minLpOut: m.lp + 1n, refundTo: d.treasury.address });
            expectNoFailures(r);
            expect(refundCodes(r)).toEqual([Number(CODE_SLIPPAGE)]);
            expect(await d.jBal(d.jA, d.treasury.address)).toBe(treasA + toNano('25000'));
            expect(gramPayouts(r, d.treasury.address)[0].amount).toBe(toNano('5'));
        });

        it('add then remove never returns more than was deposited', async () => {
            const pd = await p.getGetPoolData();
            const g = toNano('33.333333333');
            const t = toNano('171717.171717');
            const m = modelAdd(g, t, pd.reserve0, pd.reserve1, pd.totalSupply);
            expectNoFailures(await d.provideBoth(d.jA, d.carol, t, g));
            const lp = await d.lpBal(p, d.carol.address);
            expect(lp).toBe(m.lp);
            const mid = await p.getGetPoolData();
            const b = modelBurn(lp, mid.reserve0, mid.reserve1, mid.totalSupply);
            const r = await d.burnLp(p, d.carol, lp);
            expectNoFailures(r);
            const out0 = gramPayouts(r, d.carol.address).find((x) => x.reason === Number(REASON_BURN_OUT))!.amount;
            expect(out0).toBe(b.out0);
            expect(out0).toBeLessThanOrEqual(m.use0);
            expect(b.out1).toBeLessThanOrEqual(m.use1);
        });
    });

    describe('LpAccountRefund', () => {
        it('returns pending Gram and pending jettons to the user', async () => {
            const p = await d.poolOf(GRAM, d.tokA);
            pools.push(p);
            expectNoFailures(await d.provideNative(d.bob, toNano('7'), d.tokA));
            const acc = await d.lpAccount(p, d.bob.address);
            const r = await acc.send(d.bob.getSender(), { value: toNano('0.2') }, { $$type: 'LpAccountRefund', queryId: 1n });
            fees(r, 'LpAccountRefund (Gram)');
            expectNoFailures(r);
            const g = gramPayouts(r, d.bob.address)[0];
            expect(g.reason).toBe(Number(REASON_LP_ACCOUNT_REFUND));
            expect(g.amount).toBe(toNano('7'));
            expect((await acc.getGetLpAccountData()).pending0).toBe(0n);

            const pj = await d.poolOf(d.tokA, d.tokB);
            pools.push(pj);
            const bobB = await d.jBal(d.jB, d.bob.address);
            expectNoFailures(await d.provideJetton(d.jB, d.bob, toNano('55'), d.tokA));
            expect(await d.jBal(d.jB, d.bob.address)).toBe(bobB - toNano('55'));
            const accj = await d.lpAccount(pj, d.bob.address);
            const r2 = await accj.send(d.bob.getSender(), { value: toNano('0.2') }, { $$type: 'LpAccountRefund', queryId: 2n });
            fees(r2, 'LpAccountRefund (jetton)');
            expectNoFailures(r2);
            expect(await d.jBal(d.jB, d.bob.address)).toBe(bobB);
        });

        it('rejects a non-owner and low gas; an empty refund only returns the gas', async () => {
            const p = await d.poolOf(GRAM, d.tokA);
            pools.push(p);
            expectNoFailures(await d.provideNative(d.bob, toNano('7'), d.tokA));
            const acc = await d.lpAccount(p, d.bob.address);
            const r1 = await acc.send(d.carol.getSender(), { value: toNano('0.5') }, { $$type: 'LpAccountRefund', queryId: 1n });
            expect(r1.transactions).toHaveTransaction({ to: acc.address, success: false, exitCode: ERR.lpAccount['Not owner'] });
            const r2 = await acc.send(d.bob.getSender(), { value: toNano('0.19') }, { $$type: 'LpAccountRefund', queryId: 1n });
            expect(r2.transactions).toHaveTransaction({ to: acc.address, success: false, exitCode: ERR.lpAccount['Insufficient TON attached'] });
            expect((await acc.getGetLpAccountData()).pending0).toBe(toNano('7'));
            expectNoFailures(await acc.send(d.bob.getSender(), { value: toNano('0.2') }, { $$type: 'LpAccountRefund', queryId: 1n }));
            const r3 = await acc.send(d.bob.getSender(), { value: toNano('0.2') }, { $$type: 'LpAccountRefund', queryId: 1n });
            expectNoFailures(r3);
            expect(gramPayouts(r3).length).toBe(0);
            expect(txsBetween(r3, p.address, d.bob.address).some((t) => opOf(t) === OP.JettonExcesses)).toBe(true);
        });
    });

    describe('entry validation', () => {
        it('native provide: deadline, zero amount, bad token and low value throw', async () => {
            const cases: [() => Promise<any>, string][] = [
                [() => d.provideNative(d.bob, toNano('1'), d.tokA, { deadline: BigInt(d.now - 1) }), 'Deadline'],
                [() => d.provideNative(d.bob, 0n, d.tokA), 'Invalid amount'],
                [() => d.provideNative(d.bob, toNano('1'), GRAM), 'Invalid token'],
                [() => d.provideNative(d.bob, toNano('1'), d.tokA, { gas: PROVIDE_GAS }), 'Insufficient TON attached'],
            ];
            for (const [f, err] of cases) {
                const res = await f();
                expect(res.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router[err] });
            }
        });

        it('jetton provide: deadline and low gas refund; exact minimum works', async () => {
            const bobA = await d.jBal(d.jA, d.bob.address);
            const r1 = await d.provideJetton(d.jA, d.bob, toNano('1'), GRAM, { deadline: BigInt(d.now - 1) });
            expectNoFailures(r1);
            expect(refundCodes(r1)).toEqual([Number(CODE_DEADLINE)]);
            const snap = d.snapshot();
            const probe = await d.provideJetton(d.jA, d.bob, toNano('1'), GRAM);
            const rtx = probe.transactions.find((t) => opOf(t) === OP.JettonNotification &&
                t.inMessage!.info.dest instanceof Address && t.inMessage!.info.dest.equals(d.router.address))!;
            const min = PROVIDE_GAS + 2n * readForwardFee(rtx);
            await d.restore(snap);
            const r2 = await d.provideJetton(d.jA, d.bob, toNano('1'), GRAM, { gas: min - 1n });
            expectNoFailures(r2);
            expect(refundCodes(r2)).toEqual([Number(CODE_LOW_GAS)]);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA);
            const r3 = await d.provideJetton(d.jA, d.bob, toNano('1'), GRAM, { gas: min });
            expectNoFailures(r3);
            pools.push(await d.poolOf(GRAM, d.tokA));
        });

        it('completing a jetton/jetton pair at the exact minimum, with an unused-side refund, succeeds', async () => {
            const p = await d.seedJJ(d.jA, toNano('1000'), d.jB, toNano('3000'));
            pools.push(p);
            expectNoFailures(await d.provideJetton(d.jA, d.carol, toNano('100'), d.tokB));
            const snap = d.snapshot();
            const probe = await d.provideJetton(d.jB, d.carol, toNano('500'), d.tokA);
            const rtx = probe.transactions.find((t) => opOf(t) === OP.JettonNotification &&
                t.inMessage!.info.dest instanceof Address && t.inMessage!.info.dest.equals(d.router.address))!;
            const min = PROVIDE_GAS + 2n * readForwardFee(rtx);
            await d.restore(snap);
            const pd = await p.getGetPoolData();
            const m = modelAdd(pd.token0.equals(d.tokA) ? toNano('100') : toNano('500'),
                pd.token0.equals(d.tokA) ? toNano('500') : toNano('100'), pd.reserve0, pd.reserve1, pd.totalSupply);
            const carolB = await d.jBal(d.jB, d.carol.address);
            const r = await d.provideJetton(d.jB, d.carol, toNano('500'), d.tokA, { gas: min });
            fees(r, 'completing jetton/jetton deposit at the minimum');
            expectNoFailures(r);
            expect(await d.lpBal(p, d.carol.address)).toBe(m.lp);
            // 100 A is worth 300 B: 200 B come back.
            expect(await d.jBal(d.jB, d.carol.address)).toBe(carolB - toNano('300'));
        });
    });

    describe('creation pause', () => {
        async function pause(v: boolean) {
            expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetCreationPaused', queryId: 0n, paused: v }));
        }

        it('refunds the first deposit of a new pool; existing pools still accept deposits', async () => {
            const existing = await d.seedNative(d.jA, toNano('100'), toNano('1000'));
            pools.push(existing);
            const fresh = await d.poolOf(GRAM, d.tokB);
            pools.push(fresh);
            await pause(true);

            const r1 = await d.provideNative(d.bob, toNano('5'), d.tokB);
            expectNoFailures(r1);
            expect(refundCodes(r1)).toEqual([Number(CODE_CREATION_PAUSED)]);
            expect(gramPayouts(r1, d.bob.address)[0].amount).toBe(toNano('5'));

            const bobB = await d.jBal(d.jB, d.bob.address);
            const r2 = await d.provideJetton(d.jB, d.bob, toNano('5'), GRAM);
            expectNoFailures(r2);
            expect(refundCodes(r2)).toEqual([Number(CODE_CREATION_PAUSED)]);
            const r3 = await d.provideBoth(d.jB, d.bob, toNano('5'), toNano('5'));
            expectNoFailures(r3);
            expect(refundCodes(r3)).toEqual([Number(CODE_CREATION_PAUSED)]);
            expect(await d.jBal(d.jB, d.bob.address)).toBe(bobB);
            expect((await fresh.getGetPoolData()).totalSupply).toBe(0n);

            // Existing pool: dual and two-step both work while paused.
            expectNoFailures(await d.provideBoth(d.jA, d.bob, toNano('10'), toNano('1')));
            expect(await d.lpBal(existing, d.bob.address)).toBeGreaterThan(0n);
            expectNoFailures(await d.provideNative(d.carol, toNano('1'), d.tokA));
            expectNoFailures(await d.provideJetton(d.jA, d.carol, toNano('10'), GRAM));
            expect(await d.lpBal(existing, d.carol.address)).toBeGreaterThan(0n);

            await pause(false);
            expectNoFailures(await d.provideBoth(d.jB, d.bob, toNano('5'), toNano('5')));
            expect((await fresh.getGetPoolData()).totalSupply).toBe(isqrt(toNano('5') * toNano('5')));
        });

        it('a side parked before the pause stays pending when the completing side is refunded', async () => {
            const fresh = await d.poolOf(GRAM, d.tokB);
            pools.push(fresh);
            expectNoFailures(await d.provideNative(d.bob, toNano('5'), d.tokB));
            await pause(true);
            const r = await d.provideJetton(d.jB, d.bob, toNano('5'), GRAM);
            expectNoFailures(r);
            expect(refundCodes(r)).toEqual([Number(CODE_CREATION_PAUSED)]);
            expect((await d.pending(fresh, d.bob.address)).pending0).toBe(toNano('5'));
            await pause(false);
            expectNoFailures(await d.provideJetton(d.jB, d.bob, toNano('5'), GRAM));
            expect(await d.lpBal(fresh, d.bob.address)).toBe(toNano('5') - 1000n);
        });
    });

    describe('burn', () => {
        let p: SandboxContract<Pool>;
        beforeEach(async () => {
            p = await d.seedNative(d.jA, toNano('1000'), toNano('5000000'));
            pools.push(p);
            expectNoFailures(await d.provideBoth(d.jA, d.bob, toNano('500000'), toNano('100')));
            expectNoFailures(await d.swapNative(d.carol, toNano('50'), d.tokA));
        });

        it('pays pro-rata (Gram leg directly, jetton leg via PayTo), floors, updates supply', async () => {
            const lp = (await d.lpBal(p, d.bob.address)) / 3n;
            const pd = await p.getGetPoolData();
            const m = modelBurn(lp, pd.reserve0, pd.reserve1, pd.totalSupply);
            const q = await p.getGetExpectedBurn(lp);
            expect(q.out0).toBe(m.out0);
            expect(q.out1).toBe(m.out1);
            const bobA = await d.jBal(d.jA, d.bob.address);
            const r = await d.burnLp(p, d.bob, lp, { min0: m.out0, min1: m.out1 });
            fees(r, 'burn (native pool)');
            expectNoFailures(r);
            const g = gramPayouts(r, d.bob.address).find((x) => x.reason === Number(REASON_BURN_OUT))!;
            expect(g.amount).toBe(m.out0);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA + m.out1);
            const after = await p.getGetPoolData();
            expect(after.reserve0).toBe(pd.reserve0 - m.out0);
            expect(after.reserve1).toBe(pd.reserve1 - m.out1);
            expect(after.totalSupply).toBe(pd.totalSupply - lp);
            expect((await p.getGetJettonData()).totalSupply).toBe(after.totalSupply);
        });

        it('mins and deadline are enforced: the bounce restores the LP balance', async () => {
            const lp = await d.lpBal(p, d.bob.address);
            const q = await p.getGetExpectedBurn(lp);
            const cases = [
                { min0: q.out0 + 1n },
                { min1: q.out1 + 1n },
                { deadline: BigInt(d.now - 1) },
                { value: toNano('0.15') },       // the Pool requires BURN_POOL_GAS
            ];
            const errs = ['Slippage', 'Slippage', 'Deadline', 'Insufficient TON attached'];
            const before = await p.getGetPoolData();
            for (let i = 0; i < cases.length; i++) {
                const r = await d.burnLp(p, d.bob, lp, cases[i]);
                expect(r.transactions).toHaveTransaction({ to: p.address, success: false, exitCode: ERR.pool[errs[i]] });
                expect(await d.lpBal(p, d.bob.address)).toBe(lp);
            }
            const after = await p.getGetPoolData();
            expect(after.totalSupply).toBe(before.totalSupply);
            expect(after.reserve0).toBe(before.reserve0);
        });

        it('works without RemoveParams, and rejects burns above the balance or by a non-owner', async () => {
            const lp = await d.lpBal(p, d.bob.address);
            const w = await d.lpWallet(p, d.bob.address);
            const r1 = await w.send(d.carol.getSender(), { value: toNano('0.3') }, {
                $$type: 'JettonBurn', queryId: 0n, amount: 1n, responseDestination: null, customPayload: null,
            });
            expect(r1.transactions).toHaveTransaction({ to: w.address, success: false, exitCode: ERR.lpWallet['Not owner'] });
            const r2 = await d.burnLp(p, d.bob, lp + 1n);
            expect(r2.transactions).toHaveTransaction({ to: w.address, success: false, exitCode: ERR.lpWallet['Insufficient balance'] });
            const r3 = await d.burnLp(p, d.bob, lp, { noParams: true, response: null });
            expectNoFailures(r3);
            expect(await d.lpBal(p, d.bob.address)).toBe(0n);
        });

        it('a full exit of every owned LP leaves MIN_LIQUIDITY and positive reserves', async () => {
            for (const u of [d.alice, d.bob]) {
                const lp = await d.lpBal(p, u.address);
                expectNoFailures(await d.burnLp(p, u, lp));
            }
            const pd = await p.getGetPoolData();
            expect(pd.totalSupply).toBe(1000n);
            expect(pd.reserve0).toBeGreaterThan(0n);
            expect(pd.reserve1).toBeGreaterThan(0n);
            // The pool still works afterwards.
            expectNoFailures(await d.provideBoth(d.jA, d.carol, toNano('1000'), toNano('1')));
            expect(await d.lpBal(p, d.carol.address)).toBeGreaterThan(0n);
        });

        it('LP transfer between users, then a burn by the new owner', async () => {
            const lp = await d.lpBal(p, d.bob.address);
            const half = lp / 2n;
            const r = await d.transferLp(p, d.bob, d.carol.address, half);
            fees(r, 'LP transfer');
            expectNoFailures(r);
            expect(await d.lpBal(p, d.bob.address)).toBe(lp - half);
            expect(await d.lpBal(p, d.carol.address)).toBe(half);
            const w = await d.lpWallet(p, d.carol.address);
            const wd = await w.getGetWalletData();
            expect(wd.owner.equals(d.carol.address)).toBe(true);
            expect(wd.master.equals(p.address)).toBe(true);
            const q = await p.getGetExpectedBurn(half);
            const r2 = await d.burnLp(p, d.carol, half);
            expectNoFailures(r2);
            expect(gramPayouts(r2, d.carol.address)[0].amount).toBe(q.out0);
            // Non-owner transfer fails.
            const w2 = await d.lpWallet(p, d.bob.address);
            const r3 = await w2.send(d.carol.getSender(), { value: toNano('0.1') }, {
                $$type: 'JettonTransfer', queryId: 0n, amount: 1n, destination: d.carol.address, responseDestination: null,
                customPayload: null, forwardTonAmount: 0n, forwardPayload: beginCell().storeBit(0).endCell().beginParse(),
            });
            expect(r3.transactions).toHaveTransaction({ to: w2.address, success: false, exitCode: ERR.lpWallet['Not owner'] });
        });

        it('LP transfer with a forward amount notifies the new owner', async () => {
            const w = await d.lpWallet(p, d.bob.address);
            const r = await w.send(d.bob.getSender(), { value: toNano('0.2') }, {
                $$type: 'JettonTransfer', queryId: 0n, amount: 1000n, destination: d.carol.address, responseDestination: d.bob.address,
                customPayload: null, forwardTonAmount: toNano('0.01'), forwardPayload: beginCell().storeBit(0).storeUint(5, 8).endCell().beginParse(),
            });
            expectNoFailures(r);
            expect(r.transactions).toHaveTransaction({ to: d.carol.address, op: OP.JettonNotification, value: toNano('0.01') });
        });
    });

    describe('jetton/jetton burn', () => {
        it('returns both jettons pro-rata', async () => {
            const p = await d.seedJJ(d.jA, toNano('1000'), d.jB, toNano('4000'), d.bob);
            pools.push(p);
            const lp = await d.lpBal(p, d.bob.address);
            const q = await p.getGetExpectedBurn(lp / 2n);
            const pd = await p.getGetPoolData();
            const aIs0 = pd.token0.equals(d.tokA);
            const bobA = await d.jBal(d.jA, d.bob.address);
            const bobB = await d.jBal(d.jB, d.bob.address);
            const r = await d.burnLp(p, d.bob, lp / 2n, { value: toNano('0.25') });
            fees(r, 'burn (jetton/jetton)');
            expectNoFailures(r);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA + (aIs0 ? q.out0 : q.out1));
            expect(await d.jBal(d.jB, d.bob.address)).toBe(bobB + (aIs0 ? q.out1 : q.out0));
        });
    });
});
