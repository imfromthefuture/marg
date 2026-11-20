// Marg launch v4, round-6 fixes: regression tests for pitch/audit-r6a-2026-11-19.md, pitch/audit-r6b-2026-11-19.md
// and the cloud review (signed acked / R6-1, the claim cap R6A-3, the receive path R6A-2 / R6B-3, untracked wallets
// R6A-7, the launch report R6B-2, underfunded launches R6B-4, the Harvest leftover, the master's and the wallets'
// plain Gram receivers, getters with storage debt). Kept from rewards-hardening.spec.ts: the harness.
// (Original header of the harness:) Marg launch v4 holder rewards (v3 design, hardened): regression tests for the round-4 / round-5 audit
// findings (pitch/audit-r4a-2026-11-18.md R4A-1 / R4A-3, pitch/audit-r4b-2026-11-18.md R4B-1 / R4B-2 / R4B-3,
// pitch/audit-r5a-2026-11-19.md R5A-3) against the hardened per-wallet RewardState design:
// REWARD_GAS_HEADROOM, the wallet storage reserve (WALLET_MIN_STORAGE + myStorageDue()), SyncRewards by
// anyone (no ResetRewards: a wallet whose ack is truly lost stays stuck, safely), the master's rent fund and partial claims (RewardAck.owed).
// Sandbox only, against the real dex/v2 Router and Pool.

import * as fs from 'fs';
import * as path from 'path';
import { Blockchain, BlockchainTransaction, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import '@ton/test-utils';
import { LaunchFactory, LaunchParams } from '../build/Launch_LaunchFactory';
import { LaunchJetton, loadTaxSplitEvent } from '../build/Launch_LaunchJetton';
import {
    LaunchWallet, storeClaimRewards, storeJettonTransfer, storeSyncRewards, storeCreateToken,
} from '../build/Launch_LaunchWallet';
import { Router, storeSwapPayload, storeSwapNative } from '../../dex/v2/build/Router_Router';
import { Pool } from '../../dex/v2/build/Router_Pool';
import { txOk, opOf, gramPayouts, REASON, events } from '../../dex/v2/tests/helpers';
import { poolCodeArgs } from './poolcode';

jest.setTimeout(1800000);

const GRAM = new Address(0, Buffer.alloc(32));
const T0 = 1_800_000_000;
const DAY = 86400;
const YEAR = 365 * DAY;
const PARAMS: LaunchParams = { $$type: 'LaunchParams', startMcap: toNano('2600'), tickSpacing: 10n };
const TIERS = { $$type: 'LaunchTiers' as const, low: PARAMS,
    mid: { $$type: 'LaunchParams' as const, startMcap: toNano('10000'), tickSpacing: 10n },
    high: { $$type: 'LaunchParams' as const, startMcap: toNano('30000'), tickSpacing: 10n } };
const LAUNCH_FEE = toNano('1.5');
const OPS = {
    checkpoint: 0x4d4c0030, claim: 0x4d4c0031, ack: 0x4d4c0032, claimRewards: 0x4d4c0033, sync: 0x4d4c0034, reset: 0x4d4c0037,
    transfer: 0x0f8a7ea5, internal: 0x178d4519, excesses: 0xd53276db,
};
const BASE_PRICE = 67n;          // nanoGram per gas (mainnet: 66.67)

// Code constants, read from the contract sources.
function tactConst(file: string, n: string): bigint {
    const k = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const m = k.match(new RegExp(`const ${n}: Int = (?:ton\\("([0-9.]+)"\\)|([0-9]+));`));
    if (!m) throw new Error(`${n} not found in ${file}`);
    return m[1] ? toNano(m[1]) : BigInt(m[2]);
}
const J = (n: string) => tactConst('../contracts/jetton.tact', n);
const C = {
    CP_MASTER_GAS: J('CP_MASTER_GAS'), ACK_GAS: J('ACK_GAS'), CLAIM_MASTER_GAS: J('CLAIM_MASTER_GAS'), CLAIM_WALLET_GAS: J('CLAIM_WALLET_GAS'),
    WALLET_MIN_STORAGE: J('WALLET_MIN_STORAGE'), MASTER_MIN_STORAGE: J('MASTER_MIN_STORAGE'), RENT_FUND_TARGET: J('RENT_FUND_TARGET'),
    TAX_PAYOUT_GAS: tactConst('../../dex/v2/contracts/constants.tact', 'TAX_PAYOUT_GAS'),
};

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
const gasOf = (tx: BlockchainTransaction) => Number((tx.description as any).computePhase?.gasUsed ?? 0);
const isBounced = (tx: BlockchainTransaction) => tx.inMessage?.info.type === 'internal' && (tx.inMessage.info as any).bounced === true;
const js = (o: any) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
function expectNoFailures(res: { transactions: BlockchainTransaction[] }) {
    const bad = res.transactions.filter((tx) => !txOk(tx));
    expect(bad.map((tx) => [exitCode(tx), opOf(tx)?.toString(16)])).toEqual([]);
}
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
const storageOf = (tx: BlockchainTransaction) => {
    const sp = (tx.description as any).storagePhase;
    return { collected: (sp?.storageFeesCollected ?? 0n) as bigint, due: (sp?.storageFeesDue ?? 0n) as bigint };
};

// Config params 20 / 21: set the gas price to `nano` nanoGram per gas.
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

describe('Marg launch v4: round-6 fixes', () => {
    let chain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let treasury: SandboxContract<TreasuryContract>;
    let creator: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let mallory: SandboxContract<TreasuryContract>;
    let m2: SandboxContract<TreasuryContract>;
    let m3: SandboxContract<TreasuryContract>;
    let router: SandboxContract<Router>;
    let factory: SandboxContract<LaunchFactory>;
    let config0: Cell;
    let base: any;

    type CreateOpts = { buyTaxBps?: bigint; sellTaxBps?: bigint; rewardsBps?: bigint; walletBps?: bigint; buybackBps?: bigint; taxWallet?: Address | null; vaultBps?: bigint };
    async function launch(o: CreateOpts = {}) {
        const p = (await factory.getGetFactoryData()).tiers.low;
        const vaultBps = o.vaultBps ?? 0n;
        const res = await factory.send(creator.getSender(), { value: await factory.getGetCreateValue2(0n, vaultBps > 0n) }, {
            $$type: 'CreateToken', queryId: 7n, content: content('V4H'), devBuy: 0n, minDevOut: 0n,
            buyTaxBps: o.buyTaxBps ?? 0n, sellTaxBps: o.sellTaxBps ?? 0n, taxWallet: o.taxWallet ?? null,
            rewardsBps: o.rewardsBps ?? 0n, walletBps: o.walletBps ?? 0n, buybackBps: o.buybackBps ?? 0n,
            antiSnipePips: 0n, antiSnipeDuration: 0n, startMcap: p.startMcap, tickSpacing: p.tickSpacing,
            vaultBps, vaultLock: vaultBps > 0n ? 7n * 86400n : 0n, vaultVest: 0n,
        });
        expectNoFailures(res);
        const idx = (await factory.getGetFactoryData()).nextIndex - 1n;
        const master = chain.openContract(LaunchJetton.fromAddress(await factory.getGetTokenAddress(idx)));
        const key = await master.getGetPoolKey();
        const pool = chain.openContract(Pool.fromAddress(await router.getGetPoolAddress(key.token0, key.token1, key.tickSpacing, key.ext)));
        return { master, key, pool };
    }
    const walletOf = async (master: SandboxContract<LaunchJetton>, owner: Address) =>
        chain.openContract(LaunchWallet.fromAddress(await master.getGetWalletAddress(owner)));
    const active = async (a: Address) => (await chain.getContract(a)).accountState?.type === 'active';
    const jBal = async (master: SandboxContract<LaunchJetton>, owner: Address) => {
        const w = await walletOf(master, owner);
        return (await active(w.address)) ? (await w.getGetWalletData()).balance : 0n;
    };
    const rState = async (master: SandboxContract<LaunchJetton>, owner: Address) => {
        const w = await walletOf(master, owner);
        return (await active(w.address)) ? await w.getGetRewardState() : null;
    };
    // What the owner could claim now (wallet state + the master's accumulator).
    const pend = async (master: SandboxContract<LaunchJetton>, owner: Address) => {
        const w = await walletOf(master, owner);
        if (!(await active(w.address))) return 0n;
        return w.getGetPendingRewards((await master.getGetRewardsData()).acc);
    };
    const balOf = async (a: Address) => (await chain.getContract(a)).balance;
    const buy = (who: SandboxContract<TreasuryContract>, key: any, amount: bigint) =>
        router.send(who.getSender(), { value: amount + toNano('0.7') }, {
            $$type: 'SwapNative', queryId: 1n, amount, otherToken: key.token1, tickSpacing: key.tickSpacing, ext: key.ext, minOut: 0n,
            sqrtPriceLimitX96: 0n, maxCrossings: 24n, allowPartial: false, deadline: BigInt(chain.now! + 600), receiver: null,
            refundTo: null, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null,
        });
    function sellBody(key: any, amount: bigint, who: Address) {
        const p = beginCell().store(storeSwapPayload({
            $$type: 'SwapPayload', otherToken: GRAM, tickSpacing: key.tickSpacing, ext: key.ext, minOut: 0n, sqrtPriceLimitX96: 0n,
            maxCrossings: 24n, allowPartial: false, deadline: BigInt(chain.now! + 600), receiver: null, refundTo: null, referral: null,
            refBps: 0n, fwdTon: 0n, fwdPayload: null,
        })).endCell();
        return {
            $$type: 'JettonTransfer' as const, queryId: 2n, amount, destination: router.address, responseDestination: who,
            customPayload: null, forwardTonAmount: toNano('0.7'), forwardPayload: beginCell().storeBit(1).storeRef(p).endCell().beginParse(),
        };
    }
    const sell = async (who: SandboxContract<TreasuryContract>, master: SandboxContract<LaunchJetton>, key: any, amount: bigint) =>
        (await walletOf(master, who.address)).send(who.getSender(), { value: toNano('0.8') }, sellBody(key, amount, who.address));
    const xferBody = (to: Address, amount: bigint, resp: Address) => ({
        $$type: 'JettonTransfer' as const, queryId: 3n, amount, destination: to, responseDestination: resp, customPayload: null,
        forwardTonAmount: 0n, forwardPayload: beginCell().storeBit(0).endCell().beginParse(),
    });
    const transfer = async (master: SandboxContract<LaunchJetton>, from: SandboxContract<TreasuryContract>, to: Address, amount: bigint, value = toNano('0.12')) =>
        (await walletOf(master, from.address)).send(from.getSender(), { value }, xferBody(to, amount, from.address));
    const claim = async (master: SandboxContract<LaunchJetton>, who: SandboxContract<TreasuryContract>, value = toNano('0.1')) =>
        (await walletOf(master, who.address)).send(who.getSender(), { value }, { $$type: 'ClaimRewards', queryId: 9n });
    const syncBy = async (master: SandboxContract<LaunchJetton>, owner: Address, by: SandboxContract<TreasuryContract>, value?: bigint) => {
        const w = await walletOf(master, owner);
        return w.send(by.getSender(), { value: value ?? (await w.getGetRewardValues()).sync }, { $$type: 'SyncRewards', queryId: 5n });
    };
    // held(): what the master owes (holders, rent fund, buyback bucket, launch-fee escrow).
    const held = async (master: SandboxContract<LaunchJetton>) => {
        const rd = await master.getGetRewardsData();
        return rd.accrued + rd.carry - rd.claimed + rd.rentFund + (await master.getGetBuybackStatus()).balance + (await master.getGetLaunchState()).feeEscrow;
    };
    // The master's own reserve floor during a claim: storage minimum + rent fund + buyback bucket + escrow.
    const floor = async (master: SandboxContract<LaunchJetton>) => {
        const rd = await master.getGetRewardsData();
        return C.MASTER_MIN_STORAGE + rd.rentFund + (await master.getGetBuybackStatus()).balance + (await master.getGetLaunchState()).feeEscrow;
    };
    const solvent = async (master: SandboxContract<LaunchJetton>) => {
        const rd = await master.getGetRewardsData();
        expect(rd.claimed).toBeLessThanOrEqual(rd.accrued);
        expect(await balOf(master.address)).toBeGreaterThanOrEqual(await held(master));
    };
    // Sum of the tracked wallets' acked shares must be the master's totalShares (nothing in flight).
    const sharesConsistent = async (master: SandboxContract<LaunchJetton>, owners: Address[]) => {
        let sum = 0n;
        for (const o of owners) {
            const s = await rState(master, o);
            if (!s) continue;
            expect(s.inFlight).toBe(0n);
            expect(s.acked).toBe(await jBal(master, o));
            sum += s.acked;
        }
        expect((await master.getGetRewardsData()).totalShares).toBe(sum);
    };
    // A claim that may be refused by the master (e.g. "Rewards insolvent"): returns the master's exit code
    // (0 = paid) instead of failing the test, so the per-holder checks below can report what happened.
    const tryClaim = async (master: SandboxContract<LaunchJetton>, who: SandboxContract<TreasuryContract>) => {
        const r = await claim(master, who);
        const mtx = r.transactions.find((tx) => dst(tx)?.equals(master.address) && opOf(tx) === OPS.claim);
        expect(r.transactions.filter((tx) => !txOk(tx) && tx !== mtx && !isBounced(tx))).toEqual([]);
        return mtx ? (exitCode(mtx) as number) : -1;
    };
    // A claim on a stuck wallet (inFlight > 0): must be refused by the wallet itself and its value returned.
    const STUCK_REFUSED = -100;
    const stuckClaim = async (master: SandboxContract<LaunchJetton>, who: SandboxContract<TreasuryContract>) => {
        const w = await walletOf(master, who.address);
        const r = await claim(master, who, toNano('0.1'));
        const wtx = r.transactions.filter((tx) => dst(tx)?.equals(w.address) && src(tx)?.equals(who.address));
        const back = r.transactions.filter((tx) => src(tx)?.equals(w.address) && dst(tx)?.equals(who.address) && isBounced(tx)).map(valueIn);
        const toMaster = r.transactions.some((tx) => dst(tx)?.equals(master.address));
        const ok = wtx.length === 1 && !txOk(wtx[0]) && back.length === 1 && back[0] > toNano('0.095') && !toMaster;
        return ok ? STUCK_REFUSED : (wtx[0] ? exitCode(wtx[0]) : -1);
    };
    // Runs a message, calling hook after each transaction (to change the config mid-trace).
    async function runIter(m: any, hook: (tx: BlockchainTransaction, i: number) => void) {
        const it = await chain.sendMessageIter(m);
        const txs: BlockchainTransaction[] = [];
        for await (const tx of it) {
            txs.push(tx);
            hook(tx, txs.length - 1);
        }
        return txs;
    }

    beforeAll(async () => {
        chain = await Blockchain.create();
        chain.now = T0;
        config0 = chain.config;
        admin = await chain.treasury('admin');
        treasury = await chain.treasury('treasury');
        creator = await chain.treasury('creator', { balance: toNano('1000000') });
        alice = await chain.treasury('alice', { balance: toNano('1000000') });
        bob = await chain.treasury('bob', { balance: toNano('1000000') });
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

    const splitEvents = (txs: BlockchainTransaction[]) =>
        events({ transactions: txs } as any).filter((e: any) => e.op === 0x4d4c0022).map((e: any) => loadTaxSplitEvent(e.body.clone()));
    const qm = () => (chain as any).defaultQueueManager;
    const step = async () => (await qm().runQueueIter(true).next()).value as BlockchainTransaction | undefined;
    const drain = async () => {
        const out: BlockchainTransaction[] = [];
        while (qm().messageQueue.length > 0) {
            const t = await step();
            if (t) out.push(t);
        }
        return out;
    };
    const swapBody = (key: any, amount: bigint) => beginCell().store(storeSwapNative({
        $$type: 'SwapNative', queryId: 1n, amount, otherToken: key.token1, tickSpacing: key.tickSpacing, ext: key.ext, minOut: 0n,
        sqrtPriceLimitX96: 0n, maxCrossings: 24n, allowPartial: false, deadline: BigInt(chain.now! + 600), receiver: null,
        refundTo: null, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null,
    })).endCell();
    const realOf = async (master: SandboxContract<LaunchJetton>, owners: SandboxContract<TreasuryContract>[]) => {
        let s = 0n;
        for (const o of owners) s += await jBal(master, o.address);
        return s;
    };
    const ackedOf = async (master: SandboxContract<LaunchJetton>, owners: SandboxContract<TreasuryContract>[]) => {
        let s = 0n;
        for (const o of owners) s += (await rState(master, o.address))?.acked ?? 0n;
        return s;
    };
    // A claim whose master result is reported (exit, amount paid, what stays owed).
    const claimR = async (master: SandboxContract<LaunchJetton>, who: SandboxContract<TreasuryContract>) => {
        const want = await pend(master, who.address);
        const c0 = (await master.getGetRewardsData()).claimed;
        const r = await claim(master, who);
        expectNoFailures(r);
        return { want, paid: (await master.getGetRewardsData()).claimed - c0, owed: (await rState(master, who.address))!.owed };
    };
    // Tokens in all wallets of a token (holders given + the Router's + the master's own) == supply.
    const conserved = async (master: SandboxContract<LaunchJetton>, owners: Address[]) => {
        let s = await jBal(master, router.address) + await jBal(master, master.address);
        for (const o of owners) s += await jBal(master, o);
        return s === (await master.getGetJettonData()).totalSupply;
    };

    // -----------------------------------------------------------------------
    // R6-1 (R6A-1 / R6B-1): a +T checkpoint that bounces (or is lost), then -T applied
    // -----------------------------------------------------------------------

    // m2 buys at 67; the gas price rises while its wallet's receive checkpoint (+T) is on its way to the master;
    // m2 sends all T on to m3 before the master's answer is back. `spike`: only the master's +T transaction runs
    // at the high price (then the price is back to 67) and m2's transfer is moved in front of the answer.
    async function r61(price: bigint, spike: boolean) {
        setGasPrice(chain, BASE_PRICE);
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        expectNoFailures(await buy(alice, key, toNano('100')));
        expectNoFailures(await buy(bob, key, toNano('100')));
        const w2 = await walletOf(master, m2.address);
        const txs: BlockchainTransaction[] = [];
        await qm().pushMessage(internal({ from: m2.address, to: router.address, value: toNano('100.7'), body: swapBody(key, toNano('100')) }));
        for (;;) {
            const t = (await step())!;
            txs.push(t);
            if (dst(t)?.equals(w2.address) && opOf(t) === OPS.internal) break;
        }
        const T = (await w2.getGetWalletData()).balance;
        expect((await w2.getGetRewardState()).inFlight).toBe(1n);
        setGasPrice(chain, price);
        if (spike) {
            for (;;) {
                const t = (await step())!;
                txs.push(t);
                if (dst(t)?.equals(master.address) && src(t)?.equals(w2.address) && opOf(t) === OPS.checkpoint) break;
            }
            setGasPrice(chain, BASE_PRICE);
        }
        await qm().pushMessage(internal({ from: m2.address, to: w2.address, value: toNano('1'),
            body: beginCell().store(storeJettonTransfer(xferBody(m3.address, T, m2.address))).endCell() }));
        if (spike) {
            const q = qm().messageQueue as any[];
            const mine = q.pop();
            const i = q.findIndex((m: any) => m.info.dest?.equals(w2.address) && m.info.src?.equals(master.address));
            q.splice(i >= 0 ? i : q.length, 0, mine);
        }
        txs.push(...await drain());
        setGasPrice(chain, BASE_PRICE);
        const cps = txs.filter((t) => dst(t)?.equals(master.address) && src(t)?.equals(w2.address) && opOf(t) === OPS.checkpoint);
        return { master, key, w2, T, cps };
    }

    it('R6-1 exact sequence (x3: +T bounces, -T applied): acked follows the master to -T, the owner\'s SyncRewards repairs it to 0, no phantom earnings, the last claimer is paid in full', async () => {
        const { master, key, w2, T, cps } = await r61(3n * BASE_PRICE, false);
        const all = [alice, bob, m2, m3];
        expect(cps.map(txOk)).toEqual([false, true]);              // +T bounced, -T applied
        let s = await w2.getGetRewardState();
        expect(await jBal(master, m2.address)).toBe(0n);
        expect([s.synced, s.acked, s.inFlight]).toEqual([-T, -T, 0n]);   // v4: signed, mirrors the master's view
        expect((await master.getGetRewardsData()).totalShares).toBe(await ackedOf(master, all));
        expect(await pend(master, m2.address)).toBe(0n);
        // The repair: the owner's SyncRewards (+T).
        expectNoFailures(await syncBy(master, m2.address, m2));
        s = await w2.getGetRewardState();
        expect([s.synced, s.acked, s.inFlight]).toEqual([0n, 0n, 0n]);
        for (const o of all) expectNoFailures(await syncBy(master, o.address, o));
        const real = await realOf(master, all);
        expect((await master.getGetRewardsData()).totalShares).toBe(real);
        expect(await ackedOf(master, all)).toBe(real);
        // Everyone claims, one accrual, everyone claims again: the empty wallet earns nothing, everyone else is paid in full.
        for (const o of all) expectNoFailures(await claim(master, o));
        const rd0 = await master.getGetRewardsData();
        expectNoFailures(await buy(creator, key, toNano('400')));
        const rd1 = await master.getGetRewardsData();
        const A = rd1.accrued - rd0.accrued;
        expect(A).toBeGreaterThan(toNano('10'));
        expect(await pend(master, m2.address)).toBe(0n);
        const rows: string[] = [];
        let sum = 0n;
        for (const o of [m2, m3, alice, bob]) {                  // bob last
            const c = await claimR(master, o);
            rows.push(`want ${c.want} paid ${c.paid} owed ${c.owed}`);
            expect(c.paid).toBe(c.want);
            expect(c.owed).toBe(0n);
            sum += c.paid;
        }
        expect(sum).toBeLessThanOrEqual(A);
        expect(A - sum).toBeLessThan(10n);
        await solvent(master);
        // eslint-disable-next-line no-console
        console.log(`R6-1 x3: T ${T}; after the accrual of ${A}: ${rows.join('; ')}`);
    });

    it('R6-1 lost variant (x30 spike: +T lost, -T applied) and R6A-3: the stuck wallet cannot claim, nobody is refused, the cap pays what is there and the rest stays owed', async () => {
        const { master, key, w2, T, cps } = await r61(30n * BASE_PRICE, true);
        const all = [alice, bob, m2, m3];
        expect(cps.map(txOk)).toEqual([false, true]);
        const s = await w2.getGetRewardState();
        expect(s.inFlight).toBe(1n);                               // stuck: the +T neither applied nor bounced
        expect(s.acked).toBe(-T);
        expect(await pend(master, m2.address)).toBe(0n);
        expectNoFailures(await syncBy(master, m2.address, m2));    // cannot repair a lost message
        expect((await w2.getGetRewardState()).inFlight).toBe(1n);
        const real = await realOf(master, all);
        const rd0 = await master.getGetRewardsData();
        expect(real - rd0.totalShares).toBe(T);                    // understated for good: the others are over-credited
        for (const o of [alice, bob, m3]) expectNoFailures(await claim(master, o));
        const rd1 = await master.getGetRewardsData();
        expectNoFailures(await buy(creator, key, toNano('400')));
        const rd2 = await master.getGetRewardsData();
        const avail = rd2.accrued - rd2.claimed;
        const want = { m3: await pend(master, m3.address), alice: await pend(master, alice.address), bob: await pend(master, bob.address) };
        expect(want.m3 + want.alice + want.bob).toBeGreaterThan(avail);   // more promised than accrued
        const rows: string[] = [`accrual ${rd2.accrued - rd1.accrued}, available ${avail}, promised ${want.m3 + want.alice + want.bob}`];
        const res: { want: bigint; paid: bigint; owed: bigint }[] = [];
        for (const o of [m3, alice, bob]) {
            const c = await claimR(master, o);                    // never refused (no "Rewards insolvent")
            res.push(c);
            rows.push(`want ${c.want} paid ${c.paid} owed ${c.owed}`);
            expect(c.paid + c.owed).toBe(c.want);
            const rd = await master.getGetRewardsData();
            expect(rd.claimed).toBeLessThanOrEqual(rd.accrued);
        }
        // The cap: everything accrued is paid out (to rounding), the last claimer gets the rest and keeps it owed.
        const rd3 = await master.getGetRewardsData();
        expect(rd3.accrued - rd3.claimed).toBeLessThan(10n);
        expect(res[2].owed).toBeGreaterThan(0n);
        expect(res[2].paid).toBeGreaterThan(0n);
        expect(await stuckClaim(master, m2)).toBe(STUCK_REFUSED);
        await solvent(master);
        // The next accrual pays bob's owed part first come.
        expectNoFailures(await buy(creator, key, toNano('400')));
        const c = await claimR(master, bob);
        expect(c.paid).toBeGreaterThan(res[2].owed);
        await solvent(master);
        // eslint-disable-next-line no-console
        console.log(`R6-1 lost (x30 spike): T ${T}, totalShares understated by ${real - rd0.totalShares}; ${rows.join('; ')}; next claim of bob paid ${c.paid}`);
    });

    // -----------------------------------------------------------------------
    // R6A-2 / R6B-3: notifying transfers to a wallet in storage debt / an unaffordable notification
    // -----------------------------------------------------------------------

    for (const rewards of [false, true]) {
        it(`R6A-2: ${rewards ? 'rewards' : 'plain'} token, notifying transfer at tight values to a wallet in storage debt (5 / 20 idle years): delivered or bounced to the sender, never destroyed`, async () => {
            const { master, key } = await launch(rewards ? { buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n } : {});
            expectNoFailures(await buy(alice, key, toNano('50')));
            expectNoFailures(await buy(bob, key, toNano('5')));
            const wa = await walletOf(master, alice.address);
            const owners = [alice.address, bob.address];
            const rows: string[] = [];
            for (const years of [5, 20]) {
                const snap0 = chain.snapshot();
                chain.now = T0 + years * YEAR;
                // The sender is active (a plain Gram top-up pays its own rent); only the receiver was idle.
                expectNoFailures(await chain.sendMessage(internal({ from: alice.address, to: wa.address, value: toNano('0.5'), bounce: true, body: Cell.EMPTY })));
                const snap = chain.snapshot();
                const need = await wa.getGetTransferFee(bob.address);
                const comment = beginCell().storeUint(0, 32).storeStringTail('hi').endCell();
                const body = { ...xferBody(bob.address, 1000n, alice.address), forwardTonAmount: 1n,
                    forwardPayload: beginCell().storeBit(1).storeRef(comment).endCell().beginParse() };
                const out = { refused: 0, delivered: 0, bounced: 0, lost: 0 };
                for (let i = 0; i < 40; i++) {
                    await chain.loadFrom(snap);
                    const a0 = await jBal(master, alice.address), b0 = await jBal(master, bob.address);
                    const value = need + BigInt(i) * toNano('0.001');
                    const r = await wa.send(alice.getSender(), { value }, body);
                    const a1 = await jBal(master, alice.address), b1 = await jBal(master, bob.address);
                    if (a1 + b1 !== a0 + b0 || !(await conserved(master, owners))) out.lost++;
                    else if (b1 === b0 + 1000n) out.delivered++;
                    else if (r.transactions.some((tx) => dst(tx)?.equals(wa.address) && isBounced(tx))) out.bounced++;
                    else out.refused++;
                }
                rows.push(`${years}y: ${js(out)}`);
                // eslint-disable-next-line no-console
                console.log(`R6A-2 ${rewards ? 'rewards' : 'plain'} ${years}y (values get_transfer_fee ${need} + 0..0.039): ${js(out)}`);
                expect(out.lost).toBe(0);
                if (years === 5) expect(out.delivered).toBeGreaterThan(0);
                // With enough value (the receiver's debt included) it is delivered.
                await chain.loadFrom(snap);
                const b0 = await jBal(master, bob.address);
                expectNoFailures(await wa.send(alice.getSender(), { value: need + toNano('0.2') }, body));
                expect(await jBal(master, bob.address)).toBe(b0 + 1000n);
                await chain.loadFrom(snap0);
            }
            // eslint-disable-next-line no-console
            console.log(`R6A-2 ${rewards ? 'rewards' : 'plain'}: ` + rows.join(' | '));
        });
    }

    it('R6B-3: at 250 nanoGram/gas a notifying transfer with a 30-cell payload to a first-time holder, swept in 1 mGram steps: never destroyed', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        expectNoFailures(await buy(alice, key, toNano('50')));
        setGasPrice(chain, 250n);
        const wa = await walletOf(master, alice.address);
        let p = beginCell().storeUint(0, 32).storeStringTail('end').endCell();
        for (let i = 0; i < 29; i++) p = beginCell().storeUint(i, 32).storeBuffer(Buffer.alloc(120, i)).storeRef(p).endCell();
        const snap = chain.snapshot();
        const need = await wa.getGetTransferFee(bob.address);
        const out = { refused: 0, delivered: 0, deliveredUnreported: 0, bounced: 0, lost: 0 };
        for (let i = 0; i < 120; i++) {
            await chain.loadFrom(snap);
            const value = toNano('0.01') + need + BigInt(i) * toNano('0.001');
            const r = await wa.send(alice.getSender(), { value }, { ...xferBody(bob.address, 1000n, alice.address), forwardTonAmount: toNano('0.01'),
                forwardPayload: beginCell().storeBit(1).storeRef(p).endCell().beginParse() });
            const b1 = await jBal(master, bob.address);
            if (!(await conserved(master, [alice.address, bob.address]))) out.lost++;
            else if (b1 === 1000n) {
                const st = (await rState(master, bob.address))!;
                if (st.acked === 1000n) out.delivered++; else out.deliveredUnreported++;
            } else if (r.transactions.some((tx) => dst(tx)?.equals(wa.address) && isBounced(tx))) out.bounced++;
            else out.refused++;
        }
        // eslint-disable-next-line no-console
        console.log(`R6B-3 at 250: ${js(out)}`);
        expect(out.lost).toBe(0);
        expect(out.delivered).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // R6A-7: the Router's (untracked) wallet pays its fixed-value legs after a long idle time
    // -----------------------------------------------------------------------

    it('R6A-7: the Router\'s wallet idle 15 years: a protocol-fee collect in the token (fixed 0.07 leg) and a buy still pay', async () => {
        const { master, key, pool } = await launch({});
        expectNoFailures(await buy(alice, key, toNano('50')));
        expectNoFailures(await sell(alice, master, key, (await jBal(master, alice.address)) / 2n));   // protocol fee in the token
        const st0 = await pool.getGetPoolState();
        const tokenIs1 = st0.key.token1.equals(key.token1);
        const fee = tokenIs1 ? st0.protocolFees1 : st0.protocolFees0;
        expect(fee).toBeGreaterThan(0n);
        const rw = await walletOf(master, router.address);
        // Keep the pool itself funded for the idle years (a donation joins its endowment and does not touch the
        // Router's wallet); without it the pool's own rent eats its 0.2 endowment in ~5 years (known, DEX side).
        expectNoFailures(await chain.sendMessage(internal({ from: admin.address, to: pool.address, value: toNano('5'), bounce: true, body: Cell.EMPTY })));
        chain.now = T0 + 15 * YEAR;
        const t0 = await jBal(master, treasury.address);
        const res = await router.send(bob.getSender(), { value: toNano('0.35') }, { $$type: 'CollectProtocolFees', queryId: 0n, key: { ...key, $$type: 'PoolKey' } });
        const ptx = res.transactions.find((tx) => dst(tx)?.equals(pool.address))!;
        const pd: any = ptx.description;
        // eslint-disable-next-line no-console
        console.log(`R6A-7 pool tx: value in ${valueIn(ptx)}, storage ${js(storageOf(ptx))}, compute ${pd.computePhase?.exitCode} gas ${pd.computePhase?.gasUsed}, ` +
            `action ${pd.actionPhase?.success}/${pd.actionPhase?.resultCode} (${pd.actionPhase?.totalActions} actions), pool balance now ${await balOf(pool.address)}; ` +
            `pool state ${js(await pool.getGetPoolState().then((x: any) => ({ endowment: x.endowment, reserve0: x.reserve0, pf0: x.protocolFees0, pf1: x.protocolFees1 })))}`);
        expectNoFailures(res);
        const rtx = res.transactions.find((tx) => dst(tx)?.equals(rw.address))!;
        expect(await jBal(master, treasury.address)).toBe(t0 + fee);
        const b0 = await jBal(master, bob.address);
        expectNoFailures(await buy(bob, key, toNano('5')));
        expect(await jBal(master, bob.address)).toBeGreaterThan(b0);
        // eslint-disable-next-line no-console
        console.log(`R6A-7: Router wallet after 15 idle years: rent ${js(storageOf(rtx))}; protocol fee ${fee} paid to the treasury; a buy works`);
    });

    // -----------------------------------------------------------------------
    // R6B-2 / R6B-4: launches at higher gas prices
    // -----------------------------------------------------------------------

    async function freshLaunch(price: bigint, devBuy: bigint, taxed: boolean, race: boolean, extra = 0n) {
        const c = await Blockchain.create();
        c.now = T0;
        setGasPrice(c, price);
        const adm = await c.treasury('admin');
        const tre = await c.treasury('treasury');
        const cre = await c.treasury('creator', { balance: toNano('1000000') });
        const rtr = c.openContract(await Router.fromInit(adm.address, tre.address));
        await rtr.send(adm.getSender(), { value: toNano('1') }, null);
        const fac = c.openContract(await LaunchFactory.fromInit(adm.address, tre.address, rtr.address, LAUNCH_FEE, TIERS, ...(await poolCodeArgs())));
        await fac.send(adm.getSender(), { value: toNano('0.5') }, null);
        const body = {
            $$type: 'CreateToken' as const, queryId: 7n, content: content('Gas'), devBuy, minDevOut: 0n,
            buyTaxBps: taxed ? 500n : 0n, sellTaxBps: taxed ? 500n : 0n, taxWallet: null,
            rewardsBps: taxed ? 4000n : 0n, walletBps: taxed ? 3000n : 0n, buybackBps: taxed ? 3000n : 0n,
            antiSnipePips: 0n, antiSnipeDuration: 0n, startMcap: PARAMS.startMcap, tickSpacing: 10n,
            vaultBps: taxed ? 1000n : 0n, vaultLock: taxed ? 7n * 86400n : 0n, vaultVest: 0n,
        };
        const value = (await fac.getGetCreateValue2(devBuy, taxed)) + extra;
        // (sendMessageIter injects the creator's message without debiting it: creatorNet is what came back)
        const bal = async (a: Address) => (await c.getContract(a)).balance;
        const tb = await bal(tre.address), cb = await bal(cre.address);
        const q = (c as any).defaultQueueManager;
        const it = await c.sendMessageIter(internal({ from: cre.address, to: fac.address, value, body: beginCell().store(storeCreateToken(body)).endCell() }));
        const masterAddr = await fac.getGetTokenAddress(0n);
        const m = c.openContract(LaunchJetton.fromAddress(masterAddr));
        let k: any; let poolAddr: Address | undefined; let cw: Address | undefined;
        const late: any[] = [];
        let injected = false;
        const txs: BlockchainTransaction[] = [];
        for (;;) {
            if (race && cw) {
                const qq = q.messageQueue as any[];
                for (let i = qq.length - 1; i >= 0; i--) {
                    const inf = qq[i].info;
                    if (inf?.src?.equals?.(cw) && inf?.dest?.equals?.(masterAddr)) late.push(...qq.splice(i, 1));
                }
            }
            const r = await it.next();
            if (r.done) break;
            const tx = r.value as BlockchainTransaction;
            txs.push(tx);
            if (dst(tx)?.equals(masterAddr) && !k && (await c.getContract(masterAddr)).accountState?.type === 'active') {
                k = await m.getGetPoolKey();
                poolAddr = await rtr.getGetPoolAddress(k.token0, k.token1, k.tickSpacing, k.ext);
                cw = await m.getGetWalletAddress(cre.address);
            }
            if (race && !injected && poolAddr && dst(tx)?.equals(poolAddr) && src(tx)?.equals(rtr.address)) {
                injected = true;
                await q.pushMessage(internal({ from: cre.address, to: rtr.address, value: toNano('3'),
                    body: beginCell().store(storeSwapNative({
                        $$type: 'SwapNative', queryId: 99n, amount: toNano('0.5'), otherToken: k.token1, tickSpacing: k.tickSpacing, ext: k.ext,
                        minOut: 0n, sqrtPriceLimitX96: 0n, maxCrossings: 2n, allowPartial: false, deadline: BigInt(T0 + 600),
                        receiver: masterAddr, refundTo: masterAddr, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null,
                    })).endCell() }));
            }
        }
        for (const x of late) await q.pushMessage(x);
        while (q.messageQueue.length > 0) {
            const r = await q.runQueueIter(true).next();
            if (r.value) txs.push(r.value as BlockchainTransaction);
        }
        const init = poolAddr && (await c.getContract(poolAddr)).accountState?.type === 'active'
            ? (await c.openContract(Pool.fromAddress(poolAddr)).getGetPoolState()).initialized : false;
        c.now = T0 + 5000;
        await c.sendMessage(internal({ from: adm.address, to: masterAddr, value: toNano('0.1'), body: Cell.EMPTY }));
        const rwAddr = k ? await m.getGetWalletAddress(rtr.address) : undefined;
        const report = txs.find((tx) => dst(tx)?.equals(masterAddr) && poolAddr && src(tx)?.equals(poolAddr));
        const bounced = txs.some((tx) => dst(tx)?.equals(cre.address) && opOf(tx) === 0x4d4c0025);
        return {
            value, init, bounced, treasury: (await bal(tre.address)) - tb, creatorNet: (await bal(cre.address)) - cb,
            routerWallet: rwAddr ? await bal(rwAddr) : 0n,
            report: report ? `${exitCode(report)} gas ${gasOf(report)} value ${valueIn(report)}` : '-',
            aborted: txs.filter((tx) => (tx.description as any).aborted).length,
            trace: txs.filter((tx) => (tx.description as any).aborted).map((tx) => {
                const d: any = tx.description;
                const nm = (a?: Address) => !a ? '?' : a.equals(fac.address) ? 'factory' : a.equals(masterAddr) ? 'master' : a.equals(rtr.address) ? 'router' :
                    poolAddr && a.equals(poolAddr) ? 'pool' : rwAddr && a.equals(rwAddr) ? 'routerWallet' : a.equals(cre.address) ? 'creator' : 'other';
                return `${nm(src(tx))}->${nm(dst(tx))} op ${opOf(tx)?.toString(16)} exit ${d.computePhase?.exitCode} action ${d.actionPhase?.resultCode ?? '-'}`;
            }).join('; '),
        };
    }

    it('R6B-2: dev-buy launch at 3x and 5x gas with the round-5 race replayed: the launch report pays the launch fee to the treasury; at 6x (VAULT_GAS 0.13, audit R10-4) taxed + vault launches too or, if ever underfunded, is refused and refunded, see R6B-4', async () => {
        const rows: string[] = [];
        for (const taxed of [false, true]) {
            for (const f of [3n, 5n]) {
                const r = await freshLaunch(f * BASE_PRICE, toNano('1'), taxed, true);
                rows.push(`${taxed ? 'taxed+vault' : 'plain'} x${f}: pool initialized ${r.init}, report ${r.report}, treasury +${r.treasury}, creator got back ${r.creatorNet}, launch bounced ${r.bounced}`);
                expect(r.init).toBe(true);
                expect(r.treasury).toBeGreaterThanOrEqual(LAUNCH_FEE);
            }
        }
        // 6x: the plain launch goes through; since VAULT_GAS 0.13 (audit R10-4) the taxed + vault launch does too. A
        // launch the "Launch underfunded" check refuses is refunded (nothing to the treasury, value back less gas).
        for (const taxed of [false, true]) {
            const r = await freshLaunch(6n * BASE_PRICE, toNano('1'), taxed, true);
            rows.push(`${taxed ? 'taxed+vault' : 'plain'} x6: pool initialized ${r.init}, treasury +${r.treasury}, creator got back ${r.creatorNet} of ${r.value}`);
            if (r.init) {
                expect(r.treasury).toBeGreaterThanOrEqual(LAUNCH_FEE);
            } else {
                expect(r.creatorNet).toBeGreaterThan(r.value - toNano('0.5'));
                expect(r.treasury).toBeLessThan(toNano('0.01'));
            }
        }
        expect(rows.filter((x) => x.includes('x6: pool initialized true')).length).toBe(2);
        // eslint-disable-next-line no-console
        console.log('R6B-2:\n' + rows.join('\n'));
    });

    it('R6B-4: dev-buy launch at 700-1000 nanoGram/gas: either it launches, or it is refunded to the creator; nothing is stranded in the Router\'s wallet', async () => {
        const rows: string[] = [];
        for (const price of [700n, 800n, 900n, 1000n]) {
            const r = await freshLaunch(price, toNano('5'), false, false);
            rows.push(`@${price}: attached ${r.value}, pool initialized ${r.init}, launch bounced ${r.bounced}, aborted ${r.aborted}, creator got back ${r.creatorNet}, treasury +${r.treasury}, Router wallet holds ${r.routerWallet}; ${r.trace}`);
            // eslint-disable-next-line no-console
            console.log(rows[rows.length - 1]);
            expect(r.routerWallet).toBeLessThan(toNano('0.05'));
            if (r.init) expect(r.treasury).toBeGreaterThanOrEqual(LAUNCH_FEE);
            else {
                // Refunded (LaunchBounced from the factory, or the Router wallet's failed action bouncing the mint
                // back to the master): the creator gets the value back less gas, the treasury nothing.
                // (sendMessageIter injects the message, so creatorNet is what came back to the creator.)
                expect(r.creatorNet).toBeGreaterThan(r.value - toNano('0.5'));
                expect(r.treasury).toBeLessThan(toNano('0.01'));
            }
        }
        // eslint-disable-next-line no-console
        console.log('R6B-4:\n' + rows.join('\n'));
    });

    // -----------------------------------------------------------------------
    // Plain Gram receivers; getters with storage debt
    // -----------------------------------------------------------------------

    it('master plain transfer: absorbs the rent and refills rentFund to RENT_FUND_TARGET first, forwards the rest to the creator', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        expectNoFailures(await buy(alice, key, toNano('20')));
        expectNoFailures(await buy(bob, key, toNano('20')));
        chain.now = T0 + 3000;
        await chain.sendMessage(internal({ from: admin.address, to: master.address, value: toNano('0.05'), bounce: false, body: Cell.EMPTY }));
        expect((await master.getGetRewardsData()).rentFund).toBe(C.RENT_FUND_TARGET);
        chain.now = T0 + 8 * YEAR;
        // A claim absorbs 8 years of rent from the fund.
        expectNoFailures(await claim(master, alice));
        const rf0 = (await master.getGetRewardsData()).rentFund;
        expect(rf0).toBeLessThan(C.RENT_FUND_TARGET - toNano('0.1'));
        chain.now! += YEAR;
        const c0 = await balOf(creator.address);
        const r = await chain.sendMessage(internal({ from: mallory.address, to: master.address, value: toNano('1'), bounce: true, body: Cell.EMPTY }));
        expectNoFailures(r);
        const rd = await master.getGetRewardsData();
        expect(rd.rentFund).toBe(C.RENT_FUND_TARGET);
        const toCreator = (await balOf(creator.address)) - c0;
        expect(toCreator).toBeGreaterThan(toNano('1') - (C.RENT_FUND_TARGET - rf0) - toNano('0.1'));
        expect(toCreator).toBeLessThan(toNano('1') - (C.RENT_FUND_TARGET - rf0));
        await solvent(master);
        // Full fund: a plain transfer is forwarded whole (less gas), the fund stays at the target.
        const c1 = await balOf(creator.address);
        expectNoFailures(await chain.sendMessage(internal({ from: mallory.address, to: master.address, value: toNano('1'), bounce: true, body: Cell.EMPTY })));
        expect((await master.getGetRewardsData()).rentFund).toBe(C.RENT_FUND_TARGET);
        expect((await balOf(creator.address)) - c1).toBeGreaterThan(toNano('0.98'));
        // The remaining claim still pays in full.
        const c = await claimR(master, bob);
        expect([c.paid, c.owed]).toEqual([c.want, 0n]);
        // eslint-disable-next-line no-console
        console.log(`master plain transfer: rentFund ${rf0} -> ${rd.rentFund}, creator got ${toCreator} of 1 Gram`);
    });

    it('wallet plain Gram: a bounceable empty message to a tracked and to a plain wallet succeeds and the Gram stays', async () => {
        const t = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        const p = await launch({});
        for (const { master, key } of [t, p]) {
            expectNoFailures(await buy(alice, key, toNano('5')));
            const w = await walletOf(master, alice.address);
            const g0 = await balOf(w.address);
            const r = await chain.sendMessage(internal({ from: mallory.address, to: w.address, value: toNano('0.5'), bounce: true, body: Cell.EMPTY }));
            expectNoFailures(r);
            expect(r.transactions.filter((tx) => isBounced(tx))).toEqual([]);
            expect(await balOf(w.address)).toBeGreaterThan(g0 + toNano('0.49'));
        }
    });

    it('getters and storage debt: on a wallet idle 10 years the exact getter values are refused safely; after a top-up they work', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        expectNoFailures(await buy(alice, key, toNano('20')));
        expectNoFailures(await buy(bob, key, toNano('20')));
        const wa = await walletOf(master, alice.address);
        for (let i = 1; i <= 10; i++) {
            chain.now = T0 + i * YEAR;
            expectNoFailures(await buy(bob, key, toNano('5')));        // bob active, alice idle
        }
        const snap = chain.snapshot();
        const rv = await wa.getGetRewardValues();
        const need = await wa.getGetTransferFee(bob.address);
        const rows: string[] = [`claim value ${rv.claim}, transfer fee ${need}`];
        const c = await claim(master, alice, rv.claim);
        const ctx = c.transactions.find((tx) => dst(tx)?.equals(wa.address) && src(tx)?.equals(alice.address))!;
        rows.push(`claim with exactly get_reward_values().claim: wallet exit ${exitCode(ctx)}, rent ${js(storageOf(ctx))}`);
        await chain.loadFrom(snap);
        const t = await transfer(master, alice, bob.address, 1000n, need + toNano('0.0005'));
        const ttx = t.transactions.find((tx) => dst(tx)?.equals(wa.address) && src(tx)?.equals(alice.address))!;
        rows.push(`transfer with get_transfer_fee + 0.0005: wallet exit ${exitCode(ttx)}, rent ${js(storageOf(ttx))}`);
        // Workaround (what the web app does): a plain Gram top-up first materializes and pays the debt; then the
        // getters' values are exact.
        await chain.loadFrom(snap);
        expectNoFailures(await chain.sendMessage(internal({ from: alice.address, to: wa.address, value: toNano('0.05'), bounce: true, body: Cell.EMPTY })));
        const rv2 = await wa.getGetRewardValues();
        const c2 = await claim(master, alice, rv2.claim);
        rows.push(`after a 0.05 top-up: claim value ${rv2.claim}, claim with exactly it: ${c2.transactions.every(txOk) ? 'ok' : 'failed'}`);
        // eslint-disable-next-line no-console
        console.log('getters with storage debt (idle 10y):\n' + rows.join('\n'));
        expectNoFailures(c2);
        // The getters cannot see rent that accrued since the wallet's last transaction (myStorageDue() is only the
        // recorded debt), so on a long-idle wallet the advertised minimum is short by the rent of the idle period.
        // Documented behaviour (launch/README.md): such a call is refused at the wallet and bounces; nothing
        // reaches the master and no tokens move. Apps top the wallet up first (web: walletTopUp).
        for (const r of [c, t]) {
            const wtx = r.transactions.find((tx) => dst(tx)?.equals(wa.address) && src(tx)?.equals(alice.address))!;
            expect(txOk(wtx)).toBe(false);
            expect(r.transactions.some((tx) => dst(tx)?.equals(master.address))).toBe(false);
        }
    });
    // -----------------------------------------------------------------------
    // Round 7 (pitch/audit-r7a-2026-11-19.md, pitch/audit-r7b-2026-11-19.md)
    // -----------------------------------------------------------------------

    it('R7A-1: after the R6-1 sequence (x3) a third party\'s SyncRewards repairs the negative-acked wallet: totalShares == real balances, fair payouts after', async () => {
        const { master, key, w2, T, cps } = await r61(3n * BASE_PRICE, false);
        const all = [alice, bob, m2, m3];
        expect(cps.map(txOk)).toEqual([false, true]);
        expect((await w2.getGetRewardState()).acked).toBe(-T);
        expect((await realOf(master, all)) - (await master.getGetRewardsData()).totalShares).toBe(T);   // understated until repaired
        // A keeper (mallory, not the owner) repairs it; the keeper gets back at most its own value.
        const w0 = await balOf(w2.address);
        const r = await syncBy(master, m2.address, mallory, toNano('0.2'));
        expectNoFailures(r);
        const back = r.transactions.filter((tx) => src(tx)?.equals(w2.address) && dst(tx)?.equals(mallory.address)).map(valueIn);
        expect(back.length).toBe(1);
        expect(back[0]).toBeLessThan(toNano('0.2'));
        expect(await balOf(w2.address)).toBeGreaterThanOrEqual(w0);
        const s = await w2.getGetRewardState();
        expect([s.synced, s.acked, s.inFlight]).toEqual([0n, 0n, 0n]);
        const real = await realOf(master, all);
        expect((await master.getGetRewardsData()).totalShares).toBe(real);
        expect(await ackedOf(master, all)).toBe(real);
        // Fair payouts: everyone claims, one accrual, each gets its share of it (to rounding), the empty wallet nothing.
        for (const o of all) expectNoFailures(await claim(master, o));
        const rd0 = await master.getGetRewardsData();
        const T0s = rd0.totalShares;
        const bals = await Promise.all(all.map((o) => jBal(master, o.address)));
        expectNoFailures(await buy(creator, key, toNano('400')));
        const A = (await master.getGetRewardsData()).accrued - rd0.accrued;
        const rows: string[] = [];
        for (const [i, o] of all.entries()) {
            const c = await claimR(master, o);
            const fair = A * bals[i] / T0s;
            rows.push(`paid ${c.paid} fair ${fair}`);
            expect(c.paid).toBeLessThanOrEqual(fair + 1n);
            expect(fair - c.paid).toBeLessThanOrEqual(2n);
        }
        await solvent(master);
        // eslint-disable-next-line no-console
        console.log(`R7A-1: keeper repair, accrual ${A}: ${rows.join('; ')}`);
    });

    it('R7A-2: a bounced notifying transfer on a plain token returns its Gram to the owner (nothing locked); a bounce on the master\'s own wallet sends nothing', async () => {
        const { master, key } = await launch({});
        expectNoFailures(await buy(alice, key, toNano('50')));
        expectNoFailures(await buy(bob, key, toNano('5')));
        const wa = await walletOf(master, alice.address);
        chain.now = T0 + 20 * YEAR;                                  // bob's wallet in deep storage debt
        expectNoFailures(await chain.sendMessage(internal({ from: alice.address, to: wa.address, value: toNano('0.5'), bounce: true, body: Cell.EMPTY })));
        // (alice's wallet also holds the 0.5 top-up: it comes back with the excess too, everything above the reserve)
        const comment = beginCell().storeUint(0, 32).storeStringTail('hi').endCell();
        const need = await wa.getGetTransferFee(bob.address);
        const value = need + toNano('0.02');
        const g0 = await balOf(wa.address);
        const a0 = await balOf(alice.address), j0 = await jBal(master, alice.address);
        const r = await wa.send(alice.getSender(), { value }, { ...xferBody(bob.address, 1000n, alice.address), forwardTonAmount: toNano('0.01'),
            forwardPayload: beginCell().storeBit(1).storeRef(comment).endCell().beginParse() });
        expect(r.transactions.some((tx) => dst(tx)?.equals(wa.address) && isBounced(tx))).toBe(true);    // bounced back
        expect(await jBal(master, alice.address)).toBe(j0);                                               // tokens back
        const excess = r.transactions.filter((tx) => src(tx)?.equals(wa.address) && dst(tx)?.equals(alice.address) && opOf(tx) === OPS.excesses).map(valueIn);
        expect(excess.length).toBe(1);
        const g1 = await balOf(wa.address);
        expect(g1).toBeLessThanOrEqual(C.WALLET_MIN_STORAGE + toNano('0.001'));    // nothing locked above the reserve
        const cost = a0 - (await balOf(alice.address));
        // eslint-disable-next-line no-console
        console.log(`R7A-2: sent ${value}, wallet ${g0} -> ${g1}, excess back ${excess[0]}, alice net cost ${cost}`);
        expect(cost).toBeLessThan(toNano('0.05'));
        // The master's own wallet: a bounce (sandbox-injected; on chain only a real bounce) restores the balance and sends nothing.
        chain.now = T0 + 20 * YEAR + DAY;
        const t = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, buybackBps: 10000n });
        expectNoFailures(await buy(bob, t.key, toNano('100')));          // the buyback runs: the master's own wallet exists
        expect((await t.master.getGetBuybackStatus()).count).toBe(1n);
        const mw = await walletOf(t.master, t.master.address);
        expect(await active(mw.address)).toBe(true);
        expectNoFailures(await chain.sendMessage(internal({ from: admin.address, to: mw.address, value: toNano('0.2'), bounce: true, body: Cell.EMPTY })));
        const bounceBody = beginCell().storeUint(0xffffffff, 32).storeUint(0x178d4519, 32).storeUint(0, 64).storeCoins(5n).endCell();
        const peer = await t.master.getGetWalletAddress(bob.address);
        const rb = await chain.sendMessage(internal({ from: peer, to: mw.address, value: toNano('0.1'), bounce: false, bounced: true, body: bounceBody } as any));
        expect(rb.transactions.filter((tx) => src(tx)?.equals(mw.address))).toEqual([]);
    });

    it('R7A-4: a vault launch at 800-1500 nanoGram/gas is refused by the "Launch underfunded" check (not by the mint bounce) and refunded', async () => {
        const rows: string[] = [];
        for (const price of [800n, 1000n, 1200n, 1500n]) {
            const r = await freshLaunch(price, toNano('5'), true, false);
            rows.push(`@${price}: initialized ${r.init}, creator got back ${r.creatorNet} of ${r.value}, treasury +${r.treasury}; ${r.trace}`);
            // eslint-disable-next-line no-console
            console.log(rows[rows.length - 1]);
            if (r.init) continue;
            expect(r.trace).toMatch(/^factory->master op 4d4c0002 exit \d+/);       // the check at LaunchSetup, nothing else failed
            expect(r.trace).not.toMatch(/routerWallet/);
            expect(r.creatorNet).toBeGreaterThan(r.value - toNano('0.2'));
            expect(r.treasury).toBeLessThan(toNano('0.01'));
        }
    });

    it('R7B-2 / R7B-4: no-tax Harvests never drain the bucket; a 1-unit burn or a plain message never pays out bucket or surplus Gram; the surplus is swept by the next tax payout', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, buybackBps: 5000n, rewardsBps: 5000n });
        expectNoFailures(await buy(alice, key, toNano('100')));          // 5 Gram tax: bucket + rewards, buyback may run
        const HV = J('HARVEST_VALUE') + J('KEEPER_FEE');
        const b0 = (await master.getGetBuybackStatus()).balance;
        expect(b0).toBeGreaterThan(0n);
        // 10 harvests, one a minute (and one an hour), no tax pending: the caller pays every time, the bucket never drops.
        let paid = 0n;
        for (let i = 0; i < 10; i++) {
            chain.now! += i % 2 ? 60 : 3600;
            const m0 = await balOf(mallory.address);
            const r = await master.send(mallory.getSender(), { value: HV }, { $$type: 'Harvest', queryId: BigInt(i) });
            expectNoFailures(r);
            paid += m0 - (await balOf(mallory.address));
            expect((await master.getGetBuybackStatus()).balance).toBeGreaterThanOrEqual(b0);
        }
        expect(paid).toBeGreaterThan(toNano('0.1'));
        const surplus = (await balOf(master.address)) - C.MASTER_MIN_STORAGE - (await held(master));
        expect(surplus).toBeGreaterThan(0n);                              // KEEPER_FEE and leftovers above held()
        // A 1-unit burn with responseDestination = the burner: it gets back at most its own value.
        const wa = await walletOf(master, alice.address);
        const a0 = await balOf(alice.address);
        const rb = await wa.send(alice.getSender(), { value: toNano('0.1') }, { $$type: 'JettonBurn', queryId: 0n, amount: 1n, responseDestination: alice.address, customPayload: null });
        expectNoFailures(rb);
        const fromMaster = rb.transactions.filter((tx) => src(tx)?.equals(master.address) && dst(tx)?.equals(alice.address)).map(valueIn);
        expect(fromMaster.reduce((x, y) => x + y, 0n)).toBeLessThan(toNano('0.1'));
        expect(a0 - (await balOf(alice.address))).toBeGreaterThan(0n);
        // A plain message (the creator's own included): the creator gets at most that message's value.
        for (const from of [mallory, creator]) {
            const c0 = await balOf(creator.address);
            const r = await chain.sendMessage(internal({ from: from.address, to: master.address, value: toNano('0.1'), bounce: true, body: Cell.EMPTY }));
            expectNoFailures(r);
            const toCreator = r.transactions.filter((tx) => src(tx)?.equals(master.address) && dst(tx)?.equals(creator.address)).map(valueIn);
            expect(toCreator.reduce((x, y) => x + y, 0n)).toBeLessThanOrEqual(toNano('0.1'));
            void c0;
        }
        const surplus2 = (await balOf(master.address)) - C.MASTER_MIN_STORAGE - (await held(master));
        expect(surplus2).toBeGreaterThanOrEqual(surplus - toNano('0.001'));
        // The next tax payout sweeps it (`extra`, into the bucket on a buyback token).
        const bb0 = (await master.getGetBuybackStatus()).balance;
        const rt = await buy(bob, key, toNano('100'));
        expectNoFailures(rt);
        const [sp] = splitEvents(rt.transactions);
        expect(sp.extra).toBeGreaterThanOrEqual(surplus2 - toNano('0.05'));
        const surplus3 = (await balOf(master.address)) - C.MASTER_MIN_STORAGE - (await held(master));
        // eslint-disable-next-line no-console
        console.log(`R7B-2: 10 no-tax harvests cost the caller ${paid}, bucket ${b0} -> ${bb0}; surplus ${surplus} -> after burn/plain ${surplus2}; next payout extra ${sp.extra}, surplus after ${surplus3}`);
        expect(surplus3).toBeLessThan(surplus2);                          // swept; what is left is this payout's own gas leftover
        expect(surplus3).toBeLessThan(toNano('0.1'));
    });

    it('R7B-3: a CreateToken whose queryId carries the BB_TAG is refused and the value refunded', async () => {
        const p = (await factory.getGetFactoryData()).tiers.low;
        const idx0 = (await factory.getGetFactoryData()).nextIndex;
        const c0 = await balOf(creator.address);
        const value = await factory.getGetCreateValue2(toNano('10'), false);
        const r = await factory.send(creator.getSender(), { value }, {
            $$type: 'CreateToken', queryId: (0x4d4cbbbbn << 32n) + 1n, content: content('Tag'), devBuy: toNano('10'), minDevOut: 0n,
            buyTaxBps: 500n, sellTaxBps: 500n, taxWallet: null, rewardsBps: 0n, walletBps: 0n, buybackBps: 10000n,
            antiSnipePips: 0n, antiSnipeDuration: 0n, startMcap: p.startMcap, tickSpacing: p.tickSpacing, vaultBps: 0n, vaultLock: 0n, vaultVest: 0n,
        });
        expect(r.transactions).toHaveTransaction({ from: creator.address, to: factory.address, success: false });
        expect(r.transactions).toHaveTransaction({ from: factory.address, to: creator.address, inMessageBounced: true });
        expect((await factory.getGetFactoryData()).nextIndex).toBe(idx0);
        expect(c0 - (await balOf(creator.address))).toBeLessThan(toNano('0.05'));
        // A normal queryId still works.
        expectNoFailures(await factory.send(creator.getSender(), { value }, {
            $$type: 'CreateToken', queryId: 1n, content: content('Tag'), devBuy: toNano('10'), minDevOut: 0n,
            buyTaxBps: 500n, sellTaxBps: 500n, taxWallet: null, rewardsBps: 0n, walletBps: 0n, buybackBps: 10000n,
            antiSnipePips: 0n, antiSnipeDuration: 0n, startMcap: p.startMcap, tickSpacing: p.tickSpacing, vaultBps: 0n, vaultLock: 0n, vaultVest: 0n,
        }));
    });

    it('launch outcome (R7B-2 forwardToCreator): a refused launch returns the fee and the value to the creator, nothing stays in the master; a successful one pays the fee to the treasury', async () => {
        const f2 = chain.openContract(await LaunchFactory.fromInit(admin.address, treasury.address, router.address, LAUNCH_FEE,
            { ...TIERS, low: { ...PARAMS, tickSpacing: 30n } }, ...(await poolCodeArgs())));
        await f2.send(admin.getSender(), { value: toNano('0.5') }, null);
        const rows: string[] = [];
        const checks: (() => void)[] = [];
        for (const devBuy of [0n, toNano('50')]) {
            const p = (await f2.getGetFactoryData()).tiers.low;
            const idx = (await f2.getGetFactoryData()).nextIndex;
            const tb = await balOf(treasury.address), cb = await balOf(creator.address);
            const value = await f2.getGetCreateValue2(devBuy, false);
            const res = await f2.send(creator.getSender(), { value }, {
                $$type: 'CreateToken', queryId: 7n, content: content('Refused'), devBuy, minDevOut: 0n,
                buyTaxBps: 0n, sellTaxBps: 0n, taxWallet: null, rewardsBps: 0n, walletBps: 0n, buybackBps: 0n,
                antiSnipePips: 0n, antiSnipeDuration: 0n, startMcap: p.startMcap, tickSpacing: 30n, vaultBps: 0n, vaultLock: 0n, vaultVest: 0n,
            });
            expectNoFailures(res);
            const master = chain.openContract(LaunchJetton.fromAddress(await f2.getGetTokenAddress(idx)));
            const ls = await master.getGetLaunchState();
            const spent = cb - (await balOf(creator.address));
            const mb = await balOf(master.address);
            rows.push(`refused launch, dev buy ${devBuy}: settled ${ls.settled}, escrow ${ls.feeEscrow}, creator spent ${spent} of ${value}, master keeps ${mb}, treasury +${(await balOf(treasury.address)) - tb}`);
            checks.push(() => {
                expect(spent).toBeLessThan(toNano('0.3'));         // gas only: the fee and the dev buy come back
                expect(mb).toBeLessThan(toNano('0.06'));
            });
        }
        // eslint-disable-next-line no-console
        console.log('launch outcome:\n' + rows.join('\n'));
        // A successful launch still pays the fee to the treasury.
        const tb = await balOf(treasury.address);
        await launch({});
        expect((await balOf(treasury.address)) - tb).toBeGreaterThanOrEqual(LAUNCH_FEE - toNano('0.01'));
        for (const c of checks) c();
    });
});
