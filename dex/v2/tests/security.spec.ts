// Security suite: forged-message matrix against every authenticated handler (raw attacker and a
// FakeJettonWallet), spoofed jetton notifications, bounced Router transfers, 2^119-sized amounts,
// tick-spam griefing bounded by the crossing cap, dust, and "no round trip is profitable".

import { Address, beginCell, Cell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, CODES, REASON, STOP, Pool, MintAccount, expectNoFailures, swapEvents, modifyEvents, refundCodes,
    gramPayouts, simOf, expectPoolEquals, failedAt, msg, gasAt, events, OP,
    storePoolSwap, storePoolMint, storePoolGraduate, storePoolSetProtocolShare, storePoolCollectProtocol, storePoolBurn,
    storeCbMint, storeCbMintRefund, storeCbMintReject, storeHookSetFee, storeHookCollectFees, storePayTo, storePositionInit,
    storeMintAccountDeposit, storeJettonNotification, storeSwapPayload,
} from './helpers';
import * as M from './model';

jest.setTimeout(900000);

const P = (o: any = {}) => ({ $$type: 'FeePreset' as const, baseFeePips: 0n, varFeeControl: 0n, filterPeriod: 0n, decayPeriod: 0n, reductionBps: 0n, maxVolAcc: 0n, ...o });

describe('security: forged messages', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    let eve: SandboxContract<TreasuryContract>;
    let key: any;

    beforeAll(async () => {
        d = await Dex.create();
        eve = await d.chain.treasury('eve', { balance: toNano('1000000') });
        pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -600n, 600n, toNano('1000'), { sqrtPriceInit: Q96 }));
        expectNoFailures(await d.swapNative(d.bob, toNano('10'), d.tokA));
        // a parked MintAccount leg on a jetton/jetton pool
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('10'), d.tokB, -600n, 600n, 0n, { viaAccount: true, sqrtPriceInit: Q96 }));
        const s = await pool.getGetPoolState();
        key = { $$type: 'PoolKey', token0: s.key.token0, token1: s.key.token1, tickSpacing: s.key.tickSpacing, ext: s.key.ext };
    });

    it('every authenticated handler rejects an attacker (raw and through a FakeJettonWallet); nothing moves', async () => {
        const pos = await d.position(pool, 0n);
        const pd = await pos.getGetPositionData();
        const pj = await d.poolOf(d.tokA, d.tokB, 60n, null);
        const ma = d.chain.openContract(MintAccount.fromAddress(await pj.getGetMintAccountAddress(d.alice.address)));
        const mp = { $$type: 'MintParams' as const, tickLower: -600n, tickUpper: 600n, sqrtPriceInitX96: 0n, minLiquidity: 0n,
            owner: eve.address, refundTo: eve.address, deadline: d.deadline(), sqrtPriceMinX96: 0n, sqrtPriceMaxX96: 0n };
        const c = (st: any) => beginCell().store(st).endCell();
        const toPool: [string, Cell][] = [
            ['PoolSwap', c(storePoolSwap({ $$type: 'PoolSwap', queryId: 0n, fromUser: eve.address, zeroForOne: false, amountIn: toNano('500'),
                minOut: 0n, sqrtPriceLimitX96: 0n, maxCrossings: 24n, allowPartial: true, deadline: d.deadline(), receiver: eve.address,
                refundTo: eve.address, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null, platformBps: 100n, platformTo: eve.address }))],
            ['PoolMint', c(storePoolMint({ $$type: 'PoolMint', queryId: 0n, fromUser: eve.address, amount0: 0n, amount1: toNano('500'),
                params: { ...mp, tickLower: -1200n, tickUpper: -600n }, viaAccount: false, allowInit: true, preset: P() }))],
            ['PoolGraduate', c(storePoolGraduate({ $$type: 'PoolGraduate', queryId: 0n, fromUser: eve.address, amount0: 1n, amount1: 1n,
                feeClaimer: eve.address, refundTo: eve.address, deadline: d.deadline(), allowInit: true, preset: P() }))],
            ['PoolSetProtocolShare', c(storePoolSetProtocolShare({ $$type: 'PoolSetProtocolShare', queryId: 0n, shareBps: 0n, excessTo: eve.address }))],
            ['PoolCollectProtocol', c(storePoolCollectProtocol({ $$type: 'PoolCollectProtocol', queryId: 0n, treasury: eve.address, excessTo: eve.address }))],
            ['PoolBurn', c(storePoolBurn({ $$type: 'PoolBurn', queryId: 0n, index: 0n, owner: eve.address, recipient: eve.address,
                tickLower: pd.tickLower, tickUpper: pd.tickUpper, liquidity: pd.liquidity, liquidityDelta: pd.liquidity, fgLast0: 0n, fgLast1: 0n,
                amount0Min: 0n, amount1Min: 0n, deadline: d.deadline() }))],
            ['CbMint', c(storeCbMint({ $$type: 'CbMint', queryId: 0n, user: eve.address, amount0: toNano('500'), amount1: toNano('500'),
                params: mp, allowInit: true, preset: P() }))],
            ['CbMintRefund', c(storeCbMintRefund({ $$type: 'CbMintRefund', queryId: 0n, user: eve.address, amount0: toNano('500'), amount1: toNano('500') }))],
            ['CbMintReject', c(storeCbMintReject({ $$type: 'CbMintReject', queryId: 0n, user: eve.address, amount0: toNano('500'),
                amount1: toNano('500'), refundTo: eve.address, stored0: toNano('500'), stored1: 0n, storedTo: eve.address }))],
            ['HookSetFee', c(storeHookSetFee({ $$type: 'HookSetFee', queryId: 0n, feePips: 0n }))],
            ['HookCollectFees', c(storeHookCollectFees({ $$type: 'HookCollectFees', queryId: 0n }))],
        ];
        const fake = await d.fake(eve);
        const sim = await simOf(pool);
        const poolGram = await d.gram(pool.address);
        const held = [await d.routerHolds(d.tokA), await d.routerHolds(d.tokB)];
        for (const [name, body] of toPool) {
            let res = await d.chain.sendMessage(msg(eve.address, pool.address, toNano('1'), body));
            expect([name, failedAt(res, pool.address).length]).toEqual([name, 1]);
            res = await fake.send(eve.getSender(), { value: toNano('2') }, { $$type: 'FakeSend', to: pool.address, value: toNano('1'), bounce: true, body });
            expect([name + ' via fake', failedAt(res, pool.address).length]).toEqual([name + ' via fake', 1]);
        }
        // Router: PayTo for the real pool key from a non-pool; Position: PositionInit / Sync; MintAccount: deposit.
        const others: [string, Address, Cell][] = [
            ['PayTo', d.router.address, c(storePayTo({ $$type: 'PayTo', queryId: 0n, key, wallet: d.tokA, amount: toNano('500'), to: eve.address,
                excessTo: eve.address, fwdTon: 0n, fwdPayload: null, reason: 1n }))],
            ['PositionInit', pos.address, c(storePositionInit({ $$type: 'PositionInit', queryId: 0n, owner: eve.address, tickLower: -600n,
                tickUpper: 600n, liquidity: 10n ** 30n, fgInside0: 0n, fgInside1: 0n, lockedUntil: 0n }))],
            ['MintAccountDeposit', ma.address, c(storeMintAccountDeposit({ $$type: 'MintAccountDeposit', queryId: 0n, amount0: toNano('500'),
                amount1: toNano('500'), params: mp, allowInit: true, preset: P() }))],
        ];
        for (const [name, to, body] of others) {
            const res = await d.chain.sendMessage(msg(eve.address, to, toNano('1'), body));
            expect([name, failedAt(res, to).length]).toEqual([name, 1]);
        }
        // Even the pool cannot re-initialize an existing Position.
        const res = await d.chain.sendMessage(msg(pool.address, pos.address, toNano('1'), others[1][2]));
        expect(failedAt(res, pos.address).length).toBe(1);
        expect((await pos.getGetPositionData()).owner.equals(d.alice.address)).toBe(true);
        await expectPoolEquals(pool, sim);
        expect(await d.gram(pool.address)).toBeGreaterThanOrEqual(poolGram);
        expect([await d.routerHolds(d.tokA), await d.routerHolds(d.tokB)]).toEqual(held);
        const md = await ma.getGetMintAccountData();
        expect(md.pending0 + md.pending1).toBe(toNano('10'));
    });

    it('spoofed jetton notifications: a fake wallet can only ever act on keys containing itself', async () => {
        const fake = await d.fake(eve);
        const sim = await simOf(pool);
        const held = await d.routerHolds(d.tokA);
        const notif = (amount: bigint, payload: Cell, sender = d.alice.address) => beginCell().store(storeJettonNotification({
            $$type: 'JettonNotification', queryId: 0n, amount, sender,
            forwardPayload: beginCell().storeBit(1).storeRef(payload).endCell().beginParse(),
        })).endCell();
        // "I am a wallet and alice sent 1e9 jettons to swap for Gram" — the key becomes (GRAM, fake).
        const sp = beginCell().store(storeSwapPayload({ $$type: 'SwapPayload', otherToken: GRAM, tickSpacing: 60n, ext: null, minOut: 0n,
            sqrtPriceLimitX96: 0n, maxCrossings: 24n, allowPartial: true, deadline: d.deadline(), receiver: eve.address, refundTo: eve.address,
            referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null })).endCell();
        let res = await fake.send(eve.getSender(), { value: toNano('2') }, { $$type: 'FakeSend', to: d.router.address, value: toNano('1'), bounce: false, body: notif(toNano('1000000000'), sp) });
        expect(refundCodes(res)).toEqual([CODES.NOT_INITIALIZED]);
        const fakePool = await d.poolOf(GRAM, fake.address, 60n, null);
        expect(await d.isActive(fakePool.address)).toBe(true);
        expect(gramPayouts(res).filter((x) => x.reason === REASON.SWAP_OUT)).toEqual([]);
        // The refund is a JettonTransfer from the Router to the fake wallet itself (harmless).
        expect(res.transactions).toHaveTransaction({ from: d.router.address, to: fake.address, op: 0x0f8a7ea5 });
        // Same with otherToken = the real tokA: key (fake, tokA), a fresh empty pool — never the real one.
        const sp2 = beginCell().store(storeSwapPayload({ $$type: 'SwapPayload', otherToken: d.tokA, tickSpacing: 60n, ext: null, minOut: 0n,
            sqrtPriceLimitX96: 0n, maxCrossings: 24n, allowPartial: true, deadline: d.deadline(), receiver: eve.address, refundTo: eve.address,
            referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null })).endCell();
        res = await fake.send(eve.getSender(), { value: toNano('2') }, { $$type: 'FakeSend', to: d.router.address, value: toNano('1'), bounce: false, body: notif(toNano('1000000000'), sp2) });
        expect(refundCodes(res)).toEqual([CODES.NOT_INITIALIZED]);
        // Graduation spoof: the key's token1 is the fake wallet, so alice's canonical launch key is untouched.
        const gp = d.graduatePayload(toNano('1'), eve.address, eve.address);
        res = await fake.send(eve.getSender(), { value: toNano('3') }, { $$type: 'FakeSend', to: d.router.address, value: toNano('2'), bounce: false, body: notif(toNano('1000'), gp) });
        const canonical = await d.router.getGetGraduationPoolAddress(d.tokA, 60n, d.alice.address, 0n, 0n);
        expect(await d.isActive(canonical)).toBe(false);
        // Amount 0 → BAD_PAYLOAD and the value goes back; value below ROUTER_REFUND_MIN → LOW_GAS event only.
        res = await fake.send(eve.getSender(), { value: toNano('2') }, { $$type: 'FakeSend', to: d.router.address, value: toNano('1'), bounce: false, body: notif(0n, sp) });
        expect(refundCodes(res)).toEqual([CODES.BAD_PAYLOAD]);
        res = await fake.send(eve.getSender(), { value: toNano('2') }, { $$type: 'FakeSend', to: d.router.address, value: toNano('0.08') - 1n, bounce: false, body: notif(5n, sp) });
        expect(refundCodes(res)).toEqual([CODES.LOW_GAS]);
        expect(res.transactions).not.toHaveTransaction({ from: d.router.address, to: fake.address });
        // Garbage payload → BAD_PAYLOAD refund.
        res = await fake.send(eve.getSender(), { value: toNano('2') }, { $$type: 'FakeSend', to: d.router.address, value: toNano('1'), bounce: false,
            body: notif(5n, beginCell().storeUint(0x4d480001, 32).storeUint(1, 3).endCell()) });
        expect(refundCodes(res)).toEqual([CODES.BAD_PAYLOAD]);
        // Notification "from the Router itself" as sender is refused (BAD_RECIPIENT, nothing sent).
        res = await fake.send(eve.getSender(), { value: toNano('2') }, { $$type: 'FakeSend', to: d.router.address, value: toNano('1'), bounce: false, body: notif(5n, sp, d.router.address) });
        expect(refundCodes(res)).toEqual([CODES.BAD_RECIPIENT]);
        await expectPoolEquals(pool, sim);
        expect(await d.routerHolds(d.tokA)).toBe(held);
    });

    it('a refund to a broken jetton wallet bounces back to the Router: TRANSFER_BOUNCED event, no state change', async () => {
        const broken = await d.fake(eve, 1n);
        const sp = beginCell().storeUint(0xdeadbeef, 32).endCell();
        const res = await broken.send(eve.getSender(), { value: toNano('2') }, { $$type: 'FakeSend', to: d.router.address, value: toNano('1'), bounce: false,
            body: beginCell().store(storeJettonNotification({ $$type: 'JettonNotification', queryId: 0n, amount: 5n, sender: eve.address,
                forwardPayload: beginCell().storeBit(1).storeRef(sp).endCell().beginParse() })).endCell() });
        expect(refundCodes(res)).toEqual([CODES.BAD_PAYLOAD, CODES.TRANSFER_BOUNCED]);
    });
});

describe('security: huge amounts, tick spam, dust, round trips', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    let eve: SandboxContract<TreasuryContract>;
    let base: any;

    beforeAll(async () => {
        d = await Dex.create();
        eve = await d.chain.treasury('eve', { balance: toNano('1000000') });
        pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -600n, 600n, toNano('1000'), { sqrtPriceInit: Q96 }));
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('2^119-sized jetton deposits: mint above the per-tick cap refunds exactly; a 2^119 swap fills partially and stays solvent', async () => {
        const HUGE = 1n << 119n;
        expectNoFailures(await d.jA.send(d.admin.getSender(), { value: toNano('0.2') }, {
            $$type: 'TestMint', queryId: 0n, to: eve.address, amount: HUGE, responseDestination: d.admin.address, forwardTonAmount: 0n, forwardPayload: null,
        }));
        const sim = await simOf(pool);
        // Quotes never throw on the largest representable input.
        const q = await pool.getGetQuote(false, (1n << 120n) - 1n, 0n, 24n, 0n, true);
        expect(q.code).toBe(0n);
        expect(q.stop).toBe(BigInt(STOP.NO_LIQUIDITY));
        const mq = await pool.getGetMintQuote(-1200n, -600n, 0n, HUGE, 0n);
        expect(mq.code).toBe(BigInt(CODES.MATH_FAILURE)); // L above maxLiquidityPerTick
        let res = await d.mintJetton(d.jA, eve, HUGE, GRAM, -1200n, -600n, 0n);
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.MATH_FAILURE]);
        expect(await d.jBal(d.jA, eve.address)).toBe(HUGE);
        await expectPoolEquals(pool, sim);
        // Swap the whole 2^119 in: it empties the book above (NO_LIQUIDITY), the rest is refunded.
        const e = sim.swap(false, HUGE, 0n, 24, 0n, true, 0n, BigInt(d.now));
        expect(e.code).toBe(0);
        res = await d.swapJetton(d.jA, eve, HUGE, GRAM, { allowPartial: true });
        expectNoFailures(res);
        expect(swapEvents(res)[0].amountOut).toBe(e.out);
        expect(await d.jBal(d.jA, eve.address)).toBe(HUGE - e.consumed);
        await expectPoolEquals(pool, sim);
        await d.checkSolvency([pool]);
        // Not partial: refunded in full.
        res = await d.swapJetton(d.jA, eve, HUGE - e.consumed, GRAM);
        expect(refundCodes(res)).toEqual([CODES.NO_LIQUIDITY]);
    });

    it('tick spam: dust positions on every spacing cost a rent buffer each and only bound swaps to partial fills', async () => {
        // eve spams 40 single-spacing ranges at the minimum liquidity just below the price.
        const g0 = await d.gram(pool.address);
        expectNoFailures(await d.jA.send(d.admin.getSender(), { value: toNano('0.2') }, {
            $$type: 'TestMint', queryId: 0n, to: eve.address, amount: toNano('1000'), responseDestination: d.admin.address, forwardTonAmount: 0n, forwardPayload: null,
        }));
        // Below MIN_POSITION_LIQUIDITY is refused.
        let res: any = await d.mintJetton(d.jA, eve, 1n, GRAM, -120n, -60n, 0n);
        expect(refundCodes(res)).toEqual([CODES.LIQUIDITY_BELOW_MIN]);
        const st0 = await pool.getGetPoolState();
        for (let i = 1; i <= 40; i++) {
            const tU = BigInt(-60 * i);
            const tL = tU - 60n;
            // smallest amount that reaches MIN_POSITION_LIQUIDITY (1000)
            let amt = 1n;
            while ((await pool.getGetMintQuote(tL, tU, 0n, amt, 0n)).liquidity < 1000n) amt *= 2n;
            res = await d.mintJetton(d.jA, eve, amt, GRAM, tL, tU, 0n);
            expectNoFailures(res);
            expect(modifyEvents(res).length).toBe(1);
        }
        const st1 = await pool.getGetPoolState();
        const newTicks = st1.tickCount - st0.tickCount;
        expect(newTicks).toBeGreaterThanOrEqual(39n);
        // Each new tick keeps TICK_RENT_BUFFER (0.02) in the pool: spam costs real Gram.
        expect(await d.gram(pool.address) - g0).toBeGreaterThanOrEqual(newTicks * toNano('0.02') - toNano('0.01'));
        // A large sell now crosses dust ticks: bounded at 24 crossings, partial fill, gas < 1M; the next
        // swap continues; quote == execution throughout.
        const sim = await simOf(pool);
        const e = sim.swap(true, toNano('2000'), 0n, 24, 0n, true, 0n, BigInt(d.now));
        expect(e.stop).toBe(STOP.CROSSINGS);
        res = await d.swapNative(d.bob, toNano('2000'), d.tokA, { allowPartial: true });
        expectNoFailures(res);
        expect(swapEvents(res)[0].amountOut).toBe(e.out);
        expect(gasAt(res, pool.address, 0x4d480021)[0]).toBeLessThan(1_000_000n);
        await expectPoolEquals(pool, sim);
        const e2 = sim.swap(true, e.refund, 0n, 24, 0n, true, 0n, BigInt(d.now));
        res = await d.swapNative(d.bob, e.refund, d.tokA, { allowPartial: true });
        expectNoFailures(res);
        expect(swapEvents(res)[0].amountOut).toBe(e2.out);
        await expectPoolEquals(pool, sim);
    });

    it('dust: 1-unit swaps never change state; collecting with no fees pays nothing', async () => {
        const sim = await simOf(pool);
        for (let i = 0; i < 5; i++) {
            const res = await d.swapNative(d.bob, 1n, d.tokA);
            expect(refundCodes(res)).toEqual([CODES.ZERO_OUT]);
        }
        await expectPoolEquals(pool, sim);
        const pos = await d.position(pool, 0n);
        const res = await d.decrease(pos, d.alice, 0n);
        expectNoFailures(res);
        expect(modifyEvents(res)[0].fees0 + modifyEvents(res)[0].fees1).toBe(0n);
        expect(gramPayouts(res, d.alice.address).filter((x) => x.reason === REASON.POSITION_OUT)).toEqual([]);
        void events;
        void OP;
    });

    it('no round trip is profitable: swap out and back, or mint and burn immediately, never returns more', async () => {
        const R = [toNano('0.001'), toNano('1'), toNano('77'), toNano('400')];
        for (const x of R) {
            await d.chain.loadFrom(base);
            const j0 = await d.jBal(d.jA, eve.address);
            let res = await d.swapNative(eve, x, d.tokA);
            const out = swapEvents(res)[0].amountOut;
            expect(await d.jBal(d.jA, eve.address)).toBe(j0 + out);
            res = await d.swapJetton(d.jA, eve, out, GRAM);
            const back = swapEvents(res)[0].amountOut;
            expect(back).toBeLessThan(x);
        }
        // Mint then burn at once, in range and on each side.
        for (const [tL, tU] of [[-120n, 120n], [60n, 600n], [-600n, -60n]]) {
            await d.chain.loadFrom(base);
            expectNoFailures(await d.jA.send(d.admin.getSender(), { value: toNano('0.2') }, {
                $$type: 'TestMint', queryId: 0n, to: eve.address, amount: toNano('100'), responseDestination: d.admin.address, forwardTonAmount: 0n, forwardPayload: null,
            }));
            const res = await d.mintJetton(d.jA, eve, toNano('37'), GRAM, tL, tU, toNano('37'));
            expectNoFailures(res);
            const m = modifyEvents(res)[0];
            const pos = await d.position(pool, m.index);
            const r2 = await d.decrease(pos, eve, m.liquidityDelta);
            expectNoFailures(r2);
            const b = modifyEvents(r2)[0];
            expect(b.amount0 + b.fees0).toBeLessThanOrEqual(m.amount0);
            expect(b.amount1 + b.fees1).toBeLessThanOrEqual(m.amount1);
            expect(m.amount0 - b.amount0 + m.amount1 - b.amount1).toBeLessThanOrEqual(4n);
        }
        void M;
    });
});
