import { Address, toNano } from '@ton/core';
import { SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import {
    CODE_LP_BELOW_MIN, CODE_SLIPPAGE, CODE_ZERO_OUT, Dex, expectNoFailures, GRAM, modelAdd, modelBurn, modelSwap, Pool,
    PoolData, refundCodes, rng, swapEvents, TestJettonMaster,
} from './helpers';

// Randomized sequence of 200 operations with a fixed seed over three pools (two native, one
// jetton/jetton) and three users. After every operation:
//   - no transaction in the trace failed;
//   - every swap paid exactly the x*y=k model output (or was refunded for the modelled reason);
//   - k never decreases on a swap, and the value of one LP share (r0*r1/S^2) never decreases;
//   - the Router's jetton wallets hold exactly what pools and LpAccounts owe, and every native
//     pool holds its Gram reserve + protocol fee + storage buffer.

const SEED = 20261112;
const OPS = 200;

describe('invariants under a randomized op sequence', () => {
    it(`holds over ${OPS} ops (seed ${SEED})`, async () => {
        const d = await Dex.create();
        const r = rng(SEED);
        const nA = await d.seedNative(d.jA, toNano('2000'), toNano('8000000'));
        const nB = await d.seedNative(d.jB, toNano('500'), toNano('900000'), d.bob);
        const jj = await d.seedJJ(d.jA, toNano('3000000'), d.jB, toNano('700000'), d.carol);
        const pools = [nA, nB, jj];
        const users = [d.alice, d.bob, d.carol];
        const counts: Record<string, number> = {};
        const outcomes: Record<string, number> = {};

        const data = async (p: SandboxContract<Pool>) => p.getGetPoolData();
        const masterOf = (t: Address) => d.masterOf(t);

        const note = (k: string) => (outcomes[k] = (outcomes[k] ?? 0) + 1);

        async function swapOp(u: SandboxContract<TreasuryContract>, p: SandboxContract<Pool>, pre: PoolData) {
            const in0 = r.next() < 0.5;
            const rIn = in0 ? pre.reserve0 : pre.reserve1;
            const rOut = in0 ? pre.reserve1 : pre.reserve0;
            const amountIn = r.next() < 0.1 ? BigInt(r.int(1, 5000)) : r.big(1n, rIn / 15n);
            const useRef = r.next() < 0.4;
            const refBps = useRef ? BigInt(r.int(0, 10)) : 0n;
            const m = modelSwap(amountIn, rIn, rOut, pre.lpFeeBps, pre.protocolFeeBps, refBps);
            const mode = r.int(0, 3);   // 0: minOut 0, 1: exact quote, 2: quote + 1 (slippage), 3: half quote
            const minOut = mode === 0 ? 0n : mode === 1 ? m.amountOut : mode === 2 ? m.amountOut + 1n : m.amountOut / 2n;
            const tokenIn = in0 ? pre.token0 : pre.token1;
            const tokenOut = in0 ? pre.token1 : pre.token0;
            const o = { minOut, referral: useRef ? d.treasury.address : null, refBps, receiver: r.next() < 0.3 ? d.carol.address : null };
            const res = tokenIn.equals(GRAM)
                ? await d.swapNative(u, amountIn, tokenOut, o)
                : await d.swapJetton(masterOf(tokenIn), u, amountIn, tokenOut, o);
            expectNoFailures(res);
            const post = await data(p);
            if (m.amountOut === 0n) {
                expect(refundCodes(res)).toEqual([Number(CODE_ZERO_OUT)]);
                note('swap:zero-out');
            } else if (minOut > m.amountOut) {
                expect(refundCodes(res)).toEqual([Number(CODE_SLIPPAGE)]);
                note('swap:slippage');
            } else {
                const ev = swapEvents(res);
                expect(ev.length).toBe(1);
                expect(ev[0].amountOut).toBe(m.amountOut);
                expect(ev[0].protocolFee).toBe(m.protocolFee);
                expect(ev[0].refFee).toBe(m.refFee);
                const rIn2 = in0 ? post.reserve0 : post.reserve1;
                const rOut2 = in0 ? post.reserve1 : post.reserve0;
                expect(rIn2).toBe(rIn + amountIn - m.protocolFee - m.refFee);
                expect(rOut2).toBe(rOut - m.amountOut);
                expect(rIn2 * rOut2).toBeGreaterThanOrEqual(rIn * rOut);
                note('swap:ok');
            }
            if (m.amountOut === 0n || minOut > m.amountOut) {
                expect(post.reserve0).toBe(pre.reserve0);
                expect(post.reserve1).toBe(pre.reserve1);
            }
        }

        // Amounts near the pool ratio, skewed by a random factor.
        function depositAmounts(pre: PoolData) {
            const a0 = r.next() < 0.1 ? BigInt(r.int(1, 3000)) : r.big(1n, pre.reserve0 / 8n);
            const skew = BigInt(r.int(50, 200));
            const a1 = (a0 * pre.reserve1 * skew) / (pre.reserve0 * 100n) + 1n;
            return [a0, a1];
        }

        async function provideBothOp(u: SandboxContract<TreasuryContract>, p: SandboxContract<Pool>, pre: PoolData) {
            const [g, t] = depositAmounts(pre);
            const m = modelAdd(g, t, pre.reserve0, pre.reserve1, pre.totalSupply);
            const strict = r.int(0, 2);
            const minLpOut = strict === 0 ? 0n : strict === 1 ? m.lp : m.lp + 1n;
            const lpBefore = await d.lpBal(p, u.address);
            const res = await d.provideBoth(masterOf(pre.token1), u, t, g, { minLpOut });
            expectNoFailures(res);
            await checkAdd(res, p, pre, m, minLpOut, u, lpBefore, 'both');
        }

        async function twoStepOp(u: SandboxContract<TreasuryContract>, p: SandboxContract<Pool>, pre: PoolData) {
            const [a0, a1] = depositAmounts(pre);
            const m = modelAdd(a0, a1, pre.reserve0, pre.reserve1, pre.totalSupply);
            const minLpOut = r.next() < 0.2 ? m.lp + 1n : 0n;
            const lpBefore = await d.lpBal(p, u.address);
            const side0 = async (min: bigint) => pre.token0.equals(GRAM)
                ? d.provideNative(u, a0, pre.token1, { minLpOut: min })
                : d.provideJetton(masterOf(pre.token0), u, a0, pre.token1, { minLpOut: min });
            const side1 = async (min: bigint) => d.provideJetton(masterOf(pre.token1), u, a1, pre.token0, { minLpOut: min });
            const first0 = r.next() < 0.5;
            expectNoFailures(await (first0 ? side0(0n) : side1(0n)));
            const res = await (first0 ? side1(minLpOut) : side0(minLpOut));
            expectNoFailures(res);
            await checkAdd(res, p, pre, m, minLpOut, u, lpBefore, 'two-step');
            const pend = await d.pending(p, u.address);
            expect(pend.pending0 + pend.pending1).toBe(0n);
        }

        async function checkAdd(res: SendMessageResult, p: SandboxContract<Pool>, pre: PoolData,
                                m: { lp: bigint; use0: bigint; use1: bigint }, minLpOut: bigint,
                                u: SandboxContract<TreasuryContract>, lpBefore: bigint, kind: string) {
            const post = await data(p);
            if (m.lp === 0n) {
                expect(refundCodes(res)).toEqual([Number(CODE_LP_BELOW_MIN)]);
                note(`add-${kind}:below-min`);
            } else if (minLpOut > m.lp) {
                expect(refundCodes(res)).toEqual([Number(CODE_SLIPPAGE)]);
                note(`add-${kind}:slippage`);
            } else {
                expect(await d.lpBal(p, u.address)).toBe(lpBefore + m.lp);
                expect(post.reserve0).toBe(pre.reserve0 + m.use0);
                expect(post.reserve1).toBe(pre.reserve1 + m.use1);
                expect(post.totalSupply).toBe(pre.totalSupply + m.lp);
                note(`add-${kind}:ok`);
                return;
            }
            expect(post.reserve0).toBe(pre.reserve0);
            expect(post.reserve1).toBe(pre.reserve1);
            expect(post.totalSupply).toBe(pre.totalSupply);
        }

        async function burnOp(u: SandboxContract<TreasuryContract>, p: SandboxContract<Pool>, pre: PoolData) {
            const lp = await d.lpBal(p, u.address);
            if (lp === 0n) return note('burn:skip');
            const amt = r.next() < 0.2 ? lp : r.big(1n, lp);
            const m = modelBurn(amt, pre.reserve0, pre.reserve1, pre.totalSupply);
            if (m.out0 + m.out1 === 0n) return note('burn:dust-skip');
            const res = await d.burnLp(p, u, amt, { min0: m.out0, min1: m.out1 });
            expectNoFailures(res);
            const post = await data(p);
            expect(post.reserve0).toBe(pre.reserve0 - m.out0);
            expect(post.reserve1).toBe(pre.reserve1 - m.out1);
            expect(post.totalSupply).toBe(pre.totalSupply - amt);
            expect(await d.lpBal(p, u.address)).toBe(lp - amt);
            note('burn:ok');
        }

        for (let i = 0; i < OPS; i++) {
            const p = r.pick(pools);
            const u = r.pick(users);
            const pre = await data(p);
            const before = await Promise.all(pools.map(data));
            const kind = r.pick(['swap', 'swap', 'swap', 'swap', 'both', 'twostep', 'burn', 'burn', 'transfer', 'collect', 'fees', 'refund', 'donate']);
            counts[kind] = (counts[kind] ?? 0) + 1;
            switch (kind) {
                case 'swap': await swapOp(u, p, pre); break;
                case 'both':
                    if (pre.isNative) await provideBothOp(u, p, pre);
                    else await twoStepOp(u, p, pre);
                    break;
                case 'twostep': await twoStepOp(u, p, pre); break;
                case 'burn': await burnOp(u, p, pre); break;
                case 'transfer': {
                    const lp = await d.lpBal(p, u.address);
                    if (lp > 0n) {
                        const to = r.pick(users.filter((x) => x !== u));
                        const toBefore = await d.lpBal(p, to.address);
                        const amt = r.big(1n, lp);
                        expectNoFailures(await d.transferLp(p, u, to.address, amt));
                        expect(await d.lpBal(p, to.address)).toBe(toBefore + amt);
                        expect(await d.lpBal(p, u.address)).toBe(lp - amt);
                    }
                    break;
                }
                case 'collect': {
                    const res = await d.router.send(u.getSender(), { value: toNano('0.2') }, {
                        $$type: 'CollectProtocolFees', queryId: 0n, tokenA: pre.token1, tokenB: pre.token0,
                    });
                    expectNoFailures(res);
                    const post = await data(p);
                    expect(post.protocolFee0 + post.protocolFee1).toBe(0n);
                    expect(post.reserve0).toBe(pre.reserve0);
                    expect(post.reserve1).toBe(pre.reserve1);
                    break;
                }
                case 'fees': {
                    const lpF = BigInt(r.int(0, 100));
                    const prF = BigInt(r.int(0, 50));
                    expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, {
                        $$type: 'SetPoolFees', queryId: 0n, tokenA: pre.token0, tokenB: pre.token1, lpFeeBps: lpF, protocolFeeBps: prF,
                    }));
                    const post = await data(p);
                    expect([post.lpFeeBps, post.protocolFeeBps]).toEqual([lpF, prF]);
                    break;
                }
                case 'refund': {
                    // One-sided deposit, then take it back.
                    const amt = r.big(1n, toNano('50'));
                    const res = pre.isNative
                        ? await d.provideNative(u, amt, pre.token1)
                        : await d.provideJetton(masterOf(pre.token1), u, amt, pre.token0);
                    expectNoFailures(res);
                    const acc = await d.lpAccount(p, u.address);
                    expectNoFailures(await acc.send(u.getSender(), { value: toNano('0.2') }, { $$type: 'LpAccountRefund', queryId: 0n }));
                    const pend = await acc.getGetLpAccountData();
                    expect(pend.pending0 + pend.pending1).toBe(0n);
                    break;
                }
                case 'donate':
                    expectNoFailures(await u.send({ to: p.address, value: toNano(r.int(1, 20)), bounce: false }));
                    break;
            }

            // Share value never decreases, for every pool (only this op's pool can have changed).
            const after = await Promise.all(pools.map(data));
            for (let j = 0; j < pools.length; j++) {
                const a = before[j];
                const b = after[j];
                expect(b.reserve0 * b.reserve1 * a.totalSupply * a.totalSupply)
                    .toBeGreaterThanOrEqual(a.reserve0 * a.reserve1 * b.totalSupply * b.totalSupply);
                if (j !== pools.indexOf(p)) {
                    expect(b.reserve0).toBe(a.reserve0);
                    expect(b.reserve1).toBe(a.reserve1);
                }
            }
            await d.checkSolvency(pools, true);
        }
        // eslint-disable-next-line no-console
        console.log('op mix', counts, 'outcomes', outcomes);
        // The run must actually have exercised the interesting branches.
        expect(outcomes['swap:ok']).toBeGreaterThan(20);
        expect(outcomes['swap:slippage']).toBeGreaterThan(3);
        expect((outcomes['add-both:ok'] ?? 0) + (outcomes['add-two-step:ok'] ?? 0)).toBeGreaterThan(5);
        expect(outcomes['burn:ok']).toBeGreaterThan(5);
    }, 900_000);
});
void TestJettonMaster;
