// Marg vault test fixture: the REAL dex/v2 Router / Pool / Position (imported read-only from
// dex/v2's own test helpers) plus a vault on the CANONICAL plain Gram/USDT key (ext = null).
// dex/v2's mock jetton plays USDT (6 decimals: 1 USDT = 1_000_000 units). Sandbox only.

import { Blockchain, BlockchainTransaction, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import {
    Dex, GRAM, Pool, Position, TestJettonMaster, TestJettonWallet, encodeSqrtPrice, expectNoFailures, txOk, eitherRef,
} from '../../dex/v2/tests/helpers';
import {
    Vault, storeDepositPayload, storeOpenPayload, Strategy, loadDepositRefusedEvent,
} from '../build/Vault_Vault';
import { events } from '../../dex/v2/tests/helpers';
import { VaultWallet } from '../build/Vault_VaultWallet';
import * as VM from './model';

export { Dex, GRAM, Pool, Position, TestJettonMaster, TestJettonWallet, encodeSqrtPrice, expectNoFailures, txOk, eitherRef, toNano };
export { Vault, VaultWallet };

export const USDT = 1_000_000n;            // 1 USDT in units
export const GRAM_1 = 1_000_000_000n;      // 1 Gram in nanoGram
export const SPACING = 60n;
export const P0 = encodeSqrtPrice(3n * USDT, GRAM_1);   // 3 USDT per Gram
export const DEAD_SHARES = 1_000_000n;
export const WITHDRAW_GAS = toNano('1.6');
export const REBALANCE_GAS = toNano('3.5');
export const DEPOSIT_GAS = toNano('0.35');
export const OPEN_GAS = toNano('1.5');

export const PHASE = { SETUP: 0n, OPENING: 1n, IDLE: 2n, REB: 3n };
export const PAYOUT = { WITHDRAW: 1, FEE: 2, GAS: 3, REFUND: 4 };
export const OPV = { VaultPayout: 0x56410012, DepositEvent: 0x56410071, WithdrawEvent: 0x56410072, RebalanceEvent: 0x56410073, DepositRefusedEvent: 0x56410074 };
export const OPD = { PoolObserve: 0x4d480081, PoolObservation: 0x4d480082, BurnReceipt: 0x4d480083, MintReceipt: 0x4d480084, GramPayout: 0x4d480061,
    JettonNotification: 0x7362d09c, PositionDecreaseNotify: 0x4d480049 };

// Failure filter: the vault's own refusals that bounce on purpose are excluded by callers.
export function okExcept(res: SendMessageResult, allow: (tx: BlockchainTransaction) => boolean = () => false) {
    expectNoFailures(res, allow);
}

// DepositRefusedEvent codes: 1 closed / paused / busy, 2 oracle, 3 below minShares, 4 changed meanwhile.
export function refusals(res: SendMessageResult) {
    return events(res).filter((e) => e.op === OPV.DepositRefusedEvent).map((e) => Number(loadDepositRefusedEvent(e.body.clone()).code));
}

export class VaultFx {
    d!: Dex;
    chain!: Blockchain;
    usdt!: SandboxContract<TestJettonMaster>;
    vault!: SandboxContract<Vault>;
    pool!: SandboxContract<Pool>;
    keyExt!: Cell | null;
    admin!: SandboxContract<TreasuryContract>;
    keeper!: SandboxContract<TreasuryContract>;
    treasury!: SandboxContract<TreasuryContract>;
    alice!: SandboxContract<TreasuryContract>;
    bob!: SandboxContract<TreasuryContract>;
    carol!: SandboxContract<TreasuryContract>;
    mallory!: SandboxContract<TreasuryContract>;
    poolCode!: Cell;
    positionCode!: Cell;
    qid = 100n;

    // Deploy + setup (+ optional open with a seed) of a Gram/USDT vault on the canonical plain key.
    // An existing Dex can be shared (several vaults on one key).
    static async create(o: { open?: boolean; seed0?: bigint; seed1?: bigint; sqrtInit?: bigint; salt?: bigint; dex?: Dex; poke?: boolean } = {}) {
        const f = new VaultFx();
        f.d = o.dex ?? await Dex.create();
        f.chain = f.d.chain;
        f.usdt = f.d.jA;
        f.admin = f.d.admin;
        f.treasury = f.d.treasury;
        f.alice = f.d.alice;
        f.bob = f.d.bob;
        f.carol = f.d.carol;
        f.keeper = await f.chain.treasury('keeper', { balance: toNano('1000000') });
        f.mallory = await f.chain.treasury('mallory', { balance: toNano('10000000') });
        if (!o.dex) {
            await f.mintUsdt(f.admin.address, 10_000_000n * USDT);
            await f.mintUsdt(f.mallory.address, 100_000_000n * USDT);
        }

        // Code of the DEX Pool / Position as the Router deploys them.
        const dummyKey = { $$type: 'PoolKey' as const, token0: GRAM, token1: f.d.tokA, tickSpacing: SPACING, ext: null };
        const poolProbe = await Pool.fromInit(f.d.router.address, dummyKey);
        f.poolCode = poolProbe.init!.code;
        const posProbe = await Position.fromInit(poolProbe.address, 0n);
        f.positionCode = posProbe.init!.code;

        f.vault = f.chain.openContract(await Vault.fromInit(
            f.admin.address, f.d.router.address, f.usdt.address,
            BigInt('0x' + f.poolCode.hash().toString('hex')), BigInt('0x' + f.positionCode.hash().toString('hex')),
            SPACING, o.salt ?? 0n));
        const dep = await f.vault.send(f.admin.getSender(), { value: toNano('2') }, null);
        expectNoFailures(dep);
        const setup = await f.vault.send(f.admin.getSender(), { value: toNano('0.3') }, {
            $$type: 'VaultSetup', queryId: 1n, poolCode: f.poolCode, positionCode: f.positionCode,
            content: beginCell().storeUint(1, 8).storeStringTail('https://example.org/marg-vault-gram-usdt.json').endCell(),
        });
        expectNoFailures(setup);
        f.keyExt = null;
        f.pool = f.chain.openContract(Pool.fromAddress((await f.vault.getGetVaultData()).pool!));
        if (o.open ?? true) {
            const r = await f.open(o.seed0 ?? 1000n * GRAM_1, o.seed1 ?? 3000n * USDT, o.sqrtInit ?? P0);
            expectNoFailures(r, (tx) => f.observeOfUndeployedPool(tx));
            // first TWAP anchor at the opening time
            if (o.poke ?? true) expectNoFailures(await f.poke());
        }
        return f;
    }

    // The opening observation of a pool that was never deployed bounces (the vault reads it as
    // "not initialized" and initializes the canonical pool with its seed mint).
    observeOfUndeployedPool(tx: BlockchainTransaction) {
        const d = tx.inMessage?.info.dest;
        const b = tx.inMessage?.body.beginParse();
        return d instanceof Address && d.equals(this.pool.address) && !!b && b.remainingBits >= 32 && b.preloadUint(32) === OPD.PoolObserve;
    }

    get now() {
        return this.chain.now!;
    }

    async wait(dt: number) {
        this.chain.now = this.now + dt;
    }

    async mintUsdt(to: Address, amount: bigint) {
        const r = await this.usdt.send(this.admin.getSender(), { value: toNano('0.2') }, {
            $$type: 'TestMint', queryId: 0n, to, amount, responseDestination: this.admin.address,
            forwardTonAmount: 0n, forwardPayload: null,
        });
        expectNoFailures(r);
    }

    async usdtWallet(owner: Address) {
        return this.chain.openContract(TestJettonWallet.fromAddress(await this.usdt.getGetWalletAddress(owner)));
    }

    async usdtBal(owner: Address) {
        return this.d.jBal(this.usdt, owner);
    }

    async gram(addr: Address) {
        return this.d.gram(addr);
    }

    async shareWallet(owner: Address) {
        return this.chain.openContract(VaultWallet.fromAddress(await this.vault.getGetWalletAddress(owner)));
    }

    async shares(owner: Address) {
        const w = await this.shareWallet(owner);
        if (!(await this.d.isActive(w.address))) return 0n;
        return (await w.getGetWalletData()).balance;
    }

    async data() {
        return this.vault.getGetVaultData();
    }

    async open(seed0: bigint, seed1: bigint, sqrtInit: bigint, from?: SandboxContract<TreasuryContract>) {
        const p = beginCell().store(storeOpenPayload({ $$type: 'OpenPayload', gramAmount: seed0, sqrtPriceInitX96: sqrtInit, receiver: null })).endCell();
        return this.sendUsdt(from ?? this.admin, seed1, seed0 + OPEN_GAS + toNano('0.1'), eitherRef(p));
    }

    async sendUsdt(from: SandboxContract<TreasuryContract>, amount: bigint, forwardTon: bigint, payload: any, dest?: Address, queryId = 0n) {
        const w = await this.usdtWallet(from.address);
        return w.send(from.getSender(), { value: forwardTon + toNano('0.1') }, {
            $$type: 'JettonTransfer', queryId, amount, destination: dest ?? this.vault.address,
            responseDestination: from.address, customPayload: null, forwardTonAmount: forwardTon, forwardPayload: payload,
        });
    }

    depositPayload(gramAmount: bigint, minShares = 0n, receiver: Address | null = null) {
        return eitherRef(beginCell().store(storeDepositPayload({ $$type: 'DepositPayload', gramAmount, minShares, receiver })).endCell());
    }

    async depositUsdt(from: SandboxContract<TreasuryContract>, amount1: bigint, gram = 0n, minShares = 0n, gas = DEPOSIT_GAS + toNano('0.05')) {
        return this.sendUsdt(from, amount1, gram + gas, this.depositPayload(gram, minShares));
    }

    async depositGram(from: SandboxContract<TreasuryContract>, amount0: bigint, minShares = 0n, gas = DEPOSIT_GAS + toNano('0.05')) {
        return this.vault.send(from.getSender(), { value: amount0 + gas }, {
            $$type: 'DepositNative', queryId: this.qid++, amount: amount0, minShares, receiver: null,
        });
    }

    async withdraw(from: SandboxContract<TreasuryContract>, shares: bigint, o: { value?: bigint; recipient?: Address | null } = {}) {
        const w = await this.shareWallet(from.address);
        return w.send(from.getSender(), { value: o.value ?? WITHDRAW_GAS + toNano('0.1') }, {
            $$type: 'JettonBurn', queryId: this.qid++, amount: shares, responseDestination: o.recipient ?? null, customPayload: null,
        });
    }

    async rebalance(from?: SandboxContract<TreasuryContract>, value = REBALANCE_GAS + toNano('0.1')) {
        return this.vault.send((from ?? this.keeper).getSender(), { value }, { $$type: 'Rebalance', queryId: this.qid++ });
    }

    async poke(from?: SandboxContract<TreasuryContract>, value = toNano('0.2')) {
        return this.vault.send((from ?? this.keeper).getSender(), { value }, { $$type: 'Poke', queryId: this.qid++ });
    }

    async swapGram(from: SandboxContract<TreasuryContract>, amount0: bigint, o: { minOut?: bigint; allowPartial?: boolean; receiver?: Address; fwdTon?: bigint } = {}) {
        return this.d.swapNative(from, amount0, this.d.tokA, { tickSpacing: SPACING, ext: this.keyExt, minOut: o.minOut ?? 0n,
            allowPartial: o.allowPartial, receiver: o.receiver, fwdTon: o.fwdTon });
    }

    async swapUsdt(from: SandboxContract<TreasuryContract>, amount1: bigint, o: { allowPartial?: boolean; receiver?: Address } = {}) {
        return this.d.swapJetton(this.usdt, from, amount1, GRAM, { tickSpacing: SPACING, ext: this.keyExt, allowPartial: o.allowPartial, receiver: o.receiver });
    }

    // Swap Gram in (price down) or USDT in (price up) until the pool tick crosses `target`.
    async moveTo(target: bigint, who?: SandboxContract<TreasuryContract>) {
        const w = who ?? this.mallory;
        for (let i = 0; i < 40; i++) {
            const t = (await this.poolState()).tick;
            if ((t - target) * (t - target) <= 900n) return t;
            const dist = t > target ? t - target : target - t;
            if (t > target) await this.swapGram(w, (dist * GRAM_1 * 3n) / 5n + GRAM_1, { allowPartial: true });
            else await this.swapUsdt(w, (dist * USDT * 9n) / 5n + USDT, { allowPartial: true });
        }
        return (await this.poolState()).tick;
    }

    async setStrategy(patch: Partial<Strategy>) {
        const s = (await this.data()).strategy;
        return this.vault.send(this.admin.getSender(), { value: toNano('0.05') }, {
            $$type: 'SetStrategy', queryId: 1n, strategy: { ...s, ...patch, $$type: 'Strategy' },
        });
    }

    async poolState() {
        return this.pool.getGetPoolState();
    }

    async positions() {
        const m = await this.vault.getGetPositions();
        const out: { slot: number; index: bigint; tL: bigint; tU: bigint; L: bigint; reserved: bigint; busy: bigint; uf0: bigint; uf1: bigint }[] = [];
        for (const k of m.keys()) {
            const p = m.get(k)!;
            out.push({ slot: Number(k), index: p.index, tL: p.tL, tU: p.tU, L: p.L, reserved: p.reserved, busy: p.busy, uf0: p.uf0, uf1: p.uf1 });
        }
        return out.sort((a, b) => a.slot - b.slot);
    }

    async position(index: bigint) {
        return this.chain.openContract(Position.fromAddress(await this.pool.getGetPositionAddress(index)));
    }

    // Real liquidity of each tracked position read from the NFTs: the vault's view must match.
    async expectPositionsMatchNfts() {
        for (const p of await this.positions()) {
            const nft = await this.position(p.index);
            const pd = await nft.getGetPositionData();
            expect(pd.owner.equals(this.vault.address)).toBe(true);
            expect(pd.liquidity).toBe(p.L);
            expect(pd.busy).toBe(false);
            const ck = (await this.vault.getGetCheckpoints()).get(p.slot)!;
            expect([ck.fg0, ck.fg1]).toEqual([pd.fgLast0, pd.fgLast1]);
        }
    }

    // Strict solvency: accounted USDT <= wallet balance; owed Gram <= vault balance.
    async expectSolvent() {
        const v = await this.data();
        const bal1 = await this.usdtBal(this.vault.address);
        expect(v.idle1 + v.fee1 + v.pendUsdt).toBeLessThanOrEqual(bal1);
        expect(v.idle0 + v.fee0 + v.heldGas).toBeLessThanOrEqual(await this.gram(this.vault.address));
    }

    // Refresh the TWAP anchor, then let `seconds` pass (the TWAP window is 1800 s by default).
    async warm(seconds = 3700) {
        expectNoFailures(await this.poke());
        await this.wait(seconds);
    }

    // Everything the reference model needs, read through getters (vault + pool + NFTs).
    async snap() {
        const v = await this.data();
        const pos = await this.positions();
        const o = await this.vault.getGetOracleState();
        const ps = await this.poolState();
        const obs = await this.pool.getGetObserve();
        const fees: { f0: bigint; f1: bigint }[] = [];
        for (const p of pos) {
            const nft = await (await this.position(p.index)).getGetPositionData();
            const pa = await this.pool.getGetPositionAmounts(nft.tickLower, nft.tickUpper, nft.liquidity, nft.fgLast0, nft.fgLast1, 0n);
            fees.push({ f0: pa.fees0, f1: pa.fees1 });
        }
        return { v, pos, o, ps, obs, fees, window: v.strategy.twapWindow, now: BigInt(this.now) };
    }

    // The TWAP / spot a deposit or rebalance sent now will see (its own observation pushes an anchor first).
    modelView(sn: Awaited<ReturnType<VaultFx['snap']>>) {
        return VM.oracleAfterObserve(sn.o, sn.obs.tickCumulative, sn.now, sn.window, sn.ps.tick, sn.ps.sqrtPriceX96);
    }

    modelShares(sn: Awaited<ReturnType<VaultFx['snap']>>, a0: bigint, a1: bigint) {
        const ov = this.modelView(sn);
        const bps = sn.v.strategy.perfFeeBps;
        return VM.quoteShares(a0, a1, ov.twap, ov.spot, ov.spotSqrtP, sn.v.supply,
            sn.v.idle0 + sn.v.exp0 - sn.v.owe0, sn.v.idle1 + sn.v.exp1 - sn.v.owe1, sn.pos, sn.fees, bps);
    }

    // Withdrawal: collect first (fees net of the performance fee join idle), then pro-rata.
    modelSplit(sn: Awaited<ReturnType<VaultFx['snap']>>, shares: bigint) {
        const bps = sn.v.strategy.perfFeeBps;
        let i0 = sn.v.idle0;
        let i1 = sn.v.idle1;
        for (const f of sn.fees) {
            i0 += f.f0 - (f.f0 * bps) / 10000n;
            i1 += f.f1 - (f.f1 * bps) / 10000n;
        }
        return VM.withdrawSplit(shares, sn.v.supply, i0, i1, sn.pos);
    }
}

// Run the first `n` transactions of a trace in its OWN queue (allowParallel): the rest stays "in
// flight" while other messages are processed, until drained. Models network delay.
export async function stepParallel(chain: Blockchain, m: any, n: number) {
    const it = await chain.sendMessageIter(m, { allowParallel: true } as any);
    const txs: BlockchainTransaction[] = [];
    for (let i = 0; i < n; i++) {
        const r = await it.next();
        if (r.done) break;
        txs.push(r.value);
    }
    return { it, txs };
}

export function gramPaidTo(res: SendMessageResult, to: Address, reason?: number) {
    let sum = 0n;
    for (const tx of res.transactions) {
        const d = tx.inMessage?.info.dest;
        if (!(d instanceof Address) || !d.equals(to)) continue;
        const b = tx.inMessage!.body.beginParse();
        if (b.remainingBits < 32 || b.preloadUint(32) !== OPV.VaultPayout) continue;
        b.loadUint(32);
        b.loadUintBig(64);
        const r = b.loadUint(8);
        const amount = b.loadCoins();
        if (reason === undefined || r === reason) sum += amount;
    }
    return sum;
}

export function vaultFailures(res: SendMessageResult, vault: Address) {
    return res.transactions.filter((tx) => {
        const d = tx.inMessage?.info.dest;
        return d instanceof Address && d.equals(vault) && !txOk(tx);
    });
}

export function computeGas(res: SendMessageResult, addr: Address, op?: number) {
    const out: bigint[] = [];
    for (const tx of res.transactions) {
        const d = tx.inMessage?.info.dest;
        if (!(d instanceof Address) || !d.equals(addr)) continue;
        const b = tx.inMessage?.body.beginParse();
        if (op !== undefined && (!b || b.remainingBits < 32 || b.preloadUint(32) !== op)) continue;
        const cp: any = (tx.description as any).computePhase;
        if (cp?.type === 'vm') out.push(cp.gasUsed as bigint);
    }
    return out;
}
