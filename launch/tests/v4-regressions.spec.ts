// v4 regression tests for the launch side of the security issue register (pitch/issue-register.md).
// Each test replays the scenario of an earlier attack PoC and asserts that the attack now FAILS
// (the fixed behaviour holds). Sandbox only, against the real dex/v2 Router and Pool.
//  - R8B-1   holder rewards accrue only once tracked holders own >= REWARD_MIN_SHARES (1% of supply)
//  - R7B-6   ProvideWalletAddress before the launch answers addr_none
//  - R6A-5   a long-idle sender at the advertised minimum value: the receiver is still registered
//  - R6A-1   in-flight +delta checkpoint at a higher gas price: no phantom shares (was audit8a-rewards, audit8b-phantom-shares)
//  - V3-M1   the launch-fee escrow outcome cannot be spoofed through the pool (was audit4-escrow, audit7b-escrow-outcome)
//  - R6B-2   the escrow race of a dev-buy launch on a split basechain (was audit5-shard-race)

import { Blockchain, BlockchainTransaction, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import '@ton/test-utils';
import { LaunchFactory, LaunchParams } from '../build/Launch_LaunchFactory';
import { LaunchJetton, loadTaxSplitEvent } from '../build/Launch_LaunchJetton';
import { LaunchWallet, storeJettonTransfer, storeProvideWalletAddress, storeCreateToken } from '../build/Launch_LaunchWallet';
import { Router, storeSwapNative, storeSwapPayload } from '../../dex/v2/build/Router_Router';
import { Pool } from '../../dex/v2/build/Router_Pool';
import { txOk, opOf, events } from '../../dex/v2/tests/helpers';
import { poolCodeArgs } from './poolcode';

jest.setTimeout(1800000);

const T0 = 1_800_000_000;
const DAY = 86400;
const YEAR = 365 * DAY;
const PARAMS: LaunchParams = { $$type: 'LaunchParams', startMcap: toNano('2600'), tickSpacing: 10n };
const TIERS = { $$type: 'LaunchTiers' as const, low: PARAMS,
    mid: { $$type: 'LaunchParams' as const, startMcap: toNano('10000'), tickSpacing: 10n },
    high: { $$type: 'LaunchParams' as const, startMcap: toNano('30000'), tickSpacing: 10n } };
const LAUNCH_FEE = toNano('1.5');
const OPS = { checkpoint: 0x4d4c0030, claim: 0x4d4c0031, ack: 0x4d4c0032, claimRewards: 0x4d4c0033, sync: 0x4d4c0034,
    transfer: 0x0f8a7ea5, internal: 0x178d4519, excesses: 0xd53276db, notify: 0x7362d09c, take: 0xd1735400 };
const BASE_PRICE = 67n;
const REWARD_MIN_SHARES = 10n ** 16n;          // jetton.tact: 1% of TOTAL_SUPPLY
const GRAM = new Address(0, Buffer.alloc(32));
const TAX_SPLIT_OP = 0x4d4c0022;
const splitEvents = (txs: BlockchainTransaction[]) =>
    events({ transactions: txs } as any).filter((e) => e.op === TAX_SPLIT_OP).map((e) => loadTaxSplitEvent(e.body.clone()));
// Comment payments from `from` to `to` with the given text.
function comments(txs: BlockchainTransaction[], from: Address, to: Address, text: string): bigint[] {
    const out: bigint[] = [];
    for (const tx of txs) {
        if (!src(tx)?.equals(from) || !dst(tx)?.equals(to)) continue;
        const b = tx.inMessage!.body.beginParse();
        if (b.remainingBits < 32 || b.loadUint(32) !== 0) continue;
        if (b.loadStringTail() !== text) continue;
        out.push(valueIn(tx));
    }
    return out;
}

function content(name: string): Cell {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    for (const [k, v] of [['name', name], ['symbol', 'MARG'], ['decimals', '9']]) {
        dict.set(BigInt('0x' + sha256_sync(k).toString('hex')), beginCell().storeUint(0, 8).storeStringTail(v).endCell());
    }
    return beginCell().storeUint(0, 8).storeDict(dict).endCell();
}
const dst = (tx: BlockchainTransaction) => (tx.inMessage?.info.dest instanceof Address ? tx.inMessage.info.dest : undefined);
const src = (tx: BlockchainTransaction) => (tx.inMessage?.info.src instanceof Address ? tx.inMessage.info.src : undefined);
const valueIn = (tx: BlockchainTransaction) => (tx.inMessage!.info as any).value.coins as bigint;
const exitCode = (tx: BlockchainTransaction) => (tx.description as any).computePhase?.exitCode;
function expectNoFailures(res: { transactions: BlockchainTransaction[] }) {
    const bad = res.transactions.filter((tx) => !txOk(tx));
    expect(bad.map((tx) => [exitCode(tx), opOf(tx)?.toString(16)])).toEqual([]);
}
function setGasPrice(chain: Blockchain, nano: bigint) {
    const dict = Dictionary.loadDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell(), chain.config);
    for (const id of [20, 21]) {
        const s = dict.get(id)!.beginParse();
        const b = beginCell();
        let tag = s.loadUint(8);
        if (tag === 0xd1) {
            const limit = s.loadUintBig(64);
            s.loadUintBig(64);
            b.storeUint(tag, 8).storeUint(limit, 64).storeUint(limit * nano, 64);
            tag = s.loadUint(8);
        }
        s.loadUintBig(64);
        b.storeUint(tag, 8).storeUint(nano << 16n, 64).storeSlice(s);
        dict.set(id, b.endCell());
    }
    chain.setConfig(beginCell().storeDictDirect(dict).endCell());
}

describe('Marg launch v4: regression tests for the audit register', () => {
    let chain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let treasury: SandboxContract<TreasuryContract>;
    let creator: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let carol: SandboxContract<TreasuryContract>;
    let mallory: SandboxContract<TreasuryContract>;
    let m2: SandboxContract<TreasuryContract>;
    let m3: SandboxContract<TreasuryContract>;
    let router: SandboxContract<Router>;
    let factory: SandboxContract<LaunchFactory>;
    let config0: Cell;
    let base: any;

    type CreateOpts = { buyTaxBps?: bigint; sellTaxBps?: bigint; rewardsBps?: bigint; walletBps?: bigint; buybackBps?: bigint; vaultBps?: bigint; devBuy?: bigint };
    const createBody = (o: CreateOpts = {}) => {
        const vaultBps = o.vaultBps ?? 0n;
        return {
            $$type: 'CreateToken' as const, queryId: 7n, content: content('V4R'), devBuy: o.devBuy ?? 0n, minDevOut: 0n,
            buyTaxBps: o.buyTaxBps ?? 0n, sellTaxBps: o.sellTaxBps ?? 0n, taxWallet: null,
            rewardsBps: o.rewardsBps ?? 0n, walletBps: o.walletBps ?? 0n, buybackBps: o.buybackBps ?? 0n,
            antiSnipePips: 0n, antiSnipeDuration: 0n, startMcap: PARAMS.startMcap, tickSpacing: PARAMS.tickSpacing,
            vaultBps, vaultLock: vaultBps > 0n ? 7n * 86400n : 0n, vaultVest: 0n,
        };
    };
    async function launch(o: CreateOpts = {}) {
        const res = await factory.send(creator.getSender(), { value: await factory.getGetCreateValue2(o.devBuy ?? 0n, (o.vaultBps ?? 0n) > 0n) }, createBody(o));
        expectNoFailures(res);
        const idx = (await factory.getGetFactoryData()).nextIndex - 1n;
        const master = chain.openContract(LaunchJetton.fromAddress(await factory.getGetTokenAddress(idx)));
        const key = await master.getGetPoolKey();
        const pool = chain.openContract(Pool.fromAddress(await router.getGetPoolAddress(key.token0, key.token1, key.tickSpacing, key.ext)));
        return { master, key, pool };
    }
    type M = SandboxContract<LaunchJetton>;
    const walletOf = async (master: M, owner: Address) => chain.openContract(LaunchWallet.fromAddress(await master.getGetWalletAddress(owner)));
    const active = async (a: Address) => (await chain.getContract(a)).accountState?.type === 'active';
    const jBal = async (master: M, owner: Address) => {
        const w = await walletOf(master, owner);
        return (await active(w.address)) ? (await w.getGetWalletData()).balance : 0n;
    };
    const rState = async (master: M, owner: Address) => {
        const w = await walletOf(master, owner);
        return (await active(w.address)) ? await w.getGetRewardState() : null;
    };
    const pend = async (master: M, owner: Address) => {
        const w = await walletOf(master, owner);
        if (!(await active(w.address))) return 0n;
        return w.getGetPendingRewards((await master.getGetRewardsData()).acc);
    };
    const balOf = async (a: Address) => (await chain.getContract(a)).balance;
    const swapMsg = (key: any, amount: bigint) => ({
        $$type: 'SwapNative' as const, queryId: 1n, amount, otherToken: key.token1, tickSpacing: key.tickSpacing, ext: key.ext, minOut: 0n,
        sqrtPriceLimitX96: 0n, maxCrossings: 24n, allowPartial: false, deadline: BigInt(chain.now! + 600), receiver: null,
        refundTo: null, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null,
    });
    const buy = (who: SandboxContract<TreasuryContract>, key: any, amount: bigint, extra = toNano('0.7')) =>
        router.send(who.getSender(), { value: amount + extra }, swapMsg(key, amount));
    const xferBody = (to: Address, amount: bigint, resp: Address | null, fwdTon = 0n, payload?: Cell) => ({
        $$type: 'JettonTransfer' as const, queryId: 3n, amount, destination: to, responseDestination: resp, customPayload: null,
        forwardTonAmount: fwdTon,
        forwardPayload: payload ? beginCell().storeBit(1).storeRef(payload).endCell().beginParse() : beginCell().storeBit(0).endCell().beginParse(),
    });
    const transfer = async (master: M, from: SandboxContract<TreasuryContract>, to: Address, amount: bigint, value = toNano('0.12'), fwdTon = 0n, payload?: Cell) =>
        (await walletOf(master, from.address)).send(from.getSender(), { value }, xferBody(to, amount, from.address, fwdTon, payload));
    const SELL_GAS = toNano('0.6');
    const sell = async (master: M, who: SandboxContract<TreasuryContract>, key: any, amount: bigint) => {
        const payload = beginCell().store(storeSwapPayload({
            $$type: 'SwapPayload', otherToken: GRAM, tickSpacing: key.tickSpacing, ext: key.ext, minOut: 0n, sqrtPriceLimitX96: 0n,
            maxCrossings: 12n, allowPartial: false, deadline: BigInt(chain.now! + 600), receiver: null, refundTo: null, referral: null,
            refBps: 0n, fwdTon: 0n, fwdPayload: null,
        })).endCell();
        return (await walletOf(master, who.address)).send(who.getSender(), { value: SELL_GAS + toNano('0.15') }, {
            $$type: 'JettonTransfer', queryId: 0n, amount, destination: router.address, responseDestination: who.address, customPayload: null,
            forwardTonAmount: SELL_GAS, forwardPayload: beginCell().storeBit(1).storeRef(payload).endCell().beginParse(),
        });
    };
    const sellAll = async (master: M, who: SandboxContract<TreasuryContract>, key: any) => {
        const j = await jBal(master, who.address);
        if (j > 0n) expectNoFailures(await sell(master, who, key, j));
    };
    const claim = async (master: M, who: SandboxContract<TreasuryContract>, value = toNano('0.1')) =>
        (await walletOf(master, who.address)).send(who.getSender(), { value }, { $$type: 'ClaimRewards', queryId: 9n });
    const syncBy = async (master: M, owner: Address, by: SandboxContract<TreasuryContract>, value?: bigint) => {
        const w = await walletOf(master, owner);
        return w.send(by.getSender(), { value: value ?? (await w.getGetRewardValues()).sync }, { $$type: 'SyncRewards', queryId: 5n });
    };
    const held = async (master: M) => {
        const rd = await master.getGetRewardsData();
        return rd.accrued + rd.carry - rd.claimed + rd.rentFund + (await master.getGetBuybackStatus()).balance + (await master.getGetLaunchState()).feeEscrow;
    };
    const solvent = async (master: M) => {
        const rd = await master.getGetRewardsData();
        expect(rd.claimed).toBeLessThanOrEqual(rd.accrued);
        expect(await balOf(master.address)).toBeGreaterThanOrEqual(await held(master));
    };
    const ackedSum = async (master: M, owners: Address[]) => {
        let s = 0n;
        for (const o of owners) s += (await rState(master, o))?.acked ?? 0n;
        return s;
    };
    const realSum = async (master: M, owners: Address[]) => {
        let s = 0n;
        for (const o of owners) s += await jBal(master, o);
        return s;
    };
    const qm = () => (chain as any).defaultQueueManager;
    const step = async () => (await qm().runQueueIter(true).next()).value as BlockchainTransaction | undefined;
    const drain = async () => {
        const txs: BlockchainTransaction[] = [];
        while (qm().messageQueue.length > 0) {
            const t = await step();
            if (t) txs.push(t);
        }
        return txs;
    };

    beforeAll(async () => {
        chain = await Blockchain.create();
        chain.now = T0;
        config0 = chain.config;
        admin = await chain.treasury('admin');
        treasury = await chain.treasury('treasury');
        creator = await chain.treasury('creator', { balance: toNano('1000000') });
        alice = await chain.treasury('alice', { balance: toNano('1000000') });
        bob = await chain.treasury('bob', { balance: toNano('1000000') });
        carol = await chain.treasury('carol', { balance: toNano('1000000') });
        mallory = await chain.treasury('mallory', { balance: toNano('1000000') });
        m2 = await chain.treasury('mallory-2', { balance: toNano('1000000') });
        m3 = await chain.treasury('mallory-3', { balance: toNano('1000000') });
        router = chain.openContract(await Router.fromInit(admin.address, treasury.address));
        await router.send(admin.getSender(), { value: toNano('50') }, null);
        factory = chain.openContract(await LaunchFactory.fromInit(admin.address, treasury.address, router.address, LAUNCH_FEE, TIERS, ...(await poolCodeArgs())));
        await factory.send(admin.getSender(), { value: toNano('0.5') }, null);
        base = chain.snapshot();
    });
    beforeEach(async () => {
        await chain.loadFrom(base);
        chain.setConfig(config0);
        chain.now = T0;
    });

    // -----------------------------------------------------------------------
    // R8B-1 / R9B-1..3 / R10-1: REWARD_MIN_SHARES and the re-routing below it. Since R10-1 the factory refuses
    // a holders-only split, so the holders' share below 1% always has a buyback or wallet share to go to and
    // no token ever carries it (the carry and its drip in accrue() are unreachable).
    // -----------------------------------------------------------------------

    it('R10-1: the factory refuses holder rewards without a buyback or wallet share (value back, no token); 99.99/0/0.01 and 99.99/0.01/0 launch', async () => {
        const n0 = (await factory.getGetFactoryData()).nextIndex;
        const c0 = await balOf(creator.address);
        const v = await factory.getGetCreateValue2(0n, false);
        const res = await factory.send(creator.getSender(), { value: v },
            createBody({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 10000n, walletBps: 0n, buybackBps: 0n }));
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: false, exitCode: 63623 });
        expect((await factory.getGetFactoryData()).nextIndex).toBe(n0);
        expect(c0 - (await balOf(creator.address))).toBeLessThan(toNano('0.05'));    // bounced: only fees lost
        expectNoFailures(await factory.send(creator.getSender(), { value: v },
            createBody({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, walletBps: 0n, buybackBps: 1n })));
        expectNoFailures(await factory.send(creator.getSender(), { value: v },
            createBody({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, walletBps: 1n, buybackBps: 0n })));
        expect((await factory.getGetFactoryData()).nextIndex).toBe(n0 + 2n);
    });

    it('R8B-1: a dust first buyer cannot take the rewards share of the first real buy (no dev buy, 5% tax, 99.99% rewards): it goes to the buyback, nothing is carried', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        const m0 = await balOf(mallory.address);
        expectNoFailures(await buy(mallory, key, toNano('0.05')));
        const mShares = await jBal(master, mallory.address);
        expect(mShares).toBeGreaterThan(0n);
        expect(mShares).toBeLessThan(REWARD_MIN_SHARES);
        const rdA = await master.getGetRewardsData();
        const res = await buy(alice, key, toNano('1000'));
        expectNoFailures(res);
        const rd1 = await master.getGetRewardsData();
        const [sp] = splitEvents(res.transactions);
        expect(rd1.accrued).toBe(rdA.accrued);
        expect(rd1.carry).toBe(0n);
        expect([sp.rewards, sp.wallet]).toEqual([0n, 0n]);
        expect(sp.buyback).toBe(sp.amount - sp.rent);
        expect(await pend(master, mallory.address)).toBe(0n);
        expect(rd1.totalShares).toBeGreaterThanOrEqual(REWARD_MIN_SHARES);
        // From now on taxes accrue pro rata; the sniper gets at most its share.
        const aShares = await jBal(master, alice.address);
        expectNoFailures(await buy(bob, key, toNano('10')));
        const rd2 = await master.getGetRewardsData();
        expect(rd2.carry).toBe(0n);
        const A = rd2.accrued - rd1.accrued;
        expect(A).toBeGreaterThan(0n);
        expect(await pend(master, mallory.address)).toBeLessThanOrEqual((A * mShares) / rd1.totalShares + 1n);
        expect(await pend(master, alice.address)).toBeGreaterThanOrEqual((A * aShares) / rd1.totalShares - 1n);
        const mw = await walletOf(master, mallory.address);
        expectNoFailures(await mw.send(mallory.getSender(), { value: (await mw.getGetRewardValues()).claim + toNano('0.02') }, { $$type: 'ClaimRewards', queryId: 0n }));
        expect(await balOf(mallory.address)).toBeLessThan(m0);
        expectNoFailures(await claim(master, alice));
        await solvent(master);
    });

    it('REWARD_MIN_SHARES: every split matches the model exactly: below 1% the holders\' share goes to the buyback, at or above it accrues; the carry stays 0', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        let accrued = 0n;
        let below = 0, above = 0;
        for (let i = 0; i < 40; i++) {
            const who = [alice, bob, carol][i % 3];
            const T = (await master.getGetRewardsData()).totalShares;
            const res = await buy(who, key, toNano(i < 12 ? '3' : '1.2'));
            expectNoFailures(res);
            for (const sp of splitEvents(res.transactions)) {
                expect(sp.wallet).toBe(0n);
                if (T < REWARD_MIN_SHARES) { below++; expect(sp.rewards).toBe(0n); } else if (sp.rewards > 0n) above++;
                accrued += sp.rewards;                       // extra goes to the buyback bucket (buyback on)
            }
            const rd = await master.getGetRewardsData();
            expect([rd.accrued, rd.carry]).toEqual([accrued, 0n]);
        }
        expect(below).toBeGreaterThan(0);
        expect(above).toBeGreaterThan(0);
        let paid = 0n;
        for (const o of [alice, bob, carol]) {
            const c0 = (await master.getGetRewardsData()).claimed;
            expectNoFailures(await claim(master, o));
            paid += (await master.getGetRewardsData()).claimed - c0;
        }
        expect((await master.getGetRewardsData()).accrued - paid).toBeLessThan(10n);
        await solvent(master);
    });

    it('R9B-1/2: below 1% tracked the holders\' share goes to the buyback bucket (buyback on), else to the tax wallet (wallet on); from 1% on it accrues', async () => {
        const snap = chain.snapshot();
        for (const kind of ['buyback', 'wallet'] as const) {
            await chain.loadFrom(snap);
            chain.now = T0;
            const taxWallet = await chain.treasury('tax-wallet');
            const o: CreateOpts = kind === 'buyback' ? { rewardsBps: 5000n, buybackBps: 5000n } : { rewardsBps: 5000n, walletBps: 5000n };
            const res0 = await factory.send(creator.getSender(), { value: await factory.getGetCreateValue2(0n, false) },
                { ...createBody({ buyTaxBps: 500n, sellTaxBps: 500n, ...o }), taxWallet: kind === 'wallet' ? taxWallet.address : null });
            expectNoFailures(res0);
            const master = chain.openContract(LaunchJetton.fromAddress(await factory.getGetTokenAddress((await factory.getGetFactoryData()).nextIndex - 1n)));
            const key = await master.getGetPoolKey();
            let below = 0, above = 0;
            for (let i = 0; i < 12; i++) {
                const T = (await master.getGetRewardsData()).totalShares;
                const rd0 = await master.getGetRewardsData();
                const res = await buy([alice, bob, carol][i % 3], key, toNano('10'));
                expectNoFailures(res);
                const [sp] = splitEvents(res.transactions);
                const x = sp.amount;
                const share = (x * 5000n) / 10000n;
                const r = share - sp.rent;
                const rd1 = await master.getGetRewardsData();
                const paidW = comments(res.transactions, master.address, taxWallet.address, 'Marg tax').reduce((a, b) => a + b, 0n);
                expect(sp.rewards + sp.rent + sp.wallet + sp.buyback).toBe(x);
                expect(rd1.carry).toBe(0n);
                if (T < REWARD_MIN_SHARES) {
                    below++;
                    expect(rd1.accrued).toBe(rd0.accrued);
                    if (kind === 'buyback') expect([sp.rewards, sp.wallet, sp.buyback]).toEqual([0n, 0n, x - sp.rent]);
                    else {
                        expect([sp.rewards, sp.wallet, sp.buyback]).toEqual([0n, x - sp.rent, 0n]);
                        expect(paidW).toBeGreaterThanOrEqual(x - sp.rent);
                    }
                } else {
                    above++;
                    expect(sp.rewards).toBe(r);
                    expect(rd1.accrued - rd0.accrued).toBe(r);
                    if (kind === 'buyback') expect(sp.buyback).toBe(x - share);
                    else expect(sp.wallet).toBe(x - share);
                }
            }
            expect(below).toBeGreaterThan(0);
            expect(above).toBeGreaterThan(0);
            await solvent(master);
        }
    });

    it('R9B-1 / R10-1: with every holder below 1% for 20 round trips nothing is carried (all to the buyback), so a just-in-time buyer who crosses 1% finds nothing to take and loses money', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        expectNoFailures(await buy(alice, key, toNano('13')));
        for (let i = 0; i < 20; i++) {
            chain.now! += 3600;
            expectNoFailures(await buy(bob, key, toNano('6')));
            chain.now! += 3600;
            await sellAll(master, bob, key);
        }
        const rd0 = await master.getGetRewardsData();
        expect([rd0.accrued, rd0.carry]).toEqual([0n, 0n]);
        const m0 = (await balOf(mallory.address)) + (await balOf(m2.address));
        expectNoFailures(await buy(mallory, key, toNano('130')));
        for (let i = 0; i < 12; i++) {
            expectNoFailures(await buy(m2, key, toNano('2.2')));
            chain.now! += 120;
        }
        expect((await master.getGetRewardsData()).carry).toBe(0n);
        expectNoFailures(await claim(master, mallory));
        expectNoFailures(await claim(master, m2));
        await sellAll(master, mallory, key);
        await sellAll(master, m2, key);
        expect((await balOf(mallory.address)) + (await balOf(m2.address)) - m0).toBeLessThan(0n);
        await solvent(master);
    });

    // -----------------------------------------------------------------------
    // R7B-6: ProvideWalletAddress before the launch
    // -----------------------------------------------------------------------

    it('R7B-6: ProvideWalletAddress before the launch answers addr_none; after the launch the real wallet address', async () => {
        const idx = (await factory.getGetFactoryData()).nextIndex;
        const pre = chain.openContract(await LaunchJetton.fromInit(factory.address, idx));
        expect(pre.address.equals(await factory.getGetTokenAddress(idx))).toBe(true);
        const ask = async (deploy: boolean) => {
            const body = beginCell().store(storeProvideWalletAddress({ $$type: 'ProvideWalletAddress', queryId: 77n, ownerAddress: alice.address, includeAddress: false })).endCell();
            const res = await chain.sendMessage(internal({ from: mallory.address, to: pre.address, value: toNano('0.05'), body,
                ...(deploy ? { stateInit: pre.init } : {}) }));
            expectNoFailures(res);
            const tx = res.transactions.find((t) => src(t)?.equals(pre.address) && dst(t)?.equals(mallory.address))!;
            const s = tx.inMessage!.body.beginParse();
            expect([s.loadUint(32), s.loadUintBig(64)]).toEqual([OPS.take, 77n]);
            return s;
        };
        // Anyone can deploy the master's address before the factory does: it answers addr_none.
        let s = await ask(true);
        expect(s.preloadUint(2)).toBe(0);
        expect(s.loadMaybeAddress()).toBeNull();
        // The launch (factory) still works on the pre-deployed address.
        const res = await factory.send(creator.getSender(), { value: await factory.getGetCreateValue2(0n, false) }, createBody({}));
        expectNoFailures(res);
        expect((await pre.getGetLaunchState()).settled).toBe(true);
        s = await ask(false);
        const w = s.loadAddress();
        expect(w.equals(await pre.getGetWalletAddress(alice.address))).toBe(true);
    });

    // -----------------------------------------------------------------------
    // R6A-5: a sender below the reserve at the advertised minimum
    // -----------------------------------------------------------------------

    // Fixed in v4 (jetton.tact JettonTransfer requires and get_transfer_fee advertises the reserve refill). What
    // remains is the documented long-idle-wallet limit: a getter cannot see rent no transaction has charged yet, so
    // at exactly the advertised minimum an idle sender's transfer is either delivered and registered, refused
    // (bounced, nothing moves), or delivered with the receiver under-reported (best effort; any SyncRewards
    // repairs it). Tokens are never destroyed, and after a top-up (what the app does) every case registers.
    it('R6A-5: a tracked sender idle 0-6 years at the advertised minimum never destroys tokens; an under-reported receiver is repaired by SyncRewards; after a top-up the receiver is always registered', async () => {
        const { master, key } = await launch({ buyTaxBps: 300n, sellTaxBps: 300n, rewardsBps: 9999n, buybackBps: 1n });
        expectNoFailures(await buy(alice, key, toNano('5')));
        const wa = await walletOf(master, alice.address);
        const snap = chain.snapshot();
        const rows: string[] = [];
        const bad: string[] = [];
        for (const years of [0, 1, 2, 3, 4, 6]) {
            for (const fwdTon of [0n, 1n]) {
                await chain.loadFrom(snap);
                chain.now = T0 + years * YEAR + DAY;
                const fresh = await chain.treasury(`fresh-${years}-${fwdTon}`);
                const need = await wa.getGetTransferFee(fresh.address);
                const payload = beginCell().storeUint(0, 32).storeStringTail('hello').endCell();
                const probe = await transfer(master, alice, fresh.address, 1n, toNano('1'), fwdTon, fwdTon > 0n ? payload : undefined);
                const tx0 = probe.transactions.find((tx) => dst(tx)?.equals(wa.address))!;
                const fwdIn = (tx0.inMessage!.info as any).forwardFee as bigint;
                const due = ((tx0.description as any).storagePhase?.storageFeesDue ?? 0n) as bigint;
                await chain.loadFrom(snap);
                chain.now = T0 + years * YEAR + DAY;
                const g0 = await balOf(wa.address);
                const a0 = await jBal(master, alice.address);
                // value > fwd + n x fwdFee + get_transfer_fee (+ storage due; the checkpoints' forward fees are 2 more)
                const value = need + fwdTon + (fwdTon > 0n ? 4n : 3n) * fwdIn + due + toNano('0.0002');
                const res = await transfer(master, alice, fresh.address, 1000n, value, fwdTon, fwdTon > 0n ? payload : undefined);
                const got = await jBal(master, fresh.address);
                const acked = (await rState(master, fresh.address))?.acked ?? -1n;
                const a1 = await jBal(master, alice.address);
                const row = `idle ${years}y fwd=${fwdTon}: sender Gram ${g0} (due ${due}), value ${value}: receiver got ${got}, acked ${acked}, sender acked ${(await rState(master, alice.address))!.acked} of ${a1}`;
                rows.push(row);
                expect(a0 - a1).toBe(got);                       // never destroyed
                if (got === 1000n && acked !== got) {
                    // Under-reported receive: a third party's SyncRewards on the receiver's wallet repairs it.
                    const fw = await walletOf(master, fresh.address);
                    expectNoFailures(await fw.send(bob.getSender(), { value: toNano('0.1') }, { $$type: 'SyncRewards', queryId: 7n }));
                    expect((await rState(master, fresh.address))!.acked).toBe(1000n);
                }
                // After a 0.05 Gram top-up of the sender's wallet, the advertised minimum always registers the receiver.
                await chain.loadFrom(snap);
                chain.now = T0 + years * YEAR + DAY;
                expectNoFailures(await chain.sendMessage(internal({ from: alice.address, to: wa.address, value: toNano('0.05'), bounce: true, body: Cell.EMPTY })));
                const need2 = await wa.getGetTransferFee(fresh.address);
                const value2 = need2 + fwdTon + (fwdTon > 0n ? 4n : 3n) * fwdIn + toNano('0.0002');
                await transfer(master, alice, fresh.address, 1000n, value2, fwdTon, fwdTon > 0n ? payload : undefined);
                const got2 = await jBal(master, fresh.address);
                const acked2 = (await rState(master, fresh.address))?.acked ?? -1n;
                if (got2 !== 1000n || acked2 !== got2) bad.push(row + ` | after top-up: got ${got2}, acked ${acked2}`);
                void res;
            }
        }
        // eslint-disable-next-line no-console
        console.log('R6A-5:\n' + rows.join('\n'));
        expect(bad).toEqual([]);
    });

    it('checked (audit R6A): a buy with exactly the Router\'s minimum swap value at 67 to 1000 nanoGram/gas registers the buyer; nothing is destroyed', async () => {
        const snap = chain.snapshot();
        for (const p of [67n, 200n, 400n, 700n, 1000n]) {
            await chain.loadFrom(snap);
            chain.setConfig(config0);
            chain.now = T0;
            setGasPrice(chain, BASE_PRICE);
            const { master, key } = await launch({ buyTaxBps: 300n, sellTaxBps: 300n, rewardsBps: 9999n, buybackBps: 1n });
            expectNoFailures(await buy(alice, key, toNano('5')));
            setGasPrice(chain, p);
            const rw = await walletOf(master, router.address);
            const r0 = (await rw.getGetWalletData()).balance;
            const extra = (await router.getGetSwapGas(24n, false, 0n, key.ext, true)) + toNano('0.02');
            expectNoFailures(await buy(bob, key, toNano('5'), extra));
            const out = r0 - (await rw.getGetWalletData()).balance;
            const got = await jBal(master, bob.address);
            expect(got).toBeGreaterThan(0n);
            expect(out).toBe(got);
            expect((await rState(master, bob.address))!.acked).toBe(got);
        }
        chain.setConfig(config0);
    });

    // -----------------------------------------------------------------------
    // R6A-1 (was audit8a-rewards and audit8b-phantom-shares): no phantom shares
    // -----------------------------------------------------------------------

    it('R6A-1 (audit8a thresholds): an in-flight +T receive checkpoint at x2 to x40 gas: applied, bounced or lost, the wallet never holds more acked shares than tokens; SyncRewards repairs every non-lost case', async () => {
        const snap = chain.snapshot();
        const rows: string[] = [];
        for (const f of [2n, 3n, 4n, 8n, 16n, 40n]) {
            await chain.loadFrom(snap);
            chain.setConfig(config0);
            chain.now = T0;
            setGasPrice(chain, BASE_PRICE);
            const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
            expectNoFailures(await buy(alice, key, toNano('100')));
            const w2 = await walletOf(master, m2.address);
            await qm().pushMessage(internal({ from: m2.address, to: router.address, value: toNano('100.7'),
                body: beginCell().store(storeSwapNative(swapMsg(key, toNano('100')))).endCell() }));
            for (;;) {
                const t = (await step())!;
                if (dst(t)?.equals(w2.address) && opOf(t) === OPS.internal) break;
            }
            const T = (await w2.getGetWalletData()).balance;
            setGasPrice(chain, f * BASE_PRICE);
            await drain();
            setGasPrice(chain, BASE_PRICE);
            let s = await w2.getGetRewardState();
            rows.push(`x${f}: synced ${s.synced}, acked ${s.acked}, inFlight ${s.inFlight} (T ${T})`);
            expect(s.acked).toBeLessThanOrEqual(T);
            if (s.inFlight === 0n) {
                expectNoFailures(await syncBy(master, m2.address, mallory));
                s = await w2.getGetRewardState();
                expect([s.synced, s.acked, s.inFlight]).toEqual([T, T, 0n]);
                expect((await master.getGetRewardsData()).totalShares).toBe(await realSum(master, [alice.address, m2.address]));
            }
        }
        // eslint-disable-next-line no-console
        console.log('R6A-1 thresholds:\n' + rows.join('\n'));
    });

    // The audit8b sequence: mallory -> sybil (all X), the gas price rises while sybil's +X checkpoint is in flight, sybil sends
    // everything back before the bounce returns; then the documented repair (SyncRewards), an accrual and everybody claims.
    async function phantomScenario(newPrice: bigint | null) {
        setGasPrice(chain, BASE_PRICE);
        const sybil = await chain.treasury('sybil', { balance: toNano('1000000') });
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        expectNoFailures(await buy(alice, key, toNano('100')));
        expectNoFailures(await buy(bob, key, toNano('100')));
        expectNoFailures(await buy(mallory, key, toNano('100')));
        const X = await jBal(master, mallory.address);
        const wm = await walletOf(master, mallory.address);
        const ws = await walletOf(master, sybil.address);
        for (const h of [alice, bob, mallory]) expectNoFailures(await claim(master, h));
        const it = await chain.sendMessageIter(internal({
            from: mallory.address, to: wm.address, value: toNano('0.3'),
            body: beginCell().store(storeJettonTransfer(xferBody(sybil.address, X, mallory.address))).endCell(),
        }));
        for await (const tx of it) {
            if (dst(tx)?.equals(ws.address) && opOf(tx) === OPS.internal) break;
        }
        expect((await ws.getGetRewardState()).inFlight).toBe(1n);
        if (newPrice) setGasPrice(chain, newPrice);
        const resB = await chain.sendMessage(internal({
            from: sybil.address, to: ws.address, value: toNano('1'),
            body: beginCell().store(storeJettonTransfer(xferBody(mallory.address, X, sybil.address))).endCell(),
        }));
        const cps = resB.transactions.filter((tx) => dst(tx)?.equals(master.address) && src(tx)?.equals(ws.address) && opOf(tx) === OPS.checkpoint);
        const s1 = await ws.getGetRewardState();
        expectNoFailures(await syncBy(master, sybil.address, bob));
        expectNoFailures(await syncBy(master, mallory.address, bob));
        if (newPrice) setGasPrice(chain, BASE_PRICE);
        const owners = [alice.address, bob.address, mallory.address, sybil.address];
        const s2 = await ws.getGetRewardState();
        const rd = await master.getGetRewardsData();
        const sumAcked = await ackedSum(master, owners);
        const real = await realSum(master, owners);
        const rd0 = await master.getGetRewardsData();
        expectNoFailures(await buy(alice, key, toNano('400')));
        expectNoFailures(await syncBy(master, alice.address, bob));
        const rd1 = await master.getGetRewardsData();
        const pends: Record<string, bigint> = {};
        for (const [n, h] of [['sybil', sybil], ['mallory', mallory], ['alice', alice], ['bob', bob]] as [string, SandboxContract<TreasuryContract>][]) {
            pends[n] = await pend(master, h.address);
        }
        const sumPend = Object.values(pends).reduce((a, b) => a + b, 0n);
        const paid: Record<string, bigint> = {};
        for (const [n, h] of [['sybil', sybil], ['mallory', mallory], ['alice', alice], ['bob', bob]] as [string, SandboxContract<TreasuryContract>][]) {
            const c0 = (await master.getGetRewardsData()).claimed;
            const r = await claim(master, h);
            expectNoFailures(r);
            paid[n] = (await master.getGetRewardsData()).claimed - c0;
        }
        return { master, X, cps, s1, s2, rd, sumAcked, pends, sumPend, paid, accrued: rd1.accrued - rd0.accrued, unclaimed: rd1.accrued - rd1.claimed, sybilBal: await jBal(master, sybil.address), real };
    }

    for (const factor of [null, 3n, 4n] as const) {
        it(`R6A-1 (audit8b phantom shares) ${factor ? `gas price x${factor} while a +checkpoint is in flight` : 'control (no gas-price change)'}: after the repair no wallet earns on tokens it does not hold; every claim is paid in full`, async () => {
            const r = await phantomScenario(factor ? BASE_PRICE * factor : null);
            if (factor) {
                expect(r.cps.map(txOk)).toEqual([false, true]);          // +X bounced, -X applied
                // v4: signed acked mirrors the master's view (-X), not clamped at 0.
                expect([r.s1.synced, r.s1.acked]).toEqual([-r.X, -r.X]);
            }
            expect(r.sybilBal).toBe(0n);
            expect([r.s2.synced, r.s2.acked, r.s2.inFlight]).toEqual([0n, 0n, 0n]);
            expect(r.sumAcked).toBe(r.rd.totalShares);
            expect(r.rd.totalShares).toBe(r.real);
            expect(r.pends.sybil).toBe(0n);
            expect(r.paid.sybil).toBe(0n);
            expect(r.sumPend).toBeLessThanOrEqual(r.unclaimed);
            for (const n of ['mallory', 'alice', 'bob']) expect(r.paid[n]).toBe(r.pends[n]);
            await solvent(r.master);
        });
    }

    // -----------------------------------------------------------------------
    // V3-M1: launch-fee escrow outcome (was audit4-escrow, audit7b-escrow-outcome, audit5-shard-race)
    // -----------------------------------------------------------------------

    // Runs CreateToken until the master has run LaunchSetup; the mint -> Router wallet -> Router -> Pool hops are held back.
    async function startLaunch(devBuy = 0n) {
        const idx = (await factory.getGetFactoryData()).nextIndex;
        const masterAddr = await factory.getGetTokenAddress(idx);
        const value = await factory.getGetCreateValue2(devBuy, false);
        const it = await chain.sendMessageIter(internal({ from: creator.address, to: factory.address, value,
            body: beginCell().store(storeCreateToken(createBody({ devBuy }))).endCell() }));
        for (;;) { const r = await it.next(); if (r.done || dst(r.value)?.equals(masterAddr)) break; }
        const q = qm().messageQueue as any[];
        const heldMsgs = q.splice(0, q.length);
        const master = chain.openContract(LaunchJetton.fromAddress(masterAddr));
        const release = async () => {
            for (const mm of heldMsgs) qm().pushMessage(mm);
            return (await qm().runQueue()) as { transactions: BlockchainTransaction[] };
        };
        return { master, masterAddr, release };
    }

    it('V3-M1 (audit4 fee evasion): a refused MintNative with refundTo = master does not settle the escrow; the launch then succeeds and the treasury is paid the launch fee', async () => {
        const { master, masterAddr, release } = await startLaunch();
        expect((await master.getGetLaunchState()).feeEscrow).toBe(LAUNCH_FEE);
        const key = await master.getGetPoolKey();
        const tb = await balOf(treasury.address);
        const r = await router.send(creator.getSender(), { value: toNano('0.9') }, {
            $$type: 'MintNative', queryId: 99n, amount: toNano('0.1'), otherToken: key.token1, tickSpacing: key.tickSpacing, ext: key.ext,
            tickLower: -100n, tickUpper: 100n, sqrtPriceInitX96: 0n, minLiquidity: 0n, owner: null, refundTo: masterAddr,
            deadline: BigInt(T0 + 600), sqrtPriceMinX96: 0n, sqrtPriceMaxX96: 0n,
        });
        const pool = chain.openContract(Pool.fromAddress(await router.getGetPoolAddress(key.token0, key.token1, key.tickSpacing, key.ext)));
        let ls = await master.getGetLaunchState();
        expect([ls.settled, ls.feeEscrow]).toEqual([false, LAUNCH_FEE]);
        expect(r.transactions.filter((tx) => src(tx)?.equals(masterAddr) && dst(tx)?.equals(creator.address)).map(valueIn)
            .reduce((a, b) => a + b, 0n)).toBeLessThan(LAUNCH_FEE);
        await release();
        expect((await pool.getGetPoolState()).initialized).toBe(true);
        ls = await master.getGetLaunchState();
        expect([ls.settled, ls.feeEscrow]).toEqual([true, 0n]);
        expect((await balOf(treasury.address)) - tb).toBeGreaterThan(LAUNCH_FEE - toNano('0.001'));   // (minus the treasury's own receive gas)
    });

    it('V3-M1 (audit4 griefing): a refused SwapNative with refundTo = master does not pay the fee; the launch then fails (deadline) and the fee goes back to the creator', async () => {
        const { master, masterAddr, release } = await startLaunch(toNano('20'));
        const key = await master.getGetPoolKey();
        const tb = await balOf(treasury.address);
        const r = await router.send(mallory.getSender(), { value: toNano('1.5') }, {
            $$type: 'SwapNative', queryId: 1n, amount: toNano('0.01'), otherToken: key.token1, tickSpacing: key.tickSpacing, ext: key.ext, minOut: 0n,
            sqrtPriceLimitX96: 0n, maxCrossings: 1n, allowPartial: false, deadline: BigInt(T0 + 600), receiver: null,
            refundTo: masterAddr, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null,
        });
        let ls = await master.getGetLaunchState();
        expect([ls.settled, ls.feeEscrow]).toEqual([false, LAUNCH_FEE]);
        expect(r.transactions.some((tx) => src(tx)?.equals(masterAddr) && dst(tx)?.equals(treasury.address))).toBe(false);
        // The launch now fails: the chain stalls past the launch deadline.
        chain.now = T0 + 700;
        const c0 = await balOf(creator.address);
        await release();
        const pool = chain.openContract(Pool.fromAddress(await router.getGetPoolAddress(key.token0, key.token1, key.tickSpacing, key.ext)));
        expect((await pool.getGetPoolState()).initialized).toBe(false);
        ls = await master.getGetLaunchState();
        expect([ls.settled, ls.feeEscrow]).toEqual([true, 0n]);
        expect((await balOf(treasury.address)) - tb).toBeLessThan(toNano('0.01'));
        // fee and dev buy back to the creator
        expect((await balOf(creator.address)) - c0).toBeGreaterThan(LAUNCH_FEE + toNano('19'));
    });

    it('V3-M1 (audit7b): forged GramPayouts (LAUNCH_DONE 19, LAUNCH_REFUND 17) from a non-pool address while the launch is in flight neither settle nor move the escrow', async () => {
        const { master, release } = await startLaunch();
        const tb = await balOf(treasury.address);
        for (const reason of [19n, 17n, 18n]) {
            const res = await master.send(mallory.getSender(), { value: toNano('0.2') }, {
                $$type: 'GramPayout', queryId: 0n, reason, amount: 0n, payload: null,
            } as any);
            expect(res.transactions.some((tx) => dst(tx)?.equals(treasury.address))).toBe(false);
            const ls = await master.getGetLaunchState();
            expect([ls.settled, ls.feeEscrow]).toEqual([false, LAUNCH_FEE]);
        }
        await release();
        const ls = await master.getGetLaunchState();
        expect([ls.settled, ls.feeEscrow]).toEqual([true, 0n]);
        expect((await balOf(treasury.address)) - tb).toBeGreaterThan(LAUNCH_FEE - toNano('0.001'));   // (minus the treasury's own receive gas)
        // After the launch a forged LAUNCH_DONE moves nothing either.
        const t1 = await balOf(treasury.address);
        await master.send(mallory.getSender(), { value: toNano('0.2') }, { $$type: 'GramPayout', queryId: 0n, reason: 19n, amount: 0n, payload: null } as any);
        expect(await balOf(treasury.address)).toBe(t1);
    });

    for (const delayed of [false, true]) {
        it(`R6B-2 (audit5 shard race): dev-buy launch with a swap (receiver = refundTo = master) right behind it, creator-wallet excess ${delayed ? 'one step late (other shard)' : 'in order'}: the treasury is paid the launch fee`, async () => {
            const devBuy = toNano('1');
            const idx = (await factory.getGetFactoryData()).nextIndex;
            const masterAddr = await factory.getGetTokenAddress(idx);
            const master = chain.openContract(LaunchJetton.fromAddress(masterAddr));
            const value = await factory.getGetCreateValue2(devBuy, false);
            const tb = await balOf(treasury.address);
            const it = await chain.sendMessageIter(internal({ from: creator.address, to: factory.address, value,
                body: beginCell().store(storeCreateToken(createBody({ devBuy }))).endCell() }));
            let key: any; let poolAddr: Address | undefined; let creatorWallet: Address | undefined;
            const late: any[] = [];
            let injected = false;
            for (;;) {
                if (delayed && creatorWallet) {
                    const q = qm().messageQueue as any[];
                    for (let i = q.length - 1; i >= 0; i--) {
                        const inf = q[i].info;
                        if (inf?.src?.equals?.(creatorWallet) && inf?.dest?.equals?.(masterAddr)) late.push(...q.splice(i, 1));
                    }
                }
                const r = await it.next();
                if (r.done) break;
                const tx = r.value as BlockchainTransaction;
                if (dst(tx)?.equals(masterAddr) && !key) {
                    key = await master.getGetPoolKey();
                    poolAddr = await router.getGetPoolAddress(key.token0, key.token1, key.tickSpacing, key.ext);
                    creatorWallet = await master.getGetWalletAddress(creator.address);
                }
                if (!injected && poolAddr && dst(tx)?.equals(poolAddr) && src(tx)?.equals(router.address)) {
                    injected = true;
                    await qm().pushMessage(internal({ from: creator.address, to: router.address, value: toNano('1.5'),
                        body: beginCell().store(storeSwapNative({
                            $$type: 'SwapNative', queryId: 99n, amount: toNano('0.5'), otherToken: key.token1, tickSpacing: key.tickSpacing, ext: key.ext,
                            minOut: 0n, sqrtPriceLimitX96: 0n, maxCrossings: 2n, allowPartial: false, deadline: BigInt(T0 + 600),
                            receiver: masterAddr, refundTo: masterAddr, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null,
                        })).endCell() }));
                }
            }
            for (const m of late) await qm().pushMessage(m);
            await qm().runQueue();
            const pool = chain.openContract(Pool.fromAddress(poolAddr!));
            expect((await pool.getGetPoolState()).initialized).toBe(true);
            chain.now = T0 + 5000;
            await chain.sendMessage(internal({ from: admin.address, to: masterAddr, value: toNano('0.1'), body: Cell.EMPTY }));
            const ls = await master.getGetLaunchState();
            expect([ls.settled, ls.feeEscrow]).toEqual([true, 0n]);
            expect((await balOf(treasury.address)) - tb).toBeGreaterThan(LAUNCH_FEE - toNano('0.001'));   // (minus the treasury's own receive gas)
        });
    }
});
