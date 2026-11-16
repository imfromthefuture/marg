import { Address, toNano } from '@ton/core';
import { SandboxContract } from '@ton/sandbox';
import {
    ADMIN_GAS, COLLECT_GAS, Dex, ERR, expectNoFailures, fees, GRAM, gramPayouts, MAX_LP_FEE_BPS, MAX_PROTOCOL_FEE_BPS,
    modelSwap, OP, opOf, Pool, REASON_PROTOCOL_FEE, ROUTER_MIN_STORAGE, txsBetween,
} from './helpers';

// Admin operations, their caps and access control, and protocol fee collection.

describe('admin', () => {
    let d: Dex;
    let native: SandboxContract<Pool>;
    let jj: SandboxContract<Pool>;

    beforeEach(async () => {
        d = await Dex.create();
        native = await d.seedNative(d.jA, toNano('1000'), toNano('5000000'));
        jj = await d.seedJJ(d.jA, toNano('1000000'), d.jB, toNano('2000000'));
    });

    afterEach(async () => {
        await d.checkSolvency([native, jj], true);
    });

    const setFees = (from: SandboxContract<any>, a: Address, b: Address, lp: bigint, proto: bigint, value = toNano('0.1')) =>
        d.router.send(from.getSender(), { value }, { $$type: 'SetPoolFees', queryId: 0n, tokenA: a, tokenB: b, lpFeeBps: lp, protocolFeeBps: proto });

    describe('SetPoolFees', () => {
        it('changes a pool fee; quotes and execution follow; excess returns to the admin', async () => {
            const r = await setFees(d.admin, d.tokA, GRAM, 40n, 20n);
            fees(r, 'SetPoolFees');
            expectNoFailures(r);
            expect(txsBetween(r, native.address, d.admin.address).some((t) => opOf(t) === OP.JettonExcesses)).toBe(true);
            const pd = await native.getGetPoolData();
            expect(pd.lpFeeBps).toBe(40n);
            expect(pd.protocolFeeBps).toBe(20n);
            const m = modelSwap(toNano('10'), pd.reserve0, pd.reserve1, 40n, 20n, 0n);
            expect((await native.getGetExpectedOut(GRAM, toNano('10'), 0n)).amountOut).toBe(m.amountOut);
            const bobA = await d.jBal(d.jA, d.bob.address);
            expectNoFailures(await d.swapNative(d.bob, toNano('10'), d.tokA, { minOut: m.amountOut }));
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA + m.amountOut);
            expect((await native.getGetPoolData()).protocolFee0).toBe(toNano('10') * 20n / 10000n);
            // Other pools are untouched.
            expect((await jj.getGetPoolData()).lpFeeBps).toBe(25n);
        });

        it('accepts the caps exactly, rejects anything above them, and zero fees work', async () => {
            expectNoFailures(await setFees(d.admin, d.tokA, d.tokB, MAX_LP_FEE_BPS, MAX_PROTOCOL_FEE_BPS));
            let pd = await jj.getGetPoolData();
            expect(pd.lpFeeBps).toBe(100n);
            expect(pd.protocolFeeBps).toBe(50n);
            for (const [lp, proto] of [[MAX_LP_FEE_BPS + 1n, 0n], [0n, MAX_PROTOCOL_FEE_BPS + 1n], [65535n, 65535n]]) {
                const r = await setFees(d.admin, d.tokA, d.tokB, lp, proto);
                expect(r.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Fee above cap'] });
            }
            expectNoFailures(await setFees(d.admin, d.tokB, d.tokA, 0n, 0n));
            pd = await jj.getGetPoolData();
            expect(pd.lpFeeBps).toBe(0n);
            const m = modelSwap(toNano('100'), pd.token0.equals(d.tokA) ? pd.reserve0 : pd.reserve1,
                pd.token0.equals(d.tokA) ? pd.reserve1 : pd.reserve0, 0n, 0n, 0n);
            expect((await jj.getGetExpectedOut(d.tokA, toNano('100'), 0n)).amountOut).toBe(m.amountOut);
            expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('100'), d.tokB, { minOut: m.amountOut }));
        });

        it('rejects non-admins and low gas; a missing pool bounces and the Router swallows it', async () => {
            const r1 = await setFees(d.bob, d.tokA, GRAM, 1n, 1n);
            expect(r1.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Not admin'] });
            const r2 = await setFees(d.admin, d.tokA, GRAM, 1n, 1n, ADMIN_GAS - 1n);
            expect(r2.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Insufficient TON attached'] });
            const missing = await d.poolOf(GRAM, d.tokC);
            const r3 = await setFees(d.admin, d.tokC, GRAM, 1n, 1n);
            expectNoFailures(r3, (tx) => tx.inMessage!.info.dest instanceof Address && tx.inMessage!.info.dest.equals(missing.address));
            expect(r3.transactions).toHaveTransaction({ from: missing.address, to: d.router.address, inMessageBounced: true, success: true });
            expect(await d.isActive(missing.address)).toBe(false);
            expect((await native.getGetPoolData()).lpFeeBps).toBe(25n);
        });
    });

    describe('creation pause, treasury and admin transfer', () => {
        it('SetCreationPaused and SetTreasury are admin-only and stored', async () => {
            for (const msg of [
                { $$type: 'SetCreationPaused' as const, queryId: 0n, paused: true },
                { $$type: 'SetTreasury' as const, queryId: 0n, treasury: d.carol.address },
            ]) {
                const bad = await d.router.send(d.bob.getSender(), { value: toNano('0.1') }, msg);
                expect(bad.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Not admin'] });
                const ok = await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, msg);
                expectNoFailures(ok);
                expect(ok.transactions).toHaveTransaction({ from: d.router.address, to: d.admin.address, op: OP.JettonExcesses });
            }
            const rd = await d.router.getGetRouterData();
            expect(rd.creationPaused).toBe(true);
            expect(rd.treasury.equals(d.carol.address)).toBe(true);
        });

        it('two-step admin transfer, with cancel', async () => {
            const transfer = (from: SandboxContract<any>, to: Address) =>
                d.router.send(from.getSender(), { value: toNano('0.1') }, { $$type: 'TransferAdmin', queryId: 0n, newAdmin: to });
            const claim = (from: SandboxContract<any>) => d.router.send(from.getSender(), { value: toNano('0.1') }, { $$type: 'ClaimAdmin', queryId: 0n });

            const r0 = await transfer(d.bob, d.bob.address);
            expect(r0.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Not admin'] });

            expectNoFailures(await transfer(d.admin, d.bob.address));
            expect((await d.router.getGetRouterData()).pendingAdmin!.equals(d.bob.address)).toBe(true);
            const r1 = await claim(d.carol);
            expect(r1.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Not pending admin'] });
            // Still admin until claimed.
            expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetCreationPaused', queryId: 0n, paused: false }));

            // Cancel with TransferAdmin(self).
            expectNoFailures(await transfer(d.admin, d.admin.address));
            expect((await d.router.getGetRouterData()).pendingAdmin).toBeNull();
            const r2 = await claim(d.bob);
            expect(r2.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Not pending admin'] });

            expectNoFailures(await transfer(d.admin, d.bob.address));
            expectNoFailures(await claim(d.bob));
            const rd = await d.router.getGetRouterData();
            expect(rd.admin.equals(d.bob.address)).toBe(true);
            expect(rd.pendingAdmin).toBeNull();
            const r3 = await setFees(d.admin, d.tokA, GRAM, 1n, 1n);
            expect(r3.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Not admin'] });
            expectNoFailures(await setFees(d.bob, d.tokA, GRAM, 1n, 1n));
            expect((await native.getGetPoolData()).lpFeeBps).toBe(1n);
        });
    });

    describe('WithdrawRouterExcess', () => {
        it('sweeps only the Router buffer above ROUTER_MIN_STORAGE; pool and LpAccount funds are untouched', async () => {
            // Park some Gram in an LpAccount and leave reserves in place.
            expectNoFailures(await d.provideNative(d.carol, toNano('3'), d.tokC));
            const accAddr = await d.router.getGetLpAccountAddress(GRAM, d.tokC, d.carol.address);
            const accBefore = await d.gram(accAddr);
            const poolBefore = await d.gram(native.address);
            const holdsA = await d.routerHolds(d.tokA);
            await d.router.send(d.bob.getSender(), { value: toNano('5') }, null);   // a top-up / donation
            const bad = await d.router.send(d.bob.getSender(), { value: toNano('0.1') }, { $$type: 'WithdrawRouterExcess', queryId: 0n });
            expect(bad.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Not admin'] });

            const tBefore = await d.gram(d.treasury.address);
            const r = await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'WithdrawRouterExcess', queryId: 0n });
            expectNoFailures(r);
            const routerAfter = await d.gram(d.router.address);
            expect(routerAfter).toBeLessThanOrEqual(ROUTER_MIN_STORAGE);
            expect(routerAfter).toBeGreaterThan(ROUTER_MIN_STORAGE - toNano('0.001'));
            expect(await d.gram(d.treasury.address)).toBeGreaterThan(tBefore + toNano('5'));
            expect(await d.gram(native.address)).toBe(poolBefore);
            expect(await d.gram(accAddr)).toBe(accBefore);
            expect(await d.routerHolds(d.tokA)).toBe(holdsA);
            // The Router still works with only its minimum buffer.
            expectNoFailures(await d.swapNative(d.bob, toNano('1'), d.tokA));
        });
    });

    describe('protocol fee collection', () => {
        it('collects the Gram and jetton legs of a native pool to the treasury (anyone may trigger)', async () => {
            expectNoFailures(await d.swapNative(d.bob, toNano('100'), d.tokA));
            expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('300000'), GRAM));
            const pd = await native.getGetPoolData();
            expect(pd.protocolFee0).toBe(toNano('100') * 5n / 10000n);
            expect(pd.protocolFee1).toBe(toNano('300000') * 5n / 10000n);
            const tA = await d.jBal(d.jA, d.treasury.address);
            const r = await d.router.send(d.carol.getSender(), { value: COLLECT_GAS }, { $$type: 'CollectProtocolFees', queryId: 0n, tokenA: d.tokA, tokenB: GRAM });
            fees(r, 'collect (native pool)');
            expectNoFailures(r);
            const g = gramPayouts(r, d.treasury.address)[0];
            expect(g.reason).toBe(Number(REASON_PROTOCOL_FEE));
            expect(g.amount).toBe(pd.protocolFee0);
            expect(await d.jBal(d.jA, d.treasury.address)).toBe(tA + pd.protocolFee1);
            const after = await native.getGetPoolData();
            expect(after.protocolFee0).toBe(0n);
            expect(after.protocolFee1).toBe(0n);
            expect(after.reserve0).toBe(pd.reserve0);
            expect(after.reserve1).toBe(pd.reserve1);
            expect(await d.gram(native.address)).toBeGreaterThanOrEqual(after.reserve0 + toNano('0.049'));
        });

        it('collects both jetton legs of a jetton/jetton pool at exactly COLLECT_GAS', async () => {
            expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('10000'), d.tokB));
            expectNoFailures(await d.swapJetton(d.jB, d.bob, toNano('10000'), d.tokA));
            const pd = await jj.getGetPoolData();
            expect(pd.protocolFee0).toBeGreaterThan(0n);
            expect(pd.protocolFee1).toBeGreaterThan(0n);
            const tA = await d.jBal(d.jA, d.treasury.address);
            const tB = await d.jBal(d.jB, d.treasury.address);
            const r = await d.router.send(d.carol.getSender(), { value: COLLECT_GAS }, { $$type: 'CollectProtocolFees', queryId: 0n, tokenA: d.tokB, tokenB: d.tokA });
            fees(r, 'collect (jetton/jetton) at COLLECT_GAS');
            expectNoFailures(r);
            expect(await d.jBal(d.jA, d.treasury.address)).toBe(tA + toNano('10000') * 5n / 10000n);
            expect(await d.jBal(d.jB, d.treasury.address)).toBe(tB + toNano('10000') * 5n / 10000n);
            const after = await jj.getGetPoolData();
            expect(after.protocolFee0 + after.protocolFee1).toBe(0n);
        });

        it('with nothing accrued only returns the gas; low gas is rejected; a missing pool bounces', async () => {
            const r = await d.router.send(d.carol.getSender(), { value: COLLECT_GAS }, { $$type: 'CollectProtocolFees', queryId: 0n, tokenA: d.tokA, tokenB: GRAM });
            expectNoFailures(r);
            expect(gramPayouts(r).length).toBe(0);
            expect(txsBetween(r, native.address, d.carol.address).some((t) => opOf(t) === OP.JettonExcesses)).toBe(true);
            const low = await d.router.send(d.carol.getSender(), { value: COLLECT_GAS - 1n }, { $$type: 'CollectProtocolFees', queryId: 0n, tokenA: d.tokA, tokenB: GRAM });
            expect(low.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Insufficient TON attached'] });
            const missing = await d.poolOf(d.tokC, GRAM);
            const r3 = await d.router.send(d.carol.getSender(), { value: COLLECT_GAS }, { $$type: 'CollectProtocolFees', queryId: 0n, tokenA: d.tokC, tokenB: GRAM });
            expectNoFailures(r3, (tx) => tx.inMessage!.info.dest instanceof Address && tx.inMessage!.info.dest.equals(missing.address));
        });

        it('goes to the treasury current at request time', async () => {
            expectNoFailures(await d.swapNative(d.bob, toNano('100'), d.tokA));
            expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetTreasury', queryId: 0n, treasury: d.carol.address }));
            const r = await d.router.send(d.bob.getSender(), { value: COLLECT_GAS }, { $$type: 'CollectProtocolFees', queryId: 0n, tokenA: d.tokA, tokenB: GRAM });
            expectNoFailures(r);
            expect(gramPayouts(r, d.carol.address)[0].amount).toBe(toNano('100') * 5n / 10000n);
            expect(gramPayouts(r, d.treasury.address).length).toBe(0);
        });
    });
});
