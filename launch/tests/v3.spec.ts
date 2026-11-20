// Marg direct launch v3: regression tests for the 2026-11 review findings (L-4, L-5, L-6, R2-L2,
// R2-L6 and the launch-fee / bounce / tax-wallet info items). Sandbox only, against the real dex/v2
// Router and Pool.

import { Blockchain, BlockchainTransaction, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import '@ton/test-utils';
import { LaunchFactory, LaunchParams, loadLaunchBounced, storeLaunchSetup } from '../build/Launch_LaunchFactory';
import { LaunchJetton, loadTaxSplitEvent, storeGramPayout, storeJettonExcesses, storeRewardCheckpoint } from '../build/Launch_LaunchJetton';
import { LaunchWallet, storeJettonTransfer, storeProvideWalletAddress, storeCreateToken } from '../build/Launch_LaunchWallet';
import { LaunchVault } from '../build/Launch_LaunchVault';
import { Router } from '../../dex/v2/build/Router_Router';
import { Pool } from '../../dex/v2/build/Router_Pool';
import { txOk, events, refundCodes, opOf, CODES } from '../../dex/v2/tests/helpers';
import { poolCodeArgs } from './poolcode';

jest.setTimeout(900000);

const T0 = 1_800_000_000;
const SUPPLY = 10n ** 18n;
const PARAMS: LaunchParams = { $$type: 'LaunchParams', startMcap: toNano('2600'), tickSpacing: 10n };
const TIERS = { $$type: 'LaunchTiers' as const, low: PARAMS,
    mid: { $$type: 'LaunchParams' as const, startMcap: toNano('10000'), tickSpacing: 10n },
    high: { $$type: 'LaunchParams' as const, startMcap: toNano('30000'), tickSpacing: 10n } };
const LAUNCH_FEE = toNano('1.5');
const OPS = { checkpoint: 0x4d4c0030, ack: 0x4d4c0032, taxSplit: 0x4d4c0022, buyback: 0x4d4c0023, bounced: 0x4d4c0025, take: 0xd1735400 };
const BB_TAG = 0x4d4cbbbbn;

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

// Gram that `to` received from `from` in a trace.
const received = (txs: BlockchainTransaction[], from: Address, to: Address) =>
    txs.filter((tx) => src(tx)?.equals(from) && dst(tx)?.equals(to)).reduce((x, tx) => x + valueIn(tx), 0n);

// Config params 20 / 21 (gas prices, masterchain / basechain): set the gas price to `nano` nanoGram per gas.
function setGasPrice(chain: Blockchain, nano: bigint): bigint {
    const dict = Dictionary.loadDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell(), chain.config);
    let old = 0n;
    for (const id of [20, 21]) {
        const s = dict.get(id)!.beginParse();
        const b = beginCell();
        let tag = s.loadUint(8);
        if (tag === 0xd1) {                         // gas_flat_pfx: flat_gas_limit, flat_gas_price
            const limit = s.loadUintBig(64);
            s.loadUintBig(64);
            b.storeUint(tag, 8).storeUint(limit, 64).storeUint(limit * nano, 64);
            tag = s.loadUint(8);
        }
        old = s.loadUintBig(64) >> 16n;             // gas_price is nanoGram << 16
        b.storeUint(tag, 8).storeUint(nano << 16n, 64).storeSlice(s);
        dict.set(id, b.endCell());
    }
    chain.setConfig(beginCell().storeDictDirect(dict).endCell());
    return old;
}

describe('Marg direct launch v3: review fixes', () => {
    let chain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let treasury: SandboxContract<TreasuryContract>;
    let creator: SandboxContract<TreasuryContract>;
    let holders: SandboxContract<TreasuryContract>[];
    let mallory: SandboxContract<TreasuryContract>;
    let router: SandboxContract<Router>;
    let factory: SandboxContract<LaunchFactory>;
    let config0: Cell;
    let base: any;

    type CreateOpts = {
        devBuy?: bigint; buyTaxBps?: bigint; sellTaxBps?: bigint; taxWallet?: Address | null; queryId?: bigint;
        rewardsBps?: bigint; walletBps?: bigint; buybackBps?: bigint; antiSnipePips?: bigint; antiSnipeDuration?: bigint; value?: bigint;
        vaultBps?: bigint; from?: SandboxContract<TreasuryContract>; factory?: SandboxContract<LaunchFactory>; tickSpacing?: bigint;
    };
    async function createMsg(o: CreateOpts = {}) {
        const f = o.factory ?? factory;
        const devBuy = o.devBuy ?? 0n;
        const vaultBps = o.vaultBps ?? 0n;
        const p = (await f.getGetFactoryData()).tiers.low;
        return {
            value: o.value ?? await f.getGetCreateValue2(devBuy, vaultBps > 0n),
            body: {
                $$type: 'CreateToken' as const, queryId: o.queryId ?? 7n, content: content('V3 Test'), devBuy, minDevOut: 0n,
                buyTaxBps: o.buyTaxBps ?? 0n, sellTaxBps: o.sellTaxBps ?? 0n, taxWallet: o.taxWallet ?? null,
                rewardsBps: o.rewardsBps ?? 0n, walletBps: o.walletBps ?? 0n, buybackBps: o.buybackBps ?? 0n,
                antiSnipePips: o.antiSnipePips ?? 0n, antiSnipeDuration: o.antiSnipeDuration ?? 0n,
                startMcap: p.startMcap, tickSpacing: o.tickSpacing ?? p.tickSpacing,
                vaultBps, vaultLock: vaultBps > 0n ? 7n * 86400n : 0n, vaultVest: 0n,
            },
        };
    }
    async function create(o: CreateOpts = {}) {
        const m = await createMsg(o);
        return (o.factory ?? factory).send((o.from ?? creator).getSender(), { value: m.value }, m.body);
    }
    async function opened(index: bigint, f = factory) {
        const master = chain.openContract(LaunchJetton.fromAddress(await f.getGetTokenAddress(index)));
        const key = await master.getGetPoolKey();
        const pool = chain.openContract(Pool.fromAddress(await router.getGetPoolAddress(key.token0, key.token1, key.tickSpacing, key.ext)));
        return { master, key, pool };
    }
    async function launch(o: CreateOpts = {}) {
        const res = await create(o);
        expectNoFailures(res);
        const idx = (await factory.getGetFactoryData()).nextIndex - 1n;
        return { res, ...(await opened(idx)) };
    }
    const walletOf = async (master: SandboxContract<LaunchJetton>, owner: Address) =>
        chain.openContract(LaunchWallet.fromAddress(await master.getGetWalletAddress(owner)));
    const active = async (a: Address) => (await chain.getContract(a)).accountState?.type === 'active';
    const jBal = async (master: SandboxContract<LaunchJetton>, owner: Address) => {
        const w = await walletOf(master, owner);
        return (await active(w.address)) ? (await w.getGetWalletData()).balance : 0n;
    };
    const balOf = async (a: Address) => (await chain.getContract(a)).balance;
    const buy = (who: SandboxContract<TreasuryContract>, key: any, amount: bigint) =>
        router.send(who.getSender(), { value: amount + toNano('0.7') }, {
            $$type: 'SwapNative', queryId: 1n, amount, otherToken: key.token1, tickSpacing: key.tickSpacing, ext: key.ext, minOut: 0n,
            sqrtPriceLimitX96: 0n, maxCrossings: 24n, allowPartial: false, deadline: BigInt(chain.now! + 600), receiver: null,
            refundTo: null, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null,
        });
    const xferBody = (to: Address, amount: bigint, resp: Address) => ({
        $$type: 'JettonTransfer' as const, queryId: 3n, amount, destination: to, responseDestination: resp, customPayload: null,
        forwardTonAmount: 0n, forwardPayload: beginCell().storeBit(0).endCell().beginParse(),
    });
    const transfer = async (master: SandboxContract<LaunchJetton>, from: SandboxContract<TreasuryContract>, to: Address, amount: bigint,
                            value = toNano('0.12'), resp = from.address) =>
        (await walletOf(master, from.address)).send(from.getSender(), { value }, xferBody(to, amount, resp));
    const collect = (key: any) =>
        router.send(mallory.getSender(), { value: toNano('0.3') }, { $$type: 'CollectTax', queryId: 0n, key: { ...key, $$type: 'PoolKey' } });
    const gramPayout = (reason: bigint, amount: bigint, queryId = 0n) =>
        beginCell().store(storeGramPayout({ $$type: 'GramPayout', queryId, reason, amount, payload: null })).endCell();
    const splits = (txs: BlockchainTransaction[]) =>
        events({ transactions: txs } as any).filter((e) => e.op === OPS.taxSplit).map((e) => loadTaxSplitEvent(e.body.clone()));

    beforeAll(async () => {
        chain = await Blockchain.create();
        chain.now = T0;
        config0 = chain.config;
        admin = await chain.treasury('admin');
        treasury = await chain.treasury('treasury');
        creator = await chain.treasury('creator', { balance: toNano('1000000') });
        holders = [];
        for (const n of ['h0', 'h1', 'h2']) holders.push(await chain.treasury(n, { balance: toNano('1000000') }));
        mallory = await chain.treasury('mallory', { balance: toNano('1000000') });
        router = chain.openContract(await Router.fromInit(admin.address, treasury.address));
        await router.send(admin.getSender(), { value: toNano('1') }, null);
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
    // L-4: tax payouts and buyback refunds only from the token's own pool
    // -----------------------------------------------------------------------

    it('L-4: the master derives its pool address (= the Router\'s) for every kind of launch; the factory exposes the pool code', async () => {
        const [hash, depth] = await poolCodeArgs();
        const pc = await factory.getGetPoolCode();
        expect([pc.hash, pc.depth]).toEqual([hash, depth]);
        const variants: CreateOpts[] = [
            {},
            { devBuy: toNano('5') },
            { buyTaxBps: 300n, sellTaxBps: 500n, rewardsBps: 5000n, walletBps: 2000n, buybackBps: 3000n },
            { buyTaxBps: 100n, rewardsBps: 9999n, buybackBps: 1n, vaultBps: 2000n, antiSnipePips: 900000n, antiSnipeDuration: 60n },
            { vaultBps: 5000n, antiSnipePips: 150000n, antiSnipeDuration: 15n },
        ];
        for (const v of variants) {
            const { master, pool } = await launch(v);
            expect((await master.getGetPoolAddress()).toString()).toBe(pool.address.toString());
            expect((await pool.getGetPoolState()).initialized).toBe(true);
        }
    });

    it('L-4: a fake TAX payout moves no counter and no buyback timing; a fake buyback refund does not change `spent`', async () => {
        const { master, key, pool } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, buybackBps: 10000n });
        const snap = async () => ({ tax: await master.getGetTaxData(), bb: await master.getGetBuybackStatus(), rw: await master.getGetRewardsData() });
        const js = (o: any) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
        const s0 = await snap();
        expect(s0.bb.count).toBe(0n);
        // Fake payouts big enough to trigger a buyback if they were believed: from a stranger, the Router and the creator.
        for (const from of [mallory.address, router.address, creator.address]) {
            const res = await chain.sendMessage(internal({ from, to: master.address, value: toNano('30'), body: gramPayout(14n, toNano('30')) }));
            expectNoFailures(res);
            expect(splits(res.transactions)).toEqual([]);
            expect(events(res as any).filter((e) => e.op === OPS.buyback)).toEqual([]);
            expect(received(res.transactions, master.address, creator.address)).toBeGreaterThan(toNano('29.9'));   // a donation: forwarded to the creator
        }
        expect(js(await snap())).toBe(js(s0));
        // A real payout (a taxed buy) splits and runs the buyback.
        const res = await buy(holders[0], key, toNano('100'));
        expectNoFailures(res);
        expect(splits(res.transactions).length).toBeGreaterThanOrEqual(1);       // the buy's tax (and the buyback's own buy tax)
        const s1 = await snap();
        expect([s1.bb.count, s1.tax.taxIn > 0n, s1.bb.spent > 0n]).toEqual([1n, true, true]);
        // Fake refunds of "the buyback" (own-query id) from non-pool senders: `spent` stays; the Gram is a donation to the bucket.
        const qid = (BB_TAG << 32n) + 1n;
        for (const reason of [2n, 10n]) {
            const r = await chain.sendMessage(internal({ from: mallory.address, to: master.address, value: toNano('1'), body: gramPayout(reason, s1.bb.spent, qid) }));
            expectNoFailures(r);
        }
        const s2 = await snap();
        expect(s2.bb.spent).toBe(s1.bb.spent);
        expect(s2.bb.balance).toBeGreaterThan(s1.bb.balance + toNano('1.9'));
        expect(js(s2.tax)).toBe(js(s1.tax));
        // The same refund from the pool is believed.
        await chain.sendMessage(internal({ from: pool.address, to: master.address, value: toNano('1'), body: gramPayout(2n, toNano('1'), qid) }));
        expect((await snap()).bb.spent).toBe(s1.bb.spent - toNano('1'));
    });

    // -----------------------------------------------------------------------
    // L-5 and the tax-wallet rules
    // -----------------------------------------------------------------------

    it('L-5: a masterchain creator is refused before anything is deployed and gets the whole value back; non-basechain tax wallet refused', async () => {
        const mc = await chain.treasury('mc-creator', { workchain: -1, balance: toNano('1000') });
        expect(mc.address.workChain).toBe(-1);
        const tb = await balOf(treasury.address);
        const cb = await balOf(mc.address);
        const res = await create({ from: mc, devBuy: toNano('20') });
        expect(res.transactions).toHaveTransaction({ from: mc.address, to: factory.address, success: false });
        expect(res.transactions).toHaveTransaction({ from: factory.address, to: mc.address, inMessageBounced: true });
        expect(res.transactions.length).toBe(3);                                  // wallet, factory (refused), bounce: nothing deployed
        expect((await factory.getGetFactoryData()).nextIndex).toBe(0n);
        expect(await active(await factory.getGetTokenAddress(0n))).toBe(false);
        expect(await balOf(treasury.address)).toBe(tb);                           // no launch fee taken
        expect(cb - (await balOf(mc.address))).toBeLessThan(toNano('0.3'));       // only (masterchain) gas: the 1.5 fee and the 20 dev buy came back
        // A tax wallet outside the basechain is refused the same way.
        const r2 = await create({ buyTaxBps: 300n, walletBps: 10000n, taxWallet: mc.address });
        expect(r2.transactions).toHaveTransaction({ to: factory.address, success: false });
        expect((await factory.getGetFactoryData()).nextIndex).toBe(0n);
        // Admin addresses: only basechain.
        const r3 = await factory.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetTreasury', queryId: 0n, treasury: mc.address });
        expect(r3.transactions).toHaveTransaction({ to: factory.address, success: false });
        const r4 = await factory.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'TransferAdmin', queryId: 0n, newAdmin: mc.address });
        expect(r4.transactions).toHaveTransaction({ to: factory.address, success: false });
    });

    it('tax wallet: the token\'s creator vault, its master, the factory and the Router are refused (the wallet share would be locked)', async () => {
        const master = await factory.getGetTokenAddress(0n);
        const vault = chain.openContract(await LaunchVault.fromInit(master)).address;
        for (const taxWallet of [vault, master, factory.address, router.address]) {
            for (const vaultBps of [0n, 2000n]) {
                const res = await create({ buyTaxBps: 300n, walletBps: 10000n, taxWallet, vaultBps });
                expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });
                expect((await factory.getGetFactoryData()).nextIndex).toBe(0n);
            }
        }
        // Any other basechain address is fine, with or without a vault.
        const ok = await launch({ buyTaxBps: 300n, walletBps: 10000n, taxWallet: holders[2].address, vaultBps: 2000n });
        expect((await ok.master.getGetVaultAddress())!.toString()).toBe(vault.toString());
        expect((await ok.master.getGetTaxData()).taxWallet!.toString()).toBe(holders[2].address.toString());
    });

    // -----------------------------------------------------------------------
    // L-6: TEP-89
    // -----------------------------------------------------------------------

    it('L-6: provide_wallet_address answers addr_none for a non-basechain owner (TEP-89), the wallet address otherwise', async () => {
        const { master } = await launch({});
        const ask = async (owner: Address, include: boolean) => {
            const res = await chain.sendMessage(internal({ from: mallory.address, to: master.address, value: toNano('0.05'),
                body: beginCell().store(storeProvideWalletAddress({ $$type: 'ProvideWalletAddress', queryId: 77n, ownerAddress: owner, includeAddress: include })).endCell() }));
            expectNoFailures(res);
            const tx = res.transactions.find((t) => src(t)?.equals(master.address) && dst(t)?.equals(mallory.address))!;
            return tx.inMessage!.body.beginParse();
        };
        const mcOwner = new Address(-1, Buffer.alloc(32, 7));
        let s = await ask(mcOwner, true);
        expect([s.loadUint(32), s.loadUintBig(64)]).toEqual([OPS.take, 77n]);
        expect(s.preloadUint(2)).toBe(0);                           // addr_none$00
        expect(s.loadMaybeAddress()).toBeNull();
        expect(s.loadMaybeRef()!.beginParse().loadAddress().toString()).toBe(mcOwner.toString());
        expect(s.remainingBits).toBe(0);
        s = await ask(holders[0].address, false);
        s.skip(96);
        expect(s.loadAddress().toString()).toBe((await master.getGetWalletAddress(holders[0].address)).toString());
        expect(s.loadMaybeRef()).toBeNull();
    });

    // -----------------------------------------------------------------------
    // R2-L2: reward message values follow the gas price; nothing sticks
    // -----------------------------------------------------------------------

    it('R2-L2 (v4): reward values are gas amounts priced by the chain config (2x headroom on what a wallet sends) and scale with it', async () => {
        const { master } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        setGasPrice(chain, 400n);
        const v400 = await master.getGetRewardValues();
        const CUSHION = toNano('0.002'), MIN = toNano('0.01');
        // checkpoint = 2 x (master + ack compute) + the ack's rent cushion + 2 forward fees.
        const fwd = v400.checkpoint - 2n * (58500n + 15000n) * 400n - CUSHION;      // 2 forward fees
        expect(v400.ack).toBe(4n * 15000n * 400n + CUSHION);                       // CLAIM_ACK_HEADROOM 4
        expect(fwd).toBeGreaterThan(0n);
        expect(fwd).toBeLessThan(toNano('0.004'));
        // claim = wallet compute (CLAIM_WALLET_GAS 21000) + storage reserve + 2 x claimMin (master compute + the ack (4 x its compute + cushion)
        // + 2 forward fees) + 1 forward fee.
        expect(v400.claim).toBe((21000n + 2n * (70000n + 4n * 15000n)) * 400n + 2n * CUSHION + MIN + fwd * 5n / 2n);
        // sync = wallet compute + storage reserve + checkpoint + 1 forward fee (the caller's excess).
        expect(v400.sync).toBe(v400.checkpoint + 21000n * 400n + MIN + fwd / 2n);   // CLAIM_WALLET_GAS 21000 (audit C7)
        expect(v400.checkpoint).toBeLessThan(toNano('0.062'));
        expect(v400.claim).toBeLessThan(toNano('0.13'));
        setGasPrice(chain, 4000n);
        const v4000 = await master.getGetRewardValues();
        expect(v4000.ack - CUSHION).toBe((v400.ack - CUSHION) * 10n);
        expect(v4000.checkpoint - fwd - CUSHION).toBe((v400.checkpoint - fwd - CUSHION) * 10n);
        expect(v4000.claim - fwd * 5n / 2n - 2n * CUSHION - MIN).toBe((v400.claim - fwd * 5n / 2n - 2n * CUSHION - MIN) * 10n);
    });

    for (const price of [400n, 2000n, 6000n]) {
        it(`R2-L2: at ${price} nanoGram/gas transfers checkpoint, acks are processed, inFlight returns to 0 and ClaimRewards pays`, async () => {
            const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
            const [a, b] = holders;
            // Trades at the default price (the DEX gas constants are not the subject here).
            expectNoFailures(await buy(a, key, toNano('100')));
            expectNoFailures(await buy(b, key, toNano('20')));
            expectNoFailures(await collect(key));
            const old = setGasPrice(chain, price);
            expect(old).toBeGreaterThan(0n);
            const rv = await master.getGetRewardValues();
            const wa = await walletOf(master, a.address), wb = await walletOf(master, b.address);
            const shares0 = (await master.getGetRewardsData()).totalShares;
            // Tracked -> tracked transfer: both checkpoints run, both acks are processed.
            const res = await transfer(master, a, b.address, 12345n, toNano('0.3') * price / 400n);
            expectNoFailures(res);
            const cps = res.transactions.filter((tx) => opOf(tx) === OPS.checkpoint);
            const acks = res.transactions.filter((tx) => opOf(tx) === OPS.ack);
            expect([cps.length, acks.length]).toEqual([2, 2]);
            // Within the budgets (the 1.5x margins, worst case, are measured in rewards-hardening.spec.ts).
            for (const tx of acks) expect(Number((tx.description as any).computePhase.gasUsed)).toBeLessThan(15000 / 1.5 + 1);
            for (const tx of cps) expect(Number((tx.description as any).computePhase.gasUsed)).toBeLessThan(58500);
            expect((await wa.getGetRewardState()).inFlight).toBe(0n);
            expect((await wb.getGetRewardState()).inFlight).toBe(0n);
            expect((await master.getGetRewardsData()).totalShares).toBe(shares0);
            expect((await wa.getGetRewardState()).acked).toBe(await jBal(master, a.address));
            // Claim at exactly the wallet's minimum.
            const st = await wa.getGetRewardState();
            const due = await master.getGetPendingRewards(st.acked, st.lastAcc, st.frac, st.owed);
            expect(due).toBeGreaterThan(0n);
            const low = await wa.send(a.getSender(), { value: rv.claim - 1n }, { $$type: 'ClaimRewards', queryId: 9n });
            expect(low.transactions).toHaveTransaction({ to: wa.address, success: false });
            const c = await wa.send(a.getSender(), { value: rv.claim }, { $$type: 'ClaimRewards', queryId: 9n });
            expectNoFailures(c);
            expect((await master.getGetRewardsData()).claimed).toBe(due);
            expect(received(c.transactions, master.address, a.address)).toBeGreaterThanOrEqual(due);
            const s2 = await wa.getGetRewardState();
            expect([s2.inFlight, s2.owed]).toEqual([0n, 0n]);
            // SyncRewards at exactly its minimum.
            const sy = await wb.send(b.getSender(), { value: rv.sync }, { $$type: 'SyncRewards', queryId: 9n });
            expectNoFailures(sy);
            expect((await wb.getGetRewardState()).inFlight).toBe(0n);
            // A second claim is possible right away (nothing is stuck).
            expectNoFailures(await wa.send(a.getSender(), { value: rv.claim * 2n }, { $$type: 'ClaimRewards', queryId: 10n }));
        });
    }

    it('R2-L2: an underfunded checkpoint / claim is refused by the master before it applies anything and bounces: the wallet undoes it', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        const [a] = holders;
        expectNoFailures(await buy(a, key, toNano('100')));
        expectNoFailures(await collect(key));
        const wa = await walletOf(master, a.address);
        const bal = await jBal(master, a.address);
        // The gas price rises 3x while a transfer's checkpoint is in flight: wallet priced it at 400, master sees 1200.
        setGasPrice(chain, 400n);
        const it = await chain.sendMessageIter(internal({ from: a.address, to: wa.address, value: toNano('0.5'),
            body: beginCell().store(storeJettonTransfer(xferBody(holders[1].address, 1000n, a.address))).endCell() }));
        const txs: BlockchainTransaction[] = [(await it.next()).value];
        expect((await wa.getGetRewardState()).inFlight).toBe(1n);
        setGasPrice(chain, 1200n);
        for (let r = await it.next(); !r.done; r = await it.next()) txs.push(r.value);
        const cp = txs.filter((tx) => opOf(tx) === OPS.checkpoint && dst(tx)?.equals(master.address));
        // a's checkpoint (priced at 400) is refused and nothing of it is applied; the receiver's wallet priced its own at 1200.
        expect(cp.map((tx) => [src(tx)!.equals(wa.address), txOk(tx)])).toEqual([[true, false], [false, true]]);
        expect(txs.filter((tx) => opOf(tx) === OPS.ack).length).toBe(1);
        expect(txs.filter((tx) => dst(tx)?.equals(wa.address) && tx.inMessage?.info.type === 'internal' && (tx.inMessage.info as any).bounced).map(txOk)).toEqual([true]);
        const s = await wa.getGetRewardState();
        expect(s.inFlight).toBe(0n);                                             // not stuck
        expect(s.synced).toBe(bal);                                              // the -1000 is still to be reported
        expect(await jBal(master, a.address)).toBe(bal - 1000n);
        expect((await master.getGetRewardsData()).totalShares).toBe(bal + 1000n);   // a's old view + the receiver
        // A claim right now works (at the new price) and reports the pending delta.
        const rv = await master.getGetRewardValues();
        const c = await wa.send(a.getSender(), { value: rv.claim }, { $$type: 'ClaimRewards', queryId: 9n });
        expectNoFailures(c);
        expect((await wa.getGetRewardState()).inFlight).toBe(0n);
        expect((await master.getGetRewardsData()).totalShares).toBe(bal);
        // A claim whose value no longer covers the master's side (price 400 -> 4000) is refused there and bounced: inFlight returns to 0.
        setGasPrice(chain, 400n);
        const it2 = await chain.sendMessageIter(internal({ from: a.address, to: wa.address, value: (await master.getGetRewardValues()).claim,
            body: beginCell().storeUint(0x4d4c0033, 32).storeUint(11, 64).endCell() }));
        const t2: BlockchainTransaction[] = [(await it2.next()).value];
        expect((await wa.getGetRewardState()).inFlight).toBe(1n);
        // v4: the claim carries 2x the master's compute and a 4x ack, so a 3x rise is still applied; 10x is refused.
        setGasPrice(chain, 4000n);
        for (let r = await it2.next(); !r.done; r = await it2.next()) t2.push(r.value);
        expect(t2.filter((tx) => dst(tx)?.equals(master.address)).map(txOk)).toEqual([false]);
        expect((await wa.getGetRewardState()).inFlight).toBe(0n);
        // Forged small checkpoint "from the wallet": refused for value before the sender check.
        const f = await chain.sendMessage(internal({ from: wa.address, to: master.address, value: 1000n, bounce: true,
            body: beginCell().store(storeRewardCheckpoint({ $$type: 'RewardCheckpoint', queryId: 0n, delta: 5n, owner: a.address })).endCell() }));
        expect(f.transactions).toHaveTransaction({ to: master.address, success: false });
        expect((await master.getGetRewardsData()).totalShares).toBe(bal);
    });

    // -----------------------------------------------------------------------
    // L-2: a standard 0.05 Gram transfer of a rewards token
    // -----------------------------------------------------------------------

    it('L-2: at the mainnet gas price (66.7) a 0.05 Gram transfer between tracked holders succeeds with both checkpoints; at 400 it needs ~0.15 and 0.05 is refused cleanly', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        const [a, b, c] = holders;
        expectNoFailures(await buy(a, key, toNano('100')));
        expectNoFailures(await buy(b, key, toNano('20')));
        const wa = await walletOf(master, a.address);
        // The default sandbox config is the mainnet one (config 21: 66.67 nanoGram/gas, checked 2026-11-18).
        const dict = Dictionary.loadDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell(), chain.config);
        expect(Number(dict.get(21)!.beginParse().skip(8 + 64 + 64 + 8).loadUintBig(64) >> 16n)).toBe(66);
        // The wallet StateInit stays under the bound the fee formula uses.
        const acc = (await chain.getContract(wa.address)).accountState as any;
        const seen = new Set<string>();
        let bits = 0, cells = 0;
        const walk = (x: Cell) => { const h = x.hash().toString('hex'); if (seen.has(h)) return; seen.add(h); cells++; bits += x.bits.length; x.refs.forEach(walk); };
        walk(acc.state.code); walk(acc.state.data);
        // (checked at the end, so the transfer checks below still run)
        const initBound = [cells + 3 <= 80, bits + 1100 <= 33500, `wallet StateInit ${cells} cells / ${bits} bits (+3 / +1100 for the body) vs WALLET_INIT_CELLS 80 / WALLET_INIT_BITS 33500`] as const;
        console.log(initBound[2]);
        for (const to of [b, c]) {                                     // an existing tracked wallet, and a brand-new one
            const need = await wa.getGetTransferFee(to.address);
            // v4: 2 checkpoints with 2x headroom; get_transfer_fee + the forward fees (< 0.001) stays under 0.05.
            expect(need + toNano('0.001')).toBeLessThan(toNano('0.05'));
            const before = await jBal(master, to.address);
            const res = await transfer(master, a, to.address, 5000n, toNano('0.05'));
            expectNoFailures(res);
            expect(res.transactions.filter((tx) => opOf(tx) === OPS.checkpoint).length).toBe(2);
            expect(res.transactions.filter((tx) => opOf(tx) === OPS.ack).length).toBe(2);
            expect(await jBal(master, to.address)).toBe(before + 5000n);
            const st = await (await walletOf(master, to.address)).getGetRewardState();
            expect([st.inFlight, st.acked]).toEqual([0n, before + 5000n]);    // fully reported: the receiver earns on all of it
            // The floor: exactly the fee is refused, a little above it passes.
            const low = await transfer(master, a, to.address, 1n, need);
            expect(low.transactions).toHaveTransaction({ to: wa.address, success: false });
            expectNoFailures(await transfer(master, a, to.address, 1n, need + toNano('0.001')));
        }
        expect((await wa.getGetRewardState()).inFlight).toBe(0n);
        expect((await master.getGetRewardsData()).totalShares)
            .toBe((await jBal(master, a.address)) + (await jBal(master, b.address)) + (await jBal(master, c.address)));
        // At 400 nanoGram/gas the same transfer needs ~0.1; 0.05 is refused by the sender's wallet before anything changes.
        setGasPrice(chain, 400n);
        const need400 = await wa.getGetTransferFee(b.address);
        console.log(`L-2: get_transfer_fee at 400 nanoGram/gas: ${need400}`);
        expect(need400).toBeGreaterThan(toNano('0.12'));
        expect(need400).toBeLessThan(toNano('0.17'));
        const balA = await jBal(master, a.address);
        const res = await transfer(master, a, b.address, 5000n, toNano('0.05'));
        expect(res.transactions).toHaveTransaction({ to: wa.address, success: false });
        expect(await jBal(master, a.address)).toBe(balA);
        expect((await wa.getGetRewardState()).inFlight).toBe(0n);
        expectNoFailures(await transfer(master, a, b.address, 5000n, need400 + toNano('0.002')));
        expect([initBound[0], initBound[1], initBound[2]]).toEqual([true, true, initBound[2]]);
    });

    // -----------------------------------------------------------------------
    // R2-L6: no buyback inside the POOL's launch-fee window
    // -----------------------------------------------------------------------

    it('R2-L6: the pool is initialized later than the factory call; no buyback runs before the pool\'s own window has ended', async () => {
        const DUR = 300;
        const LAG = 40;        // seconds between CreateToken and the Pool's initialization
        const m = await createMsg({ buyTaxBps: 500n, sellTaxBps: 500n, buybackBps: 10000n, antiSnipePips: 900000n, antiSnipeDuration: BigInt(DUR) });
        const it = await chain.sendMessageIter(internal({ from: creator.address, to: factory.address, value: m.value,
            body: beginCell().store(storeCreateToken(m.body)).endCell() }));
        const txs: BlockchainTransaction[] = [];
        for (let r = await it.next(); !r.done; r = await it.next()) {
            txs.push(r.value);
            if (dst(r.value)?.equals(router.address)) chain.now = T0 + LAG;     // the Router -> Pool hop arrives LAG seconds later
        }
        expectNoFailures({ transactions: txs });
        const { master, key, pool } = await opened(0n);
        expect((await pool.getGetPoolState()).initialized).toBe(true);
        expect((await master.getGetLaunchInfo()).createdAt).toBe(BigInt(T0));
        const ls = await master.getGetLaunchState();
        expect(ls.settled).toBe(true);
        expect(ls.bbFrom).toBe(BigInt(T0 + LAG + DUR));                         // tightened from T0 + 600 + DUR by the pool's excess
        expect((await master.getGetBuybackStatus()).nextAllowedAt).toBe(ls.bbFrom);
        // Fill the bucket (a tax payout from the pool).
        const fill = () => chain.sendMessage(internal({ from: pool.address, to: master.address, value: toNano('5'), body: gramPayout(14n, toNano('5')) }));
        // createdAt + launchDuration (the v2 rule): the pool's fee is still > 0 for LAG more seconds. No buyback.
        chain.now = T0 + DUR;
        let res = await fill();
        expectNoFailures(res);
        expect(events(res as any).filter((e) => e.op === OPS.buyback)).toEqual([]);
        let st = await master.getGetBuybackStatus();
        expect([st.count, st.wouldRun]).toEqual([0n, false]);
        chain.now = T0 + LAG + DUR - 1;
        const early = await master.send(mallory.getSender(), { value: toNano('0.05') }, { $$type: 'Buyback', queryId: 1n });
        expect(early.transactions).toHaveTransaction({ to: master.address, success: false });
        // A buy at this moment still pays the launch fee; one second later it does not.
        const outLate = async () => {
            const snap = chain.snapshot();
            const r = await buy(holders[0], key, toNano('10'));
            const out = await jBal(master, holders[0].address);
            await chain.loadFrom(snap);
            expectNoFailures(r);
            return out;
        };
        const inside = await outLate();
        chain.now = T0 + LAG + DUR;
        const after = await outLate();
        expect(after).toBeGreaterThan(inside);
        // The window is over: the buyback runs and is a real swap.
        expect((await master.getGetBuybackStatus()).wouldRun).toBe(true);
        res = await master.send(mallory.getSender(), { value: toNano('0.05') }, { $$type: 'Buyback', queryId: 1n });
        expectNoFailures(res);
        st = await master.getGetBuybackStatus();
        expect(st.count).toBe(1n);
        expect(st.burned).toBeGreaterThan(0n);
    });

    it('R2-L6: without any outcome message the buyback waits for the launch deadline + the window (the safe bound)', async () => {
        const { master } = await launch({ buyTaxBps: 500n, buybackBps: 10000n, antiSnipePips: 150000n, antiSnipeDuration: 60n });
        // Normal launch: settled by the pool's excess at T0 (same sandbox time), so bbFrom = T0 + 60.
        expect((await master.getGetLaunchState()).bbFrom).toBe(BigInt(T0 + 60));
        // No anti-snipe fee: no wait at all.
        const plain = await launch({ buyTaxBps: 500n, buybackBps: 10000n });
        expect((await plain.master.getGetLaunchState()).bbFrom).toBe(0n);
        expect((await plain.master.getGetBuybackStatus()).nextAllowedAt).toBe(0n);
    });

    // -----------------------------------------------------------------------
    // Launch fee: held until the outcome is known
    // -----------------------------------------------------------------------

    it('launch fee: paid to the treasury by the master once the launch succeeded (with and without a dev buy); never twice', async () => {
        for (const devBuy of [0n, toNano('25')]) {
            const tb = await balOf(treasury.address);
            const { res, master, key } = await launch({ devBuy });
            const fee = res.transactions.filter((tx) => src(tx)?.equals(master.address) && dst(tx)?.equals(treasury.address));
            expect(fee.map(valueIn)).toEqual([LAUNCH_FEE]);
            expect(fee[0].inMessage!.body.beginParse().skip(32).loadStringTail()).toBe('Launch fee');
            expect(res.transactions.some((tx) => src(tx)?.equals(factory.address) && dst(tx)?.equals(treasury.address))).toBe(false);
            const ls = await master.getGetLaunchState();
            expect([ls.settled, ls.feeEscrow]).toEqual([true, 0n]);
            expect((await balOf(treasury.address)) - tb).toBeGreaterThan(LAUNCH_FEE - toNano('0.001'));
            // Later "failure-looking" messages change nothing: tokens sent to the master with the excess to the master.
            expectNoFailures(await buy(holders[0], key, toNano('5')));
            const cb = await balOf(creator.address);
            const r = await transfer(master, holders[0], master.address, 1000n, toNano('0.2'), master.address);
            expectNoFailures(r);
            expect(r.transactions.some((tx) => dst(tx)?.equals(treasury.address))).toBe(false);
            expect((await balOf(creator.address)) - cb).toBeLessThan(toNano('0.2'));      // only that transfer's own excess
        }
    });

    it('launch fee: a launch the DEX refuses returns the fee (and the dev buy) to the creator; the treasury gets nothing', async () => {
        // A factory whose tier is not a DEX preset (init does not check; SetLaunchParams would): the Router refunds the launch.
        const f2 = chain.openContract(await LaunchFactory.fromInit(admin.address, treasury.address, router.address, LAUNCH_FEE,
            { ...TIERS, low: { ...PARAMS, tickSpacing: 30n } }, ...(await poolCodeArgs())));
        await f2.send(admin.getSender(), { value: toNano('0.5') }, null);
        for (const devBuy of [0n, toNano('50')]) {
            const idx = (await f2.getGetFactoryData()).nextIndex;
            const tb = await balOf(treasury.address);
            const cb = await balOf(creator.address);
            const res = await create({ factory: f2, devBuy, tickSpacing: 30n });
            expectNoFailures(res);
            expect(refundCodes(res as any)).toEqual([CODES.BAD_TICK_SPACING]);
            const master = chain.openContract(LaunchJetton.fromAddress(await f2.getGetTokenAddress(idx)));
            expect(await jBal(master, master.address)).toBe(SUPPLY);           // the supply is stuck in the master's own wallet
            const ls = await master.getGetLaunchState();
            expect([ls.settled, ls.feeEscrow]).toEqual([true, 0n]);
            expect(await balOf(treasury.address)).toBe(tb);
            const spent = cb - (await balOf(creator.address));
            expect(spent).toBeLessThan(toNano('0.3'));                         // gas and the master's storage only: fee + dev buy are back
            expect(await balOf(master.address)).toBeLessThan(toNano('0.06'));
            // eslint-disable-next-line no-console
            console.log(`refused launch (dev buy ${devBuy}): creator spent ${spent} of ${LAUNCH_FEE + devBuy} + gas attached`);
            // Nothing later can pay the fee out again.
            const again = await chain.sendMessage(internal({ from: mallory.address, to: master.address, value: toNano('0.1'), body: Cell.EMPTY }));
            expect(again.transactions.some((tx) => dst(tx)?.equals(treasury.address))).toBe(false);
        }
    });

    it('launch fee: outcome messages cannot be faked while the launch is in flight; with no message at all the fee is released after 2x the deadline', async () => {
        const m = await createMsg({});
        const it = await chain.sendMessageIter(internal({ from: creator.address, to: factory.address, value: m.value,
            body: beginCell().store(storeCreateToken(m.body)).endCell() }));
        const masterAddr = await factory.getGetTokenAddress(0n);
        const master = chain.openContract(LaunchJetton.fromAddress(masterAddr));
        // Run until the master has sent the mint, then hold the rest of the chain.
        for (;;) { const r = await it.next(); if (r.done || dst(r.value)?.equals(masterAddr)) break; }
        const q = (chain as any).defaultQueueManager.messageQueue as any[];
        const held = q.splice(0, q.length);
        expect(held.length).toBeGreaterThan(0);
        expect((await master.getGetLaunchState()).feeEscrow).toBe(LAUNCH_FEE);
        // Fakes from a stranger: an excess, a mint refund, a tax payout, plain Gram. Nothing settles, the fee stays.
        const fakes = [
            beginCell().store(storeJettonExcesses({ $$type: 'JettonExcesses', queryId: 7n })).endCell(),
            gramPayout(13n, toNano('1'), 7n), gramPayout(14n, toNano('1')), gramPayout(2n, toNano('1'), 7n), Cell.EMPTY,
        ];
        const cb = await balOf(creator.address);
        for (const body of fakes) {
            const r = await chain.sendMessage(internal({ from: mallory.address, to: masterAddr, value: toNano('0.1'), body }));
            expectNoFailures(r);
            expect(r.transactions.some((tx) => dst(tx)?.equals(treasury.address))).toBe(false);
        }
        let ls = await master.getGetLaunchState();
        expect([ls.settled, ls.feeEscrow]).toEqual([false, LAUNCH_FEE]);
        expect((await balOf(creator.address)) - cb).toBeLessThan(toNano('0.5'));   // only the fakes' own Gram was forwarded
        expect(await balOf(masterAddr)).toBeGreaterThanOrEqual(LAUNCH_FEE);
        // Deliver the real chain: settled as a success by the pool's excess.
        const snap = chain.snapshot();
        for (const mm of held) (chain as any).defaultQueueManager.pushMessage(mm);
        const rest = await (chain as any).defaultQueueManager.runQueue();
        expect(rest.transactions.filter((tx: BlockchainTransaction) => src(tx)?.equals(masterAddr) && dst(tx)?.equals(treasury.address)).map(valueIn)).toEqual([LAUNCH_FEE]);
        expect((await master.getGetLaunchState()).settled).toBe(true);
        // Or: the outcome message never arrives. Before 2x the deadline nothing; after it any message releases the fee.
        await chain.loadFrom(snap);
        chain.now = T0 + 1200;
        let r = await chain.sendMessage(internal({ from: mallory.address, to: masterAddr, value: toNano('0.1'), body: Cell.EMPTY }));
        expect(r.transactions.some((tx) => dst(tx)?.equals(treasury.address))).toBe(false);
        chain.now = T0 + 1201;
        r = await chain.sendMessage(internal({ from: mallory.address, to: masterAddr, value: toNano('0.1'), body: Cell.EMPTY }));
        expect(r.transactions.filter((tx) => dst(tx)?.equals(treasury.address)).map(valueIn)).toEqual([LAUNCH_FEE]);
        ls = await master.getGetLaunchState();
        expect([ls.settled, ls.feeEscrow]).toEqual([true, 0n]);
    });

    // -----------------------------------------------------------------------
    // Factory bounced handler
    // -----------------------------------------------------------------------

    it('factory: a bounced LaunchSetup returns the whole value to that launch\'s creator, once; other bounces keep the Gram', async () => {
        expectNoFailures(await create({}));
        const master = await factory.getGetTokenAddress(0n);
        const info = await chain.openContract(LaunchJetton.fromAddress(master)).getGetLaunchInfo();
        const setup = beginCell().store(storeLaunchSetup({
            $$type: 'LaunchSetup', queryId: 7n, index: 0n, launchFee: LAUNCH_FEE, content: Cell.EMPTY, info, devBuy: 0n, minDevOut: 0n, routerValue: 0n,
            poolCodeHash: 0n, poolCodeDepth: 0n,
        })).endCell().beginParse();
        // A real bounce body: 0xFFFFFFFF + the first 256 bits of the original body (op, queryId, index, the start of launchFee), no refs.
        const bounceBody = (index: bigint) => beginCell().storeUint(0xffffffff, 32).storeUint(setup.preloadUint(32), 32).storeUint(7, 64).storeUint(index, 64)
            .storeBits(setup.clone().skip(160).loadBits(Math.min(96, setup.remainingBits - 160))).endCell();
        const send = (from: Address, index: bigint, value: bigint) =>
            chain.sendMessage(internal({ from, to: factory.address, value, bounce: false, bounced: true, body: bounceBody(index) } as any));
        const fb = await balOf(factory.address);
        // Not from that launch's master: accepted, logged, nothing sent.
        let res = await send(mallory.address, 0n, toNano('1'));
        expectNoFailures(res);
        expect(res.transactions.length).toBe(1);
        expect((await balOf(factory.address)) - fb).toBeGreaterThan(toNano('0.99'));
        // From the master: the creator gets the value.
        const cb = await balOf(creator.address);
        res = await send(master, 0n, toNano('3'));
        expectNoFailures(res);
        const ev = events(res as any).filter((e) => e.op === OPS.bounced).map((e) => loadLaunchBounced(e.body.clone()));
        expect([ev.length, ev[0].index, ev[0].creator!.equals(creator.address), ev[0].value]).toEqual([1, 0n, true, toNano('3')]);
        expect(received(res.transactions, factory.address, creator.address)).toBeGreaterThan(toNano('2.99'));
        expect((await balOf(creator.address)) - cb).toBeGreaterThan(toNano('2.99'));
        // Only once per launch (the entry is gone): a second bounce stays in the factory.
        res = await send(master, 0n, toNano('3'));
        expect(res.transactions.length).toBe(1);
        // The factory's own funds were never touched.
        expect(await balOf(factory.address)).toBeGreaterThan(fb + toNano('3.9'));
        // The creator map only keeps the last 16 launches.
        for (let i = 0; i < 17; i++) expectNoFailures(await create({}));
        res = await send(await factory.getGetTokenAddress(1n), 1n, toNano('1'));
        expect(res.transactions.length).toBe(1);
        res = await send(await factory.getGetTokenAddress(17n), 17n, toNano('1'));
        expect(received(res.transactions, factory.address, creator.address)).toBeGreaterThan(toNano('0.99'));
    });
});
