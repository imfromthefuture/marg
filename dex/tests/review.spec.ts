import { Address, beginCell, Cell, toNano } from '@ton/core';
import { internal, SandboxContract, TreasuryContract } from '@ton/sandbox';
import {
    Dex, ERR, expectNoFailures, GRAM, isqrt, modelAdd, OP, opOf, Pool, readForwardFee, refundCodes, rng, storeJettonNotification,
    storePayTo, SWAP_GAS, txsBetween,
} from './helpers';

// Regression tests for the external review (DESIGN.md section 15). Each describe block failed
// before its fix.

const CODE_BAD_PAYLOAD = 205;
const CODE_LOW_GAS = 204;
const CODE_BAD_RECIPIENT = 215;
const CODE_FWD_DROPPED = 216;

// A payload of `n` distinct full cells (a chain), so nothing is deduplicated.
function chainPayload(n: number): Cell {
    let c = beginCell().storeBuffer(Buffer.alloc(127, 0xee)).endCell();
    for (let i = 1; i < n; i++) {
        const b = Buffer.alloc(127, i & 0xff);
        b.writeUInt32BE(i, 0);
        c = beginCell().storeBuffer(b).storeRef(c).endCell();
    }
    return c;
}

// The reviewer's payload: a 4-ary tree of depth 5 with distinct full cells (1365 cells).
function treePayload(depth: number, ctr = { n: 0 }): Cell {
    const b = Buffer.alloc(127, 0x5a);
    b.writeUInt32BE(++ctr.n, 0);
    const cb = beginCell().storeBuffer(b);
    if (depth > 0) for (let i = 0; i < 4; i++) cb.storeRef(treePayload(depth - 1, ctr));
    return cb.endCell();
}

function notification(amount: bigint, sender: Address, payload: Cell) {
    return beginCell().store(storeJettonNotification({
        $$type: 'JettonNotification', queryId: 0n, amount, sender,
        forwardPayload: beginCell().storeBit(1).storeRef(payload).endCell().beginParse(),
    })).endCell();
}

describe('review: the Router can never be a recipient (finding 1, high)', () => {
    let d: Dex;
    let ab: SandboxContract<Pool>;
    let ac: SandboxContract<Pool>;
    let native: SandboxContract<Pool>;

    beforeEach(async () => {
        d = await Dex.create();
        ab = await d.seedJJ(d.jA, toNano('1000000'), d.jB, toNano('1000000'));
        ac = await d.seedJJ(d.jA, toNano('1000000'), d.jC, toNano('1000000'));
        native = await d.seedNative(d.jA, toNano('1000'), toNano('1000000'));
    });

    afterEach(async () => {
        await d.checkSolvency([ab, ac, native], true);
    });

    async function routerLpAccountActive(a: Address, b: Address) {
        return d.isActive(await d.router.getGetLpAccountAddress(a, b, d.router.address));
    }

    it('refunds a "zap" swap whose receiver is the Router, so LpAccount(pool, Router) is never filled', async () => {
        const aliceC = await d.jBal(d.jC, d.alice.address);
        const zap = d.providePayload(d.tokB, { lpReceiver: d.alice.address });
        const res = await d.swapJetton(d.jC, d.alice, toNano('10000'), d.tokA,
            { receiver: d.router.address, fwdTon: toNano('0.5'), fwdPayload: zap });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODE_BAD_RECIPIENT]);
        expect(await d.jBal(d.jC, d.alice.address)).toBe(aliceC);
        expect(await routerLpAccountActive(d.tokA, d.tokB)).toBe(false);

        // The thief's half of the attack is refused the same way.
        const steal = d.providePayload(d.tokA, { lpReceiver: d.bob.address });
        const res2 = await d.swapJetton(d.jC, d.bob, toNano('1'), d.tokB,
            { receiver: d.router.address, fwdTon: toNano('0.5'), fwdPayload: steal });
        expectNoFailures(res2);
        expect(refundCodes(res2)).toEqual([CODE_BAD_RECIPIENT]);
        expect(await routerLpAccountActive(d.tokA, d.tokB)).toBe(false);

        // Into a native pool: nothing is parked where it could never be completed or refunded.
        const res3 = await d.swapJetton(d.jC, d.alice, toNano('10000'), d.tokA,
            { receiver: d.router.address, fwdTon: toNano('0.5'), fwdPayload: d.providePayload(GRAM) });
        expectNoFailures(res3);
        expect(refundCodes(res3)).toEqual([CODE_BAD_RECIPIENT]);
        expect(await routerLpAccountActive(GRAM, d.tokA)).toBe(false);
        expect(await d.jBal(d.jC, d.alice.address)).toBe(aliceC);
    });

    it('a refundTo or referral equal to the Router is refused; the refund goes to the jetton sender', async () => {
        const aliceA = await d.jBal(d.jA, d.alice.address);
        for (const o of [{ refundTo: d.router.address }, { referral: d.router.address, refBps: 10n },
            { refundTo: d.router.address, deadline: BigInt(d.now - 1) }]) {
            const res = await d.swapJetton(d.jA, d.alice, toNano('100'), d.tokB, o);
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([CODE_BAD_RECIPIENT]);
            expect(await d.jBal(d.jA, d.alice.address)).toBe(aliceA);
        }
    });

    it('one-sided and dual jetton deposits with lpReceiver or refundTo = Router are refunded to the sender', async () => {
        const aliceA = await d.jBal(d.jA, d.alice.address);
        for (const o of [{ lpReceiver: d.router.address }, { refundTo: d.router.address }]) {
            const res = await d.provideJetton(d.jA, d.alice, toNano('100'), d.tokB, o);
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([CODE_BAD_RECIPIENT]);
            expect(await d.jBal(d.jA, d.alice.address)).toBe(aliceA);
            expect(await routerLpAccountActive(d.tokA, d.tokB)).toBe(false);
        }
        for (const o of [{ lpReceiver: d.router.address }, { refundTo: d.router.address }]) {
            const g0 = await d.gram(d.alice.address);
            const res = await d.provideBoth(d.jA, d.alice, toNano('100'), toNano('10'), o);
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([CODE_BAD_RECIPIENT]);
            expect(await d.jBal(d.jA, d.alice.address)).toBe(aliceA);
            // The Gram leg came back too (only fees were spent).
            expect(g0 - (await d.gram(d.alice.address))).toBeLessThan(toNano('0.2'));
        }
    });

    it('native entries throw "Invalid recipient" for any Router-addressed field', async () => {
        const err = ERR.router['Invalid recipient'];
        expect(err).toBeDefined();
        const r = d.router.address;
        for (const o of [{ receiver: r }, { refundTo: r }, { referral: r, refBps: 5n }]) {
            const res = await d.swapNative(d.bob, toNano('1'), d.tokA, o);
            expect(res.transactions).toHaveTransaction({ to: r, success: false, exitCode: err });
        }
        for (const o of [{ lpReceiver: r }, { refundTo: r }]) {
            const res = await d.provideNative(d.bob, toNano('1'), d.tokA, o);
            expect(res.transactions).toHaveTransaction({ to: r, success: false, exitCode: err });
        }
    });

    it('a notification that claims sender = Router is never routed into a pool', async () => {
        const mallory = await d.chain.treasury('mallory', { balance: toNano('1000') });
        const fake = await d.fake(mallory);
        const pool = await d.router.getGetPoolAddress(fake.address, d.tokB);
        const res = await d.fakeSend(fake, mallory, d.router.address,
            notification(toNano('1000'), d.router.address, d.providePayload(d.tokB)));
        expect(refundCodes(res)).toEqual([CODE_BAD_RECIPIENT]);
        expect(res.transactions).not.toHaveTransaction({ from: d.router.address, to: pool });
        expect(await d.isActive(pool)).toBe(false);
    });

    it('the treasury can never be set to the Router', async () => {
        const res = await d.router.send(d.admin.getSender(), { value: toNano('0.1') },
            { $$type: 'SetTreasury', queryId: 0n, treasury: d.router.address });
        expect(res.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Invalid recipient'] });
    });
});

describe('review: forward payloads are budgeted per hop and capped (finding 2, medium)', () => {
    let d: Dex;
    let ab: SandboxContract<Pool>;
    let native: SandboxContract<Pool>;

    beforeEach(async () => {
        d = await Dex.create();
        ab = await d.seedJJ(d.jA, toNano('1000000'), d.jB, toNano('1000000'));
        native = await d.seedNative(d.jA, toNano('1000'), toNano('1000000'));
    });

    const payloadFee = (p: Cell | null) => d.router.getGetPayloadFee(p);

    it('the reviewer\'s 1365-cell payload at 0.42 TON is refunded before the pool moves', async () => {
        const before = await ab.getGetPoolData();
        const aliceA = await d.jBal(d.jA, d.alice.address);
        const big = treePayload(5);
        expect(await payloadFee(big)).toBe(-1n);
        for (const gas of ['0.42', '0.52', '2']) {
            const res = await d.swapJetton(d.jA, d.alice, toNano('1000'), d.tokB,
                { fwdTon: toNano('0.01'), fwdPayload: big, gas: toNano(gas), walletValue: toNano('1') });
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([CODE_BAD_PAYLOAD]);
            expect(await d.jBal(d.jA, d.alice.address)).toBe(aliceA);
        }
        const after = await ab.getGetPoolData();
        expect(after.reserve0).toBe(before.reserve0);
        expect(after.reserve1).toBe(before.reserve1);
        await d.checkSolvency([ab, native], true);

        const res = await d.swapNative(d.bob, toNano('1'), d.tokA, { fwdTon: toNano('0.01'), fwdPayload: big, gas: toNano('2') });
        expect(res.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Payload too large'] });
    });

    for (const cells of [1, 8, 32]) {
        it(`a ${cells}-cell payload succeeds at exactly the minimum (jetton -> jetton) and refunds one below`, async () => {
            const payload = chainPayload(cells);
            const fee = await payloadFee(payload);
            expect(fee).toBeGreaterThan(0n);
            const o = { receiver: d.carol.address, fwdTon: toNano('0.01'), fwdPayload: payload, minOut: 1n, walletValue: toNano('1') };
            const snap = d.snapshot();
            const probe = await d.swapJetton(d.jA, d.alice, toNano('1000'), d.tokB, o);
            const rtx = probe.transactions.find((t) => t.inMessage?.info.dest instanceof Address &&
                t.inMessage.info.dest.equals(d.router.address) && opOf(t) === OP.JettonNotification)!;
            const min = SWAP_GAS + o.fwdTon + fee + 2n * readForwardFee(rtx);
            await d.restore(snap);
            const ok = await d.swapJetton(d.jA, d.alice, toNano('1000'), d.tokB, { ...o, gas: min });
            expectNoFailures(ok);
            expect(refundCodes(ok)).toEqual([]);
            const n = txsBetween(ok, null, d.carol.address).find((t) => opOf(t) === OP.JettonNotification);
            expect(n).toBeDefined();
            await d.restore(snap);
            const low = await d.swapJetton(d.jA, d.alice, toNano('1000'), d.tokB, { ...o, gas: min - 1n });
            expectNoFailures(low);
            expect(refundCodes(low)).toEqual([CODE_LOW_GAS]);
            await d.checkSolvency([ab, native], true);
        });
    }

    it('a 32-cell payload succeeds at exactly the minimum for SwapNative and throws one below', async () => {
        const payload = chainPayload(32);
        const fee = await payloadFee(payload);
        const amountIn = toNano('5');
        const fwdTon = toNano('0.01');
        const send = (value: bigint) => d.router.send(d.bob.getSender(), { value }, {
            $$type: 'SwapNative', queryId: 1n, amount: amountIn, askToken: d.tokA, minOut: 1n, deadline: d.deadline(),
            receiver: d.carol.address, refundTo: null, referral: null, refBps: 0n, fwdTon, fwdPayload: payload,
        });
        const snap = d.snapshot();
        const probe = await send(toNano('100'));
        const rtx = txsBetween(probe, d.bob.address, d.router.address)[0];
        const min = amountIn + SWAP_GAS + fwdTon + fee + 2n * readForwardFee(rtx);
        await d.restore(snap);
        const ok = await send(min);
        expectNoFailures(ok);
        expect(ok.transactions).toHaveTransaction({ to: d.carol.address, op: OP.JettonNotification });
        await d.restore(snap);
        const low = await send(min - 1n);
        expect(low.transactions).toHaveTransaction({ to: d.router.address, success: false, exitCode: ERR.router['Insufficient TON attached'] });
    });

    it('an under-funded PayTo still delivers the jettons (without the notification) instead of bouncing them', async () => {
        // Simulates a pool whose payout value is too small for fwdTon + payload. Only the sandbox
        // can send as the pool, so the Router's wallet is debited without pool accounting here.
        const pd = await ab.getGetPoolData();
        const carolB = await d.jBal(d.jB, d.carol.address);
        const body = beginCell().store(storePayTo({
            $$type: 'PayTo', queryId: 9n, token0: pd.token0, token1: pd.token1, wallet: d.tokB, amount: toNano('1000'),
            to: d.carol.address, excessTo: d.carol.address, fwdTon: toNano('0.05'), fwdPayload: chainPayload(32), reason: 1n,
        })).endCell();
        const res = await d.chain.sendMessage(internal({ from: ab.address, to: d.router.address, value: toNano('0.1'), body, bounce: false }));
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODE_FWD_DROPPED]);
        expect(await d.jBal(d.jB, d.carol.address)).toBe(carolB + toNano('1000'));
        expect(res.transactions).not.toHaveTransaction({ to: d.carol.address, op: OP.JettonNotification });
    });
});

describe('review: add-liquidity rounding never donates a whole coarse unit (finding 3, low)', () => {
    let d: Dex;
    let p: SandboxContract<Pool>;

    beforeEach(async () => {
        d = await Dex.create();
        p = await d.seedNative(d.jA, toNano('1000'), 10n);
    });

    it('quotes and executes floor-then-ceil: 150 Gram + 2 units into 1000 Gram / 10 units', async () => {
        const pd = await p.getGetPoolData();
        expect(pd.totalSupply).toBe(isqrt(toNano('1000') * 10n));
        const q = await p.getGetExpectedLp(toNano('150'), 2n);
        expect(q.use1).toBe(1n);
        expect(q.use0).toBe(toNano('100'));
        expect(q.lp).toBe(316227n);

        const bobA = await d.jBal(d.jA, d.bob.address);
        const g0 = await d.gram(d.bob.address);
        const res = await d.provideBoth(d.jA, d.bob, 2n, toNano('150'));
        expectNoFailures(res);
        expect(await d.lpBal(p, d.bob.address)).toBe(316227n);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(bobA - 1n);
        // 100 Gram used; the other 50 came back with the gas.
        expect(g0 - (await d.gram(d.bob.address))).toBeLessThan(toNano('100.3'));
        const after = await p.getGetPoolData();
        expect(after.reserve0).toBe(toNano('1100'));
        expect(after.reserve1).toBe(11n);
        await d.checkSolvency([p], true);
    });

    it('getter equals the model and never short-changes the pool, on coarse and fine reserves', async () => {
        const r = rng(4242);
        const pd = await p.getGetPoolData();
        for (let i = 0; i < 60; i++) {
            const a0 = r.big(1n, toNano('5000'));
            const a1 = r.big(1n, 40n);
            const q = await p.getGetExpectedLp(a0, a1);
            const m = modelAdd(a0, a1, pd.reserve0, pd.reserve1, pd.totalSupply);
            expect(q.lp).toBe(m.lp);
            expect(q.use0).toBe(m.use0);
            expect(q.use1).toBe(m.use1);
            expect(q.use0).toBeLessThanOrEqual(a0);
            expect(q.use1).toBeLessThanOrEqual(a1);
            // The LP's pro-rata claim never exceeds what was taken from the depositor.
            expect((q.lp * pd.reserve0) / pd.totalSupply).toBeLessThanOrEqual(q.use0);
            expect((q.lp * pd.reserve1) / pd.totalSupply).toBeLessThanOrEqual(q.use1);
            // Off the pool ratio by less than one unit of the finer token, unless the rounded-up
            // counterpart is at least COARSE_UNITS (then the loss is below 1 ppm of it).
            if (q.lp > 0n) {
                const x = q.use0 * pd.reserve1 - q.use1 * pd.reserve0;
                const ax = x < 0n ? -x : x;
                const lim = pd.reserve0 < pd.reserve1 ? pd.reserve0 : pd.reserve1;
                const counterpart = x < 0n ? q.use1 : q.use0;
                expect(ax < lim || counterpart >= 1_000_000n).toBe(true);
            }
        }
    });
});
