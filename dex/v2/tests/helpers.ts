// Shared fixture for the Marg DEX v2 sandbox suite. Sandbox only: no network, no wallets.

import {
    Blockchain,
    BlockchainTransaction,
    createShardAccount,
    printTransactionFees,
    SandboxContract,
    SendMessageResult,
    TreasuryContract,
} from '@ton/sandbox';
import { Address, beginCell, Cell, Slice, toNano, Transaction } from '@ton/core';
import '@ton/test-utils';
import {
    Router,
    storeSwapPayload,
    storeMintPayload,
    storeGraduatePayload,
    storeLaunchPayload,
    loadLaunchEvent,
    storeKeyExt,
    loadSwapEvent,
    loadModifyEvent,
    loadRefundEvent,
    loadInitializeEvent,
    KeyExt,
} from '../build/Router_Router';
import { Pool } from '../build/Router_Pool';
import { Position } from '../build/Router_Position';
import { MintAccount } from '../build/Router_MintAccount';
import { TestJettonMaster } from '../build/TestJetton_TestJettonMaster';
import { TestJettonWallet } from '../build/TestJetton_TestJettonWallet';
import { FakeJettonWallet } from '../build/Fake_FakeJettonWallet';

export * from '../build/Router_Router';
export { Pool, Position, MintAccount, TestJettonMaster, TestJettonWallet, FakeJettonWallet };

export const GRAM = new Address(0, Buffer.alloc(32));
export const T0 = 1_800_000_000;
export const PRINT_FEES = !!process.env.PRINT_FEES;

export const Q96 = 2n ** 96n;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

export const OP = {
    GramPayout: 0x4d480061,
    PayTo: 0x4d480031,
    PositionSync: 0x4d480044,
    SwapEvent: 0x4d480071,
    ModifyEvent: 0x4d480072,
    RefundEvent: 0x4d480073,
    InitializeEvent: 0x4d480074,
    LaunchEvent: 0x4d480075,
    PoolLaunch: 0x4d480026,
    PoolSwap: 0x4d480021,
};

export const CODE = {
    DEADLINE: 201, SLIPPAGE: 202, LOW_GAS: 204, BAD_PAYLOAD: 205, ZERO_OUT: 208, OVERFLOW: 209,
    BAD_RECIPIENT: 215, NOT_INITIALIZED: 217, NOT_INITIALIZER: 218, BAD_TICKS: 219, PRICE_OUT_OF_RANGE: 220,
    LIQUIDITY_BELOW_MIN: 221, PARTIAL_NOT_ALLOWED: 222, NO_LIQUIDITY: 223, TICK_LIMIT: 224, LOCKED: 225,
    BAD_KEY: 227, BAD_TICK_SPACING: 228, CREATION_PAUSED: 207, MINT_MISMATCH: 234, MATH_FAILURE: 229, BAD_PRICE_LIMIT: 230, ALREADY_INITIALIZED: 231,
};

export const STOP = { FILLED: 0, LIMIT: 1, CROSSINGS: 2, STEPS: 3, NO_LIQUIDITY: 4 };

// ---------------------------------------------------------------------------
// Small math helpers (BigInt)
// ---------------------------------------------------------------------------

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

// sqrt(amount1 / amount0) in Q64.96, floor.
export function encodeSqrtPrice(amount1: bigint, amount0: bigint): bigint {
    return isqrt((amount1 << 192n) / amount0);
}

// ---------------------------------------------------------------------------
// Trace inspection
// ---------------------------------------------------------------------------

export function txOk(tx: BlockchainTransaction | Transaction) {
    if (tx.description.type !== 'generic') return true;
    const cp = tx.description.computePhase;
    if (cp.type === 'skipped' && cp.reason === 'no-gas' &&
        tx.inMessage?.info.type === 'internal' && !tx.inMessage.info.bounce) return true;
    // A dust GramPayout (non-final leg: value == amount, e.g. a tiny referral fee or partial refund)
    // cannot pay for the receiving wallet's compute phase. It is non-bounceable, so the Gram is
    // still credited (credit phase precedes compute); nothing is lost.
    if (cp.type === 'vm' && cp.exitCode === -14 && tx.inMessage?.info.type === 'internal' && !tx.inMessage.info.bounce &&
        tx.inMessage.info.value.coins < 1_000_000n && tx.inMessage.body.beginParse().remainingBits >= 32 &&
        tx.inMessage.body.beginParse().preloadUint(32) === 0x4d480061) return true;
    return !tx.description.aborted && (cp.type === 'skipped' || cp.success) && (tx.description.actionPhase?.success ?? true);
}

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

const dst = (tx: BlockchainTransaction) => (tx.inMessage?.info.dest instanceof Address ? tx.inMessage.info.dest : null);

export function opOf(tx: BlockchainTransaction) {
    const b = tx.inMessage?.body.beginParse();
    if (!b || b.remainingBits < 32) return null;
    return b.preloadUint(32);
}

// Compute gas of every transaction executed by `addr` in the trace (optionally only those whose
// inbound op is `op`).
export function gasAt(res: SendMessageResult, addr: Address, op?: number): bigint[] {
    const out: bigint[] = [];
    for (const tx of res.transactions) {
        const d = dst(tx);
        if (!d || !d.equals(addr)) continue;
        if (op !== undefined && opOf(tx) !== op) continue;
        const cp: any = (tx.description as any).computePhase;
        if (cp?.type === 'vm') out.push(cp.gasUsed as bigint);
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

export const refundCodes = (res: SendMessageResult) =>
    events(res).filter((e) => e.op === OP.RefundEvent).map((e) => Number(loadRefundEvent(e.body.clone()).code));
export const swapEvents = (res: SendMessageResult) =>
    events(res).filter((e) => e.op === OP.SwapEvent).map((e) => loadSwapEvent(e.body.clone()));
export const modifyEvents = (res: SendMessageResult) =>
    events(res).filter((e) => e.op === OP.ModifyEvent).map((e) => loadModifyEvent(e.body.clone()));
export const launchEvents = (res: SendMessageResult) =>
    events(res).filter((e) => e.op === OP.LaunchEvent).map((e) => loadLaunchEvent(e.body.clone()));
export const initEvents = (res: SendMessageResult) =>
    events(res).filter((e) => e.op === OP.InitializeEvent).map((e) => loadInitializeEvent(e.body.clone()));

export type GramPayoutMsg = { to: Address; value: bigint; reason: number; amount: bigint };

export function gramPayouts(res: SendMessageResult, to?: Address): GramPayoutMsg[] {
    const out: GramPayoutMsg[] = [];
    for (const tx of res.transactions) {
        if (opOf(tx) !== OP.GramPayout) continue;
        const d = dst(tx)!;
        if (to && !d.equals(to)) continue;
        const b = tx.inMessage!.body.beginParse();
        b.loadUint(32);
        b.loadUintBig(64);
        const reason = b.loadUint(8);
        const amount = b.loadCoins();
        const value = tx.inMessage!.info.type === 'internal' ? tx.inMessage!.info.value.coins : 0n;
        out.push({ to: d, value, reason, amount });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export type SwapOpts = {
    tickSpacing?: bigint;
    ext?: Cell | null;
    minOut?: bigint;
    limit?: bigint;
    maxCrossings?: bigint;
    allowPartial?: boolean;
    deadline?: bigint;
    receiver?: Address | null;
    refundTo?: Address | null;
    referral?: Address | null;
    refBps?: bigint;
    fwdTon?: bigint;
    fwdPayload?: Cell | null;
    gas?: bigint;
};

export type LaunchOpts = {
    tickSpacing?: bigint;
    launchFeePips?: bigint;
    launchDuration?: bigint;
    deadline?: bigint;
    taxRecipient?: Address | null;
    buyTaxBps?: bigint;
    sellTaxBps?: bigint;
    devBuy?: bigint;
    minDevOut?: bigint;
    devReceiver?: Address;
    gas?: bigint;
};

export type MintOpts = {
    tickSpacing?: bigint;
    ext?: Cell | null;
    sqrtPriceInit?: bigint;
    minLiquidity?: bigint;
    owner?: Address | null;
    refundTo?: Address | null;
    deadline?: bigint;
    viaAccount?: boolean;
    gas?: bigint;
    sqrtMin?: bigint;
    sqrtMax?: bigint;
};

export function eitherRef(payload: Cell): Slice {
    return beginCell().storeBit(1).storeRef(payload).endCell().beginParse();
}

export function extCell(e: Partial<KeyExt>): Cell {
    return beginCell().store(storeKeyExt({
        $$type: 'KeyExt',
        hook: null, hookFlags: 0n, hookShareBps: 0n, hookFeeMin: 0n, hookFeeMax: 0n,
        initializer: null, launchFeePips: 0n, launchDuration: 0n, minLockSecs: 0n,
        taxRecipient: null, buyTaxBps: 0n, sellTaxBps: 0n,
        ...e,
    })).endCell();
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
    tokA!: Address;
    tokB!: Address;

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

        const js: SandboxContract<TestJettonMaster>[] = [];
        for (const salt of [1n, 2n]) {
            const j = d.chain.openContract(await TestJettonMaster.fromInit(d.admin.address, salt));
            for (const who of [d.alice, d.bob, d.carol]) {
                const res = await j.send(d.admin.getSender(), { value: toNano('0.2') }, {
                    $$type: 'TestMint', queryId: 0n, to: who.address, amount: toNano('100000000'),
                    responseDestination: d.admin.address, forwardTonAmount: 0n, forwardPayload: null,
                });
                expectNoFailures(res);
            }
            js.push(j);
        }
        [d.jA, d.jB] = js;
        d.tokA = await d.jA.getGetWalletAddress(d.router.address);
        d.tokB = await d.jB.getGetWalletAddress(d.router.address);
        return d;
    }

    get now() {
        return this.chain.now!;
    }

    deadline(dt = 3600) {
        return BigInt(this.now + dt);
    }

    async poolOf(a: Address, b: Address, tickSpacing = 60n, ext: Cell | null = null) {
        return this.chain.openContract(Pool.fromAddress(await this.router.getGetPoolAddress(a, b, tickSpacing, ext)));
    }

    async position(pool: SandboxContract<Pool>, index: bigint) {
        return this.chain.openContract(Position.fromAddress(await pool.getGetPositionAddress(index)));
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

    async routerHolds(token: Address) {
        if (!(await this.isActive(token))) return 0n;
        return (await this.chain.openContract(TestJettonWallet.fromAddress(token)).getGetWalletData()).balance;
    }

    async sendJettons(master: SandboxContract<TestJettonMaster>, from: SandboxContract<TreasuryContract>, amount: bigint,
                      forwardTon: bigint, forwardPayload: Slice, walletValue = toNano('0.1')) {
        const w = await this.jWallet(master, from.address);
        return w.send(from.getSender(), { value: forwardTon + walletValue }, {
            $$type: 'JettonTransfer',
            queryId: 0n,
            amount,
            destination: this.router.address,
            responseDestination: from.address,
            customPayload: null,
            forwardTonAmount: forwardTon,
            forwardPayload,
        });
    }

    swapPayload(otherToken: Address, o: SwapOpts = {}) {
        return beginCell().store(storeSwapPayload({
            $$type: 'SwapPayload',
            otherToken,
            tickSpacing: o.tickSpacing ?? 60n,
            ext: o.ext ?? null,
            minOut: o.minOut ?? 0n,
            sqrtPriceLimitX96: o.limit ?? 0n,
            maxCrossings: o.maxCrossings ?? 24n,
            allowPartial: o.allowPartial ?? false,
            deadline: o.deadline ?? this.deadline(),
            receiver: o.receiver ?? null,
            refundTo: o.refundTo ?? null,
            referral: o.referral ?? null,
            refBps: o.refBps ?? 0n,
            fwdTon: o.fwdTon ?? 0n,
            fwdPayload: o.fwdPayload ?? null,
        })).endCell();
    }

    // Default gas covers the Router's worst case (24 crossings, partial, referral, hook, platform + tax payouts).
    async swapJetton(master: SandboxContract<TestJettonMaster>, from: SandboxContract<TreasuryContract>, amount: bigint,
                     otherToken: Address, o: SwapOpts = {}) {
        const gas = o.gas ?? toNano('0.8') + (o.fwdTon ?? 0n);
        return this.sendJettons(master, from, amount, gas, eitherRef(this.swapPayload(otherToken, o)));
    }

    async swapNative(from: SandboxContract<TreasuryContract>, amount: bigint, otherToken: Address, o: SwapOpts = {}) {
        const gas = o.gas ?? toNano('0.8');
        return this.router.send(from.getSender(), { value: amount + gas + (o.fwdTon ?? 0n) }, {
            $$type: 'SwapNative',
            queryId: 1n,
            amount,
            otherToken,
            tickSpacing: o.tickSpacing ?? 60n,
            ext: o.ext ?? null,
            minOut: o.minOut ?? 0n,
            sqrtPriceLimitX96: o.limit ?? 0n,
            maxCrossings: o.maxCrossings ?? 24n,
            allowPartial: o.allowPartial ?? false,
            deadline: o.deadline ?? this.deadline(),
            receiver: o.receiver ?? null,
            refundTo: o.refundTo ?? null,
            referral: o.referral ?? null,
            refBps: o.refBps ?? 0n,
            fwdTon: o.fwdTon ?? 0n,
            fwdPayload: o.fwdPayload ?? null,
        });
    }

    mintPayload(otherToken: Address, tickLower: bigint, tickUpper: bigint, gramAmount: bigint, o: MintOpts = {}) {
        return beginCell().store(storeMintPayload({
            $$type: 'MintPayload',
            otherToken,
            tickSpacing: o.tickSpacing ?? 60n,
            ext: o.ext ?? null,
            tickLower,
            tickUpper,
            gramAmount,
            viaAccount: o.viaAccount ?? false,
            sqrtPriceInitX96: o.sqrtPriceInit ?? 0n,
            minLiquidity: o.minLiquidity ?? 0n,
            owner: o.owner ?? null,
            refundTo: o.refundTo ?? null,
            deadline: o.deadline ?? this.deadline(),
            sqrtPriceMinX96: o.sqrtMin ?? 0n,
            sqrtPriceMaxX96: o.sqrtMax ?? 0n,
        })).endCell();
    }

    // Jetton leg (+ optional Gram leg riding in forwardTonAmount for a native pool).
    async mintJetton(master: SandboxContract<TestJettonMaster>, from: SandboxContract<TreasuryContract>, amount: bigint,
                     otherToken: Address, tickLower: bigint, tickUpper: bigint, gramAmount = 0n, o: MintOpts = {}) {
        const p = this.mintPayload(otherToken, tickLower, tickUpper, gramAmount, o);
        return this.sendJettons(master, from, amount, gramAmount + (o.gas ?? toNano('0.7')), eitherRef(p));
    }

    async mintNative(from: SandboxContract<TreasuryContract>, amount: bigint, otherToken: Address,
                     tickLower: bigint, tickUpper: bigint, o: MintOpts = {}) {
        return this.router.send(from.getSender(), { value: amount + (o.gas ?? toNano('0.7')) }, {
            $$type: 'MintNative',
            queryId: 2n,
            amount,
            otherToken,
            tickSpacing: o.tickSpacing ?? 60n,
            ext: o.ext ?? null,
            tickLower,
            tickUpper,
            sqrtPriceInitX96: o.sqrtPriceInit ?? 0n,
            minLiquidity: o.minLiquidity ?? 0n,
            owner: o.owner ?? null,
            refundTo: o.refundTo ?? null,
            deadline: o.deadline ?? this.deadline(),
            sqrtPriceMinX96: o.sqrtMin ?? 0n,
            sqrtPriceMaxX96: o.sqrtMax ?? 0n,
        });
    }

    async decrease(pos: SandboxContract<Position>, from: SandboxContract<TreasuryContract>, liquidityDelta: bigint,
                   o: { min0?: bigint; min1?: bigint; deadline?: bigint; recipient?: Address | null; value?: bigint; queryId?: bigint } = {}) {
        return pos.send(from.getSender(), { value: o.value ?? toNano('0.3') }, {
            $$type: 'PositionDecrease',
            queryId: o.queryId ?? 7n,
            liquidityDelta,
            amount0Min: o.min0 ?? 0n,
            amount1Min: o.min1 ?? 0n,
            deadline: o.deadline ?? this.deadline(),
            recipient: o.recipient ?? null,
        });
    }

    graduatePayload(gramAmount: bigint, feeClaimer: Address, refundTo: Address,
                    o: { tickSpacing?: bigint; launchFeePips?: bigint; launchDuration?: bigint; deadline?: bigint } = {}) {
        return beginCell().store(storeGraduatePayload({
            $$type: 'GraduatePayload',
            gramAmount,
            tickSpacing: o.tickSpacing ?? 60n,
            launchFeePips: o.launchFeePips ?? 0n,
            launchDuration: o.launchDuration ?? 0n,
            feeClaimer,
            refundTo,
            deadline: o.deadline ?? this.deadline(),
        })).endCell();
    }

    launchPayload(sqrtPriceX96: bigint, feeClaimer: Address, refundTo: Address, o: LaunchOpts = {}) {
        return beginCell().store(storeLaunchPayload({
            $$type: 'LaunchPayload',
            sqrtPriceX96,
            tickSpacing: o.tickSpacing ?? 200n,
            launchFeePips: o.launchFeePips ?? 0n,
            launchDuration: o.launchDuration ?? 0n,
            deadline: o.deadline ?? this.deadline(),
            feeClaimer,
            refundTo,
            taxRecipient: o.taxRecipient ?? null,
            buyTaxBps: o.buyTaxBps ?? 0n,
            sellTaxBps: o.sellTaxBps ?? 0n,
            devBuy: o.devBuy ?? 0n,
            minDevOut: o.minDevOut ?? 0n,
            devReceiver: o.devReceiver ?? refundTo,
        })).endCell();
    }

    // `from` plays the launch master: its transfer's sender becomes the key's initializer.
    async launch(master: SandboxContract<TestJettonMaster>, from: SandboxContract<TreasuryContract>, amount: bigint,
                 sqrtPriceX96: bigint, feeClaimer: Address, refundTo: Address, o: LaunchOpts = {}) {
        const p = this.launchPayload(sqrtPriceX96, feeClaimer, refundTo, o);
        const gas = o.gas ?? toNano('0.5') + ((o.devBuy ?? 0n) > 0n ? toNano('0.15') : 0n) + toNano('0.05');
        return this.sendJettons(master, from, amount, (o.devBuy ?? 0n) + gas, eitherRef(p));
    }

    async launchKey(token: Address, initializer: Address, o: LaunchOpts = {}) {
        return this.router.getGetLaunchKey(token, o.tickSpacing ?? 200n, initializer, o.launchFeePips ?? 0n, o.launchDuration ?? 0n,
            o.taxRecipient ?? null, o.buyTaxBps ?? 0n, o.sellTaxBps ?? 0n);
    }

    async collectTax(from: SandboxContract<TreasuryContract>, key: { token0: Address; token1: Address; tickSpacing: bigint; ext: Cell | null },
                     value = toNano('0.3')) {
        return this.router.send(from.getSender(), { value }, {
            $$type: 'CollectTax', queryId: 5n,
            key: { $$type: 'PoolKey', token0: key.token0, token1: key.token1, tickSpacing: key.tickSpacing, ext: key.ext },
        });
    }

    // Per-token solvency: Router wallet >= what pools owe; native pool balance >= reserve + fees.
    async checkSolvency(pools: SandboxContract<Pool>[]) {
        const owed = new Map<string, bigint>();
        const add = (t: Address, v: bigint) => {
            if (t.equals(GRAM)) return;
            owed.set(t.toString(), (owed.get(t.toString()) ?? 0n) + v);
        };
        for (const p of pools) {
            if (!(await this.isActive(p.address))) continue;
            const s = await p.getGetPoolState();
            add(s.key.token0, s.reserve0 + s.protocolFees0 + s.hookFees0);
            add(s.key.token1, s.reserve1 + s.protocolFees1 + s.hookFees1);
            if (s.key.token0.equals(GRAM)) {
                expect(await this.gram(p.address)).toBeGreaterThanOrEqual(s.reserve0 + s.protocolFees0 + s.hookFees0 + s.taxFees + s.platformFees);
            }
        }
        for (const [t, v] of owed) {
            expect(await this.routerHolds(Address.parse(t))).toBeGreaterThanOrEqual(v);
        }
    }

    async fake(owner: SandboxContract<TreasuryContract>, salt = 0n) {
        const f = this.chain.openContract(await FakeJettonWallet.fromInit(owner.address, salt));
        await f.send(owner.getSender(), { value: toNano('100') }, null);
        return f;
    }
}

export { toNano };

// ---------------------------------------------------------------------------
// Shared utilities for the full suite (model comparison, forged messages, stepping)
// ---------------------------------------------------------------------------

import { internal as sbInternal } from '@ton/sandbox';
import * as Mdl from './model';

export const CODES = {
    ...CODE, BAD_REF_BPS: 212, CREATION_PAUSED: 207, SAME_TOKEN: 206, BAD_TOKEN: 213, TRANSFER_BOUNCED: 214,
    FWD_DROPPED: 216, BUSY: 226, BAD_CROSSINGS: 232,
};

export const REASON = {
    SWAP_OUT: 1, SWAP_REFUND: 2, REFERRAL: 6, PROTOCOL_FEE: 7, LP_ACCOUNT_REFUND: 8, PARTIAL_REFUND: 10,
    POSITION_OUT: 11, HOOK_FEE: 12, MINT_REFUND: 13, TAX: 14, PLATFORM: 15, SURPLUS: 16, LAUNCH_REFUND: 17, LAUNCH_DEVBUY_REFUND: 18,
};

// Every initialized tick of a pool (paged walk over get_ticks).
export async function allTicks(pool: SandboxContract<Pool>) {
    const ticks = new Map<number, Mdl.TickInfo>();
    let from = -887272n;
    for (;;) {
        const page = await pool.getGetTicks(from, 64n, true);
        const keys = [...page.keys()].sort((a, b) => a - b);
        for (const k of keys) {
            const v = page.get(k)!;
            ticks.set(k, { liqGross: v.liqGross, liqNet: v.liqNet, fgOut0: v.fgOut0, fgOut1: v.fgOut1 });
        }
        if (keys.length < 64) break;
        from = BigInt(keys[keys.length - 1] + 1);
    }
    return ticks;
}

// Exact equality of the whole on-chain pool state with the simulator.
export async function expectPoolEquals(pool: SandboxContract<Pool>, sim: Mdl.PoolSim, label = '') {
    const s = await pool.getGetPoolState();
    const got = {
        initialized: s.initialized, sqrtP: s.sqrtPriceX96, tick: Number(s.tick), L: s.liquidity,
        fg0: s.feeGrowth0X128, fg1: s.feeGrowth1X128, reserve0: s.reserve0, reserve1: s.reserve1,
        protocolFees0: s.protocolFees0, protocolFees1: s.protocolFees1, hookFees0: s.hookFees0, hookFees1: s.hookFees1,
        taxFees: s.taxFees, platformFees: s.platformFees, tickCount: Number(s.tickCount), nextPositionId: s.nextPositionId,
        volAcc: s.fs.volAcc, volRef: s.fs.volRef, idxRef: s.fs.idxRef, lastTs: s.fs.lastTs, protocolShareBps: s.fs.protocolShareBps,
    };
    const exp = {
        initialized: sim.initialized, sqrtP: sim.sqrtP, tick: sim.tick, L: sim.L, fg0: sim.fg0, fg1: sim.fg1,
        reserve0: sim.reserve0, reserve1: sim.reserve1, protocolFees0: sim.protocolFees0, protocolFees1: sim.protocolFees1,
        hookFees0: sim.hookFees0, hookFees1: sim.hookFees1, taxFees: sim.taxFees, platformFees: sim.platformFees, tickCount: sim.tickCount, nextPositionId: sim.nextPositionId,
        volAcc: sim.fs.volAcc, volRef: sim.fs.volRef, idxRef: sim.fs.idxRef, lastTs: sim.fs.lastTs, protocolShareBps: sim.fs.protocolShareBps,
    };
    if (label && JSON.stringify(got, big) !== JSON.stringify(exp, big)) {
        // eslint-disable-next-line no-console
        console.log('pool mismatch at', label);
    }
    expect(got).toEqual(exp);
    const ticks = await allTicks(pool);
    expect([...ticks.entries()].sort((a, b) => a[0] - b[0])).toEqual([...sim.ticks.entries()].sort((a, b) => a[0] - b[0]));
}
const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

// Load the on-chain pool into a fresh simulator (for engine checks against arbitrary states).
export async function simOf(pool: SandboxContract<Pool>, ext: Mdl.ExtModel = Mdl.PLAIN_EXT) {
    const s = await pool.getGetPoolState();
    const sim = new Mdl.PoolSim(Number(s.key.tickSpacing), ext, s.key.token0.equals(GRAM));
    sim.initialized = s.initialized;
    sim.sqrtP = s.sqrtPriceX96;
    sim.tick = Number(s.tick);
    sim.L = s.liquidity;
    sim.fg0 = s.feeGrowth0X128;
    sim.fg1 = s.feeGrowth1X128;
    sim.reserve0 = s.reserve0;
    sim.reserve1 = s.reserve1;
    sim.protocolFees0 = s.protocolFees0;
    sim.protocolFees1 = s.protocolFees1;
    sim.hookFees0 = s.hookFees0;
    sim.hookFees1 = s.hookFees1;
    sim.taxFees = s.taxFees;
    sim.platformFees = s.platformFees;
    sim.platformBps = s.platformBps;
    sim.nextPositionId = s.nextPositionId;
    sim.fs = { ...s.fs };
    sim.ticks = await allTicks(pool);
    const obs = await pool.getGetObserve();
    sim.tickCumulative = obs.tickCumulative - BigInt(sim.tick) * (obs.time - s.fs.lastTs);
    sim.obsTs = s.fs.lastTs;
    return sim;
}

// A raw internal message (for forged senders and step-by-step execution).
export function msg(from: Address, to: Address, value: bigint, body: Cell, bounce = true) {
    return sbInternal({ from, to, value, body, bounce });
}

// Run the first `n` transactions of a message's trace, leaving the rest queued.
export async function stepN(chain: Blockchain, m: ReturnType<typeof sbInternal>, n: number) {
    const it = await chain.sendMessageIter(m);
    const txs: BlockchainTransaction[] = [];
    for (let i = 0; i < n; i++) {
        const r = await it.next();
        if (r.done) break;
        txs.push(r.value);
    }
    return { it, txs };
}

// Drain whatever is queued (after stepN) and return the transactions.
export async function drain(it: AsyncIterator<BlockchainTransaction>) {
    const txs: BlockchainTransaction[] = [];
    for (;;) {
        const r = await it.next();
        if (r.done) break;
        txs.push(r.value);
    }
    return txs;
}

export function failedAt(res: { transactions: BlockchainTransaction[] }, addr: Address) {
    return res.transactions.filter((tx) => {
        const d = tx.inMessage?.info.dest;
        return d instanceof Address && d.equals(addr) && !txOk(tx);
    });
}

export function exitCodes(res: { transactions: BlockchainTransaction[] }, addr: Address) {
    return res.transactions.filter((tx) => {
        const d = tx.inMessage?.info.dest;
        return d instanceof Address && d.equals(addr);
    }).map((tx) => {
        const cp: any = (tx.description as any).computePhase;
        return cp?.type === 'vm' ? cp.exitCode : -1;
    });
}

// Smallest value in [lo, hi] for which `ok(value)` holds (ok must be monotone). Restores the
// chain snapshot before every attempt.
export async function findMin(chain: Blockchain, lo: bigint, hi: bigint, ok: (v: bigint) => Promise<boolean>) {
    const snap = chain.snapshot();
    while (lo < hi) {
        const mid = (lo + hi) / 2n;
        await chain.loadFrom(snap);
        if (await ok(mid)) hi = mid; else lo = mid + 1n;
    }
    await chain.loadFrom(snap);
    return lo;
}

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

// Jetton master of a Router wallet (token id) among the fixture jettons.
export function masterOf(d: Dex, token: Address) {
    if (token.equals(d.tokA)) return d.jA;
    if (token.equals(d.tokB)) return d.jB;
    throw new Error('unknown token');
}

// Test-only storage patch: set the pool's FeeState.maxVolAcc (layout from build/Router_Pool.fc
// $Pool$_store: root -> last ref {liquidity, fg, ticks, ...} -> last ref {4 x coins, FeeState, ...}).
// With the default presets va pins at maxVolAcc after 35 spacings and the swap loop then skips the
// virtual checkpoints (finding 7), so the theoretical worst case (24 crossings + 24 checkpoints)
// needs a preset whose maxVolAcc never pins; the admin can add one (maxVolAcc is uncapped, the 5%
// fee cap still applies). This reproduces that preset on an existing pool.
export async function patchMaxVolAcc(chain: Blockchain, pool: Address, value: bigint) {
    const sc = await chain.getContract(pool);
    const acc = sc.account.account!;
    const st = acc.storage.state;
    if (st.type !== 'active') throw new Error('pool not active');
    const data = st.state.data!;
    const b1 = data.refs[data.refs.length - 1];
    const b2 = b1.refs[b1.refs.length - 1];
    const s = b2.beginParse();
    const c = [s.loadCoins(), s.loadCoins(), s.loadCoins(), s.loadCoins()];
    const pre = s.loadBits(112);
    s.loadUint(32);
    const nb2 = beginCell().storeCoins(c[0]).storeCoins(c[1]).storeCoins(c[2]).storeCoins(c[3]).storeBits(pre)
        .storeUint(value, 32).storeSlice(s).endCell();
    const rebuild = (cell: Cell, last: Cell) => {
        const b = beginCell().storeBits(cell.bits);
        cell.refs.slice(0, -1).forEach((r) => b.storeRef(r));
        return b.storeRef(last).endCell();
    };
    const nd = rebuild(data, rebuild(b1, nb2));
    await chain.setShardAccount(pool, createShardAccount({ address: pool, code: st.state.code!, data: nd, balance: acc.storage.balance.coins }));
}
