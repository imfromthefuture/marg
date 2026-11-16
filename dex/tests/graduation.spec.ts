import { Address, beginCell, Cell, toNano } from '@ton/core';
import { SandboxContract } from '@ton/sandbox';
import {
    CODE_BAD_PAYLOAD, CODE_CREATION_PAUSED, CODE_DEADLINE, CODE_LOW_GAS, CODE_POOL_NOT_EMPTY, CODE_SLIPPAGE, Dex, ERR,
    expectNoFailures, fees, GRAM, gramPayouts, isqrt, OP, opOf, Pool, PROVIDE_BOTH_GAS, readForwardFee, refundCodes,
    storeProvideBothPayload,
} from './helpers';

// Graduation: a launchpad-like jetton master mints the pool tokens straight into the Router's
// wallet with a ProvideBothPayload; the Gram leg rides on the forward amount. LP goes to the
// zero address, refunds to the treasury.

describe('graduation', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    const g = toNano('800');
    const t = toNano('200000000');

    beforeEach(async () => {
        d = await Dex.create();
        pool = await d.poolOf(GRAM, d.tokC);
    });

    afterEach(async () => {
        await d.checkSolvency([pool], true);
    });

    // Built by hand, exactly as the launchpad would (it cannot use the TS helpers on-chain).
    function handPayload(gramAmount: bigint, o: { minLpOut?: bigint; deadline?: bigint; requireEmpty?: boolean; lpReceiver?: Address; refundTo?: Address } = {}) {
        return beginCell()
            .storeUint(0x4d470003, 32)
            .storeCoins(gramAmount)
            .storeCoins(o.minLpOut ?? 1n)
            .storeUint(o.deadline ?? d.deadline(), 32)
            .storeAddress(o.lpReceiver ?? GRAM)
            .storeAddress(o.refundTo ?? d.treasury.address)
            .storeBit(o.requireEmpty ?? true)
            .endCell();
    }

    async function graduate(payload: Cell, gram = g, amount = t, fwd = gram + toNano('0.3')) {
        return d.jC.send(d.admin.getSender(), { value: fwd + toNano('0.1') }, {
            $$type: 'TestMint', queryId: 9n, to: d.router.address, amount, responseDestination: d.treasury.address,
            forwardTonAmount: fwd, forwardPayload: payload,
        });
    }

    it('the hand-built payload equals the generated one and fits one cell', () => {
        const dl = d.deadline();
        const gen = beginCell().store(storeProvideBothPayload({
            $$type: 'ProvideBothPayload', gramAmount: g, minLpOut: 1n, deadline: dl, lpReceiver: GRAM,
            refundTo: d.treasury.address, requireEmpty: true,
        })).endCell();
        const hand = handPayload(g, { deadline: dl });
        expect(hand.equals(gen)).toBe(true);
        expect(hand.refs.length).toBe(0);
        expect(hand.bits.length).toBeLessThanOrEqual(1023);
    });

    it('creates the pool and locks all LP at the zero address', async () => {
        const res = await graduate(handPayload(g));
        fees(res, 'graduation');
        expectNoFailures(res);
        const pd = await pool.getGetPoolData();
        expect(pd.reserve0).toBe(g);
        expect(pd.reserve1).toBe(t);
        expect(pd.totalSupply).toBe(isqrt(g * t));
        expect(await d.lpBal(pool, GRAM)).toBe(isqrt(g * t) - 1000n);
        // Nobody can move it: the zero address cannot sign, and anyone else is "Not owner".
        const lw = await d.lpWallet(pool, GRAM);
        const r = await lw.send(d.bob.getSender(), { value: toNano('0.3') }, {
            $$type: 'JettonBurn', queryId: 0n, amount: 1n, responseDestination: null, customPayload: null,
        });
        expect(r.transactions).toHaveTransaction({ to: lw.address, success: false, exitCode: ERR.lpWallet['Not owner'] });
        // Trading starts immediately.
        expectNoFailures(await d.swapNative(d.bob, toNano('1'), d.tokC));
        expectNoFailures(await d.swapJetton(d.jC, d.bob, toNano('100000'), GRAM));
    });

    it('succeeds with exactly gramAmount + PROVIDE_BOTH_GAS + 2 * fwdFee, refunds one below', async () => {
        const payload = handPayload(g);
        const snap = d.snapshot();
        const probe = await graduate(payload);
        const rtx = probe.transactions.find((x) => opOf(x) === OP.JettonNotification &&
            x.inMessage!.info.dest instanceof Address && x.inMessage!.info.dest.equals(d.router.address))!;
        const min = g + PROVIDE_BOTH_GAS + 2n * readForwardFee(rtx);
        await d.restore(snap);
        const tBefore = await d.jBal(d.jC, d.treasury.address);
        const low = await graduate(payload, g, t, min - 1n);
        expectNoFailures(low);
        expect(refundCodes(low)).toEqual([Number(CODE_LOW_GAS)]);
        expect(await d.jBal(d.jC, d.treasury.address)).toBe(tBefore + t);
        // The Gram that did arrive goes back to the treasury as the refund's excess.
        expect(low.transactions).toHaveTransaction({ to: d.treasury.address, op: OP.JettonExcesses });
        await d.restore(snap);
        const ok = await graduate(payload, g, t, min);
        fees(ok, 'graduation at the exact minimum');
        expectNoFailures(ok);
        expect((await pool.getGetPoolData()).reserve0).toBe(g);
    });

    it('requireEmpty refunds both legs to the treasury when someone squatted the pool', async () => {
        // A squatter creates (GRAM, C) at a skewed price before graduation.
        expectNoFailures(await d.provideBoth(d.jC, d.bob, toNano('1000'), toNano('100')));
        const before = await pool.getGetPoolData();
        const tBefore = await d.jBal(d.jC, d.treasury.address);
        const res = await graduate(handPayload(g));
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([Number(CODE_POOL_NOT_EMPTY)]);
        expect(await d.jBal(d.jC, d.treasury.address)).toBe(tBefore + t);
        expect(gramPayouts(res, d.treasury.address)[0].amount).toBe(g);
        const after = await pool.getGetPoolData();
        expect(after.reserve0).toBe(before.reserve0);
        expect(after.totalSupply).toBe(before.totalSupply);
    });

    it('requireEmpty = false with a strict minLpOut also defeats a skewed squatter pool', async () => {
        expectNoFailures(await d.provideBoth(d.jC, d.bob, toNano('1000'), toNano('100')));
        const minLp = (isqrt(g * t) - 1000n) * 99n / 100n;
        const res = await graduate(handPayload(g, { requireEmpty: false, minLpOut: minLp }));
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([Number(CODE_SLIPPAGE)]);
    });

    it('a second graduation into its own pool is refunded', async () => {
        expectNoFailures(await graduate(handPayload(g)));
        const res = await graduate(handPayload(g));
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([Number(CODE_POOL_NOT_EMPTY)]);
        expect((await pool.getGetPoolData()).reserve0).toBe(g);
    });

    it('refunds to the treasury on gramAmount = 0, expired deadline and paused creation', async () => {
        const tBefore = await d.jBal(d.jC, d.treasury.address);
        const r1 = await graduate(handPayload(0n));
        expectNoFailures(r1);
        expect(refundCodes(r1)).toEqual([Number(CODE_BAD_PAYLOAD)]);
        const r2 = await graduate(handPayload(g, { deadline: BigInt(d.now - 1) }));
        expectNoFailures(r2);
        expect(refundCodes(r2)).toEqual([Number(CODE_DEADLINE)]);
        expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetCreationPaused', queryId: 0n, paused: true }));
        const r3 = await graduate(handPayload(g));
        expectNoFailures(r3);
        expect(refundCodes(r3)).toEqual([Number(CODE_CREATION_PAUSED)]);
        expect(gramPayouts(r3, d.treasury.address)[0].amount).toBe(g);
        expect(await d.jBal(d.jC, d.treasury.address)).toBe(tBefore + 3n * t);
        expect(await d.isActive(pool.address)).toBe(true);
        expect((await pool.getGetPoolData()).totalSupply).toBe(0n);
    });

    it('a forward amount that lies about gramAmount is refunded (Router credits only what arrived)', async () => {
        // The payload claims 800 Gram but only 1 Gram + gas arrives.
        const res = await graduate(handPayload(g), g, t, toNano('1.3'));
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([Number(CODE_LOW_GAS)]);
        expect(await d.isActive(pool.address)).toBe(false);
    });
});
