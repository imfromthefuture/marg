// Marg launch v4 holder rewards (v3 design, hardened): regression tests for the round-4 / round-5 audit
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
import { LaunchJetton } from '../build/Launch_LaunchJetton';
import {
    LaunchWallet, storeClaimRewards, storeJettonTransfer, storeSyncRewards,
} from '../build/Launch_LaunchWallet';
import { Router, storeSwapPayload } from '../../dex/v2/build/Router_Router';
import { Pool } from '../../dex/v2/build/Router_Pool';
import { txOk, opOf, gramPayouts, REASON } from '../../dex/v2/tests/helpers';
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

describe('Marg launch v4 holder rewards (hardened v3 design): audit regressions', () => {
    let chain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let treasury: SandboxContract<TreasuryContract>;
    let creator: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let mallory: SandboxContract<TreasuryContract>;
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
    // 1. R4A-1: a tracked wallet idle 5 / 10 years (storage fees on)
    // -----------------------------------------------------------------------

    for (const years of [5, 10]) {
        it(`R4A-1: a tracked wallet idle ${years} years: claim-, transfer-, sell- and receive-first all work, inFlight returns to 0, later claims pay`, async () => {
            const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
            expectNoFailures(await buy(alice, key, toNano('20')));
            const wa = await walletOf(master, alice.address);
            const g0 = await balOf(wa.address);
            for (let i = 1; i <= 4 * years; i++) {
                chain.now = T0 + Math.floor((i * YEAR) / 4);
                expectNoFailures(await buy(bob, key, toNano('20')));
            }
            expect(await balOf(wa.address)).toBe(g0);            // nothing touched alice's wallet
            const due = await pend(master, alice.address);
            expect(due).toBeGreaterThan(toNano('1'));
            const bal = await jBal(master, alice.address);
            const snap = chain.snapshot();
            const tIdle = chain.now!;
            const firstTx = (txs: BlockchainTransaction[]) => txs.find((x) => dst(x)?.equals(wa.address))!;
            const out: string[] = [`wallet balance before: ${g0}`];

            const later = async (label: string) => {
                const s = (await wa.getGetRewardState());
                expect(s.inFlight).toBe(0n);
                expect(s.acked).toBe(await jBal(master, alice.address));
                expect(await balOf(wa.address)).toBeGreaterThanOrEqual(C.WALLET_MIN_STORAGE);   // the reserve was refilled
                chain.now! += 30 * DAY;
                expectNoFailures(await buy(bob, key, toNano('20')));
                const more = await pend(master, alice.address);
                expect(more).toBeGreaterThan(0n);
                const c0 = (await master.getGetRewardsData()).claimed;
                const r = await claim(master, alice);
                expectNoFailures(r);
                expect((await master.getGetRewardsData()).claimed - c0).toBe(more);
                expect(comments(r.transactions, master.address, alice.address, 'Marg holder rewards')[0]).toBeGreaterThanOrEqual(more);
                // A second long idle period: the next claim still pays.
                chain.now! += years * YEAR;
                expectNoFailures(await buy(bob, key, toNano('20')));
                const again = await pend(master, alice.address);
                expect(again).toBeGreaterThan(0n);
                const c1 = (await master.getGetRewardsData()).claimed;
                const r2 = await claim(master, alice);
                expectNoFailures(r2);
                expect((await master.getGetRewardsData()).claimed - c1).toBe(again);
                expect((await wa.getGetRewardState()).inFlight).toBe(0n);
                await sharesConsistent(master, [alice.address, bob.address]);
                await solvent(master);
                out.push(`${label}: later claims ${more} and ${again} paid; wallet rent of the 2nd idle period ${js(storageOf(firstTx(r2.transactions)))}`);
            };

            // (a) Claim first.
            let r = await claim(master, alice);
            expectNoFailures(r);
            const st = storageOf(firstTx(r.transactions));
            expect(st.collected + st.due).toBeGreaterThan(0n);
            expect((await master.getGetRewardsData()).claimed).toBe(due);
            const paid = comments(r.transactions, master.address, alice.address, 'Marg holder rewards');
            expect(paid.length).toBe(1);
            expect(paid[0]).toBeGreaterThanOrEqual(due);
            out.push(`claim first: wallet rent ${js(st)}, paid ${paid[0]} for ${due} due`);
            await later('claim first');

            // (b) Transfer first.
            await chain.loadFrom(snap);
            chain.setConfig(config0);
            chain.now = tIdle;
            r = await transfer(master, alice, bob.address, bal / 10n);
            expectNoFailures(r);
            expect(r.transactions.filter((tx) => opOf(tx) === OPS.checkpoint && dst(tx)?.equals(master.address)).map(txOk)).toEqual([true, true]);
            expect((await wa.getGetRewardState()).acked).toBe(bal - bal / 10n);
            expect(await pend(master, alice.address)).toBe(due);
            out.push(`transfer first: wallet rent ${js(storageOf(firstTx(r.transactions)))}`);
            r = await claim(master, alice);
            expectNoFailures(r);
            expect((await master.getGetRewardsData()).claimed).toBe(due);
            await later('transfer first');

            // (c) Sell first.
            await chain.loadFrom(snap);
            chain.setConfig(config0);
            chain.now = tIdle;
            r = await sell(alice, master, key, bal / 2n);
            expectNoFailures(r);
            expect(await jBal(master, alice.address)).toBe(bal - bal / 2n);
            expect((await wa.getGetRewardState()).acked).toBe(bal - bal / 2n);
            const due2 = await pend(master, alice.address);
            expect(due2).toBeGreaterThanOrEqual(due);             // the sell's own tax accrues too
            out.push(`sell first: wallet rent ${js(storageOf(firstTx(r.transactions)))}`);
            expectNoFailures(await claim(master, alice));
            expect((await master.getGetRewardsData()).claimed).toBe(due2);
            await later('sell first');

            // (d) Receive first: bob sends alice tokens; her wallet's receive checkpoint pays the debt from the value.
            await chain.loadFrom(snap);
            chain.setConfig(config0);
            chain.now = tIdle;
            r = await transfer(master, bob, alice.address, 1000n);
            expectNoFailures(r);
            expect(r.transactions.filter((tx) => opOf(tx) === OPS.checkpoint && dst(tx)?.equals(master.address)).map((tx) => src(tx)!.equals(wa.address)))
                .toEqual([false, true]);
            expect((await wa.getGetRewardState()).acked).toBe(bal + 1000n);
            expect(await pend(master, alice.address)).toBe(due);
            out.push(`receive first: wallet rent ${js(storageOf(firstTx(r.transactions)))}`);
            expectNoFailures(await claim(master, alice));
            expect((await master.getGetRewardsData()).claimed).toBe(due);
            await later('receive first');
            // eslint-disable-next-line no-console
            console.log(`R4A-1, wallet idle ${years} years:\n` + out.join('\n'));
        });
    }

    // -----------------------------------------------------------------------
    // 2. R4B-1: the gas price rises while a checkpoint / claim is in flight
    // -----------------------------------------------------------------------

    type Leg = 'cp-to-master' | 'cp-ack' | 'claim-to-master' | 'claim-ack';
    // One scenario on a fresh 2-holder token: alice either transfers ALL her tokens to bob ('cp-*') or
    // claims ('claim-*'); the gas price changes from 67 to `price` right after the wallet's transaction
    // ('*-to-master') or right after the master's ('*-ack').
    async function priceScenario(leg: Leg, price: bigint, claimValue?: bigint) {
        setGasPrice(chain, BASE_PRICE);
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        expectNoFailures(await buy(alice, key, toNano('100')));
        expectNoFailures(await buy(mallory, key, toNano('100')));
        const wa = await walletOf(master, alice.address);
        const all = await jBal(master, alice.address);
        const pend0 = await pend(master, alice.address);
        expect(pend0).toBeGreaterThan(0n);
        const isClaim = leg.startsWith('claim');
        const body = isClaim
            ? beginCell().store(storeClaimRewards({ $$type: 'ClaimRewards', queryId: 9n })).endCell()
            : beginCell().store(storeJettonTransfer(xferBody(bob.address, all, alice.address))).endCell();
        // claimValue -1: exactly get_reward_values().claim (at the old price).
        const value = isClaim ? (claimValue === -1n ? (await wa.getGetRewardValues()).claim : claimValue ?? toNano('0.06')) : toNano('0.5');
        const c0 = (await master.getGetRewardsData()).claimed;
        const masterOp = isClaim ? OPS.claim : OPS.checkpoint;
        const txs = await runIter(internal({ from: alice.address, to: wa.address, value, body }), (tx, i) => {
            if (leg.endsWith('to-master') && i === 0) setGasPrice(chain, price);
            if (leg.endsWith('ack') && dst(tx)?.equals(master.address) && src(tx)?.equals(wa.address) && opOf(tx) === masterOp) setGasPrice(chain, price);
        });
        const mtx = txs.find((x) => dst(x)?.equals(master.address) && src(x)?.equals(wa.address) && opOf(x) === masterOp);
        const back = txs.filter((x) => dst(x)?.equals(wa.address) && (isBounced(x) || opOf(x) === OPS.ack));
        const st = await wa.getGetRewardState();
        const outcome = !mtx ? 'not sent' : !txOk(mtx) ? (back.some((x) => isBounced(x) && txOk(x)) && st.inFlight === 0n ? 'bounced' : 'lost') :
            back.some((x) => opOf(x) === OPS.ack && txOk(x)) && st.inFlight === 0n ? 'applied' : 'ack lost';
        return {
            master, key, wa, all, pend0, txs, mtx, st, outcome, paid: (await master.getGetRewardsData()).claimed - c0,
            desc: `master exit ${mtx ? exitCode(mtx) : '-'} gas ${mtx ? gasOf(mtx) : '-'}, back ${back.map((x) => `${isBounced(x) ? 'bounce' : 'ack'}:${exitCode(x)}`)}, inFlight ${st.inFlight}`,
        };
    }

    it('R4B-1: thresholds (binary search over the new gas price) at which each in-flight leg stops being applied', async () => {
        const snap = chain.snapshot();
        const rows: string[] = [];
        const thresholds: Record<string, number> = {};
        for (const [leg, v] of [['cp-to-master', undefined], ['cp-ack', undefined], ['claim-to-master', toNano('0.06')],
            ['claim-to-master', 'min'], ['claim-ack', toNano('0.06')]] as [Leg, any][]) {
            const run = async (p: bigint) => {
                await chain.loadFrom(snap);
                chain.setConfig(config0);
                chain.now = T0;
                return priceScenario(leg, p, v === 'min' ? -1n : v);
            };
            let lo = BASE_PRICE, hi = BASE_PRICE * 40n;
            const first = await run(hi);
            let outHi = first.outcome;
            if (first.outcome === 'applied') lo = hi;
            while (hi - lo > 1n) {
                const mid = (lo + hi) / 2n;
                const r = await run(mid);
                if (r.outcome === 'applied') lo = mid; else { hi = mid; outHi = r.outcome; }
            }
            const label = `${leg}${v === 'min' ? ' (claim at exactly the minimum)' : v ? ` (claim value ${v})` : ''}`;
            thresholds[label] = Number(lo) / Number(BASE_PRICE);
            rows.push(`${label}: applied up to ${lo} nanoGram/gas (${(Number(lo) / Number(BASE_PRICE)).toFixed(2)}x of ${BASE_PRICE}); above: ${outHi}; at 40x: ${first.outcome}`);
        }
        // eslint-disable-next-line no-console
        console.log('R4B-1 thresholds:\n' + rows.join('\n'));
        // The design target: up to ~2x the wallet's own checkpoint is applied as is.
        expect(thresholds['cp-to-master']).toBeGreaterThanOrEqual(2);
    });

    for (const factor of [1.5, 2.5, 4, 8]) {
        it(`R4B-1: gas price x${factor} while a checkpoint / claim is in flight: applied or bounced, repairable by SyncRewards or safely stuck, no ghost shares, no over-payment, master solvent`, async () => {
            const price = BigInt(Math.round(Number(BASE_PRICE) * factor));
            const snap = chain.snapshot();
            const rows: string[] = [];
            const failures: string[] = [];
            for (const leg of ['cp-to-master', 'cp-ack', 'claim-to-master', 'claim-ack'] as Leg[]) {
                await chain.loadFrom(snap);
                chain.setConfig(config0);
                chain.now = T0;
                const r = await priceScenario(leg, price);
                const { master, key, wa, pend0 } = r;
                let alicePaid = r.paid;
                const row = [`${leg} x${factor}: ${r.outcome} (${r.desc})`];
                expect(['applied', 'bounced', 'ack lost', 'lost']).toContain(r.outcome);
                // Repair: at the new price each owner's SyncRewards (v4: owner only). A wallet whose ack is truly lost
                // stays stuck (no reset; it can no longer claim, nothing is paid twice).
                for (const o of [alice, bob]) {
                    if (await rState(master, o.address)) expectNoFailures(await syncBy(master, o.address, o));
                }
                const stuck = (await wa.getGetRewardState()).inFlight > 0n;
                if (stuck) row.push('alice stuck (inFlight > 0)');
                setGasPrice(chain, BASE_PRICE);
                const aBal = await jBal(master, alice.address);
                const s = await wa.getGetRewardState();
                row.push(`after repair: alice balance ${aBal}, acked ${s.acked}, synced ${s.synced}, inFlight ${s.inFlight}`);
                // A fresh accrual: alice earns exactly on what she holds.
                const rd0 = await master.getGetRewardsData();
                const p0 = await pend(master, alice.address);
                expectNoFailures(await buy(mallory, key, toNano('200')));
                const rd1 = await master.getGetRewardsData();
                // (the buy's tax accrues before mallory's new tokens are reported: the shares at the accrual are rd0's)
                const fair = (rd1.accrued - rd0.accrued) * aBal / rd0.totalShares;
                const got = (await pend(master, alice.address)) - p0;
                row.push(`accrual ${rd1.accrued - rd0.accrued}: alice +${got} (fair ${fair})`);
                // Claims: alice (refused at her wallet if stuck), then the others.
                const ea = stuck ? await stuckClaim(master, alice) : await tryClaim(master, alice);
                alicePaid += (await master.getGetRewardsData()).claimed - rd1.claimed;
                const entitled = pend0 + fair;
                row.push(`alice paid in total ${alicePaid}, entitled ${entitled} (claim exit ${ea})`);
                const honest: string[] = [];
                for (const h of [bob, mallory]) {
                    if (!(await rState(master, h.address))) continue;
                    const cb = (await master.getGetRewardsData()).claimed;
                    const bp = await pend(master, h.address);
                    const e = await tryClaim(master, h);
                    const paidH = (await master.getGetRewardsData()).claimed - cb;
                    if (e !== 0 || paidH !== bp) honest.push(`${h === bob ? 'bob' : 'mallory'} claim exit ${e}, paid ${paidH} of ${bp}`);
                }
                if (honest.length) row.push(`other holders: ${honest.join(', ')}`);
                rows.push(row.join('; '));
                // Checks (collected, so every leg is reported).
                const chk = (ok: boolean, what: string) => { if (!ok) failures.push(`${leg} x${factor}: ${what}`); };
                if (!stuck) chk(s.acked === aBal && s.synced === aBal && s.inFlight === 0n, `alice's wallet not repaired (acked ${s.acked}, balance ${aBal})`);
                if (stuck) chk(ea === STUCK_REFUSED, `stuck wallet's claim not refused cleanly (${ea})`);
                chk(got <= fair + 1n, `alice earned ${got} on ${aBal} tokens, fair share ${fair} (paid for tokens she no longer holds)`);
                chk(alicePaid <= entitled + 2n, `alice was paid ${alicePaid} > entitled ${entitled} (over-payment ${alicePaid - entitled})`);
                const rd = await master.getGetRewardsData();
                chk(rd.claimed <= rd.accrued, 'claimed > accrued');
                chk((await balOf(master.address)) >= (await held(master)), 'master balance < held()');
                let sum = 0n;
                for (const o of [alice.address, bob.address, mallory.address]) sum += (await rState(master, o))?.acked ?? 0n;
                if (!stuck) chk(rd.totalShares === sum, `totalShares ${rd.totalShares} != sum of acked ${sum}`);
                if (!stuck) chk(ea === 0, `alice's claim after the repair refused (exit ${ea})`);
                chk(honest.length === 0, `other holders could not claim in full: ${honest.join(', ')}`);
                if (factor <= 3) chk(r.outcome === 'applied' || r.outcome === 'bounced', `outcome ${r.outcome} at x${factor}`);
                // v4: the claim ack carries CLAIM_ACK_HEADROOM (4) x its compute: it survives an 8x rise.
                if (leg === 'claim-ack') chk(r.outcome === 'applied', `claim ack ${r.outcome} at x${factor}`);
            }
            // eslint-disable-next-line no-console
            console.log(`R4B-1 x${factor}:\n` + rows.join('\n') + (failures.length ? '\nFAILURES:\n' + failures.join('\n') : ''));
            expect(failures).toEqual([]);
        });
    }

    // -----------------------------------------------------------------------
    // 3. R4B-2: a claim while a checkpoint is in flight is refused (by design) and works right after
    // -----------------------------------------------------------------------

    it('R4B-2: a claim while a checkpoint is in flight is refused (value back), works right after; no loss', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        expectNoFailures(await buy(alice, key, toNano('100')));
        expectNoFailures(await buy(mallory, key, toNano('100')));
        const w = await walletOf(master, alice.address);
        const mw = await walletOf(master, mallory.address);
        const pending = await pend(master, alice.address);
        expect(pending).toBeGreaterThan(toNano('1'));
        const bal = await jBal(master, alice.address);
        // (a) Dust transfers to alice: her claim reaches her wallet right after the first incoming transfer,
        // while its receive checkpoint is in flight.
        const qm = (chain as any).defaultQueueManager;
        for (let i = 0; i < 3; i++) {
            await qm.pushMessage(internal({ from: mallory.address, to: mw.address, value: toNano('0.05'),
                body: beginCell().store(storeJettonTransfer(xferBody(alice.address, 1n, mallory.address))).endCell() }));
        }
        const txs: BlockchainTransaction[] = [];
        let claimed = false;
        while (qm.messageQueue.length > 0) {
            const r = await qm.runQueueIter(true).next();
            if (!r.value) continue;
            const tx = r.value as BlockchainTransaction;
            txs.push(tx);
            if (!claimed && dst(tx)?.equals(w.address) && opOf(tx) === OPS.internal) {
                claimed = true;
                expect((await w.getGetRewardState()).inFlight).toBe(1n);
                await qm.pushMessage(internal({ from: alice.address, to: w.address, value: toNano('0.06'),
                    body: beginCell().store(storeClaimRewards({ $$type: 'ClaimRewards', queryId: 9n })).endCell() }));
            }
        }
        expect(claimed).toBe(true);
        const refused = txs.filter((tx) => src(tx)?.equals(alice.address) && dst(tx)?.equals(w.address));
        expect(refused.map(txOk)).toEqual([false]);
        // The claim's value comes back to alice (bounce), less the wallet's compute.
        const ret = txs.filter((tx) => src(tx)?.equals(w.address) && dst(tx)?.equals(alice.address) && isBounced(tx)).map(valueIn);
        expect(ret.length).toBe(1);
        expect(ret[0]).toBeGreaterThan(toNano('0.06') - toNano('0.005'));
        expect(txs.filter((tx) => !txOk(tx) && tx !== refused[0])).toEqual([]);
        expect((await master.getGetRewardsData()).claimed).toBe(0n);
        // Right after: it works and pays everything.
        const st = await w.getGetRewardState();
        expect([st.inFlight, st.acked]).toEqual([0n, bal + 3n]);
        expect(await pend(master, alice.address)).toBe(pending);
        const c = await claim(master, alice, toNano('0.06'));
        expectNoFailures(c);
        expect((await master.getGetRewardsData()).claimed).toBe(pending);
        expect(comments(c.transactions, master.address, alice.address, 'Marg holder rewards')[0]).toBeGreaterThanOrEqual(pending);
        expect(await pend(master, alice.address)).toBe(0n);
        // (b) Her own transfer: a claim sent right behind it (same block) is refused; after the ack it works.
        expectNoFailures(await buy(mallory, key, toNano('100')));
        const p2 = await pend(master, alice.address);
        const it = await chain.sendMessageIter(internal({ from: alice.address, to: w.address, value: toNano('0.12'),
            body: beginCell().store(storeJettonTransfer(xferBody(bob.address, 1000n, alice.address))).endCell() }));
        await it.next();
        expect((await w.getGetRewardState()).inFlight).toBe(1n);
        const early = await chain.sendMessage(internal({ from: alice.address, to: w.address, value: toNano('0.06'),
            body: beginCell().store(storeClaimRewards({ $$type: 'ClaimRewards', queryId: 10n })).endCell() }));
        for (let r = await it.next(); !r.done; r = await it.next()) { /* deliver the rest */ }
        expect(early.transactions.filter((tx) => dst(tx)?.equals(w.address) && src(tx)?.equals(alice.address)).map(txOk)).toEqual([false]);
        expect((await master.getGetRewardsData()).claimed).toBe(pending);
        expect(await pend(master, alice.address)).toBe(p2);
        expectNoFailures(await claim(master, alice, toNano('0.06')));
        expect((await master.getGetRewardsData()).claimed).toBe(pending + p2);
        await sharesConsistent(master, [alice.address, bob.address, mallory.address]);
        await solvent(master);
    });

    // -----------------------------------------------------------------------
    // 4. R4A-3: an idle master (thin and busy tokens)
    // -----------------------------------------------------------------------

    async function thinToken() {
        const t = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        expectNoFailures(await buy(alice, t.key, toNano('20')));
        chain.now = T0 + 60;
        expectNoFailures(await buy(bob, t.key, toNano('20')));
        chain.now = T0 + 120;
        expectNoFailures(await buy(bob, t.key, toNano('20')));
        // poke: the fee escrow leaves
        chain.now = T0 + 3000;
        await chain.sendMessage(internal({ from: admin.address, to: t.master.address, value: toNano('0.05'), bounce: false, body: Cell.EMPTY }));
        return { ...t, hs: [alice, bob] };
    }
    async function busyToken() {
        const t = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        const hs = [alice, bob, mallory];
        for (let n = 0; n < 4; n++) hs.push(await chain.treasury(`r4a3-${n}`, { balance: toNano('1000000') }));
        for (let round = 0; round < 6; round++) {
            for (let i = 0; i < hs.length; i++) {
                chain.now = T0 + 60 * (round * hs.length + i + 1);
                expectNoFailures(await buy(hs[i], t.key, toNano(String(5 + i))));
                if (round % 2 === 1) expectNoFailures(await transfer(t.master, hs[i], hs[(i + 1) % hs.length].address, (await jBal(t.master, hs[i].address)) / 7n));
                if (round === 5 && i % 2 === 0) expectNoFailures(await sell(hs[i], t.master, t.key, (await jBal(t.master, hs[i].address)) / 3n));
            }
        }
        chain.now = T0 + 6000;
        return { ...t, hs };
    }

    for (const kind of ['thin', 'busy'] as const) {
        for (const years of [3, 5, 8]) {
            it(`R4A-3: ${kind} token, master idle ${years} years: every claim pays in full, never below MASTER_MIN_STORAGE, balance >= held() after each`, async () => {
                const { master, hs } = kind === 'thin' ? await thinToken() : await busyToken();
                const rd0 = await master.getGetRewardsData();
                const b0 = await balOf(master.address), h0 = await held(master);
                expect(b0).toBeGreaterThanOrEqual(h0);
                expect(rd0.rentFund).toBe(C.RENT_FUND_TARGET);
                const t1 = chain.now! + years * YEAR;
                chain.now = t1;
                const rows: string[] = [`after trading: balance ${b0}, held ${h0} (rentFund ${rd0.rentFund}), spare ${b0 - h0}`];
                for (const h of hs) {
                    const d = await pend(master, h.address);
                    expect(d).toBeGreaterThan(0n);
                    const c0 = (await master.getGetRewardsData()).claimed;
                    const r = await claim(master, h);
                    expectNoFailures(r);
                    const mtx = r.transactions.find((x) => dst(x)?.equals(master.address))!;
                    const b = await balOf(master.address), hh = await held(master);
                    const rd = await master.getGetRewardsData();
                    rows.push(`claim: due ${d}, paid ${rd.claimed - c0}, master rent ${js(storageOf(mtx))}, balance ${b}, held ${hh}, rentFund ${rd.rentFund}`);
                    expect(rd.claimed - c0).toBe(d);                     // in full
                    expect((await rState(master, h.address))!.owed).toBe(0n);
                    expect(b).toBeGreaterThanOrEqual(C.MASTER_MIN_STORAGE);
                    expect(b).toBeGreaterThanOrEqual(hh);
                    expect(rd.claimed).toBeLessThanOrEqual(rd.accrued);
                }
                const rd1 = await master.getGetRewardsData();
                expect(rd1.accrued - rd1.claimed).toBeLessThan(100n);    // only rounding dust left
                // eslint-disable-next-line no-console
                console.log(`R4A-3 ${kind} token, master idle ${years}y:\n` + rows.join('\n'));
            });
        }
    }

    it('R4A-3: thin token, master idle 25 years (rent beyond the fund): claims pay what is free, never below the floor; the rest stays owed and is paid after a top-up', async () => {
        const { master } = await thinToken();
        chain.now = chain.now! + 25 * YEAR;
        const rows: string[] = [];
        const due: bigint[] = [];
        for (const h of [alice, bob]) due.push(await pend(master, h.address));
        let partial = 0;
        for (const [i, h] of [alice, bob].entries()) {
            const c0 = (await master.getGetRewardsData()).claimed;
            const fl0 = await floor(master);
            const r = await claim(master, h, toNano('0.5'));     // the wallets' own 25 years of rent are due too
            expectNoFailures(r);
            const rd = await master.getGetRewardsData();
            const paid = rd.claimed - c0;
            const owed = (await rState(master, h.address))!.owed;
            const b = await balOf(master.address);
            rows.push(`claim ${i}: due ${due[i]}, paid ${paid}, still owed ${owed}, master ${js(storageOf(r.transactions.find((x) => dst(x)?.equals(master.address))!))}, ` +
                `balance ${b}, floor ${await floor(master)} (was ${fl0}), held ${await held(master)}, rentFund ${rd.rentFund}`);
            expect(paid + owed).toBe(due[i]);                         // nothing lost
            if (owed > 0n) partial++;
            expect(b).toBeGreaterThanOrEqual(await floor(master));    // never below MIN + buckets
            expect(b).toBeGreaterThanOrEqual(C.MASTER_MIN_STORAGE);
            expect(rd.claimed).toBeLessThanOrEqual(rd.accrued);
            expect((await rState(master, h.address))!.inFlight).toBe(0n);
        }
        // eslint-disable-next-line no-console
        console.log('R4A-3 thin token, master idle 25y:\n' + rows.join('\n'));
        expect(partial).toBeGreaterThan(0);                          // the setup reaches the partial path
        // Top-up: anyone sends Gram to the master (it keeps what held() needs, forwards the rest to the creator).
        expectNoFailures(await chain.sendMessage(internal({ from: admin.address, to: master.address, value: toNano('1'), bounce: false, body: Cell.EMPTY })));
        expect(await balOf(master.address)).toBeGreaterThanOrEqual(await held(master));
        for (const [i, h] of [alice, bob].entries()) {
            const owed = (await rState(master, h.address))!.owed;
            const c0 = (await master.getGetRewardsData()).claimed;
            expectNoFailures(await claim(master, h, toNano('0.5')));
            expect((await master.getGetRewardsData()).claimed - c0).toBe(owed);
            expect((await rState(master, h.address))!.owed).toBe(0n);
            void i;
        }
        const rd = await master.getGetRewardsData();
        expect(rd.claimed).toBeLessThanOrEqual(rd.accrued);
        expect(rd.accrued - rd.claimed).toBeLessThan(100n);
        await solvent(master);
    });

    // -----------------------------------------------------------------------
    // 5. R5A-3: SyncRewards (anyone, v4 / R7A-1) never takes the wallet's own Gram
    // -----------------------------------------------------------------------

    it("R5A-3: SyncRewards by a third party or the owner on a wallet holding 1 Gram extra: the caller gets back at most its own value, the wallet keeps its Gram", async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        expectNoFailures(await buy(alice, key, toNano('100')));
        const wa = await walletOf(master, alice.address);
        // 1 Gram lands in alice's wallet (v4: the wallet has an empty receiver and keeps plain Gram).
        expectNoFailures(await chain.sendMessage(internal({ from: alice.address, to: wa.address, value: toNano('1'), bounce: true, body: Cell.EMPTY })));
        const rv = await wa.getGetRewardValues();
        // v4 (audit R7A-1): SyncRewards is open to anyone again (a keeper must be able to repair a negative-acked
        // wallet). A third party gets back at most its own value; the wallet keeps its Gram.
        for (const value of [rv.sync, toNano('1')]) {
            const w0 = await balOf(wa.address);
            const m0 = await balOf(mallory.address);
            const r = await syncBy(master, alice.address, mallory, value);
            expectNoFailures(r);
            const back = r.transactions.filter((tx) => src(tx)?.equals(wa.address) && dst(tx)?.equals(mallory.address)).map(valueIn);
            expect(back.length).toBe(1);
            expect(back[0]).toBeLessThan(value);
            expect(m0 - (await balOf(mallory.address))).toBeGreaterThan(0n);       // the caller pays
            expect(await balOf(wa.address)).toBeGreaterThanOrEqual(w0);              // never the wallet's own Gram
            expect((await wa.getGetRewardState()).inFlight).toBe(0n);
        }
        const rows: string[] = [];
        for (const value of [rv.sync, toNano('0.1'), toNano('1')]) {
            const w0 = await balOf(wa.address);
            expect(w0).toBeGreaterThan(toNano('1'));
            const a0 = await balOf(alice.address);
            const res = await syncBy(master, alice.address, alice, value);
            expectNoFailures(res);
            const back = res.transactions.filter((tx) => src(tx)?.equals(wa.address) && dst(tx)?.equals(alice.address)).map(valueIn);
            expect(back.length).toBe(1);
            expect(back[0]).toBeLessThan(value);
            const w1 = await balOf(wa.address);
            const cost = a0 - (await balOf(alice.address));
            rows.push(`owner SyncRewards with ${value}: back ${back[0]}, owner paid ${cost}, wallet ${w0} -> ${w1}`);
            expect(cost).toBeGreaterThan(0n);
            expect(w1).toBeGreaterThanOrEqual(w0);                   // the wallet's own Gram stays (the ack leftover comes back to it)
            expect((await wa.getGetRewardState()).inFlight).toBe(0n);
        }
        // Underfunded: refused (bounced to the owner), the wallet unchanged.
        const w0 = await balOf(wa.address);
        const low = await syncBy(master, alice.address, alice, rv.sync - 1n);
        expect(low.transactions).toHaveTransaction({ to: wa.address, success: false });
        expect(await balOf(wa.address)).toBeGreaterThanOrEqual(w0);
        // eslint-disable-next-line no-console
        console.log('R5A-3:\n' + rows.join('\n'));
        // The owner still gets the Gram out with her next claim.
        const c = await claim(master, alice, toNano('0.06'));
        expectNoFailures(c);
        expect(comments(c.transactions, master.address, alice.address, 'Marg holder rewards')[0]).toBeGreaterThan(toNano('1'));
    });

    // -----------------------------------------------------------------------
    // 6. Lost messages (no ResetRewards in v4): the stuck wallet stays stuck, safely
    // -----------------------------------------------------------------------

    // A reward message from alice's wallet that never comes back (no ack, no bounce). The queue is cut at
    // `drop`: 'request' drops the wallet's RewardCheckpoint / RewardClaim before the master, 'ack' drops
    // the master's RewardAck (the master applied it).
    async function lostMessage(master: SandboxContract<LaunchJetton>, kind: 'transfer' | 'claim', drop: 'request' | 'ack', amount = 0n) {
        const wa = await walletOf(master, alice.address);
        const qm = (chain as any).defaultQueueManager;
        const body = kind === 'claim'
            ? beginCell().store(storeClaimRewards({ $$type: 'ClaimRewards', queryId: 9n })).endCell()
            : beginCell().store(storeJettonTransfer(xferBody(bob.address, amount, alice.address))).endCell();
        await qm.pushMessage(internal({ from: alice.address, to: wa.address, value: toNano('0.12'), body }));
        const txs: BlockchainTransaction[] = [];
        let dropped = 0;
        while (qm.messageQueue.length > 0) {
            const q = qm.messageQueue as any[];
            const i = q.findIndex((m) => {
                const op = m.body.beginParse().preloadUint(32);
                if (drop === 'request') return m.info.src?.equals(wa.address) && m.info.dest?.equals(master.address) && (op === OPS.checkpoint || op === OPS.claim);
                return m.info.src?.equals(master.address) && m.info.dest?.equals(wa.address) && op === OPS.ack;
            });
            if (i >= 0 && dropped === 0) {
                q.splice(i, 1);
                dropped++;
                continue;
            }
            const r = await qm.runQueueIter(true).next();
            if (r.value) txs.push(r.value as BlockchainTransaction);
        }
        expect(dropped).toBe(1);
        expectNoFailures({ transactions: txs });
        expect((await wa.getGetRewardState()).inFlight).toBe(1n);
        return txs;
    }

    it('ResetRewards is gone (v4): op 0x4d4c0037 is an unknown op for the wallet', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        expectNoFailures(await buy(alice, key, toNano('100')));
        const wa = await walletOf(master, alice.address);
        await lostMessage(master, 'claim', 'ack');
        chain.now! += 30 * DAY;
        const r = await chain.sendMessage(internal({ from: alice.address, to: wa.address, value: toNano('0.05'),
            body: beginCell().storeUint(0x4d4c0037, 32).storeUint(0, 64).endCell() }));
        expect(r.transactions).toHaveTransaction({ from: alice.address, to: wa.address, success: false });
        expect((await wa.getGetRewardState()).inFlight).toBe(1n);
    });

    for (const [kind, drop] of [['transfer', 'request'], ['transfer', 'ack'], ['claim', 'request'], ['claim', 'ack']] as const) {
        it(`lost ${kind === 'transfer' ? 'checkpoint (alice sends half her tokens away)' : 'claim'} (${drop} lost): the wallet stays stuck and cannot claim (value back); others claim in full; claimed <= accrued, balance >= held`, async () => {
            const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
            expectNoFailures(await buy(alice, key, toNano('100')));
            expectNoFailures(await buy(bob, key, toNano('100')));
            expectNoFailures(await buy(mallory, key, toNano('100')));
            const wa = await walletOf(master, alice.address);
            const bal = await jBal(master, alice.address);
            const pend0 = await pend(master, alice.address);
            expect(pend0).toBeGreaterThan(0n);
            const c0 = (await master.getGetRewardsData()).claimed;
            await lostMessage(master, kind, drop, bal / 2n);
            const alicePaid0 = (await master.getGetRewardsData()).claimed - c0;
            expect(alicePaid0).toBeLessThanOrEqual(pend0);
            const rows: string[] = [`alice paid by the lost claim ${alicePaid0} (pending was ${pend0})`];
            // The owner's SyncRewards works but cannot unstick it (its own ack only balances its own send).
            expectNoFailures(await syncBy(master, alice.address, alice));
            expect((await wa.getGetRewardState()).inFlight).toBe(1n);
            // Time passes, more accruals (mallory, bob buy), alice keeps transferring.
            const honest: string[] = [];
            for (let n = 0; n < 3; n++) {
                chain.now! += 120 * DAY;
                expectNoFailures(await buy(n % 2 ? bob : mallory, key, toNano('200')));
                // The stuck wallet's claim is refused by the wallet itself, its value returned; nothing reaches the master.
                const ea = await stuckClaim(master, alice);
                expect(ea).toBe(STUCK_REFUSED);
                // Every other holder still claims in full.
                for (const h of [bob, mallory]) {
                    const c1 = (await master.getGetRewardsData()).claimed;
                    const hp = await pend(master, h.address);
                    const e = await tryClaim(master, h);
                    const paidH = (await master.getGetRewardsData()).claimed - c1;
                    if (e !== 0 || paidH !== hp) honest.push(`round ${n}: ${h === bob ? 'bob' : 'mallory'} claim exit ${e}, paid ${paidH} of ${hp}`);
                }
                await solvent(master);
            }
            // Alice can still move her tokens (a stuck wallet still checkpoints); the receiver earns on them.
            const aNow = await jBal(master, alice.address);
            if (aNow > 0n) {
                expectNoFailures(await transfer(master, alice, bob.address, aNow));
                expect((await rState(master, bob.address))!.acked).toBe(await jBal(master, bob.address));
                expectNoFailures(await buy(mallory, key, toNano('200')));
                for (const h of [bob, mallory]) {
                    const c1 = (await master.getGetRewardsData()).claimed;
                    const hp = await pend(master, h.address);
                    const e = await tryClaim(master, h);
                    const paidH = (await master.getGetRewardsData()).claimed - c1;
                    if (e !== 0 || paidH !== hp) honest.push(`after alice's transfer: ${h === bob ? 'bob' : 'mallory'} claim exit ${e}, paid ${paidH} of ${hp}`);
                }
            }
            expect(await stuckClaim(master, alice)).toBe(STUCK_REFUSED);
            const rd = await master.getGetRewardsData();
            let real = 0n;
            for (const o of [alice, bob, mallory]) real += await jBal(master, o.address);
            rows.push(`totalShares ${rd.totalShares} vs real tracked balances ${real} (difference ${rd.totalShares - real}: ` +
                `${rd.totalShares > real ? 'stale shares dilute the others (safe)' : rd.totalShares < real ? 'under-reported' : 'exact'}); ` +
                `claimed ${rd.claimed} / accrued ${rd.accrued}, master ${await balOf(master.address)} / held ${await held(master)}; ` +
                `other holders: ${honest.length ? honest.join(', ') : 'always paid in full'}`);
            // eslint-disable-next-line no-console
            console.log(`lost ${kind} ${drop}:\n` + rows.join('\n'));
            await solvent(master);
            expect(honest).toEqual([]);
        });
    }

    // -----------------------------------------------------------------------
    // 7. R4B-3: CollectTax returns the caller's unused value
    // -----------------------------------------------------------------------

    it('R4B-3: CollectTax with 5 Gram attached: the tax recipient gets exactly tax + 0.04, the caller gets the rest back', async () => {
        const { master, key, pool } = await launch({ buyTaxBps: 100n, sellTaxBps: 100n, walletBps: 10000n, taxWallet: creator.address });
        expectNoFailures(await buy(alice, key, toNano('5')));           // 0.05 Gram of tax stays in the pool (below TAX_MIN_PAYOUT)
        const tax = (await pool.getGetPoolState()).taxFees;
        expect(tax).toBe(toNano('0.05'));
        const recipient = (await master.getGetLaunchInfo()).taxRecipient!;
        expect(recipient.equals(master.address)).toBe(true);
        const c0 = await balOf(creator.address), m0 = await balOf(mallory.address);
        const res = await router.send(mallory.getSender(), { value: toNano('5') }, { $$type: 'CollectTax', queryId: 0n, key: { ...key, $$type: 'PoolKey' } });
        expectNoFailures(res);
        expect(gramPayouts(res, master.address).filter((x) => x.reason === REASON.TAX).map((x) => [x.amount, x.value]))
            .toEqual([[tax, tax + C.TAX_PAYOUT_GAS]]);
        expect(res.transactions.filter((tx) => dst(tx)?.equals(master.address) && src(tx)?.equals(pool.address)).map(valueIn)).toEqual([tax + C.TAX_PAYOUT_GAS]);
        const back = res.transactions.filter((tx) => dst(tx)?.equals(mallory.address) && opOf(tx) === OPS.excesses);
        expect(back.length).toBe(1);
        expect(valueIn(back[0])).toBeGreaterThan(toNano('4.85'));
        const paid = m0 - (await balOf(mallory.address));
        const got = (await balOf(creator.address)) - c0;
        // eslint-disable-next-line no-console
        console.log(`R4B-3: caller attached 5 Gram to collect ${tax} of tax: caller paid ${paid}, excess back ${valueIn(back[0])}, tax wallet received ${got}`);
        expect(paid).toBeLessThan(toNano('0.15'));
        expect(got).toBeLessThan(tax + C.TAX_PAYOUT_GAS);
        expect(got).toBeGreaterThan(tax - toNano('0.01'));
    });

    // -----------------------------------------------------------------------
    // 8. Transfer cost at the mainnet gas price
    // -----------------------------------------------------------------------

    it('transfer cost: at 66.67 nanoGram/gas get_transfer_fee between two tracked holders + forward fees < 0.05 Gram; a standard 0.05 transfer works', async () => {
        const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n });
        expectNoFailures(await buy(alice, key, toNano('100')));
        expectNoFailures(await buy(bob, key, toNano('20')));
        const dict = Dictionary.loadDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell(), chain.config);
        const raw = dict.get(21)!.beginParse().skip(8 + 64 + 64 + 8).loadUintBig(64);
        expect(Number(raw) / 65536).toBeCloseTo(66.67, 1);
        const wa = await walletOf(master, alice.address);
        const need = await wa.getGetTransferFee(bob.address);
        const rv = await wa.getGetRewardValues();
        const ok = (res: { transactions: BlockchainTransaction[] }) => res.transactions.every(txOk) &&
            res.transactions.filter((tx) => opOf(tx) === OPS.checkpoint && dst(tx)?.equals(master.address)).length === 2 &&
            res.transactions.filter((tx) => opOf(tx) === OPS.ack && txOk(tx)).length === 2;
        // The exact minimum value (binary search, nanoGram precision) for a transfer with both checkpoints.
        const snap = chain.snapshot();
        let lo = need - toNano('0.005'), hi = toNano('0.05');
        let fwdIn = 0n;
        const at0 = await transfer(master, alice, bob.address, 1000n, hi);
        expect(ok(at0)).toBe(true);                                    // a standard 0.05 transfer works
        fwdIn = (at0.transactions.find((tx) => dst(tx)?.equals(wa.address))!.inMessage!.info as any).forwardFee as bigint;
        await chain.loadFrom(snap);
        while (hi - lo > 1n) {
            const mid = (lo + hi) / 2n;
            await chain.loadFrom(snap);
            const res = await transfer(master, alice, bob.address, 1000n, mid);
            if (ok(res)) hi = mid; else lo = mid;
        }
        await chain.loadFrom(snap);
        // eslint-disable-next-line no-console
        console.log(`transfer cost at 66.67 nanoGram/gas: get_transfer_fee ${need} (checkpoint ${rv.checkpoint} x2), incoming forward fee ${fwdIn}, ` +
            `need + forward fee ${need + fwdIn}; exact minimum value that works with both checkpoints ${hi}`);
        expect(need + fwdIn).toBeLessThan(toNano('0.05'));
        expect(hi).toBeLessThan(toNano('0.05'));
        expect(hi).toBeLessThan(need + toNano('0.001'));
        // And a 0.05 transfer to a brand-new holder also checkpoints both sides.
        const fresh = await chain.treasury('fresh');
        expect(ok(await transfer(master, alice, fresh.address, 1000n, toNano('0.05')))).toBe(true);
        expect((await (await walletOf(master, fresh.address)).getGetRewardState()).acked).toBe(1000n);
    });

    // -----------------------------------------------------------------------
    // 9. Gas: master RewardCheckpoint / RewardClaim, wallet RewardAck vs the constants (1.5x)
    // -----------------------------------------------------------------------

    it('gas: master RewardCheckpoint / RewardClaim, wallet RewardAck / ClaimRewards / SyncRewards, worst case (vault token, rent absorbed, storage debt): constants >= 1.5x measured', async () => {
        const rows: string[] = [];
        const worst = { cp: 0, claim: 0, ack: 0, claimAck: 0, send: 0, recv: 0, claimW: 0, syncW: 0 };
        for (const vaultBps of [0n, 2000n]) {
            await chain.loadFrom(base);
            chain.setConfig(config0);
            chain.now = T0;
            const { master, key } = await launch({ buyTaxBps: 500n, sellTaxBps: 500n, rewardsBps: 9999n, buybackBps: 1n, vaultBps });
            if (vaultBps > 0n) expect(await master.getGetVaultAddress()).not.toBeNull();
            expectNoFailures(await buy(alice, key, toNano('300')));
            expectNoFailures(await buy(bob, key, toNano('30')));
            const cps = (res: { transactions: BlockchainTransaction[] }) =>
                res.transactions.filter((tx) => dst(tx)?.equals(master.address) && opOf(tx) === OPS.checkpoint).map(gasOf);
            const cls = (res: { transactions: BlockchainTransaction[] }) =>
                res.transactions.filter((tx) => dst(tx)?.equals(master.address) && opOf(tx) === OPS.claim).map(gasOf);
            const acks = (res: { transactions: BlockchainTransaction[] }) =>
                res.transactions.filter((tx) => opOf(tx) === OPS.ack && src(tx)?.equals(master.address)).map(gasOf);
            const m: Record<string, number[]> = {};
            const add = (k: string, res: { transactions: BlockchainTransaction[] }) => {
                expectNoFailures(res);
                m[k] = [...cps(res), ...cls(res)];
                const a = acks(res);
                m[k + ' / acks'] = a;
                worst.cp = Math.max(worst.cp, ...cps(res));
                worst.claim = Math.max(worst.claim, ...cls(res));
                if (cls(res).length) worst.claimAck = Math.max(worst.claimAck, ...a);
                else worst.ack = Math.max(worst.ack, ...a);
                // Wallet side of a ClaimRewards / SyncRewards (CLAIM_WALLET_GAS, audit C7).
                for (const tx of res.transactions) {
                    if (isBounced(tx)) continue;
                    if (opOf(tx) === OPS.claimRewards) worst.claimW = Math.max(worst.claimW, gasOf(tx));
                    if (opOf(tx) === OPS.sync) worst.syncW = Math.max(worst.syncW, gasOf(tx));
                }
            };
            // Wallet side: the sender's JettonTransfer and a tracked receiver's internal transfer, plain and
            // notifying (forwardTonAmount > 0 with a payload), to an existing and a new holder.
            const walletGas = (res: { transactions: BlockchainTransaction[] }) => {
                // (the notification to an owner without a contract fails there: not ours)
                expectNoFailures({ transactions: res.transactions.filter((tx) => opOf(tx) !== 0x7362d09c) });
                for (const tx of res.transactions) {
                    if (opOf(tx) === OPS.transfer) worst.send = Math.max(worst.send, gasOf(tx));
                    if (opOf(tx) === OPS.internal && !src(tx)?.equals(master.address)) worst.recv = Math.max(worst.recv, gasOf(tx));
                }
            };
            for (const [to, fwd] of [[bob.address, 0n], [bob.address, toNano('0.01')], [new Address(0, sha256_sync(`gas-recv-${vaultBps}`)), toNano('0.01')]] as const) {
                const payload = beginCell().storeUint(0, 32).storeStringTail('x'.repeat(100)).endCell();
                walletGas(await (await walletOf(master, alice.address)).send(alice.getSender(), { value: toNano('0.2') }, {
                    $$type: 'JettonTransfer', queryId: 3n, amount: 1000n, destination: to, responseDestination: alice.address, customPayload: null,
                    forwardTonAmount: fwd, forwardPayload: fwd > 0n ? beginCell().storeBit(1).storeRef(payload).endCell().beginParse() : beginCell().storeBit(0).endCell().beginParse(),
                }));
            }
            add('transfer existing', await transfer(master, alice, bob.address, 1000n));
            add('transfer new holder', await transfer(master, alice, new Address(0, sha256_sync(`gas-new-${vaultBps}`)), 1000n));
            add('sell', await sell(alice, master, key, 10n ** 12n));
            add('burn', await (await walletOf(master, alice.address)).send(alice.getSender(), { value: toNano('0.1') },
                { $$type: 'JettonBurn', queryId: 0n, amount: 1000n, responseDestination: alice.address, customPayload: null }));
            add('SyncRewards', await syncBy(master, alice.address, alice));
            expectNoFailures(await buy(mallory, key, toNano('20')));
            add('claim owed>0', await claim(master, bob));
            add('claim owed=0', await claim(master, bob));
            // After years without any message: the master's rent (beyond its spare Gram) is absorbed from the
            // rent fund (absorbRent's deficit branch).
            const spare = (await balOf(master.address)) - C.MASTER_MIN_STORAGE - (await held(master));
            chain.now! += 4 * YEAR;
            const rf0 = (await master.getGetRewardsData()).rentFund;
            add('transfer after 4y (rent absorbed)', await transfer(master, alice, bob.address, 1000n));
            const rf1 = (await master.getGetRewardsData()).rentFund;
            expect(rf1).toBeLessThan(rf0);
            chain.now! += 2 * YEAR;
            add('claim after 2y (rent absorbed)', await claim(master, alice));
            expect((await master.getGetRewardsData()).rentFund).toBeLessThan(rf1);
            // Wallets idle 3 more years (storage debt): a SyncRewards by a third party, then the owner's claim.
            chain.now! += 3 * YEAR;
            expectNoFailures(await buy(mallory, key, toNano('20')));
            // (the getter cannot see rent not yet recorded as debt: attach a margin, as the web app does; README "Long-idle wallets")
            add('SyncRewards with a storage debt', await syncBy(master, bob.address, mallory, (await (await walletOf(master, bob.address)).getGetRewardValues()).sync + toNano('0.02')));
            chain.now! += 3 * YEAR;
            add('claim with a storage debt', await claim(master, bob));
            rows.push(`(spare before the idle years ${spare}, rentFund ${rf0} -> ${rf1} -> ${(await master.getGetRewardsData()).rentFund})`);
            rows.push(`${vaultBps > 0n ? 'vault token' : 'no vault'}: ` + Object.entries(m).map(([k, v]) => `${k} ${v.join('/')}`).join('; '));
        }
        const margin = (c: bigint, g: number) => (Number(c) / g).toFixed(2);
        rows.push(`worst: RewardCheckpoint ${worst.cp} gas (CP_MASTER_GAS ${C.CP_MASTER_GAS}, ${margin(C.CP_MASTER_GAS, worst.cp)}x, 1.5x needs ${Math.ceil(worst.cp * 1.5)}); ` +
            `RewardClaim ${worst.claim} (CLAIM_MASTER_GAS ${C.CLAIM_MASTER_GAS}, ${margin(C.CLAIM_MASTER_GAS, worst.claim)}x, 1.5x needs ${Math.ceil(worst.claim * 1.5)}); ` +
            `RewardAck ${Math.max(worst.ack, worst.claimAck)} (checkpoint ack ${worst.ack}, claim ack ${worst.claimAck}; ACK_GAS ${C.ACK_GAS}, ` +
            `${margin(C.ACK_GAS, Math.max(worst.ack, worst.claimAck))}x, 1.5x needs ${Math.ceil(Math.max(worst.ack, worst.claimAck) * 1.5)})`);
        // eslint-disable-next-line no-console
        console.log('gas:\n' + rows.join('\n'));
        const short: string[] = [];
        if (Math.ceil(worst.cp * 1.5) > Number(C.CP_MASTER_GAS)) short.push(`CP_MASTER_GAS ${C.CP_MASTER_GAS} < 1.5 x ${worst.cp}`);
        if (Math.ceil(worst.claim * 1.5) > Number(C.CLAIM_MASTER_GAS)) short.push(`CLAIM_MASTER_GAS ${C.CLAIM_MASTER_GAS} < 1.5 x ${worst.claim}`);
        if (Math.ceil(Math.max(worst.ack, worst.claimAck) * 1.5) > Number(C.ACK_GAS)) short.push(`ACK_GAS ${C.ACK_GAS} < 1.5 x ${Math.max(worst.ack, worst.claimAck)}`);
        const WALLET_SEND_GAS = Number(J('WALLET_SEND_GAS')), WALLET_RECV_GAS = Number(J('WALLET_RECV_GAS'));
        // eslint-disable-next-line no-console
        console.log(`wallet: JettonTransfer ${worst.send} gas (WALLET_SEND_GAS ${WALLET_SEND_GAS}, ${margin(BigInt(WALLET_SEND_GAS), worst.send)}x); ` +
            `tracked receive (notifying, worst) ${worst.recv} gas (WALLET_RECV_GAS ${WALLET_RECV_GAS}, ${margin(BigInt(WALLET_RECV_GAS), worst.recv)}x)`);
        if (Math.ceil(worst.send * 1.5) > WALLET_SEND_GAS) short.push(`WALLET_SEND_GAS ${WALLET_SEND_GAS} < 1.5 x ${worst.send}`);
        if (Math.ceil(worst.recv * 1.5) > WALLET_RECV_GAS) short.push(`WALLET_RECV_GAS ${WALLET_RECV_GAS} < 1.5 x ${worst.recv}`);
        // C7: CLAIM_WALLET_GAS covers the worst of the wallet's ClaimRewards and SyncRewards.
        const CLAIM_WALLET_GAS = Number(J('CLAIM_WALLET_GAS'));
        const claimWorst = Math.max(worst.claimW, worst.syncW);
        // eslint-disable-next-line no-console
        console.log(`wallet: ClaimRewards ${worst.claimW} gas, SyncRewards ${worst.syncW} gas (CLAIM_WALLET_GAS ${CLAIM_WALLET_GAS}, ${margin(BigInt(CLAIM_WALLET_GAS), claimWorst)}x)`);
        expect(worst.claimW).toBeGreaterThan(0);
        expect(worst.syncW).toBeGreaterThan(0);
        if (Math.ceil(claimWorst * 1.5) > CLAIM_WALLET_GAS) short.push(`CLAIM_WALLET_GAS ${CLAIM_WALLET_GAS} < 1.5 x ${claimWorst}`);
        expect(short).toEqual([]);
    });
});
