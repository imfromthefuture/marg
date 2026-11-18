// Fee converter suite: the REAL Marg DEX v2 Router / Pool / Position (dex/v2 build, read-only) and
// dex/v2's mock jetton. The Router's treasury and a launch's feeClaimer point at the converter; the
// treasury wallet must end up with Gram only. Sandbox only.

import { Address, beginCell, Cell, toNano } from '@ton/core';
import { SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import {
    Dex, GRAM, Q96, Pool, TestJettonMaster, expectNoFailures, gramPayouts, refundCodes, swapEvents, encodeSqrtPrice,
    CODE, REASON, extCell, gasAt, storeSwapPayload as dexStoreSwapPayload, storePositionDecrease as dexStorePositionDecrease,
    storeJettonTransfer as dexStoreJettonTransfer, storeGramPayout as dexStoreGramPayout,
} from '../../dex/v2/tests/helpers';
import * as M from '../../dex/v2/tests/model';
import {
    FeeConverter, storeSwapPayload, storePositionDecrease, storeJettonTransfer, storeGramPayout,
} from '../build/FeeConverter_FeeConverter';

jest.setTimeout(900000);

const OP = { JettonTransfer: 0x0f8a7ea5, PositionDecrease: 0x4d480042, TreasuryDeposit: 0x4d460061 };
const RESERVE = toNano('0.05');
const JET = toNano('50000000');
const SQRT = encodeSqrtPrice(JET, toNano('1300'));

type Key = { token0: Address; token1: Address; tickSpacing: bigint; ext: Cell | null };

describe('fee converter', () => {
    let d: Dex;
    let conv: SandboxContract<FeeConverter>;
    let tre: SandboxContract<TreasuryContract>;
    let keeper: SandboxContract<TreasuryContract>;
    let mallory: SandboxContract<TreasuryContract>;
    let poolA: SandboxContract<Pool>;
    let keyA: Key;
    let base: any;

    const gram = (a: Address) => d.gram(a);
    const convWallet = (j: SandboxContract<TestJettonMaster>) => d.jWallet(j, conv.address);
    const convertValue = (mc = 24n) => conv.getGetConvertValue(mc);

    // Every message the converter sent in a trace, by destination.
    function convOut(res: SendMessageResult) {
        const out: { to: Address; op: number | null; value: bigint }[] = [];
        for (const tx of res.transactions) {
            const dst = tx.inMessage?.info.dest;
            if (!(dst instanceof Address) || !dst.equals(conv.address)) continue;
            for (const m of tx.outMessages.values()) {
                if (m.info.type !== 'internal') continue;
                const b = m.body.beginParse();
                out.push({ to: m.info.dest, op: b.remainingBits >= 32 ? b.preloadUint(32) : null, value: m.info.value.coins });
            }
        }
        return out;
    }

    // The converter only ever talks to: the treasury (Gram), its own jetton wallets, owned positions.
    async function expectOnlyAllowed(res: SendMessageResult, extra: Address[] = []) {
        const wallets = [(await convWallet(d.jA)).address, (await convWallet(d.jB)).address];
        const t = (await conv.getGetConverterData()).treasury;
        for (const m of convOut(res)) {
            const ok = m.to.equals(t) || wallets.some((w) => w.equals(m.to)) || extra.some((w) => w.equals(m.to));
            if (!ok) throw new Error(`converter sent op ${m.op?.toString(16)} to ${m.to}`);
            if (m.to.equals(t)) expect(m.op).toBe(OP.TreasuryDeposit);
        }
    }

    const convertMsg = async (j: SandboxContract<TestJettonMaster>, amount: bigint, key: Key, minOut: bigint, o: { mc?: bigint; wallet?: Address } = {}) => ({
        $$type: 'ConvertJetton' as const, queryId: 9n, jettonWallet: o.wallet ?? (await convWallet(j)).address, amount,
        tickSpacing: key.tickSpacing, ext: key.ext, minOut, maxCrossings: o.mc ?? 24n,
    });

    async function convert(from: SandboxContract<TreasuryContract>, j: SandboxContract<TestJettonMaster>, amount: bigint, key: Key,
                           minOut: bigint, o: { mc?: bigint; wallet?: Address; value?: bigint } = {}) {
        return conv.send(from.getSender(), { value: o.value ?? await convertValue(o.mc ?? 24n) }, await convertMsg(j, amount, key, minOut, o));
    }

    const approve = async (j: SandboxContract<TestJettonMaster>, key: Key, approved = true, from = d.admin, o: { wallet?: Address } = {}) =>
        conv.send(from.getSender(), { value: toNano('0.05') }, {
            $$type: 'ApproveConvertKey', queryId: 0n, jettonWallet: o.wallet ?? (await convWallet(j)).address,
            tickSpacing: key.tickSpacing, ext: key.ext, approved,
        });
    const isApproved = async (j: SandboxContract<TestJettonMaster>, key: Key) =>
        conv.getGetConvertKeyApproved((await convWallet(j)).address, key.tickSpacing, key.ext);

    const collectProtocol = (key: Key) => d.router.send(d.carol.getSender(), { value: toNano('0.3') }, {
        $$type: 'CollectProtocolFees', queryId: 3n, key: { $$type: 'PoolKey', ...key },
    });

    beforeAll(async () => {
        d = await Dex.create();
        tre = await d.chain.treasury('marg-treasury', { balance: toNano('1') });
        keeper = await d.chain.treasury('keeper', { balance: toNano('1000') });
        mallory = await d.chain.treasury('mallory', { balance: toNano('1000') });
        conv = d.chain.openContract(await FeeConverter.fromInit(tre.address, d.router.address, d.admin.address));
        expectNoFailures(await conv.send(d.admin.getSender(), { value: toNano('0.1') }, null));
        expectNoFailures(await conv.send(d.admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetKeeper', queryId: 0n, keeper: keeper.address }));
        // Mainnet step: Router.SetTreasury(converter).
        expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetTreasury', queryId: 0n, treasury: conv.address }));
        expect((await d.router.getGetRouterData()).treasury.equals(conv.address)).toBe(true);

        // Plain Gram/tokA pool, full range, price 1:1.
        keyA = { token0: GRAM, token1: d.tokA, tickSpacing: 60n, ext: null };
        poolA = await d.poolOf(GRAM, d.tokA, 60n);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('100000'), GRAM, BigInt(M.minUsable(60)), BigInt(M.maxUsable(60)),
            toNano('100000'), { sqrtPriceInit: Q96 }));
        expectNoFailures(await approve(d.jA, keyA));
        base = d.chain.snapshot();
    });

    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('dex types serialize exactly like the dex/v2 build', () => {
        const a = new Address(0, Buffer.alloc(32, 7));
        const sp = {
            $$type: 'SwapPayload' as const, otherToken: GRAM, tickSpacing: 200n, ext: extCell({ minLockSecs: 5n }), minOut: 123n,
            sqrtPriceLimitX96: 0n, maxCrossings: 24n, allowPartial: false, deadline: 99n, receiver: a, refundTo: a, referral: null,
            refBps: 0n, fwdTon: 0n, fwdPayload: null,
        };
        expect(beginCell().store(storeSwapPayload(sp)).endCell().hash()).toEqual(beginCell().store(dexStoreSwapPayload(sp)).endCell().hash());
        const pd = { $$type: 'PositionDecrease' as const, queryId: 1n, liquidityDelta: 0n, amount0Min: 0n, amount1Min: 0n, deadline: 5n, recipient: a };
        expect(beginCell().store(storePositionDecrease(pd)).endCell().hash()).toEqual(beginCell().store(dexStorePositionDecrease(pd)).endCell().hash());
        const jt = { $$type: 'JettonTransfer' as const, queryId: 1n, amount: 7n, destination: a, responseDestination: a, customPayload: null,
            forwardTonAmount: 3n, forwardPayload: beginCell().storeBit(0).endCell().beginParse() };
        expect(beginCell().store(storeJettonTransfer(jt)).endCell().hash()).toEqual(beginCell().store(dexStoreJettonTransfer(jt)).endCell().hash());
        const gp = { $$type: 'GramPayout' as const, queryId: 1n, reason: 7n, amount: 5n, payload: null };
        expect(beginCell().store(storeGramPayout(gp)).endCell().hash()).toEqual(beginCell().store(dexStoreGramPayout(gp)).endCell().hash());
    });

    it('protocol fees (Gram + jetton) -> converter; Gram forwarded, jetton converted by the keeper; treasury gets only Gram', async () => {
        expectNoFailures(await d.swapNative(d.bob, toNano('500'), d.tokA));
        expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('400'), GRAM));
        const st = await poolA.getGetPoolState();
        expect(st.protocolFees0).toBeGreaterThan(0n);
        expect(st.protocolFees1).toBeGreaterThan(0n);

        const t0 = await gram(tre.address);
        let res = await collectProtocol(keyA);
        expectNoFailures(res);
        // The Gram leg reaches the converter as a GramPayout and is forwarded in the same trace.
        expect(gramPayouts(res, conv.address).map((x) => [x.reason, x.amount])).toEqual([[REASON.PROTOCOL_FEE, st.protocolFees0]]);
        expect(res.transactions).toHaveTransaction({ from: conv.address, to: tre.address, op: OP.TreasuryDeposit, success: true });
        expect(await gram(tre.address) - t0).toBeGreaterThanOrEqual(st.protocolFees0);
        expect(await d.jBal(d.jA, conv.address)).toBe(st.protocolFees1);
        expect(await gram(conv.address)).toBeLessThanOrEqual(RESERVE);
        await expectOnlyAllowed(res);

        // Keeper converts the jetton fee on the canonical key, with a quote-based minOut.
        const amt = st.protocolFees1;
        const q = await poolA.getGetQuote(false, amt, 0n, 24n, 0n, false);
        expect(q.code).toBe(0n);
        const t1 = await gram(tre.address);
        res = await convert(keeper, d.jA, amt, keyA, q.amountOut * 99n / 100n);
        expectNoFailures(res);
        expect(swapEvents(res).map((e) => e.amountOut)).toEqual([q.amountOut]);
        expect(gramPayouts(res, conv.address).filter((x) => x.reason === REASON.SWAP_OUT).map((x) => x.amount)).toEqual([q.amountOut]);
        expect(await d.jBal(d.jA, conv.address)).toBe(0n);
        expect(await gram(tre.address) - t1).toBeGreaterThanOrEqual(q.amountOut);
        expect(await gram(conv.address)).toBeLessThanOrEqual(RESERVE + toNano('0.05'));
        await expectOnlyAllowed(res);

        // Flush sweeps the leftover (keeper gas excess) down to the reserve.
        res = await conv.send(mallory.getSender(), { value: toNano('0.02') }, { $$type: 'Flush', queryId: 1n });
        expectNoFailures(res);
        await expectOnlyAllowed(res);
        const b = await gram(conv.address);
        expect(b).toBeLessThanOrEqual(RESERVE);
        expect(b).toBeGreaterThan(RESERVE - toNano('0.001'));
        // The treasury holds no jetton at all.
        expect(await d.jBal(d.jA, tre.address)).toBe(0n);
        expect(await d.jBal(d.jB, tre.address)).toBe(0n);
    });

    it('launch position owned by the converter: CollectPosition -> Gram forwarded, jetton converted -> treasury only Gram', async () => {
        const LO = { tickSpacing: 200n };
        expectNoFailures(await d.launch(d.jB, d.alice, JET, SQRT, conv.address, d.alice.address, LO));
        const key = await d.launchKey(d.tokB, d.alice.address, LO);
        const pool = await d.poolOf(GRAM, d.tokB, 200n, key.ext);
        const pos = await d.position(pool, 0n);
        const pd = await pos.getGetPositionData();
        expect(pd.owner.equals(conv.address)).toBe(true);
        expect(pd.lockedUntil).toBe(0xFFFFFFFFn);

        // Trading: buys pay the LP fee in Gram, sells in the jetton.
        expectNoFailures(await d.swapNative(d.bob, toNano('300'), d.tokB, { tickSpacing: 200n, ext: key.ext }));
        expectNoFailures(await d.swapJetton(d.jB, d.bob, toNano('2000000'), GRAM, { tickSpacing: 200n, ext: key.ext }));
        const owed = await pool.getGetPositionAmounts(pd.tickLower, pd.tickUpper, pd.liquidity, pd.fgLast0, pd.fgLast1, 0n);
        expect(owed.fees0).toBeGreaterThan(0n);
        expect(owed.fees1).toBeGreaterThan(0n);

        // Anyone triggers the collect (here: mallory); fees go to the converter only.
        const t0 = await gram(tre.address);
        let res = await conv.send(mallory.getSender(), { value: await conv.getGetCollectValue() }, { $$type: 'CollectPosition', queryId: 4n, position: pos.address });
        expectNoFailures(res);
        expect(res.transactions).toHaveTransaction({ from: conv.address, to: pos.address, op: OP.PositionDecrease, success: true });
        expect(await d.jBal(d.jB, conv.address)).toBe(owed.fees1);
        expect(await gram(tre.address) - t0).toBeGreaterThanOrEqual(owed.fees0);
        expect(gramPayouts(res, mallory.address)).toEqual([]);
        await expectOnlyAllowed(res, [pos.address]);
        expect((await pos.getGetPositionData()).liquidity).toBe(pd.liquidity);

        // Convert the jetton fee on the launch key (the admin approves it first).
        expectNoFailures(await approve(d.jB, key));
        const q = await pool.getGetQuote(false, owed.fees1, 0n, 24n, 0n, false);
        expect(q.code).toBe(0n);
        const t1 = await gram(tre.address);
        res = await convert(keeper, d.jB, owed.fees1, key, q.amountOut * 98n / 100n);
        expectNoFailures(res);
        expect(await d.jBal(d.jB, conv.address)).toBe(0n);
        expect(await gram(tre.address) - t1).toBeGreaterThanOrEqual(q.amountOut);
        await expectOnlyAllowed(res);
        expect(await d.jBal(d.jB, tre.address)).toBe(0n);

        // A second collect with nothing accrued is harmless.
        res = await conv.send(mallory.getSender(), { value: toNano('0.3') }, { $$type: 'CollectPosition', queryId: 5n, position: pos.address });
        expectNoFailures(res);
        // Too little value is refused before anything is sent.
        res = await conv.send(mallory.getSender(), { value: toNano('0.29') }, { $$type: 'CollectPosition', queryId: 5n, position: pos.address });
        expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
        expect(convOut(res).filter((m) => !m.to.equals(mallory.address))).toEqual([]);
    });

    describe('refusals and refunds', () => {
        let amt: bigint;
        beforeEach(async () => {
            expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('1000'), GRAM));
            expectNoFailures(await collectProtocol(keyA));
            amt = await d.jBal(d.jA, conv.address);
            expect(amt).toBeGreaterThan(0n);
        });

        it('non-keeper ConvertJetton is refused (bounces, nothing sent); admin may convert', async () => {
            for (const who of [mallory, d.alice, tre]) {
                const res = await convert(who, d.jA, amt, keyA, 1n);
                expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
                expect(convOut(res).filter((m) => !m.to.equals(who.address))).toEqual([]);
            }
            expect(await d.jBal(d.jA, conv.address)).toBe(amt);
            const res = await convert(d.admin, d.jA, amt, keyA, 1n);
            expectNoFailures(res);
            expect(await d.jBal(d.jA, conv.address)).toBe(0n);
        });

        it('keeper removed -> only the admin; minOut = 0, bad crossings, low value are refused', async () => {
            expectNoFailures(await conv.send(d.admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetKeeper', queryId: 0n, keeper: null }));
            let res = await convert(keeper, d.jA, amt, keyA, 1n);
            expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
            res = await convert(d.admin, d.jA, amt, keyA, 0n);
            expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
            res = await convert(d.admin, d.jA, amt, keyA, 1n, { mc: 0n, value: toNano('1') });
            expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
            res = await convert(d.admin, d.jA, amt, keyA, 1n, { mc: 25n, value: toNano('1') });
            expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
            res = await convert(d.admin, d.jA, amt, keyA, 1n, { value: (await convertValue()) - 1n });
            expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
            expect(await d.jBal(d.jA, conv.address)).toBe(amt);
        });

        it('wrong key / no preset / bad ext / slippage -> jettons refunded to the converter, nothing lost', async () => {
            const cases: [Key, bigint, number][] = [
                [{ ...keyA, tickSpacing: 10n }, 1n, CODE.NOT_INITIALIZED],                    // valid key, pool never initialized
                [{ ...keyA, tickSpacing: 7n }, 1n, CODE.BAD_TICK_SPACING],                    // no preset
                [{ ...keyA, ext: beginCell().storeUint(1, 5).endCell() }, 1n, CODE.BAD_KEY],  // malformed ext
                [{ ...keyA, ext: extCell({ minLockSecs: 1n }) }, 1n, CODE.NOT_INITIALIZED],   // other valid key
                [keyA, toNano('1000000'), CODE.SLIPPAGE],                                    // minOut too high
            ];
            for (const [key, minOut, code] of cases) {
                if (key !== keyA) expectNoFailures(await approve(d.jA, key));   // reach the Router's own checks
                const res = await convert(keeper, d.jA, amt, key, minOut);
                expectNoFailures(res);
                expect(refundCodes(res)).toEqual([code]);
                expect(await d.jBal(d.jA, conv.address)).toBe(amt);
                await expectOnlyAllowed(res);
            }
            expect(await d.jBal(d.jA, tre.address)).toBe(0n);
            // After all the refunds the right key still converts everything.
            expectNoFailures(await convert(keeper, d.jA, amt, keyA, 1n));
            expect(await d.jBal(d.jA, conv.address)).toBe(0n);
        });

        it('allowlist: unapproved keys refused for keeper and admin (nothing sent); approved works; revoke; keeper/mallory cannot approve', async () => {
            // A rigged pool the keeper could set up: same token, unused spacing / another ext.
            const rigged: Key[] = [{ ...keyA, tickSpacing: 10n }, { ...keyA, ext: extCell({ minLockSecs: 1n }) }];
            for (const key of rigged) {
                expect(await isApproved(d.jA, key)).toBe(false);
                for (const who of [keeper, d.admin]) {
                    const res = await convert(who, d.jA, amt, key, 1n);
                    expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
                    expect(convOut(res).filter((m) => !m.to.equals(who.address))).toEqual([]);
                }
            }
            // The approval is per wallet: keyA approved for jA's wallet does not cover jB's wallet.
            expect(await isApproved(d.jA, keyA)).toBe(true);
            expect(await isApproved(d.jB, keyA)).toBe(false);
            // Keeper / mallory cannot approve (or revoke).
            for (const who of [keeper, mallory]) {
                let res = await approve(d.jA, rigged[0], true, who);
                expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
                res = await approve(d.jA, keyA, false, who);
                expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
            }
            expect(await isApproved(d.jA, rigged[0])).toBe(false);
            expect(await isApproved(d.jA, keyA)).toBe(true);
            // Invalid wallets cannot be approved.
            for (const wallet of [conv.address, d.router.address]) {
                const res = await approve(d.jA, keyA, true, d.admin, { wallet });
                expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
            }
            expect(await d.jBal(d.jA, conv.address)).toBe(amt);
            // Admin revokes keyA: refused; re-approves: converts.
            expectNoFailures(await approve(d.jA, keyA, false));
            expect(await isApproved(d.jA, keyA)).toBe(false);
            let res = await convert(keeper, d.jA, amt, keyA, 1n);
            expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
            expect(await d.jBal(d.jA, conv.address)).toBe(amt);
            expectNoFailures(await approve(d.jA, keyA, true));
            res = await convert(keeper, d.jA, amt, keyA, 1n);
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([]);
            expect(await d.jBal(d.jA, conv.address)).toBe(0n);
            await expectOnlyAllowed(res);
        });

        it('expired deadline cannot be forced: the converter always sets now + 600', async () => {
            const res = await convert(keeper, d.jA, amt, keyA, 1n);
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([]);
        });
    });

    describe('nothing can be sent elsewhere', () => {
        it('a bogus wallet / position only receives the caller\'s own value; the converter balance never drops', async () => {
            // (Approved so the send is reached: even then only the caller's value goes out.)
            expectNoFailures(await approve(d.jA, keyA, true, d.admin, { wallet: mallory.address }));
            // Give the converter some Gram below the auto-forward threshold.
            await conv.send(d.alice.getSender(), { value: toNano('0.04') }, null);
            const b0 = await gram(conv.address);
            let res = await convert(keeper, d.jA, 1n, keyA, 1n, { wallet: mallory.address });
            expect(convOut(res).some((m) => m.to.equals(mallory.address))).toBe(true);
            expect(await gram(conv.address)).toBeGreaterThanOrEqual(b0 - 1n);
            res = await conv.send(mallory.getSender(), { value: toNano('0.3') }, { $$type: 'CollectPosition', queryId: 1n, position: mallory.address });
            const toM = convOut(res).filter((m) => m.to.equals(mallory.address));
            expect(toM.length).toBe(1);
            expect(toM[0].value).toBeLessThanOrEqual(toNano('0.3'));
            expect(await gram(conv.address)).toBeGreaterThanOrEqual(b0 - 1n);
            // Invalid targets are refused outright.
            for (const position of [conv.address, d.router.address, tre.address]) {
                res = await conv.send(mallory.getSender(), { value: toNano('0.3') }, { $$type: 'CollectPosition', queryId: 1n, position });
                expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
            }
            res = await convert(keeper, d.jA, 1n, keyA, 1n, { wallet: d.router.address });
            expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
        });

        it('Flush and every Gram inflow only ever pay the treasury', async () => {
            const t0 = await gram(tre.address);
            // A "Launch fee" comment (the factory's format), a plain transfer, a GramPayout-shaped body.
            let res = await d.alice.send({ to: conv.address, value: toNano('2'), body: beginCell().storeUint(0, 32).storeStringTail('Launch fee').endCell() });
            expectNoFailures(res);
            await expectOnlyAllowed(res);
            res = await d.alice.send({ to: conv.address, value: toNano('1') });
            expectNoFailures(res);
            await expectOnlyAllowed(res);
            expect(await gram(tre.address) - t0).toBeGreaterThan(toNano('2.98'));
            expect(await gram(conv.address)).toBeLessThanOrEqual(RESERVE);
            res = await conv.send(mallory.getSender(), { value: toNano('0.5') }, { $$type: 'Flush', queryId: 1n });
            expectNoFailures(res);
            await expectOnlyAllowed(res);
            expect(convOut(res).some((m) => m.to.equals(mallory.address))).toBe(false);
        });

        it('admin: SetFeeTreasury / SetKeeper / RescueJetton restricted; rescue goes to the treasury only', async () => {
            expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('1000'), GRAM));
            expectNoFailures(await collectProtocol(keyA));
            const amt = await d.jBal(d.jA, conv.address);
            const w = (await convWallet(d.jA)).address;
            for (const who of [mallory, keeper]) {
                for (const body of [
                    { $$type: 'SetFeeTreasury' as const, queryId: 0n, treasury: who.address },
                    { $$type: 'SetKeeper' as const, queryId: 0n, keeper: who.address },
                    { $$type: 'RescueJetton' as const, queryId: 0n, jettonWallet: w, amount: amt },
                    { $$type: 'TransferConverterAdmin' as const, queryId: 0n, newAdmin: who.address },
                ]) {
                    const res = await conv.send(who.getSender(), { value: toNano('0.2') }, body as any);
                    expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
                }
            }
            for (const t of [conv.address, d.router.address]) {
                const res = await conv.send(d.admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetFeeTreasury', queryId: 0n, treasury: t });
                expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
            }
            // Rescue: the jettons land with the treasury (no conversion), nowhere else.
            let res = await conv.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'RescueJetton', queryId: 0n, jettonWallet: w, amount: amt });
            expectNoFailures(res);
            expect(await d.jBal(d.jA, tre.address)).toBe(amt);
            expect(await d.jBal(d.jA, conv.address)).toBe(0n);
            await expectOnlyAllowed(res);

            // New treasury: the next forward goes there.
            const t2 = await d.chain.treasury('treasury-2');
            expectNoFailures(await conv.send(d.admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetFeeTreasury', queryId: 0n, treasury: t2.address }));
            const b2 = await gram(t2.address);
            res = await d.alice.send({ to: conv.address, value: toNano('1') });
            expectNoFailures(res);
            expect(await gram(t2.address) - b2).toBeGreaterThan(toNano('0.99'));
            await expectOnlyAllowed(res);
        });

        it('two-step admin transfer', async () => {
            const na = await d.chain.treasury('new-admin');
            expectNoFailures(await conv.send(d.admin.getSender(), { value: toNano('0.05') }, { $$type: 'TransferConverterAdmin', queryId: 0n, newAdmin: na.address }));
            expect((await conv.getGetConverterData()).admin.equals(d.admin.address)).toBe(true);
            let res = await conv.send(mallory.getSender(), { value: toNano('0.05') }, { $$type: 'ClaimConverterAdmin', queryId: 0n });
            expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
            expectNoFailures(await conv.send(na.getSender(), { value: toNano('0.05') }, { $$type: 'ClaimConverterAdmin', queryId: 0n }));
            const cd = await conv.getGetConverterData();
            expect(cd.admin.equals(na.address)).toBe(true);
            expect(cd.pendingAdmin).toBeNull();
            res = await conv.send(d.admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetKeeper', queryId: 0n, keeper: null });
            expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
        });

        it('storage reserve is kept; getters', async () => {
            const cd = await conv.getGetConverterData();
            expect(cd.treasury.equals(tre.address)).toBe(true);
            expect(cd.router.equals(d.router.address)).toBe(true);
            expect(cd.keeper!.equals(keeper.address)).toBe(true);
            expect(cd.reserve).toBe(RESERVE);
            expect(await convertValue(24n)).toBe(toNano('0.35') + 24n * toNano('0.006') + toNano('0.1') + toNano('0.12'));   // v3: margin 0.06 -> 0.1 (M-3)
            // Below the auto-forward threshold Gram accumulates; Flush sends it, the reserve stays.
            expectNoFailures(await conv.send(mallory.getSender(), { value: toNano('0.01') }, { $$type: 'Flush', queryId: 0n }));
            expect(await gram(conv.address)).toBeLessThanOrEqual(RESERVE);
            await d.alice.send({ to: conv.address, value: toNano('0.03') });
            const b = await gram(conv.address);
            expect(b).toBeGreaterThan(RESERVE);
            const res = await conv.send(mallory.getSender(), { value: toNano('0.01') }, { $$type: 'Flush', queryId: 0n });
            expectNoFailures(res);
            const after = await gram(conv.address);
            expect(after).toBeLessThanOrEqual(RESERVE);
            expect(after).toBeGreaterThan(RESERVE - toNano('0.001'));
            // A long idle period: rent is paid from the reserve, a flush never touches more than the surplus.
            d.chain.now = d.now + 365 * 24 * 3600;
            const res2 = await conv.send(mallory.getSender(), { value: toNano('0.01') }, { $$type: 'Flush', queryId: 0n });
            expectNoFailures(res2);
            expect(await d.isActive(conv.address)).toBe(true);
        });
    });

    it('gas: convert succeeds at exactly get_convert_value (mc 1 and 24); converter compute is small', async () => {
        expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('1000'), GRAM));
        expectNoFailures(await collectProtocol(keyA));
        const amt = await d.jBal(d.jA, conv.address);
        let res = await convert(keeper, d.jA, amt / 2n, keyA, 1n, { mc: 1n, value: await convertValue(1n) });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        res = await convert(keeper, d.jA, amt - amt / 2n, keyA, 1n, { mc: 24n, value: await convertValue(24n) });
        expectNoFailures(res);
        const g = gasAt(res, conv.address);
        // eslint-disable-next-line no-console
        console.log('converter gas per tx (ConvertJetton, then payouts/excesses):', g.join(', '));
        expect(g.every((x) => x < 20000n)).toBe(true);
        expect(refundCodes(res)).toEqual([]);
        expect(await d.jBal(d.jA, conv.address)).toBe(0n);
    });
});
