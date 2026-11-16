import { Blockchain, printTransactionFees, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import {
    Router,
    storeProvideBothPayload,
    storeProvideLpPayload,
    storeSwapPayload,
} from '../build/Router_Router';
import { Pool } from '../build/Router_Pool';
import { LpWallet } from '../build/Router_LpWallet';
import { TestJettonMaster } from '../build/TestJetton_TestJettonMaster';
import { TestJettonWallet } from '../build/TestJetton_TestJettonWallet';

// Smoke test: deploy the Router, create a native Gram/jetton pool (two-step deposit), swap both
// ways, then a dual deposit and a burn. The full suite lives in the other dex/tests specs.

const GRAM = new Address(0, Buffer.alloc(32));
const PRINT_FEES = !!process.env.PRINT_FEES;
const MIN_LIQUIDITY = 1000n;
const BPS = 10000n;

function eitherRef(payload: Cell) {
    return beginCell().storeBit(1).storeRef(payload).endCell().beginParse();
}

function deadline() {
    return Math.floor(Date.now() / 1000) + 3600;
}

// Every transaction in the trace must have succeeded (no aborted compute or action phase).
function expectNoFailures(res: SendMessageResult) {
    for (const tx of res.transactions) {
        if (tx.description.type !== 'generic') continue;
        const cp = tx.description.computePhase;
        const ok = !tx.description.aborted && (cp.type === 'skipped' || cp.success) &&
            (tx.description.actionPhase?.success ?? true);
        if (!ok) printTransactionFees(res.transactions);
        expect(ok).toBe(true);
    }
}

function isqrt(n: bigint) {
    if (n < 2n) return n;
    let x = n, y = (x + 1n) / 2n;
    while (y < x) { x = y; y = (x + n / x) / 2n; }
    return x;
}

describe('Marg DEX smoke', () => {
    let chain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let treasury: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let router: SandboxContract<Router>;
    let jetton: SandboxContract<TestJettonMaster>;
    let tokenId: Address;   // the Router's jetton wallet = the token id
    let pool: SandboxContract<Pool>;

    async function jettonWallet(owner: Address) {
        return chain.openContract(TestJettonWallet.fromAddress(await jetton.getGetWalletAddress(owner)));
    }

    async function jettonBalance(owner: Address) {
        const w = await jettonWallet(owner);
        const st = await chain.getContract(w.address);
        if (st.accountState?.type !== 'active') return 0n;
        return (await w.getGetWalletData()).balance;
    }

    async function lpBalance(owner: Address) {
        const w = chain.openContract(LpWallet.fromAddress(await pool.getGetWalletAddress(owner)));
        const st = await chain.getContract(w.address);
        if (st.accountState?.type !== 'active') return 0n;
        return (await w.getGetWalletData()).balance;
    }

    async function sendJettons(from: SandboxContract<TreasuryContract>, amount: bigint, forwardTon: bigint, payload: Cell) {
        const w = await jettonWallet(from.address);
        return w.send(from.getSender(), { value: forwardTon + toNano('0.1') }, {
            $$type: 'JettonTransfer',
            queryId: 0n,
            amount,
            destination: router.address,
            responseDestination: from.address,
            customPayload: null,
            forwardTonAmount: forwardTon,
            forwardPayload: eitherRef(payload),
        });
    }

    beforeEach(async () => {
        chain = await Blockchain.create();
        admin = await chain.treasury('admin');
        treasury = await chain.treasury('treasury');
        alice = await chain.treasury('alice', { balance: toNano('1000000') });
        bob = await chain.treasury('bob', { balance: toNano('1000000') });

        router = chain.openContract(await Router.fromInit(admin.address, treasury.address));
        const dep = await router.send(admin.getSender(), { value: toNano('1') }, null);
        expect(dep.transactions).toHaveTransaction({ to: router.address, deploy: true, success: true });

        jetton = chain.openContract(await TestJettonMaster.fromInit(admin.address, 1n));
        for (const who of [alice, bob]) {
            const res = await jetton.send(admin.getSender(), { value: toNano('0.2') }, {
                $$type: 'TestMint', queryId: 0n, to: who.address, amount: toNano('10000000'),
                responseDestination: admin.address, forwardTonAmount: 0n, forwardPayload: null,
            });
            expectNoFailures(res);
        }
        tokenId = await jetton.getGetWalletAddress(router.address);
        pool = chain.openContract(Pool.fromAddress(await router.getGetPoolAddress(tokenId, GRAM)));
    });

    it('derives the pool address deterministically with Gram as token0', async () => {
        expect((await router.getGetPoolAddress(GRAM, tokenId)).equals(pool.address)).toBe(true);
        const fromInit = await Pool.fromInit(router.address, GRAM, tokenId);
        expect(fromInit.address.equals(pool.address)).toBe(true);
        expect((await router.getGetGramToken()).equals(GRAM)).toBe(true);
    });

    it('creates a native pool in two steps, swaps both ways, dual-deposits and burns', async () => {
        const gramIn = toNano('1000');
        const jetIn = toNano('5000000');

        // Step 1: the Gram side. Pool gets deployed and parks it in alice's LpAccount.
        const r1 = await router.send(alice.getSender(), { value: gramIn + toNano('0.4') }, {
            $$type: 'ProvideLpNative', queryId: 1n, amount: gramIn, otherToken: tokenId,
            minLpOut: 1n, deadline: BigInt(deadline()), lpReceiver: null, refundTo: null,
        });
        if (PRINT_FEES) printTransactionFees(r1.transactions);
        expectNoFailures(r1);
        expect(r1.transactions).toHaveTransaction({ to: pool.address, deploy: true, success: true });

        // Step 2: the jetton side completes the pair and mints LP.
        const p2 = beginCell().store(storeProvideLpPayload({
            $$type: 'ProvideLpPayload', otherToken: GRAM, minLpOut: 1n, deadline: BigInt(deadline()),
            lpReceiver: null, refundTo: null,
        })).endCell();
        const r2 = await sendJettons(alice, jetIn, toNano('0.4'), p2);
        if (PRINT_FEES) printTransactionFees(r2.transactions);
        expectNoFailures(r2);

        let data = await pool.getGetPoolData();
        expect(data.isNative).toBe(true);
        expect(data.token0.equals(GRAM)).toBe(true);
        expect(data.reserve0).toBe(gramIn);
        expect(data.reserve1).toBe(jetIn);
        const liq = isqrt(gramIn * jetIn);
        expect(data.totalSupply).toBe(liq);
        expect(await lpBalance(alice.address)).toBe(liq - MIN_LIQUIDITY);
        expect(await jettonBalance(router.address)).toBe(jetIn);
        // Pool holds its Gram reserve natively, plus the storage buffer.
        const poolBal = (await chain.getContract(pool.address)).balance;
        expect(poolBal).toBeGreaterThanOrEqual(data.reserve0 + data.protocolFee0 + toNano('0.05'));

        // Swap Gram -> jetton (bob), with a referral.
        const swapIn = toNano('10');
        const quote = await pool.getGetExpectedOut(GRAM, swapIn, 10n);
        const bobBefore = await jettonBalance(bob.address);
        const k0 = data.reserve0 * data.reserve1;
        const r3 = await router.send(bob.getSender(), { value: swapIn + toNano('0.3') }, {
            $$type: 'SwapNative', queryId: 3n, amount: swapIn, askToken: tokenId, minOut: quote.amountOut,
            deadline: BigInt(deadline()), receiver: null, refundTo: null, referral: treasury.address,
            refBps: 10n, fwdTon: 0n, fwdPayload: null,
        });
        if (PRINT_FEES) printTransactionFees(r3.transactions);
        expectNoFailures(r3);
        expect(await jettonBalance(bob.address)).toBe(bobBefore + quote.amountOut);
        data = await pool.getGetPoolData();
        expect(data.protocolFee0).toBe(swapIn * 5n / BPS);
        expect(data.reserve0).toBe(gramIn + swapIn - quote.protocolFee - quote.refFee);
        expect(data.reserve0 * data.reserve1).toBeGreaterThanOrEqual(k0);
        expect(r3.transactions).toHaveTransaction({ from: pool.address, to: treasury.address, value: quote.refFee });

        // Swap jetton -> Gram (bob), quote must match execution.
        const jIn = toNano('20000');
        const q2 = await pool.getGetExpectedOut(tokenId, jIn, 0n);
        const sp = beginCell().store(storeSwapPayload({
            $$type: 'SwapPayload', askToken: GRAM, minOut: q2.amountOut, deadline: BigInt(deadline()),
            receiver: null, refundTo: null, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null,
        })).endCell();
        const k1 = data.reserve0 * data.reserve1;
        const r4 = await sendJettons(bob, jIn, toNano('0.3'), sp);
        if (PRINT_FEES) printTransactionFees(r4.transactions);
        expectNoFailures(r4);
        expect(r4.transactions).toHaveTransaction({ from: pool.address, to: bob.address, success: true });
        const payout = r4.transactions.find((t) =>
            t.inMessage?.info.src instanceof Address && t.inMessage.info.src.equals(pool.address) &&
            t.inMessage.info.dest instanceof Address && t.inMessage.info.dest.equals(bob.address));
        const body = payout!.inMessage!.body.beginParse();
        expect(body.loadUint(32)).toBe(0x4d470051);  // GramPayout
        body.loadUintBig(64);
        expect(body.loadUint(8)).toBe(1);            // SWAP_OUT
        expect(body.loadCoins()).toBe(q2.amountOut);
        data = await pool.getGetPoolData();
        expect(data.reserve0 * data.reserve1).toBeGreaterThanOrEqual(k1);

        // Slippage: asking for more than the quote refunds the Gram (minus gas) and changes nothing.
        const before = await pool.getGetPoolData();
        const q3 = await pool.getGetExpectedOut(GRAM, swapIn, 0n);
        const r5 = await router.send(bob.getSender(), { value: swapIn + toNano('0.3') }, {
            $$type: 'SwapNative', queryId: 5n, amount: swapIn, askToken: tokenId, minOut: q3.amountOut + 1n,
            deadline: BigInt(deadline()), receiver: null, refundTo: null, referral: null,
            refBps: 0n, fwdTon: 0n, fwdPayload: null,
        });
        expectNoFailures(r5);
        expect(r5.transactions).toHaveTransaction({ from: pool.address, to: bob.address, success: true });
        const after = await pool.getGetPoolData();
        expect(after.reserve0).toBe(before.reserve0);
        expect(after.reserve1).toBe(before.reserve1);

        // Dual deposit (graduation path, requireEmpty = false here since the pool exists).
        const g = toNano('100');
        const t = toNano('600000');
        const expLp = await pool.getGetExpectedLp(g, t);
        const lpBefore = await lpBalance(bob.address);
        const both = beginCell().store(storeProvideBothPayload({
            $$type: 'ProvideBothPayload', gramAmount: g, minLpOut: expLp.lp, deadline: BigInt(deadline()),
            lpReceiver: bob.address, refundTo: bob.address, requireEmpty: false,
        })).endCell();
        const r6 = await sendJettons(bob, t, g + toNano('0.3'), both);
        if (PRINT_FEES) printTransactionFees(r6.transactions);
        expectNoFailures(r6);
        expect(await lpBalance(bob.address)).toBe(lpBefore + expLp.lp);

        // Burn all of bob's LP: pro-rata out, Gram leg pays bob directly.
        const lp = await lpBalance(bob.address);
        const expBurn = await pool.getGetExpectedBurn(lp);
        const lpw = chain.openContract(LpWallet.fromAddress(await pool.getGetWalletAddress(bob.address)));
        const jBefore = await jettonBalance(bob.address);
        const r7 = await lpw.send(bob.getSender(), { value: toNano('0.3') }, {
            $$type: 'JettonBurn', queryId: 7n, amount: lp, responseDestination: bob.address,
            customPayload: null,
        });
        if (PRINT_FEES) printTransactionFees(r7.transactions);
        expectNoFailures(r7);
        expect(await lpBalance(bob.address)).toBe(0n);
        expect(await jettonBalance(bob.address)).toBe(jBefore + expBurn.out1);

        // Solvency: the Router's wallet holds at least reserve1 + protocolFee1; the pool its Gram.
        data = await pool.getGetPoolData();
        expect(await jettonBalance(router.address)).toBeGreaterThanOrEqual(data.reserve1 + data.protocolFee1);
        expect((await chain.getContract(pool.address)).balance)
            .toBeGreaterThanOrEqual(data.reserve0 + data.protocolFee0 + toNano('0.05'));
    });

    it('refunds jettons sent with a garbage or empty payload (try/catch parse path)', async () => {
        const before = await jettonBalance(alice.address);
        for (const fp of [
            beginCell().storeBit(0).storeUint(0xdeadbeef, 32).endCell().beginParse(),   // unknown op
            beginCell().storeBit(1).storeRef(beginCell().storeUint(0x4d470001, 32).endCell()).endCell().beginParse(), // truncated SwapPayload
            beginCell().endCell().beginParse(),                                          // no Either bit at all
        ]) {
            const w = await jettonWallet(alice.address);
            const res = await w.send(alice.getSender(), { value: toNano('0.3') }, {
                $$type: 'JettonTransfer', queryId: 0n, amount: 123n, destination: router.address,
                responseDestination: alice.address, customPayload: null, forwardTonAmount: toNano('0.2'),
                forwardPayload: fp,
            });
            expectNoFailures(res);
        }
        expect(await jettonBalance(alice.address)).toBe(before);
        expect(await jettonBalance(router.address)).toBe(0n);
    });

    it('creates a jetton/jetton pool and swaps A -> B', async () => {
        const jettonB = chain.openContract(await TestJettonMaster.fromInit(admin.address, 2n));
        await jettonB.send(admin.getSender(), { value: toNano('0.2') }, {
            $$type: 'TestMint', queryId: 0n, to: alice.address, amount: toNano('1000000'),
            responseDestination: admin.address, forwardTonAmount: 0n, forwardPayload: null,
        });
        const tokenB = await jettonB.getGetWalletAddress(router.address);
        const walletB = chain.openContract(TestJettonWallet.fromAddress(await jettonB.getGetWalletAddress(alice.address)));
        const provide = (other: Address) => beginCell().store(storeProvideLpPayload({
            $$type: 'ProvideLpPayload', otherToken: other, minLpOut: 1n, deadline: BigInt(deadline()),
            lpReceiver: null, refundTo: null,
        })).endCell();

        expectNoFailures(await sendJettons(alice, toNano('1000'), toNano('0.4'), provide(tokenB)));
        expectNoFailures(await walletB.send(alice.getSender(), { value: toNano('0.5') }, {
            $$type: 'JettonTransfer', queryId: 0n, amount: toNano('4000'), destination: router.address,
            responseDestination: alice.address, customPayload: null, forwardTonAmount: toNano('0.4'),
            forwardPayload: eitherRef(provide(tokenId)),
        }));
        const jj = chain.openContract(Pool.fromAddress(await router.getGetPoolAddress(tokenId, tokenB)));
        const d = await jj.getGetPoolData();
        expect(d.isNative).toBe(false);
        expect(d.totalSupply).toBe(isqrt(toNano('1000') * toNano('4000')));

        const q = await jj.getGetExpectedOut(tokenId, toNano('10'), 0n);
        const sp = beginCell().store(storeSwapPayload({
            $$type: 'SwapPayload', askToken: tokenB, minOut: q.amountOut, deadline: BigInt(deadline()),
            receiver: bob.address, refundTo: null, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null,
        })).endCell();
        const res = await sendJettons(alice, toNano('10'), toNano('0.3'), sp);
        if (PRINT_FEES) printTransactionFees(res.transactions);
        expectNoFailures(res);
        const bobB = chain.openContract(TestJettonWallet.fromAddress(await jettonB.getGetWalletAddress(bob.address)));
        expect((await bobB.getGetWalletData()).balance).toBe(q.amountOut);
    });

    it('graduation-style dual deposit creates the pool and locks LP at the zero address', async () => {
        const g = toNano('500');
        const t = toNano('200000000');
        const payload = beginCell().store(storeProvideBothPayload({
            $$type: 'ProvideBothPayload', gramAmount: g, minLpOut: 1n, deadline: BigInt(deadline()),
            lpReceiver: GRAM, refundTo: treasury.address, requireEmpty: true,
        })).endCell();
        expect(payload.bits.length).toBeLessThanOrEqual(1023);
        expect(payload.refs.length).toBe(0);
        // The jetton master mints straight into the Router's wallet, like the launchpad would.
        const res = await jetton.send(admin.getSender(), { value: g + toNano('0.4') }, {
            $$type: 'TestMint', queryId: 9n, to: router.address, amount: t,
            responseDestination: treasury.address, forwardTonAmount: g + toNano('0.3'), forwardPayload: payload,
        });
        if (PRINT_FEES) printTransactionFees(res.transactions);
        expectNoFailures(res);
        const data = await pool.getGetPoolData();
        expect(data.reserve0).toBe(g);
        expect(data.reserve1).toBe(t);
        expect(await lpBalance(GRAM)).toBe(isqrt(g * t) - MIN_LIQUIDITY);

        // A second graduation into the now non-empty pool is refunded to the treasury.
        const tBefore = await jettonBalance(treasury.address);
        const res2 = await jetton.send(admin.getSender(), { value: g + toNano('0.4') }, {
            $$type: 'TestMint', queryId: 10n, to: router.address, amount: t,
            responseDestination: treasury.address, forwardTonAmount: g + toNano('0.3'), forwardPayload: payload,
        });
        expectNoFailures(res2);
        expect(await jettonBalance(treasury.address)).toBe(tBefore + t);
        expect((await pool.getGetPoolData()).reserve0).toBe(g);
    });
});
