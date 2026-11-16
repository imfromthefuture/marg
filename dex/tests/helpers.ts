// Shared fixture for the Marg DEX sandbox suite.
// Everything here runs in @ton/sandbox only: no network, no wallets, no mnemonics.

import {
    Blockchain,
    BlockchainSnapshot,
    BlockchainTransaction,
    printTransactionFees,
    SandboxContract,
    SendMessageResult,
    TreasuryContract,
} from '@ton/sandbox';
import { Address, beginCell, Cell, Slice, toNano, Transaction } from '@ton/core';
import '@ton/test-utils';
import {
    Router,
    storeProvideBothPayload,
    storeProvideLpPayload,
    storeRemoveParams,
    storeSwapPayload,
    Router_errors_backward,
} from '../build/Router_Router';
import { Pool, Pool_errors_backward } from '../build/Router_Pool';
import { LpWallet, LpWallet_errors_backward } from '../build/Router_LpWallet';
import { LpAccount, LpAccount_errors_backward } from '../build/Router_LpAccount';
import { TestJettonMaster } from '../build/TestJetton_TestJettonMaster';
import { TestJettonWallet } from '../build/TestJetton_TestJettonWallet';
import { FakeJettonWallet } from '../build/Fake_FakeJettonWallet';

export * from '../build/Router_Router';
export { Pool, LpWallet, LpAccount, TestJettonMaster, TestJettonWallet, FakeJettonWallet };

export const GRAM = new Address(0, Buffer.alloc(32));
export const T0 = 1_800_000_000;                 // fixed chain time, so deadlines are deterministic
export const PRINT_FEES = !!process.env.PRINT_FEES;

export const OP = {
    GramPayout: 0x4d470051,
    PayTo: 0x4d470031,
    JettonTransfer: 0x0f8a7ea5,
    JettonNotification: 0x7362d09c,
    JettonExcesses: 0xd53276db,
    SwapEvent: 0x4d470061,
    LiquidityEvent: 0x4d470062,
    RefundEvent: 0x4d470063,
    TakeWalletAddress: 0xd1735400,
};

export const ERR = {
    router: Router_errors_backward as Record<string, number>,
    pool: Pool_errors_backward as Record<string, number>,
    lpWallet: LpWallet_errors_backward as Record<string, number>,
    lpAccount: LpAccount_errors_backward as Record<string, number>,
};

// ---------------------------------------------------------------------------
// Reference math, written independently of the contract (BigInt, floor division)
// ---------------------------------------------------------------------------

export const BPS = 10000n;

export function isqrt(n: bigint): bigint {
    if (n < 0n) throw new Error('negative');
    if (n < 2n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + n / x) / 2n;
    }
    return x;
}

export function modelSwap(amountIn: bigint, rIn: bigint, rOut: bigint, lpBps: bigint, protoBps: bigint, refBps: bigint) {
    if (amountIn <= 0n || rIn <= 0n || rOut <= 0n) return { amountOut: 0n, protocolFee: 0n, refFee: 0n };
    const protocolFee = (amountIn * protoBps) / BPS;
    const refFee = (amountIn * refBps) / BPS;
    const inWithFee = amountIn * (BPS - lpBps - protoBps - refBps);
    const amountOut = (inWithFee * rOut) / (rIn * BPS + inWithFee);
    return { amountOut, protocolFee, refFee };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const bmin = (a: bigint, b: bigint) => (a < b ? a : b);

export function modelAdd(a0: bigint, a1: bigint, r0: bigint, r1: bigint, S: bigint) {
    if (a0 <= 0n || a1 <= 0n) return { lp: 0n, use0: 0n, use1: 0n };
    if (S === 0n) {
        const liq = isqrt(a0 * a1);
        return { lp: liq > 1000n ? liq - 1000n : 0n, use0: a0, use1: a1 };
    }
    let use0 = a0;
    let use1 = a1;
    // Ceil a fine counterpart; floor a coarse one and ceil the limiting side (see calcAddLiquidity).
    const COARSE = 1_000_000n;
    if ((a0 * S) / r0 <= (a1 * S) / r1) {
        const c = ceilDiv(a0 * r1, r0);
        if (c >= COARSE) use1 = bmin(a1, c);
        else {
            use1 = bmin(a1, (a0 * r1) / r0);
            use0 = bmin(a0, ceilDiv(use1 * r0, r1));
        }
    } else {
        const c = ceilDiv(a1 * r0, r1);
        if (c >= COARSE) use0 = bmin(a0, c);
        else {
            use0 = bmin(a0, (a1 * r0) / r1);
            use1 = bmin(a1, ceilDiv(use0 * r1, r0));
        }
    }
    return { lp: bmin((use0 * S) / r0, (use1 * S) / r1), use0, use1 };
}

export function modelBurn(amount: bigint, r0: bigint, r1: bigint, S: bigint) {
    return { out0: (amount * r0) / S, out1: (amount * r1) / S };
}

// Deterministic PRNG (mulberry32) for the fuzz tests.
export function rng(seed: number) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
        big: (lo: bigint, hi: bigint) => lo + (BigInt(Math.floor(next() * 2 ** 52)) * (hi - lo + 1n)) / 2n ** 52n,
        pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)],
    };
}

// ---------------------------------------------------------------------------
// Trace inspection
// ---------------------------------------------------------------------------

export function txOk(tx: BlockchainTransaction | Transaction) {
    if (tx.description.type !== 'generic') return true;
    const cp = tx.description.computePhase;
    // A non-bounceable dust payout (e.g. a 1000-nanogram referral fee) cannot buy gas at the
    // recipient: the compute phase is skipped and the tx is marked aborted, but the value was
    // already credited. Nothing is lost, so it is not a failure.
    if (cp.type === 'skipped' && cp.reason === 'no-gas' &&
        tx.inMessage?.info.type === 'internal' && !tx.inMessage.info.bounce) return true;
    return !tx.description.aborted && (cp.type === 'skipped' || cp.success) && (tx.description.actionPhase?.success ?? true);
}

// Every transaction in the trace succeeded, except those matched by `allow` (intended failures).
export function expectNoFailures(res: SendMessageResult, allow?: (tx: BlockchainTransaction) => boolean) {
    const bad = res.transactions.filter((tx) => !txOk(tx) && !(allow && allow(tx)));
    if (bad.length > 0) {
        printTransactionFees(res.transactions);
        for (const tx of bad) {
            const d: any = tx.description;
            // eslint-disable-next-line no-console
            console.log('FAILED tx to', tx.inMessage?.info.dest?.toString(), 'exit', d.computePhase?.exitCode,
                'action', d.actionPhase?.resultCode);
        }
    }
    expect(bad.length).toBe(0);
}

export function fees(res: SendMessageResult, label?: string) {
    if (PRINT_FEES) {
        // eslint-disable-next-line no-console
        if (label) console.log(label);
        printTransactionFees(res.transactions);
    }
}

// Sum of all fees paid across a trace (compute + action + storage + forward, as charged).
export function traceFees(res: SendMessageResult) {
    let total = 0n;
    for (const tx of res.transactions) total += tx.totalFees.coins;
    for (const tx of res.transactions) {
        for (const m of tx.outMessages.values()) {
            if (m.info.type === 'internal') total += m.info.forwardFee;
        }
    }
    return total;
}

const src = (tx: BlockchainTransaction) => (tx.inMessage?.info.src instanceof Address ? tx.inMessage.info.src : null);
const dst = (tx: BlockchainTransaction) => (tx.inMessage?.info.dest instanceof Address ? tx.inMessage.info.dest : null);

export function txsBetween(res: SendMessageResult, from: Address | null, to: Address | null) {
    return res.transactions.filter((tx) => {
        const s = src(tx);
        const d = dst(tx);
        return (!from || (s && s.equals(from))) && (!to || (d && d.equals(to)));
    });
}

export function opOf(tx: BlockchainTransaction) {
    const b = tx.inMessage?.body.beginParse();
    if (!b || b.remainingBits < 32) return null;
    return b.preloadUint(32);
}

export function inValue(tx: BlockchainTransaction) {
    return tx.inMessage?.info.type === 'internal' ? tx.inMessage.info.value.coins : 0n;
}

// Original forward fee of a transaction's inbound message, as Tact's readForwardFee() sees it.
export function readForwardFee(tx: BlockchainTransaction) {
    if (tx.inMessage?.info.type !== 'internal') throw new Error('not internal');
    return (tx.inMessage.info.forwardFee * 65536n) / (65536n - 21845n);
}

export type GramPayoutMsg = { from: Address; to: Address; value: bigint; reason: number; amount: bigint; payload: Cell | null; queryId: bigint };

export function gramPayouts(res: SendMessageResult, to?: Address): GramPayoutMsg[] {
    const out: GramPayoutMsg[] = [];
    for (const tx of res.transactions) {
        if (opOf(tx) !== OP.GramPayout) continue;
        const d = dst(tx)!;
        if (to && !d.equals(to)) continue;
        const b = tx.inMessage!.body.beginParse();
        b.loadUint(32);
        const queryId = b.loadUintBig(64);
        const reason = b.loadUint(8);
        const amount = b.loadCoins();
        const payload = b.loadMaybeRef();
        out.push({ from: src(tx)!, to: d, value: inValue(tx), reason, amount, payload, queryId });
    }
    return out;
}

export type PayToMsg = { wallet: Address; amount: bigint; to: Address; excessTo: Address; fwdTon: bigint; reason: number };

export function payTos(res: SendMessageResult): PayToMsg[] {
    const out: PayToMsg[] = [];
    for (const tx of res.transactions) {
        if (opOf(tx) !== OP.PayTo) continue;
        const b = tx.inMessage!.body.beginParse();
        b.loadUint(32);
        b.loadUintBig(64);
        b.loadAddress();
        b.loadAddress();
        const wallet = b.loadAddress();
        const amount = b.loadCoins();
        // Tact may move trailing fields into a ref: follow it if needed.
        let c: Slice = b;
        if (c.remainingBits < 267) c = c.loadRef().beginParse();
        const to = c.loadAddress();
        if (c.remainingBits < 267) c = c.loadRef().beginParse();
        const excessTo = c.loadAddress();
        const fwdTon = c.loadCoins();
        c.loadMaybeRef();
        const reason = c.loadUint(8);
        out.push({ wallet, amount, to, excessTo, fwdTon, reason });
    }
    return out;
}

export type Ev = { from: Address; op: number; body: Slice };

export function events(res: SendMessageResult): Ev[] {
    const out: Ev[] = [];
    for (const tx of res.transactions) {
        for (const m of tx.outMessages.values()) {
            if (m.info.type !== 'external-out') continue;
            const b = m.body.beginParse();
            if (b.remainingBits < 32) continue;
            out.push({ from: m.info.src, op: b.preloadUint(32), body: b });
        }
    }
    return out;
}

export function refundCodes(res: SendMessageResult): number[] {
    return events(res)
        .filter((e) => e.op === OP.RefundEvent)
        .map((e) => {
            const b = e.body.clone();
            b.loadUint(32);
            b.loadUintBig(64);
            b.loadAddress();
            return b.loadUint(16);
        });
}

export function swapEvents(res: SendMessageResult) {
    return events(res)
        .filter((e) => e.op === OP.SwapEvent)
        .map((e) => {
            const b = e.body.clone();
            b.loadUint(32);
            const fromUser = b.loadAddress();
            const inIsToken0 = b.loadBit();
            const amountIn = b.loadCoins();
            const amountOut = b.loadCoins();
            const protocolFee = b.loadCoins();
            let c: Slice = b;
            if (c.remainingBits < 4) c = c.loadRef().beginParse();
            const refFee = c.loadCoins();
            return { fromUser, inIsToken0, amountIn, amountOut, protocolFee, refFee };
        });
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export type SwapOpts = {
    minOut?: bigint;
    deadline?: bigint;
    receiver?: Address | null;
    refundTo?: Address | null;
    referral?: Address | null;
    refBps?: bigint;
    fwdTon?: bigint;
    fwdPayload?: Cell | null;
    gas?: bigint;           // forwardTonAmount (jetton) or value above amount + fwdTon (native)
    walletValue?: bigint;   // extra value for the user's own jetton wallet hop
};

export type ProvideOpts = {
    minLpOut?: bigint;
    deadline?: bigint;
    lpReceiver?: Address | null;
    refundTo?: Address | null;
    gas?: bigint;
};

export type BothOpts = {
    minLpOut?: bigint;
    deadline?: bigint;
    lpReceiver?: Address;
    refundTo?: Address;
    requireEmpty?: boolean;
    gas?: bigint;
};

export function eitherRef(payload: Cell): Slice {
    return beginCell().storeBit(1).storeRef(payload).endCell().beginParse();
}

export function eitherInline(payload: Cell): Slice {
    return beginCell().storeBit(0).storeSlice(payload.beginParse()).endCell().beginParse();
}

export class Dex {
    chain!: Blockchain;
    admin!: SandboxContract<TreasuryContract>;
    treasury!: SandboxContract<TreasuryContract>;
    alice!: SandboxContract<TreasuryContract>;
    bob!: SandboxContract<TreasuryContract>;
    carol!: SandboxContract<TreasuryContract>;
    router!: SandboxContract<Router>;
    jA!: SandboxContract<TestJettonMaster>;
    jB!: SandboxContract<TestJettonMaster>;
    jC!: SandboxContract<TestJettonMaster>;
    tokA!: Address;   // Router's wallet of jA = token id
    tokB!: Address;
    tokC!: Address;
    // Every (pool, user) pair that may hold an LpAccount, for the solvency check.
    lpAccountsSeen = new Map<string, { pool: Address; user: Address }>();

    static async create(): Promise<Dex> {
        const d = new Dex();
        d.chain = await Blockchain.create();
        d.chain.now = T0;
        d.admin = await d.chain.treasury('admin');
        d.treasury = await d.chain.treasury('treasury');
        d.alice = await d.chain.treasury('alice', { balance: toNano('10000000') });
        d.bob = await d.chain.treasury('bob', { balance: toNano('10000000') });
        d.carol = await d.chain.treasury('carol', { balance: toNano('10000000') });

        d.router = d.chain.openContract(await Router.fromInit(d.admin.address, d.treasury.address));
        const dep = await d.router.send(d.admin.getSender(), { value: toNano('1') }, null);
        expect(dep.transactions).toHaveTransaction({ to: d.router.address, deploy: true, success: true });

        const jettons: SandboxContract<TestJettonMaster>[] = [];
        for (const salt of [1n, 2n, 3n]) {
            const j = d.chain.openContract(await TestJettonMaster.fromInit(d.admin.address, salt));
            for (const who of [d.alice, d.bob, d.carol]) {
                const res = await j.send(d.admin.getSender(), { value: toNano('0.2') }, {
                    $$type: 'TestMint', queryId: 0n, to: who.address, amount: toNano('100000000'),
                    responseDestination: d.admin.address, forwardTonAmount: 0n, forwardPayload: null,
                });
                expectNoFailures(res);
            }
            jettons.push(j);
        }
        [d.jA, d.jB, d.jC] = jettons;
        d.tokA = await d.jA.getGetWalletAddress(d.router.address);
        d.tokB = await d.jB.getGetWalletAddress(d.router.address);
        d.tokC = await d.jC.getGetWalletAddress(d.router.address);
        return d;
    }

    get now() {
        return this.chain.now!;
    }

    deadline(dt = 3600) {
        return BigInt(this.now + dt);
    }

    masterOf(token: Address): SandboxContract<TestJettonMaster> {
        if (token.equals(this.tokA)) return this.jA;
        if (token.equals(this.tokB)) return this.jB;
        if (token.equals(this.tokC)) return this.jC;
        throw new Error('unknown token');
    }

    // --- addresses and balances ---

    async poolOf(a: Address, b: Address) {
        return this.chain.openContract(Pool.fromAddress(await this.router.getGetPoolAddress(a, b)));
    }

    async gram(addr: Address) {
        return (await this.chain.getContract(addr)).balance;
    }

    async isActive(addr: Address) {
        return (await this.chain.getContract(addr)).accountState?.type === 'active';
    }

    async jWallet(master: SandboxContract<TestJettonMaster>, owner: Address) {
        return this.chain.openContract(TestJettonWallet.fromAddress(await master.getGetWalletAddress(owner)));
    }

    async jBal(master: SandboxContract<TestJettonMaster>, owner: Address) {
        const w = await this.jWallet(master, owner);
        if (!(await this.isActive(w.address))) return 0n;
        return (await w.getGetWalletData()).balance;
    }

    // Balance of the Router's wallet for a token id.
    async routerHolds(token: Address) {
        if (!(await this.isActive(token))) return 0n;
        return (await this.chain.openContract(TestJettonWallet.fromAddress(token)).getGetWalletData()).balance;
    }

    async lpWallet(pool: SandboxContract<Pool>, owner: Address) {
        return this.chain.openContract(LpWallet.fromAddress(await pool.getGetWalletAddress(owner)));
    }

    async lpBal(pool: SandboxContract<Pool>, owner: Address) {
        const w = await this.lpWallet(pool, owner);
        if (!(await this.isActive(w.address))) return 0n;
        return (await w.getGetWalletData()).balance;
    }

    async lpAccount(pool: SandboxContract<Pool>, user: Address) {
        return this.chain.openContract(LpAccount.fromAddress(await pool.getGetLpAccountAddress(user)));
    }

    async pending(pool: SandboxContract<Pool>, user: Address) {
        const a = await this.lpAccount(pool, user);
        if (!(await this.isActive(a.address))) return { pending0: 0n, pending1: 0n, isNative: false };
        return a.getGetLpAccountData();
    }

    private async noteLpAccount(a: Address, b: Address, user: Address) {
        const pool = await this.router.getGetPoolAddress(a, b);
        this.lpAccountsSeen.set(pool.toString() + user.toString(), { pool, user });
    }

    // --- raw jetton send (user wallet -> Router) ---

    async sendJettons(master: SandboxContract<TestJettonMaster>, from: SandboxContract<TreasuryContract>, amount: bigint,
                      forwardTon: bigint, forwardPayload: Slice, walletValue = toNano('0.1'), destination?: Address) {
        const w = await this.jWallet(master, from.address);
        return w.send(from.getSender(), { value: forwardTon + walletValue }, {
            $$type: 'JettonTransfer',
            queryId: 0n,
            amount,
            destination: destination ?? this.router.address,
            responseDestination: from.address,
            customPayload: null,
            forwardTonAmount: forwardTon,
            forwardPayload,
        });
    }

    // --- flows ---

    swapPayload(askToken: Address, o: SwapOpts = {}) {
        return beginCell().store(storeSwapPayload({
            $$type: 'SwapPayload',
            askToken,
            minOut: o.minOut ?? 0n,
            deadline: o.deadline ?? this.deadline(),
            receiver: o.receiver ?? null,
            refundTo: o.refundTo ?? null,
            referral: o.referral ?? null,
            refBps: o.refBps ?? 0n,
            fwdTon: o.fwdTon ?? 0n,
            fwdPayload: o.fwdPayload ?? null,
        })).endCell();
    }

    async swapJetton(master: SandboxContract<TestJettonMaster>, from: SandboxContract<TreasuryContract>, amount: bigint,
                     askToken: Address, o: SwapOpts = {}) {
        const gas = o.gas ?? toNano('0.3') + (o.fwdTon ?? 0n);
        return this.sendJettons(master, from, amount, gas, eitherRef(this.swapPayload(askToken, o)), o.walletValue);
    }

    async swapNative(from: SandboxContract<TreasuryContract>, amount: bigint, askToken: Address, o: SwapOpts = {}) {
        const gas = o.gas ?? toNano('0.3');
        return this.router.send(from.getSender(), { value: amount + gas + (o.fwdTon ?? 0n) }, {
            $$type: 'SwapNative',
            queryId: 1n,
            amount,
            askToken,
            minOut: o.minOut ?? 0n,
            deadline: o.deadline ?? this.deadline(),
            receiver: o.receiver ?? null,
            refundTo: o.refundTo ?? null,
            referral: o.referral ?? null,
            refBps: o.refBps ?? 0n,
            fwdTon: o.fwdTon ?? 0n,
            fwdPayload: o.fwdPayload ?? null,
        });
    }

    providePayload(otherToken: Address, o: ProvideOpts = {}) {
        return beginCell().store(storeProvideLpPayload({
            $$type: 'ProvideLpPayload',
            otherToken,
            minLpOut: o.minLpOut ?? 0n,
            deadline: o.deadline ?? this.deadline(),
            lpReceiver: o.lpReceiver ?? null,
            refundTo: o.refundTo ?? null,
        })).endCell();
    }

    async provideJetton(master: SandboxContract<TestJettonMaster>, from: SandboxContract<TreasuryContract>, amount: bigint,
                        otherToken: Address, o: ProvideOpts = {}) {
        const tokenIn = await master.getGetWalletAddress(this.router.address);
        await this.noteLpAccount(tokenIn, otherToken, from.address);
        return this.sendJettons(master, from, amount, o.gas ?? toNano('0.4'), eitherRef(this.providePayload(otherToken, o)));
    }

    async provideNative(from: SandboxContract<TreasuryContract>, amount: bigint, otherToken: Address, o: ProvideOpts = {}) {
        await this.noteLpAccount(GRAM, otherToken, from.address);
        return this.router.send(from.getSender(), { value: amount + (o.gas ?? toNano('0.4')) }, {
            $$type: 'ProvideLpNative',
            queryId: 2n,
            amount,
            otherToken,
            minLpOut: o.minLpOut ?? 0n,
            deadline: o.deadline ?? this.deadline(),
            lpReceiver: o.lpReceiver ?? null,
            refundTo: o.refundTo ?? null,
        });
    }

    bothPayload(gramAmount: bigint, o: BothOpts & { lpReceiver: Address; refundTo: Address }) {
        return beginCell().store(storeProvideBothPayload({
            $$type: 'ProvideBothPayload',
            gramAmount,
            minLpOut: o.minLpOut ?? 0n,
            deadline: o.deadline ?? this.deadline(),
            lpReceiver: o.lpReceiver,
            refundTo: o.refundTo,
            requireEmpty: o.requireEmpty ?? false,
        })).endCell();
    }

    async provideBoth(master: SandboxContract<TestJettonMaster>, from: SandboxContract<TreasuryContract>, jetAmount: bigint,
                      gramAmount: bigint, o: BothOpts = {}) {
        const p = this.bothPayload(gramAmount, { ...o, lpReceiver: o.lpReceiver ?? from.address, refundTo: o.refundTo ?? from.address });
        return this.sendJettons(master, from, jetAmount, gramAmount + (o.gas ?? toNano('0.3')), eitherRef(p));
    }

    // A native pool (GRAM, token) seeded with a dual deposit.
    async seedNative(master: SandboxContract<TestJettonMaster>, g: bigint, t: bigint, from = this.alice) {
        const res = await this.provideBoth(master, from, t, g);
        expectNoFailures(res);
        return this.poolOf(GRAM, await master.getGetWalletAddress(this.router.address));
    }

    // A jetton/jetton pool seeded in two steps.
    async seedJJ(mA: SandboxContract<TestJettonMaster>, a: bigint, mB: SandboxContract<TestJettonMaster>, b: bigint, from = this.alice) {
        const tA = await mA.getGetWalletAddress(this.router.address);
        const tB = await mB.getGetWalletAddress(this.router.address);
        expectNoFailures(await this.provideJetton(mA, from, a, tB));
        expectNoFailures(await this.provideJetton(mB, from, b, tA));
        return this.poolOf(tA, tB);
    }

    async burnLp(pool: SandboxContract<Pool>, from: SandboxContract<TreasuryContract>, amount: bigint,
                 o: { min0?: bigint; min1?: bigint; deadline?: bigint; noParams?: boolean; value?: bigint; response?: Address | null } = {}) {
        const w = await this.lpWallet(pool, from.address);
        const params = o.noParams ? null : beginCell().store(storeRemoveParams({
            $$type: 'RemoveParams', min0: o.min0 ?? 0n, min1: o.min1 ?? 0n, deadline: o.deadline ?? this.deadline(),
        })).endCell();
        return w.send(from.getSender(), { value: o.value ?? toNano('0.3') }, {
            $$type: 'JettonBurn', queryId: 5n, amount, responseDestination: o.response === undefined ? from.address : o.response,
            customPayload: params,
        });
    }

    async transferLp(pool: SandboxContract<Pool>, from: SandboxContract<TreasuryContract>, to: Address, amount: bigint, value = toNano('0.1')) {
        const w = await this.lpWallet(pool, from.address);
        return w.send(from.getSender(), { value }, {
            $$type: 'JettonTransfer', queryId: 6n, amount, destination: to, responseDestination: from.address,
            customPayload: null, forwardTonAmount: 0n, forwardPayload: beginCell().storeBit(0).endCell().beginParse(),
        });
    }

    async fake(owner: SandboxContract<TreasuryContract>, salt = 0n) {
        const f = this.chain.openContract(await FakeJettonWallet.fromInit(owner.address, salt));
        await f.send(owner.getSender(), { value: toNano('100') }, null);
        return f;
    }

    // `fake` sends `body` to `to` with `value`.
    async fakeSend(f: SandboxContract<FakeJettonWallet>, owner: SandboxContract<TreasuryContract>, to: Address, body: Cell,
                   value = toNano('0.5'), bounce = true) {
        return f.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'FakeSend', to, value, bounce, body });
    }

    // --- invariants ---

    // Router wallet balance per token >= what pools and LpAccounts owe; native pools hold their Gram.
    // With exact = true the jetton balances must match to the unit (no donations in the test).
    async checkSolvency(pools: SandboxContract<Pool>[], exact = false) {
        const owed = new Map<string, bigint>();
        const add = (t: Address, v: bigint) => {
            if (t.equals(GRAM)) return;
            owed.set(t.toString(), (owed.get(t.toString()) ?? 0n) + v);
        };
        for (const p of pools) {
            if (!(await this.isActive(p.address))) continue;
            const d = await p.getGetPoolData();
            add(d.token0, d.reserve0 + d.protocolFee0);
            add(d.token1, d.reserve1 + d.protocolFee1);
            if (d.isNative) {
                expect(await this.gram(p.address)).toBeGreaterThanOrEqual(d.reserve0 + d.protocolFee0 + toNano('0.049'));
            }
            // MIN_LIQUIDITY is never owned: supply always exceeds LP in wallets, and reserves stay positive.
            if (d.totalSupply > 0n) {
                expect(d.totalSupply).toBeGreaterThan(1000n);
                expect(d.reserve0).toBeGreaterThan(0n);
                expect(d.reserve1).toBeGreaterThan(0n);
            }
        }
        for (const { pool, user } of this.lpAccountsSeen.values()) {
            const p = this.chain.openContract(Pool.fromAddress(pool));
            if (!(await this.isActive(pool))) continue;
            const d = await p.getGetPoolData();
            const acc = await this.lpAccount(p, user);
            if (!(await this.isActive(acc.address))) continue;
            const a = await acc.getGetLpAccountData();
            add(d.token0, a.pending0);
            add(d.token1, a.pending1);
            if (a.isNative) expect(await this.gram(acc.address)).toBeGreaterThanOrEqual(a.pending0);
        }
        for (const [t, v] of owed) {
            const held = await this.routerHolds(Address.parse(t));
            if (exact) expect(held).toBe(v);
            else expect(held).toBeGreaterThanOrEqual(v);
        }
    }

    snapshot(): BlockchainSnapshot {
        return this.chain.snapshot();
    }

    async restore(s: BlockchainSnapshot) {
        await this.chain.loadFrom(s);
    }
}

export const ZERO = 0n;
export { toNano };
