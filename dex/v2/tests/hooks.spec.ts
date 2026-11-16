// Hook / extension suite: AFTER_SWAP and AFTER_MODIFY payloads, FEE_CONTROL bounds and timing,
// hook fee share accrual and collection, sender checks, a throwing hook, and the full KeyExt
// validation matrix (including the canonical-encoding rule).

import { Address, beginCell, Cell, toNano } from '@ton/core';
import { SandboxContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, CODES, REASON, Pool, expectNoFailures, swapEvents, modifyEvents, refundCodes, gramPayouts,
    simOf, expectPoolEquals, failedAt, extCell, msg, storeHookSetFee, storeHookCollectFees, storeKeyExt,
} from './helpers';
import { TestHook } from '../build/TestHook_TestHook';
import * as M from './model';

jest.setTimeout(900000);

const setFee = (fee: bigint) => beginCell().store(storeHookSetFee({ $$type: 'HookSetFee', queryId: 0n, feePips: fee })).endCell();
const collect = () => beginCell().store(storeHookCollectFees({ $$type: 'HookCollectFees', queryId: 0n })).endCell();

describe('hooks: notifications, fee control, fee share', () => {
    let d: Dex;
    let hook: SandboxContract<TestHook>;
    let ext: Cell;
    let pool: SandboxContract<Pool>;
    const extM: M.ExtModel = { ...M.PLAIN_EXT, hookShareBps: 2000n };
    const cmd = (target: Address, body: Cell, value = toNano('0.05')) =>
        hook.send(d.carol.getSender(), { value: value + toNano('0.1') }, { $$type: 'HookCmd', target, value, bounce: true, body });

    beforeAll(async () => {
        d = await Dex.create();
        hook = d.chain.openContract(await TestHook.fromInit(d.carol.address, 0n));
        await hook.send(d.carol.getSender(), { value: toNano('2') }, null);
        ext = extCell({ hook: hook.address, hookFlags: 7n, hookShareBps: 2000n, hookFeeMin: 500n, hookFeeMax: 20000n });
        pool = await d.poolOf(GRAM, d.tokA, 60n, ext);
    });

    it('HookSetFee before initialization is refused (it would be overwritten at init)', async () => {
        await d.swapNative(d.bob, toNano('1'), d.tokA, { ext }); // deploys the pool uninitialized
        const res = await cmd(pool.address, setFee(1000n));
        expect(failedAt(res, pool.address).length).toBe(1);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -1200n, 1200n, toNano('1000'), { ext, sqrtPriceInit: Q96 }));
        expect((await pool.getGetPoolState()).fs.hookFeeSet).toBe(false);
    });

    it('AFTER_MODIFY on mint and burn carries exactly the modify data', async () => {
        let res = await d.mintNative(d.bob, toNano('10'), d.tokA, 60n, 600n, { ext });
        expectNoFailures(res);
        const ev = modifyEvents(res)[0];
        let lm = (await hook.getLastModify())!;
        expect([lm.owner.toString(), lm.index, lm.tickLower, lm.tickUpper, lm.liquidityDelta, lm.amount0, lm.amount1])
            .toEqual([d.bob.address.toString(), ev.index, 60n, 600n, ev.liquidityDelta, ev.amount0, ev.amount1]);
        const pos = await d.position(pool, ev.index);
        res = await d.decrease(pos, d.bob, ev.liquidityDelta / 2n);
        expectNoFailures(res);
        const ev2 = modifyEvents(res)[0];
        lm = (await hook.getLastModify())!;
        expect([lm.index, lm.liquidityDelta, lm.amount0, lm.amount1]).toEqual([ev.index, -(ev.liquidityDelta / 2n), ev2.amount0, ev2.amount1]);
    });

    it('AFTER_SWAP carries the executed swap; the hook share accrues exactly (20% of each step fee)', async () => {
        const c0 = await hook.getCounts();
        const sim = await simOf(pool, extM);
        const e = sim.swap(true, toNano('20'), 0n, 24, 5n, false, 0n, BigInt(d.now));
        const res = await d.swapNative(d.bob, toNano('20'), d.tokA, { ext, referral: d.carol.address, refBps: 5n });
        expectNoFailures(res);
        await expectPoolEquals(pool, sim);
        expect(await hook.getCounts()).toBe(c0 + 1_000_000n);
        const ls = (await hook.getLastSwap())!;
        expect([ls.fromUser.toString(), ls.zeroForOne, ls.amountIn, ls.amountOut, ls.sqrtPriceX96, ls.tick, ls.liquidity, ls.feePips])
            .toEqual([d.bob.address.toString(), true, e.consumed + e.refFee, e.out, e.sqrtP, BigInt(e.tick), e.L, e.lastFee]);
        expect(e.hook).toBeGreaterThan(0n);
        expect(swapEvents(res)[0].hookFee).toBe(e.hook);
        // jetton side too
        const e2 = sim.swap(false, toNano('20'), 0n, 24, 0n, false, 0n, BigInt(d.now));
        expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('20'), GRAM, { ext }));
        await expectPoolEquals(pool, sim);
        expect((await pool.getGetPoolState()).hookFees1).toBe(e2.hook);
    });

    it('FEE_CONTROL: bounds [min, max] inclusive, applies from the next swap, quote == execution', async () => {
        for (const bad of [499n, 20001n, 30000n]) {
            const res = await cmd(pool.address, setFee(bad));
            expect(failedAt(res, pool.address).length).toBe(1);
        }
        expect((await pool.getGetPoolState()).fs.hookFeeSet).toBe(false);
        const before = await pool.getGetQuote(true, toNano('5'), 0n, 24n, 0n, false);
        expectNoFailures(await cmd(pool.address, setFee(500n)));
        let st = await pool.getGetPoolState();
        expect([st.fs.hookFeeSet, st.fs.hookFeePips]).toEqual([true, 500n]);
        expectNoFailures(await cmd(pool.address, setFee(20000n)));
        st = await pool.getGetPoolState();
        expect(st.fs.hookFeePips).toBe(20000n);
        const after = await pool.getGetQuote(true, toNano('5'), 0n, 24n, 0n, false);
        expect(after.amountOut).toBeLessThan(before.amountOut);
        const sim = await simOf(pool, extM);
        const e = sim.swap(true, toNano('5'), 0n, 24, 0n, false, 0n, BigInt(d.now));
        expect(e.out).toBe(after.amountOut);
        const res = await d.swapNative(d.bob, toNano('5'), d.tokA, { ext });
        expectNoFailures(res);
        expect(swapEvents(res)[0].amountOut).toBe(after.amountOut);
        await expectPoolEquals(pool, sim);
    });

    it('only the key hook may set fees or collect; a hook without FEE_CONTROL cannot set fees', async () => {
        let res = await d.chain.sendMessage(msg(d.bob.address, pool.address, toNano('0.3'), setFee(1000n)));
        expect(failedAt(res, pool.address).length).toBe(1);
        res = await d.chain.sendMessage(msg(d.bob.address, pool.address, toNano('0.3'), collect()));
        expect(failedAt(res, pool.address).length).toBe(1);
        // A second TestHook (different salt) is not the key's hook.
        const other = d.chain.openContract(await TestHook.fromInit(d.carol.address, 2n));
        await other.send(d.carol.getSender(), { value: toNano('1') }, null);
        res = await other.send(d.carol.getSender(), { value: toNano('0.5') }, { $$type: 'HookCmd', target: pool.address, value: toNano('0.3'), bounce: true, body: collect() });
        expect(failedAt(res, pool.address).length).toBe(1);
        // Same hook, key without FEE_CONTROL (flags 3).
        const ext3 = extCell({ hook: hook.address, hookFlags: 3n });
        const p3 = await d.poolOf(GRAM, d.tokA, 60n, ext3);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('10'), GRAM, -600n, 600n, toNano('10'), { ext: ext3, sqrtPriceInit: Q96 }));
        res = await cmd(p3.address, setFee(1000n));
        expect(failedAt(res, p3.address).length).toBe(1);
    });

    it('the hook collects exactly its share (both tokens); low value refused; a second collect pays nothing', async () => {
        const st = await pool.getGetPoolState();
        expect(st.hookFees0).toBeGreaterThan(0n);
        expect(st.hookFees1).toBeGreaterThan(0n);
        let res = await cmd(pool.address, collect(), toNano('0.2') - 1n);
        expect(failedAt(res, pool.address).length).toBe(1);
        const jb = await d.jBal(d.jA, hook.address);
        res = await cmd(pool.address, collect(), toNano('0.2'));
        expectNoFailures(res);
        expect(gramPayouts(res, hook.address).filter((x) => x.reason === REASON.HOOK_FEE).map((x) => x.amount)).toEqual([st.hookFees0]);
        expect(await d.jBal(d.jA, hook.address)).toBe(jb + st.hookFees1);
        const st2 = await pool.getGetPoolState();
        expect([st2.hookFees0, st2.hookFees1, st2.reserve0, st2.reserve1]).toEqual([0n, 0n, st.reserve0, st.reserve1]);
        res = await cmd(pool.address, collect(), toNano('0.2'));
        expectNoFailures(res);
        expect(gramPayouts(res, hook.address).filter((x) => x.reason === REASON.HOOK_FEE)).toEqual([]);
        await d.checkSolvency([pool]);
    });

    it('a hook that throws on every notification affects nothing (swap, mint, burn all commit)', async () => {
        const bad = d.chain.openContract(await TestHook.fromInit(d.carol.address, 1n));
        await bad.send(d.carol.getSender(), { value: toNano('1') }, null);
        const e2 = extCell({ hook: bad.address, hookFlags: 3n, hookShareBps: 100n });
        const p = await d.poolOf(GRAM, d.tokA, 60n, e2);
        const okBad = (tx: any) => tx.inMessage?.info.dest?.toString() === bad.address.toString();
        let res = await d.mintJetton(d.jA, d.alice, toNano('100'), GRAM, -600n, 600n, toNano('100'), { ext: e2, sqrtPriceInit: Q96 });
        expectNoFailures(res, okBad);
        expect(failedAt(res, bad.address).length).toBe(1);
        const sim = await simOf(p, { ...M.PLAIN_EXT, hookShareBps: 100n });
        const e = sim.swap(true, toNano('3'), 0n, 24, 0n, false, 0n, BigInt(d.now));
        res = await d.swapNative(d.bob, toNano('3'), d.tokA, { ext: e2 });
        expectNoFailures(res, okBad);
        expect(swapEvents(res)[0].amountOut).toBe(e.out);
        await expectPoolEquals(p, sim);
        const pos = await d.position(p, 0n);
        res = await d.decrease(pos, d.alice, (await pos.getGetPositionData()).liquidity);
        expectNoFailures(res, okBad);
        expect((await pos.getGetPositionData()).liquidity).toBe(0n);
        expect(await bad.getCounts()).toBe(0n);
    });
});

describe('hooks: KeyExt validation matrix', () => {
    let d: Dex;
    let H: Address;

    beforeAll(async () => {
        d = await Dex.create();
        H = (await d.chain.treasury('hook')).address;
    });

    it('rejects every invalid ext (getter -1, swap and mint refunded BAD_KEY) and accepts the boundaries', async () => {
        const mc = new Address(-1, Buffer.alloc(32, 7));
        const base = { $$type: 'KeyExt' as const, hook: null, hookFlags: 0n, hookShareBps: 0n, hookFeeMin: 0n, hookFeeMax: 0n,
            initializer: null, launchFeePips: 0n, launchDuration: 0n, minLockSecs: 0n,
            taxRecipient: null, buyTaxBps: 0n, sellTaxBps: 0n };
        const raw = (e: any) => beginCell().store(storeKeyExt({ ...base, ...e })).endCell();
        const bad: [string, Cell][] = [
            ['flags without hook', extCell({ hookFlags: 1n })],
            ['share without hook', extCell({ hookShareBps: 1n })],
            ['reserved bit 3', extCell({ hook: H, hookFlags: 8n })],
            ['bit 7', extCell({ hook: H, hookFlags: 128n })],
            ['share 2001', extCell({ hook: H, hookShareBps: 2001n })],
            ['fee min > max', extCell({ hook: H, hookFlags: 4n, hookFeeMin: 600n, hookFeeMax: 500n })],
            ['fee max > 2%', extCell({ hook: H, hookFlags: 4n, hookFeeMax: 20001n })],
            ['fee bounds without FEE_CONTROL', extCell({ hook: H, hookFlags: 1n, hookFeeMax: 100n })],
            ['launch fee > 90%', extCell({ launchFeePips: 900001n, launchDuration: 100n })],
            ['launch fee without duration', extCell({ launchFeePips: 100n })],
            ['duration without launch fee', extCell({ launchDuration: 100n })],
            ['duration > 1 h', extCell({ launchFeePips: 100n, launchDuration: 3601n })],
            ['min lock > 30 d', extCell({ minLockSecs: 2592001n })],
            ['hook == Router', extCell({ hook: d.router.address, hookFlags: 1n })],
            ['hook on masterchain', extCell({ hook: mc, hookFlags: 1n })],
            ['initializer on masterchain', extCell({ initializer: mc })],
            ['trailing bit (non-canonical)', beginCell().storeSlice(raw({}).beginParse()).storeBit(0).endCell()],
            ['extra ref (non-canonical)', beginCell().storeSlice(raw({}).beginParse()).storeRef(beginCell().endCell()).endCell()],
            ['truncated', beginCell().storeUint(0, 10).endCell()],
        ];
        for (const [name, e] of bad) {
            expect([name, await d.router.getGetExtValid(e)]).toEqual([name, -1n]);
        }
        // The Router refunds swaps and mints over a bad key (jetton entry) and throws on native entries.
        for (const [name, e] of bad.slice(0, 4)) {
            const jb = await d.jBal(d.jA, d.bob.address);
            let res = await d.swapJetton(d.jA, d.bob, toNano('1'), GRAM, { ext: e });
            expectNoFailures(res);
            expect([name, refundCodes(res)]).toEqual([name, [CODES.BAD_KEY]]);
            res = await d.mintJetton(d.jA, d.bob, toNano('1'), GRAM, -600n, -60n, 0n, { ext: e });
            expect([name, refundCodes(res)]).toEqual([name, [CODES.BAD_KEY]]);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(jb);
            res = await d.swapNative(d.bob, toNano('1'), d.tokA, { ext: e });
            expect(failedAt(res, d.router.address).length).toBe(1);
        }
        const good: [string, Cell, bigint][] = [
            ['plain zero ext cell', extCell({}), 0n],
            ['max share, all flags, widest fee bounds', extCell({ hook: H, hookFlags: 7n, hookShareBps: 2000n, hookFeeMin: 0n, hookFeeMax: 20000n }), 7n],
            ['share only (no notifications)', extCell({ hook: H, hookShareBps: 2000n }), 0n],
            ['max launch fee, max duration, max lock, initializer', extCell({ launchFeePips: 900000n, launchDuration: 3600n, minLockSecs: 2592000n, initializer: H }), 512n],
        ];
        for (const [name, e, flags] of good) {
            expect([name, await d.router.getGetExtValid(e)]).toEqual([name, flags]);
        }
        expect(await d.router.getGetExtValid(null)).toBe(0n);
        // A zero ext cell is a different key from ext = null (two pools, both valid).
        const a = await d.router.getGetPoolAddress(GRAM, d.tokA, 60n, null);
        const b = await d.router.getGetPoolAddress(GRAM, d.tokA, 60n, extCell({}));
        expect(a.equals(b)).toBe(false);
    });
});
