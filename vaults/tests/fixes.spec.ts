// Tests for the fixes of the audit-v3 vault findings (pitch/audit-v3-2026-11-18.md, "Vaults"):
// H-1 terminal path, M-1 time-based recovery (every lost-reply state), L-1 queue kick after an
// aborted rebalance, L-2 access / minimum withdrawal, L-3 rebalance mint price band.
// (H-1 recipient refusal and H-2 pro-rata fees: audit4-recipient / audit4-feeskim.)

import { Address, beginCell, Message, toNano } from '@ton/core';
import { BlockchainTransaction } from '@ton/sandbox';
import {
    stepParallel, VaultFx, GRAM_1, USDT, PHASE, WITHDRAW_GAS, DEPOSIT_GAS, REBALANCE_GAS, RECOVERY_DELAY, DEP_TIMEOUT,
    OPD, OPV, expectNoFailures, refusals, gramPaidTo, events,
} from './fixture';
import { drain, msg } from '../../dex/v2/tests/helpers';
import * as M from '../../dex/v2/tests/model';
import { storeJettonBurn } from '../build/Vault_VaultWallet';
import {
    storeDepositNative, storeRebalance, storeJettonTransfer, storeDepositPayload, loadJettonTransfer, loadMintNotifyPayload,
    loadMintNativeNotify, loadRebalanceEvent, loadWithdrawFailedEvent, loadRecoverEvent,
} from '../build/Vault_Vault';

const burnOf = (amount: bigint, q = 1n) => beginCell().store(storeJettonBurn({ $$type: 'JettonBurn', queryId: q, amount, responseDestination: null, customPayload: null })).endCell();

async function withHolders() {
    const f = await VaultFx.create();
    await f.swapGram(f.carol, 3n * GRAM_1);
    await f.wait(3700);
    expectNoFailures(await f.depositUsdt(f.alice, 600n * USDT, 200n * GRAM_1));
    expectNoFailures(await f.depositUsdt(f.bob, 300n * USDT, 0n));
    return f;
}

async function stepUntil(it: AsyncIterator<BlockchainTransaction>, pred: () => Promise<boolean>, max = 300, log?: BlockchainTransaction[]) {
    for (let i = 0; i < max; i++) {
        if (await pred()) return true;
        const r = await it.next();
        if (r.done) return false;
        log?.push(r.value);
    }
    return pred();
}

const opOf = (m: Message) => {
    const b = m.body.beginParse();
    return b.remainingBits >= 32 ? b.preloadUint(32) : -1;
};
const keyOf = (m: Message) => `${(m.info as any).dest?.toString()}|${m.body.hash().toString('hex')}`;

// Internal messages produced by `txs` and not yet consumed by one of them.
function pendingOf(txs: BlockchainTransaction[]) {
    const consumed = new Map<string, number>();
    for (const tx of txs) {
        if (tx.inMessage) consumed.set(keyOf(tx.inMessage), (consumed.get(keyOf(tx.inMessage)) ?? 0) + 1);
    }
    const out: Message[] = [];
    for (const tx of txs) {
        for (const m of tx.outMessages.values()) {
            if (m.info.type !== 'internal') continue;
            const k = keyOf(m);
            const c = consumed.get(k) ?? 0;
            if (c > 0) consumed.set(k, c - 1);
            else out.push(m);
        }
    }
    return out;
}

const holdings = (f: VaultFx) => f.holdings();

function principalOf(sn: Awaited<ReturnType<VaultFx['snap']>>, dLs: bigint[], tick: bigint, sqrtP: bigint) {
    let p0 = 0n;
    let p1 = 0n;
    dLs.forEach((dL, i) => {
        if (dL === 0n) return;
        const am = M.amountsForLiquidity(Number(tick), sqrtP, Number(sn.pos[i].tL), Number(sn.pos[i].tU), dL, false);
        p0 += am.a;
        p1 += am.b;
    });
    return { p0, p1 };
}

const failedAtVault = (txs: BlockchainTransaction[], vault: Address) =>
    txs.some((tx) => tx.inMessage?.info.dest instanceof Address && tx.inMessage.info.dest.equals(vault) &&
        (tx.description as any).computePhase?.type === 'vm' && (tx.description as any).computePhase.exitCode !== 0);

describe('H-1 terminal path', () => {
    it('a user decrease the DEX refuses 3 times ends: liquidity stays with the holders, the withdrawer gets shares worth it', async () => {
        const f = await withHolders();
        const s = (await f.shares(f.alice.address)) / 2n;
        const supply0 = (await f.data()).supply;
        const w = await f.shareWallet(f.alice.address);
        const { it } = await stepParallel(f.chain, msg(f.alice.address, w.address, WITHDRAW_GAS + toNano('0.1'), burnOf(s)), 0);
        const seen = new Set<bigint>();
        const log: BlockchainTransaction[] = [];
        for (let k = 0; k < 3; k++) {
            // a fresh user decrease is in flight: delay it past its DEX deadline (the Pool refuses it)
            const sent = await stepUntil(it, async () => {
                const ops = await f.vault.getGetOps();
                for (const q of ops.keys()) {
                    const o = ops.get(q)!;
                    if (o.kind === 4n && !o.done && !seen.has(q)) {
                        seen.add(q);
                        return true;
                    }
                }
                return false;
            }, 300, log);
            expect(sent).toBe(true);
            await f.wait(86400 + 10);
        }
        log.push(...(await drain(it)));
        const fe = events({ transactions: log } as any).filter((e) => e.op === 0x56410075).map((e) => loadWithdrawFailedEvent(e.body.clone()));
        expect(fe.length).toBe(1);                 // one slot (the base), terminal after 3 refusals
        const v = await f.data();
        expect([v.workerActive, v.queueLength, v.opCount, v.due0, v.due1, v.opGas]).toEqual([false, 0n, 0n, 0n, 0n, 0n]);
        for (const p of await f.positions()) expect(p.reserved).toBe(0n);
        await f.expectPositionsMatchNfts();
        // the burned shares are gone, the compensation shares were minted
        expect(v.supply).toBe(supply0 - s + fe[0].shares);
        const mine = await f.shares(f.alice.address);
        expect(mine).toBeGreaterThan(0n);
        // the compensation is worth the liquidity it stands for (priced like a deposit: never more)
        const n = await f.vault.getGetNav();
        const ov = await f.vault.getGetOracle();
        const pos = (await f.positions()).find((p) => p.slot === Number(fe[0].slot))!;
        const t = ov.ready ? ov.twapTick : ov.spotTick;
        const am = M.amountsForLiquidity(Number(t), M.sqrtAt(Number(t)), Number(pos.tL), Number(pos.tU), fe[0].dL, false);
        const worth = am.a * ((M.sqrtAt(Number(t)) * M.sqrtAt(Number(t))) >> 128n) + (am.b << 64n);
        const claim = (n.nav * fe[0].shares) / n.supply;
        expect(claim).toBeLessThanOrEqual(worth + (worth / 1000n));
        expect(claim).toBeGreaterThan((worth * 98n) / 100n);
        // and the vault is not stuck: the compensation shares can be withdrawn normally
        const ub = await f.usdtBal(f.alice.address);
        expectNoFailures(await f.withdraw(f.alice, await f.shares(f.alice.address)));
        expect(await f.shares(f.alice.address)).toBe(0n);
        expect(await f.usdtBal(f.alice.address)).toBeGreaterThan(ub);
        await f.expectSolvent();
    });
});

describe('M-1 recovery after a lost DEX reply', () => {
    it('a deposit whose observation never comes back is refunded (both legs) after DEP_TIMEOUT; the late reply is ignored', async () => {
        const f = await withHolders();
        const gram = 20n * GRAM_1;
        const usdt = 50n * USDT;
        const fwd = gram + DEPOSIT_GAS + toNano('0.05');
        const body = beginCell().store(storeJettonTransfer({
            $$type: 'JettonTransfer', queryId: 7n, amount: usdt, destination: f.vault.address, responseDestination: f.bob.address,
            customPayload: null, forwardTonAmount: fwd, forwardPayload: f.depositPayload(gram),
        })).endCell();
        const bw = await f.usdtWallet(f.bob.address);
        const ub = await f.usdtBal(f.bob.address);
        const gb = await f.gram(f.bob.address);
        const { it } = await stepParallel(f.chain, msg(f.bob.address, bw.address, fwd + toNano('0.1'), body), 0);
        expect(await stepUntil(it, async () => (await f.data()).depCount === 1n)).toBe(true);
        // the observation is "lost" (never delivered): nothing to do before the timeout
        const early = await f.recover();
        expect(early.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        await f.wait(DEP_TIMEOUT);
        const rec = await f.recover();
        expectNoFailures(rec);
        expect(refusals(rec)).toEqual([6]);
        expect(events(rec).filter((e) => e.op === 0x56410076).map((e) => Number(loadRecoverEvent(e.body.clone()).kind))).toEqual([1]);
        let v = await f.data();
        expect([v.depCount, v.pendGram, v.pendUsdt]).toEqual([0n, 0n, 0n]);
        expect(await f.usdtBal(f.bob.address)).toBe(ub);
        const lost = gb - (await f.gram(f.bob.address));
        expect(lost).toBeLessThan(toNano('0.5'));        // only gas: the Gram leg came back
        expect(gramPaidTo(rec, f.bob.address, 4)).toBe(gram);
        // the late observation reply changes nothing
        const sharesB = await f.shares(f.bob.address);
        await drain(it);
        expect(await f.shares(f.bob.address)).toBe(sharesB);
        expect(await f.usdtBal(f.bob.address)).toBe(ub);
        v = await f.data();
        expect(v.depCount).toBe(0n);
        await f.expectSolvent();
    });

    it('a user decrease that never reaches the Position: re-synced after RECOVERY_DELAY, retried, paid once', async () => {
        const f = await withHolders();
        const s = await f.shares(f.alice.address);
        const sn = await f.snap();
        const split = f.modelSplit(sn, s);
        const w = await f.shareWallet(f.alice.address);
        const { it } = await stepParallel(f.chain, msg(f.alice.address, w.address, WITHDRAW_GAS + toNano('0.1'), burnOf(s)), 0);
        expect(await stepUntil(it, async () => [...(await f.vault.getGetOps()).values()].some((o) => o.kind === 4n))).toBe(true);
        // stuck: the position is busy, so deposits are refused and rebalances are "Busy"
        expect(refusals(await f.depositUsdt(f.carol, 10n * USDT))).toEqual([1]);
        await f.wait(86400);
        const reb = await f.rebalance();
        expect(reb.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        const early = await f.recover();
        expect(early.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        await f.wait(RECOVERY_DELAY - 86400);
        const ps = await f.poolState();
        const { p0, p1 } = principalOf(sn, split.dL, ps.tick, ps.sqrtPriceX96);
        const ub = await f.usdtBal(f.alice.address);
        const rec = await f.recover();
        expectNoFailures(rec);
        expect(gramPaidTo(rec, f.alice.address, 1)).toBe(p0);
        expect((await f.usdtBal(f.alice.address)) - ub).toBe(p1);
        let v = await f.data();
        expect([v.workerActive, v.opCount, v.due0, v.due1, v.opGas]).toEqual([false, 0n, 0n, 0n, 0n]);
        // the lost messages finally arrive (the decrease after its deadline: refused, ignored)
        const rest = await drain(it);
        expect(gramPaidTo({ transactions: rest } as any, f.alice.address, 1)).toBe(split.g);
        expect((await f.usdtBal(f.alice.address)) - ub).toBe(p1 + split.u);
        v = await f.data();
        expect([v.workerActive, v.opCount, v.exp0, v.exp1]).toEqual([false, 0n, 0n, 0n]);
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();
        expectNoFailures(await f.depositUsdt(f.carol, 10n * USDT));
        expect(await f.shares(f.carol.address)).toBeGreaterThan(0n);
    });

    it('a user decrease that ran but whose receipt was lost: the re-sync sees it ran and forwards what arrived', async () => {
        const f = await withHolders();
        const s = await f.shares(f.bob.address);
        const sn = await f.snap();
        const split = f.modelSplit(sn, s);
        const ps = await f.poolState();
        const { p0, p1 } = principalOf(sn, split.dL, ps.tick, ps.sqrtPriceX96);
        const w = await f.shareWallet(f.bob.address);
        const ub = await f.usdtBal(f.bob.address);
        const it = await f.chain.sendMessageIter(msg(f.bob.address, w.address, WITHDRAW_GAS + toNano('0.1'), burnOf(s)), { allowParallel: true } as any);
        const txs: BlockchainTransaction[] = [];
        let receipt: Message | null = null;
        for (let i = 0; i < 300 && !receipt; i++) {
            const r = await it.next();
            if (r.done) break;
            txs.push(r.value);
            for (const m of r.value.outMessages.values()) {
                if (m.info.type === 'internal' && m.info.dest.equals(f.vault.address) && opOf(m) === OPD.BurnReceipt) {
                    const b = m.body.beginParse();
                    b.loadUint(32);
                    if ((b.loadUintBig(64) >> 56n) === 4n) receipt = m;
                }
            }
        }
        expect(receipt).not.toBeNull();
        // deliver everything in flight EXCEPT the receipt (it is "lost"); the iterator is abandoned
        const gb = await f.gram(f.bob.address);
        let paid0 = gramPaidTo({ transactions: txs } as any, f.bob.address, 1);     // (the idle share, if already delivered)
        for (const m of pendingOf(txs)) {
            if (m === receipt || keyOf(m) === keyOf(receipt!)) continue;
            const r = await f.chain.sendMessage(m);
            paid0 += gramPaidTo(r, f.bob.address, 1);
        }
        let v = await f.data();
        expect(v.workerActive).toBe(true);
        const pos = await f.positions();
        const nft = await (await f.position(pos[0].index)).getGetPositionData();
        expect(nft.liquidity).toBe(pos[0].L - split.dL[0]);       // it ran at the DEX
        expect(nft.busy).toBe(false);
        await f.wait(RECOVERY_DELAY);
        const rec = await f.recover();
        expectNoFailures(rec);
        paid0 += gramPaidTo(rec, f.bob.address, 1);
        expect(paid0).toBe(split.g + p0);
        expect((await f.usdtBal(f.bob.address)) - ub).toBe(split.u + p1);
        expect(await f.gram(f.bob.address)).toBeGreaterThan(gb);
        v = await f.data();
        expect([v.workerActive, v.opCount, v.exp0, v.exp1, v.due0, v.due1, v.opGas]).toEqual([false, 0n, 0n, 0n, 0n, 0n, 0n]);
        for (const p of await f.positions()) expect(p.reserved).toBe(0n);
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();
    });

    it('a mint without receipt blocks rebalances until Recover (after its DEX deadline); its late refund restores the funds exactly', async () => {
        const f = await withHolders();
        await f.wait(86400);
        await f.warm(1900);
        const before = await holdings(f);
        const rb = msg(f.keeper.address, f.vault.address, REBALANCE_GAS + toNano('0.1'),
            beginCell().store(storeRebalance({ $$type: 'Rebalance', queryId: 9n })).endCell());
        const { it } = await stepParallel(f.chain, rb, 0);
        expect(await stepUntil(it, async () => [...(await f.vault.getGetOps()).values()].some((o) => o.kind === 1n))).toBe(true);
        // the mints are in flight forever (never delivered); after 30 min the rebalance is aborted
        await f.wait(1800);
        expectNoFailures(await f.vault.send(f.alice.getSender(), { value: toNano('0.1') }, { $$type: 'AbortRebalance', queryId: 1n }));
        let v = await f.data();
        expect(v.phase).toBe(PHASE.IDLE);
        await f.wait(86400);
        const blocked = await f.rebalance();
        expect(blocked.transactions).toHaveTransaction({ to: f.vault.address, success: false });   // "Busy": unresolved mint
        expect((await f.recover()).transactions).toHaveTransaction({ to: f.vault.address, success: false });
        await f.wait(RECOVERY_DELAY - 86400 - 1800);
        const rec = await f.recover();
        expectNoFailures(rec);
        expect(events(rec).filter((e) => e.op === 0x56410076).every((e) => Number(loadRecoverEvent(e.body.clone()).kind) === 2)).toBe(true);
        v = await f.data();
        expect([...(await f.vault.getGetOps()).values()].every((o) => o.done)).toBe(true);
        // the mints arrive late: refused for their deadline, every leg comes back to the holders
        const rest = await drain(it);
        expect(failedAtVault(rest, f.vault.address)).toBe(false);
        v = await f.data();
        expect([v.opCount, v.exp0, v.exp1]).toEqual([0n, 0n, 0n]);
        const after = await holdings(f);
        expect(after.h0).toBe(before.h0);
        expect(after.h1).toBe(before.h1);
        await f.expectSolvent();
        // and rebalancing works again
        await f.warm(1900);
        const ok = await f.rebalance();
        expectNoFailures(ok);
        expect((await f.data()).phase).toBe(PHASE.IDLE);
        expect((await f.positions()).length).toBeGreaterThan(0);
        await f.expectPositionsMatchNfts();
    });

    it('Recover is refused when nothing is stale, and needs its gas', async () => {
        const f = await withHolders();
        await f.wait(RECOVERY_DELAY + 10);
        const r = await f.recover();
        expect(r.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        const low = await f.recover(f.mallory, toNano('0.1'));
        expect(low.transactions).toHaveTransaction({ to: f.vault.address, success: false });
    });
});

describe('L-1, L-2, L-3', () => {
    it('L-1: a withdrawal queued during a rebalance starts once the aborted rebalance\'s closes come back', async () => {
        const f = await withHolders();
        await f.wait(86400);
        await f.warm(1900);
        const rb = msg(f.keeper.address, f.vault.address, REBALANCE_GAS + toNano('0.1'),
            beginCell().store(storeRebalance({ $$type: 'Rebalance', queryId: 9n })).endCell());
        const { it } = await stepParallel(f.chain, rb, 0);
        expect(await stepUntil(it, async () => (await f.positions()).some((p) => p.busy !== 0n))).toBe(true);
        expectNoFailures(await f.withdraw(f.bob, await f.shares(f.bob.address)));
        expect((await f.data()).queueLength).toBe(1n);
        await f.wait(1800);
        expectNoFailures(await f.vault.send(f.alice.getSender(), { value: toNano('0.1') }, { $$type: 'AbortRebalance', queryId: 1n }));
        let v = await f.data();
        expect([v.phase, v.queueLength]).toEqual([PHASE.IDLE, 1n]);   // positions still busy with the closes
        const ub = await f.usdtBal(f.bob.address);
        await drain(it);
        v = await f.data();
        expect([v.queueLength, v.workerActive, v.opCount]).toEqual([0n, false, 0n]);
        expect(await f.shares(f.bob.address)).toBe(0n);
        expect(await f.usdtBal(f.bob.address)).toBeGreaterThan(ub);
        await f.expectSolvent();
    });

    it('L-2: dust burns below the minimum and Rebalance from anyone else than keeper/admin are refused', async () => {
        const f = await withHolders();
        const s = await f.shares(f.bob.address);
        const minW = (await f.data()).supply / 1_000_000n;
        const dust = await f.withdraw(f.bob, minW - 1n);
        expect(dust.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        expect(await f.shares(f.bob.address)).toBe(s);
        expectNoFailures(await f.withdraw(f.bob, minW));
        await f.wait(86400);
        const spam = await f.rebalance(f.mallory);
        expect(spam.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        expect((await f.data()).phase).toBe(PHASE.IDLE);
        expectNoFailures(await f.rebalance(f.admin));
    });

    it('L-3: rebalance mints carry the price band spot ± maxDeviation/4 (inside TWAP ± maxDeviation)', async () => {
        const f = await withHolders();
        await f.moveTo((await f.poolState()).tick - 700n);
        await f.warm(4000);
        await f.poke();
        const rb = await f.rebalance();
        expectNoFailures(rb);
        const ev = events(rb).filter((e) => e.op === OPV.RebalanceEvent).map((e) => loadRebalanceEvent(e.body.clone()));
        const minted = ev.find((e) => e.stage === 2n)!;
        expect(minted).toBeDefined();
        const dev = (await f.data()).strategy.maxDeviation;
        const tol = dev / 4n;
        const lo = M.sqrtAt(Number(minted.twapTick - dev > minted.spotTick - tol ? minted.twapTick - dev : minted.spotTick - tol));
        const hi = M.sqrtAt(Number(minted.twapTick + dev < minted.spotTick + tol ? minted.twapTick + dev : minted.spotTick + tol));
        let n = 0;
        for (const tx of rb.transactions) {
            if (!(tx.inMessage?.info.src instanceof Address) || !tx.inMessage.info.src.equals(f.vault.address)) continue;
            const b = tx.inMessage.body.beginParse();
            if (b.remainingBits < 32) continue;
            const op = b.preloadUint(32);
            if (op === 0x0f8a7ea5) {
                const jt = loadJettonTransfer(b);
                const p = jt.forwardPayload;
                if (p.remainingBits === 0 || !p.loadBit()) continue;
                const pl = p.loadRef().beginParse();
                if (pl.remainingBits < 32 || pl.preloadUint(32) !== 0x4d480005) continue;
                const mp = loadMintNotifyPayload(pl);
                expect([mp.sqrtPriceMinX96, mp.sqrtPriceMaxX96]).toEqual([lo, hi]);
                n++;
            } else if (op === 0x4d48001c) {
                const mn = loadMintNativeNotify(b);
                expect([mn.sqrtPriceMinX96, mn.sqrtPriceMaxX96]).toEqual([lo, hi]);
                n++;
            }
        }
        expect(n).toBeGreaterThan(0);
        expect(hi > lo).toBe(true);
        await f.expectPositionsMatchNfts();
    });
});
