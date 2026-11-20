// Admin suite: every admin power is capped and none reaches user funds. Presets are add-only with
// hard caps; 2-step admin transfer (and cancel); treasury; creation pause blocks only pool
// INITIALIZATION (existing pools keep trading, minting and withdrawing); WithdrawRouterExcess
// cannot touch pool Gram or jettons; protocol fee collection is permissionless but pays only the
// treasury; getters.

import { Address, beginCell, toNano } from '@ton/core';
import { SandboxContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, CODES, REASON, Pool, expectNoFailures, refundCodes, gramPayouts, failedAt, simOf, expectPoolEquals,
    modifyEvents, swapEvents, extCell, msg, storePoolSwap,
} from './helpers';
import * as M from './model';

jest.setTimeout(900000);

const preset = (o: Partial<{ baseFeePips: bigint; varFeeControl: bigint; filterPeriod: bigint; decayPeriod: bigint; reductionBps: bigint; maxVolAcc: bigint }> = {}) => ({
    $$type: 'FeePreset' as const, baseFeePips: 1000n, varFeeControl: 1000n, filterPeriod: 10n, decayPeriod: 100n, reductionBps: 5000n,
    maxVolAcc: 350000n, ...o,
});

describe('admin', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    let key: any;
    let base: any;

    beforeAll(async () => {
        d = await Dex.create();
        pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -600n, 600n, toNano('1000'), { sqrtPriceInit: Q96 }));
        expectNoFailures(await d.swapNative(d.bob, toNano('10'), d.tokA));
        const s = await pool.getGetPoolState();
        key = { $$type: 'PoolKey', token0: s.key.token0, token1: s.key.token1, tickSpacing: s.key.tickSpacing, ext: s.key.ext };
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('default presets are installed exactly as specified', async () => {
        for (const [s, p] of Object.entries(M.PRESETS)) {
            const g = (await d.router.getGetPreset(BigInt(s)))!;
            expect([g.baseFeePips, g.varFeeControl, g.filterPeriod, g.decayPeriod, g.reductionBps, g.maxVolAcc])
                .toEqual([p.baseFeePips, p.varFeeControl, p.filterPeriod, p.decayPeriod, p.reductionBps, p.maxVolAcc]);
        }
        expect(await d.router.getGetPreset(50n)).toBeNull();
    });

    it('presets are add-only and capped; only the admin with enough value may add', async () => {
        const add = (who: any, tickSpacing: bigint, p = preset(), value = toNano('0.1')) =>
            d.router.send(who.getSender(), { value }, { $$type: 'AddFeePreset', queryId: 0n, tickSpacing, preset: p });
        const refused: [string, () => Promise<any>][] = [
            ['existing spacing 60', () => add(d.admin, 60n, preset({ baseFeePips: 1n }))],
            ['non-admin', () => add(d.bob, 50n)],
            ['value < ADMIN_GAS', () => add(d.admin, 50n, preset(), toNano('0.05') - 1n)],
            ['base fee > 2%', () => add(d.admin, 50n, preset({ baseFeePips: 20001n }))],
            ['reduction > 100%', () => add(d.admin, 50n, preset({ reductionBps: 10001n }))],
            ['filter > decay', () => add(d.admin, 50n, preset({ filterPeriod: 101n }))],
            ['spacing 0', () => add(d.admin, 0n)],
            ['spacing 16385', () => add(d.admin, 16385n)],
        ];
        for (const [name, f] of refused) {
            const res = await f();
            expect([name, failedAt(res, d.router.address).length]).toEqual([name, 1]);
        }
        const g60 = (await d.router.getGetPreset(60n))!;
        expect(g60.baseFeePips).toBe(3000n);
        expectNoFailures(await add(d.admin, 16384n, preset({ baseFeePips: 20000n })));
        expectNoFailures(await add(d.admin, 1000n, preset({ filterPeriod: 100n })));
        expect((await d.router.getGetPreset(16384n))!.baseFeePips).toBe(20000n);
        // The new spacing is usable at once; an existing pool's fee state does not change.
        const p2 = await d.poolOf(GRAM, d.tokA, 1000n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('10'), GRAM, -10000n, 10000n, toNano('10'), { tickSpacing: 1000n, sqrtPriceInit: Q96 }));
        expect((await p2.getGetPoolState()).fs.baseFeePips).toBe(1000n);
        expect((await pool.getGetPoolState()).fs.baseFeePips).toBe(3000n);
    });

    it('2-step admin transfer: only the pending admin claims; the old admin loses power; cancel by transferring to self', async () => {
        let res = await d.router.send(d.bob.getSender(), { value: toNano('0.1') }, { $$type: 'TransferAdmin', queryId: 0n, newAdmin: d.bob.address });
        expect(failedAt(res, d.router.address).length).toBe(1);
        expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'TransferAdmin', queryId: 0n, newAdmin: d.bob.address }));
        expect((await d.router.getGetRouterData()).pendingAdmin!.equals(d.bob.address)).toBe(true);
        res = await d.router.send(d.carol.getSender(), { value: toNano('0.1') }, { $$type: 'ClaimAdmin', queryId: 0n });
        expect(failedAt(res, d.router.address).length).toBe(1);
        // Cancel: transferring to the current admin clears the pending one.
        expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'TransferAdmin', queryId: 0n, newAdmin: d.admin.address }));
        expect((await d.router.getGetRouterData()).pendingAdmin).toBeNull();
        res = await d.router.send(d.bob.getSender(), { value: toNano('0.1') }, { $$type: 'ClaimAdmin', queryId: 0n });
        expect(failedAt(res, d.router.address).length).toBe(1);
        // Real transfer.
        expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'TransferAdmin', queryId: 0n, newAdmin: d.bob.address }));
        expectNoFailures(await d.router.send(d.bob.getSender(), { value: toNano('0.1') }, { $$type: 'ClaimAdmin', queryId: 0n }));
        const rd = await d.router.getGetRouterData();
        expect([rd.admin.toString(), rd.pendingAdmin]).toEqual([d.bob.address.toString(), null]);
        res = await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetCreationPaused', queryId: 0n, paused: true });
        expect(failedAt(res, d.router.address).length).toBe(1);
        expectNoFailures(await d.router.send(d.bob.getSender(), { value: toNano('0.1') }, { $$type: 'SetCreationPaused', queryId: 0n, paused: true }));
    });

    it('treasury: only the admin sets it, never to the Router; protocol fees then go to the new treasury', async () => {
        let res = await d.router.send(d.bob.getSender(), { value: toNano('0.1') }, { $$type: 'SetTreasury', queryId: 0n, treasury: d.bob.address });
        expect(failedAt(res, d.router.address).length).toBe(1);
        res = await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetTreasury', queryId: 0n, treasury: d.router.address });
        expect(failedAt(res, d.router.address).length).toBe(1);
        expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetTreasury', queryId: 0n, treasury: d.carol.address }));
        const st = await pool.getGetPoolState();
        expect(st.protocolFees0).toBeGreaterThan(0n);
        res = await d.router.send(d.bob.getSender(), { value: toNano('0.35') }, { $$type: 'CollectProtocolFees', queryId: 0n, key });
        expectNoFailures(res);
        expect(gramPayouts(res, d.carol.address).map((x) => [x.reason, x.amount])).toEqual([[REASON.PROTOCOL_FEE, st.protocolFees0]]);
        expect(gramPayouts(res, d.treasury.address)).toEqual([]);
    });

    it('creation pause blocks only initialization: existing pools keep swapping, minting and withdrawing', async () => {
        expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetCreationPaused', queryId: 0n, paused: true }));
        expect((await d.router.getGetRouterData()).creationPaused).toBe(true);
        // New pool: refused (both entry types), funds back.
        let res = await d.mintNative(d.bob, toNano('5'), d.tokA, 60n, 600n, { tickSpacing: 10n, sqrtPriceInit: Q96 });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.CREATION_PAUSED]);
        expect(gramPayouts(res, d.bob.address).filter((x) => x.reason === REASON.MINT_REFUND).map((x) => x.amount)).toEqual([toNano('5')]);
        res = await d.mintJetton(d.jA, d.alice, toNano('1'), d.tokB, -600n, 600n, 0n, { sqrtPriceInit: Q96 });
        expect(refundCodes(res)).toEqual([CODES.CREATION_PAUSED]);
        // Existing pool: swap, mint, decrease all work.
        res = await d.swapNative(d.bob, toNano('1'), d.tokA);
        expectNoFailures(res);
        expect(swapEvents(res).length).toBe(1);
        res = await d.mintNative(d.bob, toNano('5'), d.tokA, 60n, 600n);
        expectNoFailures(res);
        expect(modifyEvents(res).length).toBe(1);
        const pos = await d.position(pool, 0n);
        res = await d.decrease(pos, d.alice, (await pos.getGetPositionData()).liquidity);
        expectNoFailures(res);
        expect(modifyEvents(res).length).toBe(1);
        // Unpause restores creation.
        expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetCreationPaused', queryId: 0n, paused: false }));
        res = await d.mintNative(d.bob, toNano('5'), d.tokA, 60n, 600n, { tickSpacing: 10n, sqrtPriceInit: Q96 });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
    });

    it('WithdrawRouterExcess sweeps only the Router\'s own Gram; pool Gram and Router-held jettons are untouched', async () => {
        await d.router.send(d.carol.getSender(), { value: toNano('3') }, null); // a stray top-up
        const poolGram = await d.gram(pool.address);
        const jHeld = await d.routerHolds(d.tokA);
        const st = await pool.getGetPoolState();
        let res = await d.router.send(d.bob.getSender(), { value: toNano('0.1') }, { $$type: 'WithdrawRouterExcess', queryId: 0n });
        expect(failedAt(res, d.router.address).length).toBe(1);
        const tBefore = await d.gram(d.treasury.address);
        res = await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'WithdrawRouterExcess', queryId: 0n });
        expectNoFailures(res);
        expect(await d.gram(d.treasury.address)).toBeGreaterThan(tBefore + toNano('3'));
        expect(await d.gram(d.router.address)).toBeLessThanOrEqual(toNano('0.55'));  // v4: ROUTER_RENT_RESERVE
        expect(await d.gram(pool.address)).toBe(poolGram);
        expect(await d.routerHolds(d.tokA)).toBe(jHeld);
        await expectPoolEquals(pool, await simOf(pool));
        expect((await pool.getGetPoolState()).reserve0).toBe(st.reserve0);
        // Everything still works with the Router at its minimum balance.
        expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('1'), GRAM));
        expectNoFailures(await d.swapNative(d.bob, toNano('1'), d.tokA));
        await d.checkSolvency([pool]);
    });

    it('the admin has no path to pool funds: forged pool messages from the admin are rejected', async () => {
        const sim = await simOf(pool);
        const body = beginCell().store(storePoolSwap({
            $$type: 'PoolSwap', queryId: 0n, fromUser: d.admin.address, zeroForOne: false, amountIn: toNano('100'), minOut: 0n,
            sqrtPriceLimitX96: 0n, maxCrossings: 24n, allowPartial: true, deadline: d.deadline(), receiver: d.admin.address,
            refundTo: d.admin.address, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null, platformBps: 100n, platformTo: d.admin.address,
        })).endCell();
        const res = await d.chain.sendMessage(msg(d.admin.address, pool.address, toNano('1'), body));
        expect(failedAt(res, pool.address).length).toBe(1);
        await expectPoolEquals(pool, sim);
    });

    it('getters: pool address sorting, mint account address, payload fee, gram token, ticks walk, observe', async () => {
        const a = await d.router.getGetPoolAddress(d.tokA, d.tokB, 60n, null);
        const b = await d.router.getGetPoolAddress(d.tokB, d.tokA, 60n, null);
        expect(a.equals(b)).toBe(true);
        expect((await d.router.getGetPoolAddress(d.tokA, GRAM, 60n, null)).equals(pool.address)).toBe(true);
        expect((await d.router.getGetGramToken()).equals(GRAM)).toBe(true);
        expect(await d.router.getGetPayloadFee(null)).toBe(0n);
        expect(await d.router.getGetPayloadFee(beginCell().storeUint(1, 8).endCell())).toBeGreaterThan(0n);
        expect((await d.router.getGetMintAccountAddress(pool.address, d.bob.address)).equals(await pool.getGetMintAccountAddress(d.bob.address))).toBe(true);
        expect((await pool.getGetPositionAddress(0n)).equals(await pool.getGetNftAddressByIndex(0n))).toBe(true);
        const ic = beginCell().storeUint(42, 8).endCell();
        expect((await pool.getGetNftContent(0n, ic)).equals(ic)).toBe(true);
        // get_ticks both directions, from inside and from a tick.
        expectNoFailures(await d.mintNative(d.bob, toNano('5'), d.tokA, 120n, 180n));
        const up = await pool.getGetTicks(-600n, 64n, true);
        expect([...up.keys()].sort((x, y) => x - y)).toEqual([-600, 120, 180, 600]);
        const down = await pool.getGetTicks(179n, 2n, false);
        expect([...down.keys()].sort((x, y) => x - y)).toEqual([-600, 120]);
        expect((await pool.getGetTicks(601n, 64n, true)).size).toBe(0);
        expect(await pool.getGetTick(119n)).toBeNull();
        expect((await pool.getGetTick(120n))!.liqNet).toBeGreaterThan(0n);
        // TWAP: tickCumulative grows by tick * dt between samples.
        const o1 = await pool.getGetObserve();
        const t = (await pool.getGetPoolState()).tick;
        d.chain.now = d.now + 1000;
        const o2 = await pool.getGetObserve();
        expect(o2.tickCumulative - o1.tickCumulative).toBe(t * 1000n);
        expect(o2.time - o1.time).toBe(1000n);
        void Address;
        void extCell;
    });
});
