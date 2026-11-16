import { Address, beginCell, toNano } from '@ton/core';
import { internal } from '@ton/sandbox';
import {
    BPS, CODE_BAD_PAYLOAD, CODE_BAD_REF_BPS, CODE_BAD_TOKEN, CODE_DEADLINE, CODE_EMPTY_POOL, CODE_LOW_GAS,
    CODE_SAME_TOKEN, CODE_SLIPPAGE, CODE_ZERO_OUT, Dex, ERR, expectNoFailures, fees, GRAM, gramPayouts, JETTON_PAYOUT_VALUE,
    modelSwap, OP, opOf, Pool, readForwardFee, refundCodes, REASON_REFERRAL, REASON_SWAP_OUT, REASON_SWAP_REFUND,
    ROUTER_REFUND_MIN, storeSwapNative, SWAP_GAS, swapEvents, txsBetween,
} from './helpers';
import { SandboxContract } from '@ton/sandbox';

// Swaps in all three directions: Gram -> jetton, jetton -> Gram, jetton -> jetton.
// Every successful swap is checked against an independent x*y=k model with fees.

describe('swaps', () => {
    let d: Dex;
    let native: SandboxContract<Pool>;   // (GRAM, A): 1000 Gram : 5,000,000 A
    let jj: SandboxContract<Pool>;       // (A, B):   1,000,000 A : 4,000,000 B
    let exact = true;                    // false when a test deliberately strands jettons in the Router
    let extra: SandboxContract<Pool>[] = [];

    beforeEach(async () => {
        exact = true;
        extra = [];
        d = await Dex.create();
        native = await d.seedNative(d.jA, toNano('1000'), toNano('5000000'));
        jj = await d.seedJJ(d.jA, toNano('1000000'), d.jB, toNano('4000000'));
    });

    afterEach(async () => {
        await d.checkSolvency([native, jj, ...extra], exact);
    });

    async function reservesOf(p: SandboxContract<Pool>) {
        return p.getGetPoolData();
    }

    describe('Gram -> jetton', () => {
        it('pays exactly the model output, updates reserves and accrues the protocol fee', async () => {
            const before = await reservesOf(native);
            const amountIn = toNano('37.123456789');
            const m = modelSwap(amountIn, before.reserve0, before.reserve1, 25n, 5n, 0n);
            const q = await native.getGetExpectedOut(GRAM, amountIn, 0n);
            expect(q.amountOut).toBe(m.amountOut);
            expect(q.protocolFee).toBe(m.protocolFee);
            const bobA = await d.jBal(d.jA, d.bob.address);
            const res = await d.swapNative(d.bob, amountIn, d.tokA, { minOut: m.amountOut });
            fees(res, 'swap Gram -> jetton');
            expectNoFailures(res);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA + m.amountOut);
            const after = await reservesOf(native);
            expect(after.reserve0).toBe(before.reserve0 + amountIn - m.protocolFee);
            expect(after.reserve1).toBe(before.reserve1 - m.amountOut);
            expect(after.protocolFee0).toBe(before.protocolFee0 + m.protocolFee);
            expect(after.protocolFee1).toBe(before.protocolFee1);
            expect(after.reserve0 * after.reserve1).toBeGreaterThanOrEqual(before.reserve0 * before.reserve1);
            const ev = swapEvents(res);
            expect(ev.length).toBe(1);
            expect(ev[0].amountOut).toBe(m.amountOut);
            expect(ev[0].inIsToken0).toBe(true);
        });

        it('pays the referral in Gram, exactly amountIn * refBps / BPS', async () => {
            const before = await reservesOf(native);
            const amountIn = toNano('10');
            const m = modelSwap(amountIn, before.reserve0, before.reserve1, 25n, 5n, 10n);
            const res = await d.swapNative(d.bob, amountIn, d.tokA, { minOut: m.amountOut, referral: d.carol.address, refBps: 10n });
            expectNoFailures(res);
            const ref = gramPayouts(res, d.carol.address);
            expect(ref.length).toBe(1);
            expect(ref[0].reason).toBe(Number(REASON_REFERRAL));
            expect(ref[0].amount).toBe(amountIn * 10n / BPS);
            expect(ref[0].value).toBe(amountIn * 10n / BPS);
            const after = await reservesOf(native);
            expect(after.reserve0).toBe(before.reserve0 + amountIn - m.protocolFee - m.refFee);
            expect(after.reserve1).toBe(before.reserve1 - m.amountOut);
        });

        it('ignores refBps when no referral address is given', async () => {
            const before = await reservesOf(native);
            const amountIn = toNano('10');
            const m = modelSwap(amountIn, before.reserve0, before.reserve1, 25n, 5n, 0n);
            const bobA = await d.jBal(d.jA, d.bob.address);
            const res = await d.swapNative(d.bob, amountIn, d.tokA, { referral: null, refBps: 10n });
            expectNoFailures(res);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA + m.amountOut);
        });

        it('rejects refBps above the cap (throws, Gram bounces back)', async () => {
            const res = await d.swapNative(d.bob, toNano('10'), d.tokA, { referral: d.carol.address, refBps: 11n });
            expect(res.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Fee above cap'] });
            expect(res.transactions).toHaveTransaction({ from: d.router.address, to: d.bob.address, inMessageBounced: true });
        });

        it('rejects an expired deadline, a zero amount, GRAM or a masterchain ask token, and low gas', async () => {
            const cases: [() => Promise<any>, string][] = [
                [() => d.swapNative(d.bob, toNano('1'), d.tokA, { deadline: BigInt(d.now - 1) }), 'Deadline'],
                [() => d.swapNative(d.bob, 0n, d.tokA), 'Invalid amount'],
                [() => d.swapNative(d.bob, toNano('1'), GRAM), 'Invalid token'],
                [() => d.swapNative(d.bob, toNano('1'), new Address(-1, d.tokA.hash)), 'Invalid token'],
                [() => d.swapNative(d.bob, toNano('1'), d.tokA, { gas: SWAP_GAS - 1n }), 'Insufficient TON attached'],
            ];
            for (const [f, err] of cases) {
                const res = await f();
                expect(res.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router[err] });
            }
        });

        it('succeeds with exactly the minimum value and throws one nanogram below', async () => {
            const amountIn = toNano('5');
            const fwdTon = toNano('0.05');
            const snap = d.snapshot();
            const send = (value: bigint) => d.router.send(d.bob.getSender(), { value }, {
                $$type: 'SwapNative', queryId: 1n, amount: amountIn, askToken: d.tokA, minOut: 1n, deadline: d.deadline(),
                receiver: d.carol.address, refundTo: null, referral: d.carol.address, refBps: 10n, fwdTon,
                fwdPayload: beginCell().storeUint(7, 32).endCell(),
            });
            // Probe with plenty of value: the forward fee depends only on the body, not on the value.
            const probe = await send(toNano('100'));
            const rtx = txsBetween(probe, d.bob.address, d.router.address)[0];
            // The payload's forward fee on its remaining hops (DESIGN.md section 15).
            const payloadFee = await d.router.getGetPayloadFee(beginCell().storeUint(7, 32).endCell());
            const min = amountIn + SWAP_GAS + fwdTon + payloadFee + 2n * readForwardFee(rtx);
            await d.restore(snap);
            const ok = await send(min);
            fees(ok, 'swap Gram -> jetton at the exact minimum');
            expectNoFailures(ok);
            expect(ok.transactions).toHaveTransaction({ to: d.carol.address, op: OP.JettonNotification });
            await d.restore(snap);
            const low = await send(min - 1n);
            expect(low.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Insufficient TON attached'] });
        });

        it('refunds the Gram on slippage, leaving the pool unchanged', async () => {
            const before = await reservesOf(native);
            const q = await native.getGetExpectedOut(GRAM, toNano('10'), 0n);
            const res = await d.swapNative(d.bob, toNano('10'), d.tokA, { minOut: q.amountOut + 1n, refundTo: d.carol.address });
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([Number(CODE_SLIPPAGE)]);
            const p = gramPayouts(res, d.carol.address);
            expect(p.length).toBe(1);
            expect(p[0].reason).toBe(Number(REASON_SWAP_REFUND));
            expect(p[0].amount).toBe(toNano('10'));
            expect(p[0].value).toBeGreaterThan(toNano('10'));
            const after = await reservesOf(native);
            expect(after.reserve0).toBe(before.reserve0);
            expect(after.reserve1).toBe(before.reserve1);
            expect(after.protocolFee0).toBe(before.protocolFee0);
        });

        it('refunds at the pool when the deadline passes in flight (pool is authoritative)', async () => {
            const before = await reservesOf(native);
            const dl = d.deadline(10);
            const body = beginCell().store(storeSwapNative({
                $$type: 'SwapNative', queryId: 1n, amount: toNano('10'), askToken: d.tokA, minOut: 0n, deadline: dl,
                receiver: null, refundTo: null, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null,
            })).endCell();
            const iter = await d.chain.sendMessageIter(internal({ from: d.bob.address, to: d.router.address, value: toNano('10.5'), body }));
            const txs = [];
            let step = 0;
            for await (const tx of iter) {
                txs.push(tx);
                if (step++ === 0) d.chain.now = d.now + 60;   // the Router saw a valid deadline; the Pool will not
            }
            const res = { transactions: txs, events: [], externals: [] } as any;
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([Number(CODE_DEADLINE)]);
            expect(gramPayouts(res, d.bob.address)[0].amount).toBe(toNano('10'));
            expect((await reservesOf(native)).reserve0).toBe(before.reserve0);
        });

        it('refunds a swap into a pair that has no pool (deploys it empty, caller pays)', async () => {
            const res = await d.swapNative(d.bob, toNano('3'), d.tokC, { refundTo: d.carol.address });
            fees(res, 'swap into a missing pool');
            expectNoFailures(res);
            const p = await d.poolOf(GRAM, d.tokC);
            expect(res.transactions).toHaveTransaction({ to: p.address, deploy: true, success: true });
            expect(refundCodes(res)).toEqual([Number(CODE_EMPTY_POOL)]);
            expect(gramPayouts(res, d.carol.address)[0].amount).toBe(toNano('3'));
            const pd = await p.getGetPoolData();
            expect(pd.totalSupply).toBe(0n);
            expect(pd.reserve0).toBe(0n);
            expect(await d.gram(p.address)).toBeGreaterThanOrEqual(toNano('0.049'));
        });

        it('refunds a dust swap whose output rounds to zero', async () => {
            const res = await d.swapNative(d.bob, 1n, d.tokA);
            // 1 nanogram of Gram buys 4999 units of A at this price, so use a pool where it rounds to 0.
            expectNoFailures(res);
            const tiny = await d.seedJJ(d.jB, toNano('1000000'), d.jC, 2000n);
            const r2 = await d.swapJetton(d.jB, d.bob, 1000n, d.tokC);
            expectNoFailures(r2);
            expect(refundCodes(r2)).toEqual([Number(CODE_ZERO_OUT)]);
            extra.push(tiny);
        });

        it('delivers fwdTon and fwdPayload to the receiver of a jetton output', async () => {
            const payload = beginCell().storeUint(0xabcdef, 32).storeStringTail('hello').endCell();
            const res = await d.swapNative(d.bob, toNano('1'), d.tokA, { receiver: d.carol.address, fwdTon: toNano('0.05'), fwdPayload: payload });
            expectNoFailures(res);
            const n = txsBetween(res, null, d.carol.address).find((t) => opOf(t) === OP.JettonNotification)!;
            expect(n).toBeDefined();
            const b = n.inMessage!.body.beginParse();
            b.loadUint(32);
            b.loadUintBig(64);
            b.loadCoins();
            b.loadAddress();
            expect(b.loadBit()).toBe(true);
            expect(b.loadRef().equals(payload)).toBe(true);
            expect(n.inMessage!.info.type === 'internal' && n.inMessage!.info.value.coins).toBe(toNano('0.05'));
        });
    });

    describe('jetton -> Gram', () => {
        it('pays a GramPayout equal to the model output with the leftover gas', async () => {
            const before = await reservesOf(native);
            const amountIn = toNano('123456.789');
            const m = modelSwap(amountIn, before.reserve1, before.reserve0, 25n, 5n, 0n);
            expect((await native.getGetExpectedOut(d.tokA, amountIn, 0n)).amountOut).toBe(m.amountOut);
            const bobG = await d.gram(d.bob.address);
            const res = await d.swapJetton(d.jA, d.bob, amountIn, GRAM, { minOut: m.amountOut });
            fees(res, 'swap jetton -> Gram');
            expectNoFailures(res);
            const p = gramPayouts(res, d.bob.address);
            expect(p.length).toBe(1);
            expect(p[0].reason).toBe(Number(REASON_SWAP_OUT));
            expect(p[0].amount).toBe(m.amountOut);
            expect(p[0].value).toBeGreaterThan(m.amountOut);
            // Net Gram change: + out - (the 0.4 attached) + leftover gas.
            expect(await d.gram(d.bob.address)).toBeGreaterThan(bobG + m.amountOut - toNano('0.4'));
            const after = await reservesOf(native);
            expect(after.reserve1).toBe(before.reserve1 + amountIn - m.protocolFee);
            expect(after.reserve0).toBe(before.reserve0 - m.amountOut);
            expect(after.protocolFee1).toBe(before.protocolFee1 + m.protocolFee);
            expect(after.reserve0 * after.reserve1).toBeGreaterThanOrEqual(before.reserve0 * before.reserve1);
        });

        it('pays a jetton referral through a fixed-value PayTo', async () => {
            const before = await reservesOf(native);
            const amountIn = toNano('100000');
            const m = modelSwap(amountIn, before.reserve1, before.reserve0, 25n, 5n, 7n);
            const carolA = await d.jBal(d.jA, d.carol.address);
            const res = await d.swapJetton(d.jA, d.bob, amountIn, GRAM, { referral: d.carol.address, refBps: 7n, minOut: m.amountOut });
            expectNoFailures(res);
            expect(m.refFee).toBe(amountIn * 7n / BPS);
            expect(await d.jBal(d.jA, d.carol.address)).toBe(carolA + m.refFee);
            expect(gramPayouts(res, d.bob.address)[0].amount).toBe(m.amountOut);
            const after = await reservesOf(native);
            expect(after.reserve1).toBe(before.reserve1 + amountIn - m.protocolFee - m.refFee);
        });

        it('refunds refBps above the cap with BAD_REF_BPS', async () => {
            const bobA = await d.jBal(d.jA, d.bob.address);
            const res = await d.swapJetton(d.jA, d.bob, toNano('1000'), GRAM, { referral: d.carol.address, refBps: 11n });
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([Number(CODE_BAD_REF_BPS)]);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA);
        });

        it('refunds the jettons on slippage, deadline, same token and masterchain ask token', async () => {
            const q = await native.getGetExpectedOut(d.tokA, toNano('1000'), 0n);
            const cases: [any, bigint][] = [
                [{ minOut: q.amountOut + 1n, askToken: GRAM }, CODE_SLIPPAGE],
                [{ deadline: BigInt(d.now - 1), askToken: GRAM }, CODE_DEADLINE],
                [{ askToken: d.tokA }, CODE_SAME_TOKEN],
                [{ askToken: new Address(-1, d.tokB.hash) }, CODE_BAD_TOKEN],
            ];
            const bobA = await d.jBal(d.jA, d.bob.address);
            const before = await reservesOf(native);
            for (const [o, code] of cases) {
                const res = await d.swapJetton(d.jA, d.bob, toNano('1000'), o.askToken, o);
                expectNoFailures(res);
                expect(refundCodes(res)).toEqual([Number(code)]);
            }
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA);
            const after = await reservesOf(native);
            expect(after.reserve0).toBe(before.reserve0);
            expect(after.reserve1).toBe(before.reserve1);
        });

        it('refunds to the payload refundTo once the payload parsed', async () => {
            const carolA = await d.jBal(d.jA, d.carol.address);
            const res = await d.swapJetton(d.jA, d.bob, toNano('1000'), GRAM, { deadline: BigInt(d.now - 1), refundTo: d.carol.address });
            expectNoFailures(res);
            expect(await d.jBal(d.jA, d.carol.address)).toBe(carolA + toNano('1000'));
        });

        it('refunds with LOW_GAS between ROUTER_REFUND_MIN and the flow minimum, keeps below ROUTER_REFUND_MIN', async () => {
            const bobA = await d.jBal(d.jA, d.bob.address);
            const r1 = await d.swapJetton(d.jA, d.bob, toNano('1000'), GRAM, { gas: toNano('0.1') });
            expectNoFailures(r1);
            expect(refundCodes(r1)).toEqual([Number(CODE_LOW_GAS)]);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA);

            // Exactly ROUTER_REFUND_MIN still pays for the refund transfer.
            const r0 = await d.swapJetton(d.jA, d.bob, toNano('1000'), GRAM, { gas: ROUTER_REFUND_MIN });
            expectNoFailures(r0);
            expect(refundCodes(r0)).toEqual([Number(CODE_LOW_GAS)]);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA);

            // Below ROUTER_REFUND_MIN nothing can pay for a refund: documented user error, jettons stay.
            const r2 = await d.swapJetton(d.jA, d.bob, toNano('1000'), GRAM, { gas: ROUTER_REFUND_MIN - 1n });
            expectNoFailures(r2);
            expect(refundCodes(r2)).toEqual([Number(CODE_LOW_GAS)]);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA - toNano('1000'));
            expect(await d.routerHolds(d.tokA)).toBeGreaterThan(0n);
            // The stranded jettons are unaccounted: they do not change the pool.
            const pd = await reservesOf(native);
            expect(await d.routerHolds(d.tokA)).toBe(
                pd.reserve1 + pd.protocolFee1 + (await jj.getGetPoolData()).reserve0 + (await jj.getGetPoolData()).protocolFee0 + toNano('1000'));
            exact = false;
        });

        it('succeeds with exactly the minimum forward amount (referral case) and refunds one nanogram below', async () => {
            const snap = d.snapshot();
            const o = { referral: d.carol.address, refBps: 10n, receiver: d.carol.address, minOut: 1n };
            const probe = await d.swapJetton(d.jA, d.bob, toNano('1000'), GRAM, o);
            const rtx = probe.transactions.find((t) => t.inMessage?.info.dest instanceof Address &&
                t.inMessage.info.dest.equals(d.router.address) && opOf(t) === OP.JettonNotification)!;
            const min = SWAP_GAS + JETTON_PAYOUT_VALUE + 2n * readForwardFee(rtx);
            await d.restore(snap);
            const ok = await d.swapJetton(d.jA, d.bob, toNano('1000'), GRAM, { ...o, gas: min });
            fees(ok, 'jetton -> Gram at the exact minimum');
            expectNoFailures(ok);
            expect(refundCodes(ok)).toEqual([]);
            expect(gramPayouts(ok, d.carol.address).find((p) => p.reason === Number(REASON_SWAP_OUT))).toBeDefined();
            await d.restore(snap);
            const low = await d.swapJetton(d.jA, d.bob, toNano('1000'), GRAM, { ...o, gas: min - 1n });
            expectNoFailures(low);
            expect(refundCodes(low)).toEqual([Number(CODE_LOW_GAS)]);
        });

        it('carries fwdPayload in GramPayout.payload', async () => {
            const payload = beginCell().storeUint(42, 32).endCell();
            const res = await d.swapJetton(d.jA, d.bob, toNano('1000'), GRAM, { receiver: d.carol.address, fwdPayload: payload });
            expectNoFailures(res);
            const p = gramPayouts(res, d.carol.address)[0];
            expect(p.payload!.equals(payload)).toBe(true);
        });

        it('refunds a jetton swap into a pair that has no pool, at the minimum gas', async () => {
            const snap = d.snapshot();
            const probe = await d.swapJetton(d.jC, d.bob, toNano('1000'), GRAM);
            const rtx = probe.transactions.find((t) => t.inMessage?.info.dest instanceof Address &&
                t.inMessage.info.dest.equals(d.router.address) && opOf(t) === OP.JettonNotification)!;
            const min = SWAP_GAS + 2n * readForwardFee(rtx);
            await d.restore(snap);
            const bobC = await d.jBal(d.jC, d.bob.address);
            const res = await d.swapJetton(d.jC, d.bob, toNano('1000'), GRAM, { gas: min });
            fees(res, 'jetton swap into a missing pool at the minimum');
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([Number(CODE_EMPTY_POOL)]);
            expect(await d.jBal(d.jC, d.bob.address)).toBe(bobC);
        });
    });

    describe('jetton -> jetton', () => {
        it('swaps A -> B and B -> A exactly as the model, with a referral and a third-party receiver', async () => {
            for (const [m, tIn, tOut] of [[d.jA, d.tokA, d.tokB], [d.jB, d.tokB, d.tokA]] as const) {
                const before = await reservesOf(jj);
                const inIs0 = before.token0.equals(tIn);
                const rIn = inIs0 ? before.reserve0 : before.reserve1;
                const rOut = inIs0 ? before.reserve1 : before.reserve0;
                const amountIn = toNano('7777.5');
                const mo = modelSwap(amountIn, rIn, rOut, 25n, 5n, 10n);
                expect((await jj.getGetExpectedOut(tIn, amountIn, 10n)).amountOut).toBe(mo.amountOut);
                const outMaster = d.masterOf(tOut);
                const carolOut = await d.jBal(outMaster, d.carol.address);
                const treasIn = await d.jBal(m, d.treasury.address);
                const res = await d.swapJetton(m, d.bob, amountIn, tOut, {
                    minOut: mo.amountOut, receiver: d.carol.address, referral: d.treasury.address, refBps: 10n,
                });
                fees(res, 'swap jetton -> jetton with referral');
                expectNoFailures(res);
                expect(await d.jBal(outMaster, d.carol.address)).toBe(carolOut + mo.amountOut);
                expect(await d.jBal(m, d.treasury.address)).toBe(treasIn + mo.refFee);
                const after = await reservesOf(jj);
                const rIn2 = inIs0 ? after.reserve0 : after.reserve1;
                const rOut2 = inIs0 ? after.reserve1 : after.reserve0;
                expect(rIn2).toBe(rIn + amountIn - mo.protocolFee - mo.refFee);
                expect(rOut2).toBe(rOut - mo.amountOut);
                expect((inIs0 ? after.protocolFee0 : after.protocolFee1) - (inIs0 ? before.protocolFee0 : before.protocolFee1)).toBe(mo.protocolFee);
                expect(rIn2 * rOut2).toBeGreaterThanOrEqual(rIn * rOut);
            }
        });

        it('refunds slippage in the input jetton', async () => {
            const q = await jj.getGetExpectedOut(d.tokA, toNano('100'), 0n);
            const bobA = await d.jBal(d.jA, d.bob.address);
            const res = await d.swapJetton(d.jA, d.bob, toNano('100'), d.tokB, { minOut: q.amountOut + 1n });
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([Number(CODE_SLIPPAGE)]);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA);
        });

        it('delivers fwdTon + fwdPayload with the output jetton', async () => {
            const payload = beginCell().storeUint(99, 32).endCell();
            const res = await d.swapJetton(d.jA, d.bob, toNano('100'), d.tokB, { receiver: d.carol.address, fwdTon: toNano('0.02'), fwdPayload: payload });
            expectNoFailures(res);
            const n = txsBetween(res, null, d.carol.address).find((t) => opOf(t) === OP.JettonNotification)!;
            expect(n).toBeDefined();
        });

        it('succeeds at the exact minimum with referral + fwdTon (worst case) and refunds one below', async () => {
            const payload = beginCell().storeUint(99, 32).endCell();
            const o = { receiver: d.carol.address, referral: d.treasury.address, refBps: 10n, fwdTon: toNano('0.03'), fwdPayload: payload, minOut: 1n };
            const snap = d.snapshot();
            const probe = await d.swapJetton(d.jA, d.bob, toNano('100'), d.tokB, o);
            const rtx = probe.transactions.find((t) => t.inMessage?.info.dest instanceof Address &&
                t.inMessage.info.dest.equals(d.router.address) && opOf(t) === OP.JettonNotification)!;
            const min = SWAP_GAS + o.fwdTon + JETTON_PAYOUT_VALUE + (await d.router.getGetPayloadFee(payload)) + 2n * readForwardFee(rtx);
            await d.restore(snap);
            const ok = await d.swapJetton(d.jA, d.bob, toNano('100'), d.tokB, { ...o, gas: min });
            fees(ok, 'jetton -> jetton worst case at the minimum');
            expectNoFailures(ok);
            expect(refundCodes(ok)).toEqual([]);
            expect(txsBetween(ok, null, d.carol.address).find((t) => opOf(t) === OP.JettonNotification)).toBeDefined();
            await d.restore(snap);
            const low = await d.swapJetton(d.jA, d.bob, toNano('100'), d.tokB, { ...o, gas: min - 1n });
            expectNoFailures(low);
            expect(refundCodes(low)).toEqual([Number(CODE_LOW_GAS)]);
        });

        it('refunds garbage payloads with BAD_PAYLOAD and returns the gas for a 0-amount notification', async () => {
            const bobA = await d.jBal(d.jA, d.bob.address);
            const bad = beginCell().storeBit(1).storeRef(beginCell().storeUint(0x4d470002, 32).storeUint(1, 8).endCell()).endCell().beginParse();
            const r = await d.sendJettons(d.jA, d.bob, toNano('5'), toNano('0.2'), bad);
            expectNoFailures(r);
            expect(refundCodes(r)).toEqual([Number(CODE_BAD_PAYLOAD)]);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA);

            // A 0-amount notification (the standard wallet allows it; here minted with amount 0).
            const r0 = await d.jA.send(d.admin.getSender(), { value: toNano('0.5') }, {
                $$type: 'TestMint', queryId: 0n, to: d.router.address, amount: 0n, responseDestination: d.admin.address,
                forwardTonAmount: toNano('0.3'), forwardPayload: d.swapPayload(GRAM),
            });
            // The excess goes to msg.sender, here the test master, which has no JettonExcesses receiver.
            expectNoFailures(r0, (tx) => tx.inMessage?.info.dest instanceof Address && tx.inMessage.info.dest.equals(d.jA.address));
            expect(refundCodes(r0)).toEqual([Number(CODE_BAD_PAYLOAD)]);
            const back = txsBetween(r0, d.router.address, d.jA.address);
            expect(back.length).toBe(1);
            expect(opOf(back[0])).toBe(OP.JettonExcesses);
        });
    });
});
