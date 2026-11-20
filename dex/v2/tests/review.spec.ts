// Regression tests for the external review findings (DESIGN.md §15.7). Each test reproduces the
// reported scenario and asserts the fixed behaviour; every test failed (or could not be written)
// against the pre-review code.

import { Address, beginCell, ExternalAddress, toNano } from '@ton/core';
import { SandboxContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, CODES, STOP, Pool, expectNoFailures, modifyEvents, refundCodes, swapEvents, simOf, expectPoolEquals,
    failedAt, extCell, txOk, storeNftTransfer, initEvents, MintAccount, storeJettonNotification,
} from './helpers';
import * as M from './model';

jest.setTimeout(900000);

const EXT = new ExternalAddress(0x1234n, 16) as unknown as Address;     // addr_extern
const BAD_WC = new Address(5, Buffer.alloc(32, 7));                     // workchain that does not exist

const actionFailures = (res: { transactions: any[] }) =>
    res.transactions.filter((tx) => tx.description.type === 'generic' && tx.description.actionPhase && !tx.description.actionPhase.success);

describe('finding 1: a PoolBurn can never leave the Position busy', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    let base: any;

    beforeAll(async () => {
        d = await Dex.create();
        pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('100'), GRAM, -600n, 600n, toNano('100'), { sqrtPriceInit: Q96 }));
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('addr_extern / non-existent workchain recipient: refused by the Position, nothing stuck, a valid decrease then works', async () => {
        const pos = await d.position(pool, 0n);
        const L = (await pos.getGetPositionData()).liquidity;
        for (const bad of [EXT, BAD_WC]) {
            const res = await d.decrease(pos, d.alice, L, { recipient: bad });
            expect(failedAt(res, pos.address).length).toBe(1);
            expect(actionFailures(res)).toEqual([]);
            expect(modifyEvents(res)).toEqual([]);
            const pd = await pos.getGetPositionData();
            expect([pd.busy, pd.liquidity]).toEqual([false, L]);
        }
        const res = await d.decrease(pos, d.alice, L);
        expectNoFailures(res);
        expect(modifyEvents(res).length).toBe(1);
        expect((await pos.getGetPositionData()).liquidity).toBe(0n);
    });

    it('NftTransfer to a non-std owner is refused (the NFT would be unusable)', async () => {
        const pos = await d.position(pool, 0n);
        for (const bad of [EXT, BAD_WC]) {
            const body = beginCell().store(storeNftTransfer({
                $$type: 'NftTransfer', queryId: 1n, newOwner: bad, responseDestination: null, customPayload: null,
                forwardAmount: 0n, forwardPayload: beginCell().storeUint(0, 1).endCell().beginParse(),
            })).endCell();
            const res = await d.alice.send({ to: pos.address, value: toNano('0.1'), body });
            expect(failedAt(res, pos.address).length).toBe(1);
            expect((await pos.getGetPositionData()).owner.equals(d.alice.address)).toBe(true);
        }
    });

    it('jetton/jetton pool idle under storage rent: a burn at DECREASE_GAS never fails its action phase; busy is always cleared', async () => {
        const pj = await d.poolOf(d.tokA, d.tokB, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.bob, toNano('50'), d.tokB, -600n, 600n, 0n, { viaAccount: true, sqrtPriceInit: Q96 }));
        expectNoFailures(await d.mintJetton(d.jB, d.bob, toNano('50'), d.tokA, -600n, 600n, 0n, { viaAccount: true, sqrtPriceInit: Q96 }));
        const pos = await d.position(pj, 0n);
        const L = (await pos.getGetPositionData()).liquidity;
        expect(L).toBeGreaterThan(0n);
        const snap = d.chain.snapshot();
        const outcomes: string[] = [];
        // From no rent to years of rent debt (and a frozen account).
        for (const years of [0, 0.25, 1, 3, 10]) {
            await d.chain.loadFrom(snap);
            d.chain.now = d.now + Math.floor(years * 365 * 86400);
            const res = await d.decrease(pos, d.bob, L, { value: toNano('0.25'), deadline: BigInt(d.now + 60) });
            expect(actionFailures(res)).toEqual([]);
            const pd = await pos.getGetPositionData();
            expect(pd.busy).toBe(false);
            if (pd.liquidity === 0n) {
                outcomes.push(`${years}y: withdrawn`);
                expect(modifyEvents(res).length).toBe(1);
            } else {
                outcomes.push(`${years}y: refused ${refundCodes(res).join(',') || 'bounce'}`);
                expect(pd.liquidity).toBe(L);
                // Attaching more value always gets the withdrawal through (the extra pays the rent).
                const r2 = await d.decrease(pos, d.bob, L, { value: toNano('3'), deadline: BigInt(d.now + 60) });
                expect(actionFailures(r2)).toEqual([]);
                const p2 = await pos.getGetPositionData();
                expect(p2.busy).toBe(false);
                if (p2.liquidity === 0n) outcomes.push(`${years}y: withdrawn with 3 Gram`);
            }
        }
        // eslint-disable-next-line no-console
        console.log('idle-pool burns:', outcomes.join('; '));
        expect(outcomes[0]).toBe('0y: withdrawn');
    });
});

describe('finding 2: new ticks pay a non-refundable TICK_INIT_FEE kept as the pool endowment', () => {
    it('mint with 2 new ticks adds 0.2 Gram to the endowment; burning the ticks refunds only the rent buffers', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('100'), GRAM, -600n, 600n, toNano('100'), { sqrtPriceInit: Q96 }));
        let st = await pool.getGetPoolState();
        expect([st.tickCount, st.endowment]).toEqual([2n, toNano('0.2')]);
        // Reusing both ticks costs nothing extra.
        let res = await d.mintJetton(d.jA, d.bob, toNano('1'), GRAM, -600n, 600n, toNano('1'));
        expectNoFailures(res);
        expect(modifyEvents(res).length).toBe(1);
        st = await pool.getGetPoolState();
        expect([st.tickCount, st.endowment]).toEqual([2n, toNano('0.2')]);
        // Dust far from the price (the review's griefing shape) pays 0.1 Gram per new tick for good.
        expectNoFailures(await d.mintNative(d.carol, 1000n, d.tokA, 600000n, 600060n));
        st = await pool.getGetPoolState();
        expect([st.tickCount, st.endowment]).toEqual([4n, toNano('0.4')]);
        const before = await d.gram(d.carol.address);
        const pos = await d.position(pool, 2n);
        expectNoFailures(await d.decrease(pos, d.carol, (await pos.getGetPositionData()).liquidity));
        st = await pool.getGetPoolState();
        expect([st.tickCount, st.endowment]).toEqual([2n, toNano('0.4')]);
        // carol got the two refundable TICK_RENT_BUFFERs back, not the init fees.
        const back = (await d.gram(d.carol.address)) - before;
        expect(back).toBeLessThan(toNano('0.3'));
        expect(await d.gram(pool.address)).toBeGreaterThanOrEqual(st.reserve0 + st.protocolFees0 + toNano('0.05') + toNano('0.04') + st.endowment - toNano('0.001'));
        await d.checkSolvency([pool]);
    });
});

describe('finding 3: payload addresses are validated (jettons are never stranded by a malformed address)', () => {
    let d: Dex;
    let base: any;
    beforeAll(async () => {
        d = await Dex.create();
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('100'), GRAM, -600n, 600n, toNano('100'), { sqrtPriceInit: Q96 }));
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('SwapPayload.otherToken = addr_none / addr_extern → BAD_TOKEN refund (was: Router exit 9, jettons lost)', async () => {
        for (const bad of [null, EXT]) {
            const jb = await d.jBal(d.jA, d.bob.address);
            const res = await d.swapJetton(d.jA, d.bob, toNano('5'), bad as unknown as Address);
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([213]);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(jb);
        }
    });

    it('receiver / refundTo / referral non-std on a jetton swap, owner on a jetton mint → BAD_RECIPIENT refund to the sender', async () => {
        for (const o of [{ receiver: EXT }, { refundTo: BAD_WC }, { referral: EXT, refBps: 5n }]) {
            const jb = await d.jBal(d.jA, d.bob.address);
            const res = await d.swapJetton(d.jA, d.bob, toNano('5'), GRAM, o as any);
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([CODES.BAD_RECIPIENT]);
            expect(await d.jBal(d.jA, d.bob.address)).toBe(jb);
        }
        const jb = await d.jBal(d.jA, d.bob.address);
        let res = await d.mintJetton(d.jA, d.bob, toNano('5'), GRAM, -600n, 600n, 0n, { owner: EXT });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.BAD_RECIPIENT]);
        res = await d.mintJetton(d.jA, d.bob, toNano('5'), null as unknown as Address, -600n, 600n, 0n);
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([213]);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb);
    });

    it('native entries refuse non-std addresses (the bounce returns the Gram)', async () => {
        let res = await d.swapNative(d.bob, toNano('1'), d.tokA, { receiver: EXT });
        expect(failedAt(res, d.router.address).length).toBe(1);
        res = await d.mintNative(d.bob, toNano('1'), d.tokA, -600n, 600n, { owner: BAD_WC });
        expect(failedAt(res, d.router.address).length).toBe(1);
    });
});

describe('finding 4: a MintAccount leg parked before SetCreationPaused cannot initialize a pool during the pause', () => {
    it('second leg during the pause → CREATION_PAUSED refund of both legs, pool stays uninitialized', async () => {
        const d = await Dex.create();
        const pj = await d.poolOf(d.tokA, d.tokB, 60n, null);
        const ja = await d.jBal(d.jA, d.bob.address);
        const jb = await d.jBal(d.jB, d.bob.address);
        expectNoFailures(await d.mintJetton(d.jA, d.bob, toNano('10'), d.tokB, -600n, 600n, 0n, { viaAccount: true, sqrtPriceInit: Q96 }));
        expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetCreationPaused', queryId: 0n, paused: true }));
        const res = await d.mintJetton(d.jB, d.bob, toNano('10'), d.tokA, -600n, 600n, 0n, { viaAccount: true, sqrtPriceInit: Q96 });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.CREATION_PAUSED]);
        expect(initEvents(res)).toEqual([]);
        expect((await pj.getGetPoolState()).initialized).toBe(false);
        expect([await d.jBal(d.jA, d.bob.address), await d.jBal(d.jB, d.bob.address)]).toEqual([ja, jb]);
    });
});

describe('finding 6: the stored volatility accumulator is taken at the final tick', () => {
    it('boundary-aligned swaps 31 s apart: va is stored and the variable fee grows (was: 3000 pips forever)', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, BigInt(M.minUsable(60)), BigInt(M.maxUsable(60)),
            toNano('1000'), { sqrtPriceInit: Q96 }));
        const fees: bigint[] = [];
        const vols: bigint[] = [];
        for (let i = 1; i <= 6; i++) {
            if (i > 1) d.chain.now = d.now + 31;
            const sim = await simOf(pool);
            const limit = M.sqrtAt(-480 * i);
            const e = sim.swap(true, toNano('100'), limit, 24, 0n, true, 0n, BigInt(d.now));
            expect(e.code).toBe(0);
            expect(e.tick).toBe(-480 * i - 1);
            const res = await d.swapNative(d.bob, toNano('100'), d.tokA, { limit, allowPartial: true });
            expectNoFailures(res);
            expect(swapEvents(res)[0].feeTotal).toBe(e.feeTotal);
            await expectPoolEquals(pool, sim);
            fees.push(e.lastFee);
            vols.push((await pool.getGetPoolState()).fs.volAcc);
        }
        // va at the final tick: |idxRef - idx(-480i - 1)| spacings above volRef.
        expect(vols[0]).toBe(90000n);
        expect(fees[0]).toBe(3000n);
        for (let i = 1; i < 6; i++) {
            expect(fees[i]).toBeGreaterThan(fees[i - 1]);
            expect(vols[i]).toBeGreaterThan(vols[i - 1]);
        }
        expect(fees[5]).toBeGreaterThan(3500n);
    });
});

describe('finding 7: a pinned volatility fee needs no checkpoints (spacing 1 is no longer capped at 3.9% per swap)', () => {
    it('spacing-1 full-range sell moves far beyond 48 x 8 ticks, quote == execution == model', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(GRAM, d.tokA, 1n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, BigInt(M.minUsable(1)), BigInt(M.maxUsable(1)),
            toNano('1000'), { sqrtPriceInit: Q96, tickSpacing: 1n }));
        const q = await pool.getGetQuote(true, toNano('100'), 0n, 24n, 0n, false);
        expect(Number(q.code)).toBe(0);
        expect(Number(q.stop)).toBe(STOP.FILLED);
        expect(Number(q.tickAfter)).toBeLessThan(-1500);
        expect(Number(q.steps)).toBeLessThan(10);
        const sim = await simOf(pool);
        const e = sim.swap(true, toNano('100'), 0n, 24, 0n, false, 0n, BigInt(d.now));
        expect([e.out, e.steps, e.tick]).toEqual([q.amountOut, Number(q.steps), Number(q.tickAfter)]);
        const res = await d.swapNative(d.bob, toNano('100'), d.tokA, { tickSpacing: 1n });
        expectNoFailures(res);
        expect(swapEvents(res)[0].amountOut).toBe(q.amountOut);
        await expectPoolEquals(pool, sim);
        expect((await pool.getGetPoolState()).fs.volAcc).toBe(350000n);
    });
});

describe('finding 8: mint price bounds (sqrtPriceMin/MaxX96)', () => {
    it('a price push between quote and mint is refunded SLIPPAGE; within bounds the mint goes through', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, BigInt(M.minUsable(60)), BigInt(M.maxUsable(60)),
            toNano('1000'), { sqrtPriceInit: Q96 }));
        const base = d.chain.snapshot();
        const s0 = (await pool.getGetPoolState()).sqrtPriceX96;
        const bounds = { sqrtMin: s0 - s0 / 1000n, sqrtMax: s0 + s0 / 1000n };     // ±0.1% in √price
        const q0 = await pool.getGetMintQuote(-600n, 600n, toNano('10'), toNano('30'), 0n);
        // The attack: push the price up (jetton in) before the over-supplied mint lands.
        expectNoFailures(await d.swapJetton(d.jA, d.carol, toNano('40'), GRAM));
        const q1 = await pool.getGetMintQuote(-600n, 600n, toNano('10'), toNano('30'), 0n);
        expect(q1.liquidity).toBeGreaterThan(q0.liquidity);            // minLiquidity alone would pass
        const jb = await d.jBal(d.jA, d.bob.address);
        let res = await d.mintJetton(d.jA, d.bob, toNano('30'), GRAM, -600n, 600n, toNano('10'),
            { minLiquidity: q0.liquidity, ...bounds });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.SLIPPAGE]);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb);
        // Without the push the same bounded mint succeeds and uses the quoted amounts.
        await d.chain.loadFrom(base);
        res = await d.mintJetton(d.jA, d.bob, toNano('30'), GRAM, -600n, 600n, toNano('10'), { minLiquidity: q0.liquidity, ...bounds });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        const ev = modifyEvents(res)[0];
        expect([ev.liquidityDelta, ev.amount0, ev.amount1]).toEqual([q0.liquidity, q0.use0, q0.use1]);
        // MintNative honours the bounds too.
        res = await d.mintNative(d.bob, toNano('1'), d.tokA, 600n, 1200n, { sqrtMax: s0 - 1n });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.SLIPPAGE]);
        void txOk;
    });
});

describe('finding 9: liquidity added during a LAUNCH_DECAY window is locked until it ends', () => {
    it('JIT range minted mid-launch: decrease refused until startTs + launchDuration, collect allowed; after the window no lock', async () => {
        const d = await Dex.create();
        const ext = extCell({ launchFeePips: 200000n, launchDuration: 3600n });
        const pool = await d.poolOf(GRAM, d.tokA, 60n, ext);
        const t0 = d.now;
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, BigInt(M.minUsable(60)), BigInt(M.maxUsable(60)),
            toNano('1000'), { sqrtPriceInit: Q96, ext }));
        expect((await (await d.position(pool, 0n)).getGetPositionData()).lockedUntil).toBe(BigInt(t0 + 3600));
        d.chain.now = t0 + 100;
        // A one-spacing Gram-only range just above the price (the JIT shape from the review).
        expectNoFailures(await d.mintNative(d.bob, toNano('50'), d.tokA, 0n, 60n, { ext }));
        const pos = await d.position(pool, 1n);
        const pd = await pos.getGetPositionData();
        expect(pd.lockedUntil).toBe(BigInt(t0 + 3600));
        expectNoFailures(await d.swapJetton(d.jA, d.carol, toNano('20'), GRAM, { ext }));
        d.chain.now = t0 + 200;
        let res = await d.decrease(pos, d.bob, pd.liquidity);
        expect(failedAt(res, pos.address).length).toBe(1);
        res = await d.decrease(pos, d.bob, 0n);                       // fees stay collectable
        expectNoFailures(res);
        expect(modifyEvents(res).length).toBe(1);
        d.chain.now = t0 + 3600;
        res = await d.decrease(pos, d.bob, pd.liquidity);
        expectNoFailures(res);
        expect((await pos.getGetPositionData()).liquidity).toBe(0n);
        // After the window: no lock.
        expectNoFailures(await d.mintNative(d.bob, toNano('5'), d.tokA, 600n, 1200n, { ext }));
        expect((await (await d.position(pool, 2n)).getGetPositionData()).lockedUntil).toBe(0n);
    });
});

// ---------------------------------------------------------------------------
// Second review (pre-redeploy): issues 1-3.
// ---------------------------------------------------------------------------

describe('issue 1: spare Gram in a pool is never paid to whoever calls a collect op first', () => {
    it('a 5 Gram donation joins the endowment; CollectTax (untaxed key) and CollectProtocolFees (fees 0) return only the caller value', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('100'), GRAM, -600n, 600n, toNano('100'), { sqrtPriceInit: Q96 }));
        const s0 = await pool.getGetPoolState();
        expect([s0.protocolFees0, s0.protocolFees1, s0.taxFees]).toEqual([0n, 0n, 0n]);
        const key = { $$type: 'PoolKey' as const, token0: s0.key.token0, token1: s0.key.token1, tickSpacing: s0.key.tickSpacing, ext: s0.key.ext };

        expectNoFailures(await d.bob.send({ to: pool.address, value: toNano('5') }));
        expect((await pool.getGetPoolState()).endowment).toBe(s0.endowment + toNano('5'));
        const poolGram = await d.gram(pool.address);

        const value = toNano('0.35');     // v4: PROTOCOL_COLLECT_GAS (CollectTax needs less)
        for (const body of [
            { $$type: 'CollectTax' as const, queryId: 1n, key },
            { $$type: 'CollectProtocolFees' as const, queryId: 2n, key },
        ]) {
            const before = await d.gram(d.carol.address);
            const res = await d.router.send(d.carol.getSender(), { value }, body as any);
            expectNoFailures(res);
            const after = await d.gram(d.carol.address);
            // The caller gets back at most its own value (minus gas), never the donation.
            expect([body.$$type, after <= before]).toEqual([body.$$type, true]);
            expect([body.$$type, before - after < value]).toEqual([body.$$type, true]);
            // The pool keeps the donation (it only pays its own storage meanwhile).
            expect([body.$$type, await d.gram(pool.address) > poolGram - toNano('0.01')]).toEqual([body.$$type, true]);
        }
        const s1 = await pool.getGetPoolState();
        expect(await d.gram(pool.address)).toBeGreaterThanOrEqual(s1.reserve0 + s1.endowment);
    });
});

describe('issue 2: a forged first MintAccount leg cannot hijack the victim\'s real second leg', () => {
    const forgedLeg = async (d: Dex, fake: any, eve: SandboxContract<any>, victim: Address, other: Address, amount: bigint) => {
        const payload = d.mintPayload(other, -1200n, 1200n, 0n, { viaAccount: true, sqrtPriceInit: Q96, owner: eve.address, refundTo: eve.address });
        const body = beginCell().store(storeJettonNotification({
            $$type: 'JettonNotification', queryId: 7n, amount, sender: victim,
            forwardPayload: beginCell().storeBit(1).storeRef(payload).endCell().beginParse(),
        })).endCell();
        return fake.send(eve.getSender(), { value: toNano('2') }, { $$type: 'FakeSend', to: d.router.address, value: toNano('1'), bounce: false, body });
    };

    for (const order of ['forged first', 'victim first'] as const) {
        it(`${order}: no pairing, the victim's leg goes back to the victim's refundTo, nothing reaches the attacker`, async () => {
            const d = await Dex.create();
            const eve = await d.chain.treasury('eve', { balance: toNano('1000') });
            const fake = await d.fake(eve);       // stands in for an admin-mintable jetton (F) controlled by eve
            const pool = await d.poolOf(fake.address, d.tokB, 60n, null);
            const ma = d.chain.openContract(MintAccount.fromAddress(await d.router.getGetMintAccountAddress(pool.address, d.bob.address)));
            const jb = await d.jBal(d.jB, d.bob.address);
            const victimLeg = () => d.mintJetton(d.jB, d.bob, toNano('10'), fake.address, -600n, 600n, 0n, { viaAccount: true, sqrtPriceInit: Q96 });

            let res: any = order === 'forged first' ? await forgedLeg(d, fake, eve, d.bob.address, d.tokB, toNano('1'))
                : await victimLeg();
            expectNoFailures(res);
            res = order === 'forged first' ? await victimLeg() : await forgedLeg(d, fake, eve, d.bob.address, d.tokB, toNano('1'));
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([CODES.MINT_MISMATCH]);
            expect(modifyEvents(res)).toEqual([]);
            expect((await pool.getGetPoolState()).initialized).toBe(false);
            expect(await d.jBal(d.jB, d.bob.address)).toBe(jb);
            expect(await d.jBal(d.jB, eve.address)).toBe(0n);
            expect(await d.routerHolds(d.tokB)).toBe(0n);
            const md = await ma.getGetMintAccountData();
            expect([md.pending0, md.pending1, md.params]).toEqual([0n, 0n, null]);
        });
    }

    it('honest two-leg mint (identical params) still pairs and mints for the victim', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(d.tokA, d.tokB, 60n, null);
        const o = { viaAccount: true, sqrtPriceInit: Q96 };
        expectNoFailures(await d.mintJetton(d.jA, d.bob, toNano('10'), d.tokB, -600n, 600n, 0n, o));
        const res = await d.mintJetton(d.jB, d.bob, toNano('10'), d.tokA, -600n, 600n, 0n, o);
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        const ev = modifyEvents(res);
        expect(ev.length).toBe(1);
        expect(ev[0].owner.equals(d.bob.address)).toBe(true);
        await d.checkSolvency([pool]);
    });
});
