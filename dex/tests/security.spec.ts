import { Address, beginCell, Cell, contractAddress, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import {
    CODE_BAD_TOKEN, CODE_EMPTY_POOL, CODE_LOW_GAS, CODE_OVERFLOW, CODE_TRANSFER_BOUNCED, Dex, ERR, expectNoFailures,
    FakeJettonWallet, fees, GRAM, gramPayouts, MAX_COINS, modelSwap, Pool, refundCodes, storeCbAddLiquidity, storeCbRefund,
    storeJettonNotification, storeJettonTransferInternal, storeLpAccountDeposit, storeLpBurnNotification, storePayTo,
    storePoolCollectFees, storePoolProvide, storePoolSetFees, storePoolSwap, SWAP_GAS, txOk, rng, OP,
} from './helpers';

// Spoofing, forged internal messages, donations, overflow, bounces, dust and griefing.

describe('security', () => {
    let d: Dex;
    let native: SandboxContract<Pool>;
    let jj: SandboxContract<Pool>;
    let mallory: SandboxContract<TreasuryContract>;
    let fake: SandboxContract<FakeJettonWallet>;

    beforeEach(async () => {
        d = await Dex.create();
        native = await d.seedNative(d.jA, toNano('1000'), toNano('5000000'));
        jj = await d.seedJJ(d.jA, toNano('1000000'), d.jB, toNano('4000000'));
        mallory = await d.chain.treasury('mallory', { balance: toNano('100000') });
        fake = await d.fake(mallory);
    });

    afterEach(async () => {
        await d.checkSolvency([native, jj]);
    });

    function notification(amount: bigint, sender: Address, payload: Cell, inline = false) {
        return beginCell().store(storeJettonNotification({
            $$type: 'JettonNotification', queryId: 0n, amount, sender,
            forwardPayload: inline
                ? beginCell().storeBit(0).storeSlice(payload.beginParse()).endCell().beginParse()
                : beginCell().storeBit(1).storeRef(payload).endCell().beginParse(),
        })).endCell();
    }

    // Exit code of the transaction that `from` sent to `to`, which must have failed.
    function expectRejected(res: any, from: Address, to: Address, err: number) {
        expect(res.transactions).toHaveTransaction({ from, to, success: false, exitCode: err });
    }

    async function snapshotState() {
        return {
            native: await native.getGetPoolData(),
            jj: await jj.getGetPoolData(),
            a: await d.routerHolds(d.tokA),
            b: await d.routerHolds(d.tokB),
            nativeGram: await d.gram(native.address),
        };
    }

    function expectUnchanged(x: any, y: any) {
        for (const k of ['reserve0', 'reserve1', 'totalSupply', 'protocolFee0', 'protocolFee1']) {
            expect(y.native[k]).toBe(x.native[k]);
            expect(y.jj[k]).toBe(x.jj[k]);
        }
        expect(y.a).toBe(x.a);
        expect(y.b).toBe(x.b);
    }

    describe('fake jetton notifications', () => {
        it('a 1e30 notification from a fake wallet cannot touch real pools or Router wallets', async () => {
            const before = await snapshotState();
            const huge = 10n ** 30n;
            for (const ask of [d.tokA, GRAM, d.tokB]) {
                const res = await d.fakeSend(fake, mallory, d.router.address,
                    notification(huge, d.alice.address, d.swapPayload(ask, { receiver: mallory.address })));
                fees(res, 'fake swap');
                expectNoFailures(res);
                expect(refundCodes(res)).toEqual([Number(CODE_EMPTY_POOL)]);
                // The pool the fake reached is keyed by the fake's own address.
                const fp = await d.poolOf(fake.address, ask);
                expect(res.transactions).toHaveTransaction({ to: fp.address, deploy: true });
                // Nothing was paid from a real wallet: the refund went back through the fake itself.
                expect(res.transactions).not.toHaveTransaction({ from: d.router.address, to: d.tokA });
                expect(res.transactions).not.toHaveTransaction({ from: d.router.address, to: d.tokB });
                expect(gramPayouts(res).length).toBe(0);
            }
            expectUnchanged(before, await snapshotState());
        });

        it('a fake deposit claiming to be alice cannot complete alice\'s pending deposit in a real pool', async () => {
            const fresh = await d.poolOf(GRAM, d.tokC);
            expectNoFailures(await d.provideNative(d.alice, toNano('50'), d.tokC));
            const res = await d.fakeSend(fake, mallory, d.router.address,
                notification(10n ** 30n, d.alice.address, d.providePayload(GRAM, { lpReceiver: mallory.address })));
            expectNoFailures(res);
            // It reached LpAccount(Pool(GRAM, fake), alice), not LpAccount(Pool(GRAM, C), alice).
            expect((await d.pending(fresh, d.alice.address)).pending0).toBe(toNano('50'));
            expect((await fresh.getGetPoolData()).totalSupply).toBe(0n);
            const fakePool = await d.poolOf(GRAM, fake.address);
            expect((await d.pending(fakePool, d.alice.address)).pending1).toBe(10n ** 30n);
            expect(await d.lpBal(fresh, mallory.address)).toBe(0n);
        });

        it('a fake on the masterchain is refunded with BAD_TOKEN', async () => {
            const base = await FakeJettonWallet.fromInit(mallory.address, 2n);
            const mc = d.chain.openContract(new (FakeJettonWallet as any)(contractAddress(-1, base.init!), base.init) as FakeJettonWallet);
            await mc.send(mallory.getSender(), { value: toNano('100') }, null);
            const res = await d.fakeSend(mc, mallory, d.router.address, notification(1000n, mallory.address, d.swapPayload(GRAM)));
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([Number(CODE_BAD_TOKEN)]);
        });

        it('parses an inline (Either bit 0) payload', async () => {
            const res = await d.fakeSend(fake, mallory, d.router.address,
                notification(777n, mallory.address, d.providePayload(GRAM), true));
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([]);
            const fp = await d.poolOf(GRAM, fake.address);
            expect((await d.pending(fp, mallory.address)).pending1).toBe(777n);
        });

        it('a broken jetton wallet that bounces the Router\'s transfer: the Router keeps the Gram and logs it', async () => {
            const broken = await d.fake(mallory, 1n);   // odd salt: rejects JettonTransfer
            const res = await d.fakeSend(broken, mallory, d.router.address,
                notification(1000n, mallory.address, beginCell().storeUint(0xdead, 32).endCell()));
            // The fake's own rejection is the intended failure.
            expectNoFailures(res, (tx) => tx.inMessage!.info.dest instanceof Address && tx.inMessage!.info.dest.equals(broken.address));
            expect(res.transactions).toHaveTransaction({ from: broken.address, to: d.router.address, inMessageBounced: true, success: true });
            expect(refundCodes(res)).toContain(Number(CODE_TRANSFER_BOUNCED));
        });
    });

    describe('forged internal messages', () => {
        it('PayTo from a non-pool is rejected, whatever pair it claims', async () => {
            const before = await snapshotState();
            const payTo = (token0: Address, token1: Address, wallet: Address) => beginCell().store(storePayTo({
                $$type: 'PayTo', queryId: 0n, token0, token1, wallet, amount: toNano('1000'), to: mallory.address,
                excessTo: mallory.address, fwdTon: 0n, fwdPayload: null, reason: 1n,
            })).endCell();
            for (const [t0, t1, w] of [[GRAM, d.tokA, d.tokA], [d.tokA, d.tokB, d.tokB], [fake.address, d.tokA, d.tokA]]) {
                const res = await d.fakeSend(fake, mallory, d.router.address, payTo(t0, t1, w));
                expectRejected(res, fake.address, d.router.address, ERR.router['Not pool']);
            }
            expectUnchanged(before, await snapshotState());
        });

        it('Router-only pool messages are rejected', async () => {
            const before = await snapshotState();
            const bodies = [
                beginCell().store(storePoolSwap({
                    $$type: 'PoolSwap', queryId: 0n, fromUser: mallory.address, inIsToken0: false, amountIn: toNano('5000000'),
                    minOut: 0n, deadline: d.deadline(), receiver: mallory.address, refundTo: mallory.address, referral: null,
                    refBps: 0n, fwdTon: 0n, fwdPayload: null,
                })).endCell(),
                beginCell().store(storePoolProvide({
                    $$type: 'PoolProvide', queryId: 0n, user: mallory.address, amount0: toNano('1'), amount1: toNano('1000000'),
                    minLpOut: 0n, deadline: d.deadline(), lpReceiver: mallory.address, refundTo: mallory.address,
                    allowCreate: true, requireEmpty: false,
                })).endCell(),
                beginCell().store(storePoolSetFees({ $$type: 'PoolSetFees', queryId: 0n, lpFeeBps: 0n, protocolFeeBps: 0n, excessTo: mallory.address })).endCell(),
                beginCell().store(storePoolCollectFees({ $$type: 'PoolCollectFees', queryId: 0n, treasury: mallory.address, excessTo: mallory.address })).endCell(),
            ];
            for (const b of bodies) {
                const res = await d.fakeSend(fake, mallory, native.address, b, toNano('2'));
                expectRejected(res, fake.address, native.address, ERR.pool['Not router']);
            }
            expectUnchanged(before, await snapshotState());
        });

        it('CbAddLiquidity / CbRefund from a non-LpAccount are rejected', async () => {
            const before = await snapshotState();
            for (const user of [mallory.address, d.alice.address, fake.address]) {
                const add = beginCell().store(storeCbAddLiquidity({
                    $$type: 'CbAddLiquidity', queryId: 0n, user, amount0: toNano('1000'), amount1: toNano('1000000'),
                    minLpOut: 0n, lpReceiver: mallory.address, refundTo: mallory.address, allowCreate: true,
                })).endCell();
                const ref = beginCell().store(storeCbRefund({ $$type: 'CbRefund', queryId: 0n, user, amount0: toNano('500'), amount1: toNano('1000000') })).endCell();
                for (const b of [add, ref]) {
                    const res = await d.fakeSend(fake, mallory, native.address, b);
                    expectRejected(res, fake.address, native.address, ERR.pool['Not LP account']);
                }
            }
            expectUnchanged(before, await snapshotState());
        });

        it('LpBurnNotification from a non-LpWallet is rejected', async () => {
            const before = await snapshotState();
            const b = beginCell().store(storeLpBurnNotification({
                $$type: 'LpBurnNotification', queryId: 0n, amount: 10n ** 12n, sender: d.alice.address, responseDestination: mallory.address, customPayload: null,
            })).endCell();
            const res = await d.fakeSend(fake, mallory, native.address, b);
            expectRejected(res, fake.address, native.address, ERR.pool['Not LP wallet']);
            expectUnchanged(before, await snapshotState());
        });

        it('LpAccountDeposit from a non-pool and forged LP mints are rejected', async () => {
            expectNoFailures(await d.provideNative(d.alice, toNano('5'), d.tokC));
            const fresh = await d.poolOf(GRAM, d.tokC);
            const acc = await d.lpAccount(fresh, d.alice.address);
            const dep = beginCell().store(storeLpAccountDeposit({
                $$type: 'LpAccountDeposit', queryId: 0n, amount0: 0n, amount1: toNano('1000000'), minLpOut: 0n,
                lpReceiver: mallory.address, refundTo: mallory.address, allowCreate: true, isNative: true,
            })).endCell();
            const r1 = await d.fakeSend(fake, mallory, acc.address, dep);
            expectRejected(r1, fake.address, acc.address, ERR.lpAccount['Not pool']);
            expect((await acc.getGetLpAccountData()).pending1).toBe(0n);

            // Forged mint into mallory's LP wallet, claiming to come from the pool or from alice's wallet.
            // Give mallory a real LP wallet (1 unit) so the forged messages reach deployed code.
            expectNoFailures(await d.transferLp(native, d.alice, mallory.address, 1n));
            const lw = await d.lpWallet(native, mallory.address);
            for (const sender of [native.address, d.alice.address]) {
                const mint = beginCell().store(storeJettonTransferInternal({
                    $$type: 'JettonTransferInternal', queryId: 0n, amount: 10n ** 15n, sender, responseDestination: null,
                    forwardTonAmount: 0n, forwardPayload: beginCell().storeBit(0).endCell().beginParse(),
                })).endCell();
                const r = await d.fakeSend(fake, mallory, lw.address, mint);
                expectRejected(r, fake.address, lw.address, ERR.lpWallet['Not LP wallet']);
            }
            expect(await d.lpBal(native, mallory.address)).toBe(1n);
        });
    });

    describe('donations', () => {
        it('direct Gram and jetton donations change neither the reserves nor the quotes', async () => {
            const q0 = await native.getGetExpectedOut(GRAM, toNano('10'), 0n);
            const q1 = await native.getGetExpectedLp(toNano('10'), toNano('50000'));
            const b0 = await native.getGetExpectedBurn(10n ** 12n);
            const before = await native.getGetPoolData();
            const gBefore = await d.gram(native.address);
            expectNoFailures(await mallory.send({ to: native.address, value: toNano('500'), bounce: false }));
            // Jettons straight into the Router's wallet without a notification.
            expectNoFailures(await d.sendJettons(d.jA, d.bob, toNano('777777'), 0n, beginCell().storeBit(0).endCell().beginParse()));
            const after = await native.getGetPoolData();
            expect(after.reserve0).toBe(before.reserve0);
            expect(after.reserve1).toBe(before.reserve1);
            expect(after.totalSupply).toBe(before.totalSupply);
            expect(await d.gram(native.address)).toBeGreaterThan(gBefore + toNano('499'));
            expect((await native.getGetExpectedOut(GRAM, toNano('10'), 0n)).amountOut).toBe(q0.amountOut);
            expect((await native.getGetExpectedLp(toNano('10'), toNano('50000'))).lp).toBe(q1.lp);
            expect((await native.getGetExpectedBurn(10n ** 12n)).out0).toBe(b0.out0);
            // The donated Gram is only storage buffer: a later swap still pays exactly the quote.
            const bobA = await d.jBal(d.jA, d.bob.address);
            expectNoFailures(await d.swapNative(d.bob, toNano('10'), d.tokA));
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA + q0.amountOut);
        });
    });

    describe('round trips', () => {
        it('swap A -> B -> A and Gram -> A -> Gram never return more than the input', async () => {
            const bobA = await d.jBal(d.jA, d.bob.address);
            const bobB = await d.jBal(d.jB, d.bob.address);
            expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('50000'), d.tokB));
            const gotB = (await d.jBal(d.jB, d.bob.address)) - bobB;
            expectNoFailures(await d.swapJetton(d.jB, d.bob, gotB, d.tokA));
            expect(await d.jBal(d.jA, d.bob.address)).toBeLessThan(bobA);

            const a0 = await d.jBal(d.jA, d.carol.address);
            const res = await d.swapNative(d.carol, toNano('77'), d.tokA);
            expectNoFailures(res);
            const gotA = (await d.jBal(d.jA, d.carol.address)) - a0;
            const r2 = await d.swapJetton(d.jA, d.carol, gotA, GRAM);
            expectNoFailures(r2);
            expect(gramPayouts(r2, d.carol.address)[0].amount).toBeLessThan(toNano('77'));
        });
    });

    describe('overflow (coins range)', () => {
        const HALF = 2n ** 119n;
        let f1: SandboxContract<FakeJettonWallet>;
        let f2: SandboxContract<FakeJettonWallet>;

        beforeEach(async () => {
            f1 = await d.fake(mallory, 10n);
            f2 = await d.fake(mallory, 12n);
        });

        it('LpAccount: 2^119 + 2^119 pending is refunded instead of stored', async () => {
            const send = () => d.fakeSend(f1, mallory, d.router.address, notification(HALF, mallory.address, d.providePayload(f2.address)), toNano('1'));
            expectNoFailures(await send());
            const res = await send();
            fees(res, 'LpAccount overflow refund');
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([Number(CODE_OVERFLOW)]);
            // The refund goes back out through f1 (the token id of that side).
            expect(res.transactions).toHaveTransaction({ from: d.router.address, to: f1.address, op: 0x0f8a7ea5 });
            const p = await d.poolOf(f1.address, f2.address);
            const pend = await d.pending(p, mallory.address);
            expect(pend.pending0 + pend.pending1).toBe(HALF);
        });

        it('Pool: a deposit that would take a reserve above 2^120 - 1 is refunded; a swap too', async () => {
            const provide = (f: SandboxContract<FakeJettonWallet>, other: Address, amount: bigint) =>
                d.fakeSend(f, mallory, d.router.address, notification(amount, mallory.address, d.providePayload(other)), toNano('1'));
            expectNoFailures(await provide(f1, f2.address, HALF));
            expectNoFailures(await provide(f2, f1.address, HALF));
            const p = await d.poolOf(f1.address, f2.address);
            let pd = await p.getGetPoolData();
            expect(pd.reserve0).toBe(HALF);
            expect(pd.totalSupply).toBe(HALF);

            expectNoFailures(await provide(f1, f2.address, HALF));
            const res = await provide(f2, f1.address, HALF);
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([Number(CODE_OVERFLOW)]);
            pd = await p.getGetPoolData();
            expect(pd.reserve0).toBe(HALF);
            expect(pd.reserve1).toBe(HALF);

            const swap = await d.fakeSend(f1, mallory, d.router.address, notification(MAX_COINS, mallory.address, d.swapPayload(f2.address)), toNano('1'));
            expectNoFailures(swap);
            expect(refundCodes(swap)).toEqual([Number(CODE_OVERFLOW)]);
            expect((await p.getGetPoolData()).reserve0).toBe(HALF);
        });
    });

    describe('dust and griefing', () => {
        it('a swap into a missing pair costs the caller: the deployed pool keeps its buffer from the caller\'s gas', async () => {
            const mBefore = await d.gram(mallory.address);
            const res = await d.swapNative(mallory, 1n, d.tokC, { gas: SWAP_GAS + toNano('0.01') });
            expectNoFailures(res);
            const p = await d.poolOf(GRAM, d.tokC);
            expect(await d.gram(p.address)).toBeGreaterThanOrEqual(toNano('0.049'));
            expect(mBefore - (await d.gram(mallory.address))).toBeGreaterThan(toNano('0.05'));
            expect(await d.gram(d.router.address)).toBeGreaterThanOrEqual(toNano('0.99'));   // the Router paid nothing
        });

        it('zero referral fee skips the referral payout', async () => {
            const res = await d.swapNative(d.bob, 999n, d.tokA, { referral: d.carol.address, refBps: 10n });
            expectNoFailures(res);
            expect(gramPayouts(res, d.carol.address).length).toBe(0);
        });

        it('a huge fwdPayload with too little gas is refunded cleanly', async () => {
            let big = beginCell().storeBuffer(Buffer.alloc(127, 1)).endCell();
            for (let i = 0; i < 6; i++) {
                big = beginCell().storeBuffer(Buffer.alloc(127, i)).storeRef(big).storeRef(big).storeRef(big).storeRef(big).endCell();
            }
            const bobA = await d.jBal(d.jA, d.bob.address);
            const res = await d.swapJetton(d.jA, d.bob, toNano('10'), GRAM, { fwdPayload: big, gas: SWAP_GAS + toNano('0.001') });
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([Number(CODE_LOW_GAS)]);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA);
        });

        it('k never decreases over 200 alternating tiny swaps (and dust that rounds to 0 is refunded)', async () => {
            const r = rng(7);
            let pd = await native.getGetPoolData();
            let k = pd.reserve0 * pd.reserve1;
            for (let i = 0; i < 200; i++) {
                const res = i % 2 === 0
                    ? await d.swapNative(d.bob, BigInt(r.int(1, 2000)), d.tokA)
                    : await d.swapJetton(d.jA, d.bob, BigInt(r.int(1, 2000)), GRAM);
                expect(res.transactions.every(txOk)).toBe(true);
                pd = await native.getGetPoolData();
                const k2 = pd.reserve0 * pd.reserve1;
                expect(k2).toBeGreaterThanOrEqual(k);
                k = k2;
            }
        }, 300_000);
    });
});

void modelSwap;
void OP;
