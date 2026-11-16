// Asynchronous edge cases of the position-op protocol (DESIGN §5.3): a decrease that really fails at
// the Pool, payouts that overtake their receipt (cross-shard order), and pricing at the worse of
// TWAP and spot. All must end with every user paid exactly once, the books exact and the vault's
// positions equal to the NFTs.

import { Address, beginCell, toNano } from '@ton/core';
import { stepParallel, VaultFx, GRAM_1, USDT, WITHDRAW_GAS, OPD, expectNoFailures, refusals } from './fixture';
import { drain, msg } from '../../dex/v2/tests/helpers';
import { storeJettonBurn } from '../build/Vault_VaultWallet';
import * as M from '../../dex/v2/tests/model';

async function ready() {
    const f = await VaultFx.create();
    await f.swapGram(f.carol, 3n * GRAM_1);
    await f.wait(3700);
    expectNoFailures(await f.depositUsdt(f.alice, 600n * USDT, 200n * GRAM_1));
    return f;
}

async function stepUntil(it: AsyncIterator<any>, pred: () => Promise<boolean>, max = 200) {
    for (let i = 0; i < max; i++) {
        if (await pred()) return true;
        const r = await it.next();
        if (r.done) return false;
    }
    return pred();
}

const burnOf = (amount: bigint) => beginCell().store(storeJettonBurn({ $$type: 'JettonBurn', queryId: 1n, amount, responseDestination: null, customPayload: null })).endCell();

describe('async position-op protocol', () => {
    it('a user decrease that fails at the Pool (deadline) answers BurnReceipt{ok = false} and is retried: paid exactly once', async () => {
        const f = await ready();
        const s = await f.shares(f.alice.address);
        const sn = await f.snap();
        const split = f.modelSplit(sn, s);
        const w = await f.shareWallet(f.alice.address);
        const { it } = await stepParallel(f.chain, msg(f.alice.address, w.address, WITHDRAW_GAS + toNano('0.1'), burnOf(s)), 0);
        // run until the user's decrease (kind 4) has been SENT, then delay it past its deadline
        const sent = await stepUntil(it, async () => {
            const ops = await f.vault.getGetOps();
            return [...ops.values()].some((o) => o.kind === 4n);
        });
        expect(sent).toBe(true);
        await f.wait(86400 + 10);
        const ub = await f.usdtBal(f.alice.address);
        const rest = await drain(it);
        const v = await f.data();
        expect(v.workerActive).toBe(false);
        expect(v.opCount).toBe(0n);
        // a failed receipt, then the retry's successful one
        const receipts = rest.filter((tx) => tx.inMessage?.body.beginParse().preloadUint(32) === OPD.BurnReceipt &&
            tx.inMessage?.info.dest instanceof Address && tx.inMessage.info.dest.equals(f.vault.address));
        expect(receipts.length).toBeGreaterThanOrEqual(2);
        const ps = await f.poolState();
        let p1 = 0n;
        split.dL.forEach((dL, i) => {
            if (dL > 0n) p1 += M.amountsForLiquidity(Number(ps.tick), ps.sqrtPriceX96, Number(sn.pos[i].tL), Number(sn.pos[i].tU), dL, false).b;
        });
        // (the idle share is sent in the same transaction as the first decrease, so it lands after `ub`)
        expect((await f.usdtBal(f.alice.address)) - ub).toBe(split.u + p1);
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();
    });

    it('collected fees that arrive BEFORE their receipt (cross-shard order) are counted once, with the performance fee', async () => {
        const f = await ready();
        for (let i = 0; i < 4; i++) {
            expectNoFailures(await f.swapGram(f.carol, 30n * GRAM_1));
            expectNoFailures(await f.swapUsdt(f.carol, 90n * USDT));
        }
        const s = await f.shares(f.alice.address);
        const sn = await f.snap();
        const split = f.modelSplit(sn, s / 2n);
        const w = await f.shareWallet(f.alice.address);
        const { it } = await stepParallel(f.chain, msg(f.alice.address, w.address, WITHDRAW_GAS + toNano('0.1'), burnOf(s / 2n)), 0);
        // Run until the Pool executes the COLLECT; keep its out-messages and deliver them by hand:
        // the payouts first (all the way to the vault), the Position's sync (-> receipt) last.
        let poolTx: any = null;
        for (let i = 0; i < 200 && !poolTx; i++) {
            const r = await it.next();
            if (r.done) break;
            const tx = r.value;
            const d = tx.inMessage?.info.dest;
            const b = tx.inMessage?.body.beginParse();
            if (d instanceof Address && d.equals(f.pool.address) && b && b.remainingBits >= 96 && b.preloadUint(32) === 0x4d48004a) {
                const q = b.clone().skip(32).loadUintBig(64);
                const o = (await f.vault.getGetOps()).get(q);
                if (o && o.kind === 3n) poolTx = tx;
            }
        }
        expect(poolTx).not.toBeNull();
        const outs = [...poolTx.outMessages.values()].filter((m: any) => m.info.type === 'internal');
        const opOf = (m: any) => m.body.beginParse().preloadUint(32);
        const sync = outs.find((m: any) => opOf(m) === 0x4d48004b);
        const payouts = outs.filter((m: any) => m !== sync);
        for (const m of payouts) expectNoFailures(await f.chain.sendMessage(m));
        let v = await f.data();
        expect(v.exp0 + v.exp1).toBeLessThan(0n);         // arrived, not yet announced
        const ub = await f.usdtBal(f.alice.address);
        expectNoFailures(await f.chain.sendMessage(sync));
        await drain(it);
        v = await f.data();
        expect([v.workerActive, v.opCount, v.exp0, v.exp1, v.owe0, v.owe1]).toEqual([false, 0n, 0n, 0n, 0n, 0n]);
        // the performance fee was taken exactly once on each token's fees
        expect(v.fee0 - sn.v.fee0).toBe((sn.fees[0].f0 * 1000n) / 10000n);
        expect(v.fee1 - sn.v.fee1).toBe((sn.fees[0].f1 * 1000n) / 10000n);
        // and the withdrawer got exactly the model's share (idle incl. net fees + principal)
        const ps = await f.poolState();
        let p1 = 0n;
        split.dL.forEach((dL, i) => {
            if (dL > 0n) p1 += M.amountsForLiquidity(Number(ps.tick), ps.sqrtPriceX96, Number(sn.pos[i].tL), Number(sn.pos[i].tU), dL, false).b;
        });
        expect((await f.usdtBal(f.alice.address)) - ub).toBe(split.u + p1);
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();
    });

    it('a withdrawal whose collected fees never arrive is not blocked: after PAYOUT_WAIT a Poke proceeds', async () => {
        const f = await ready();
        for (let i = 0; i < 3; i++) expectNoFailures(await f.swapUsdt(f.carol, 90n * USDT));
        const s = await f.shares(f.alice.address);
        const w = await f.shareWallet(f.alice.address);
        const { it } = await stepParallel(f.chain, msg(f.alice.address, w.address, WITHDRAW_GAS + toNano('0.1'), burnOf(s)), 0);
        // drop the collect's payouts: deliver only the Position sync
        let poolTx: any = null;
        for (let i = 0; i < 200 && !poolTx; i++) {
            const r = await it.next();
            if (r.done) break;
            const tx = r.value;
            const b = tx.inMessage?.body.beginParse();
            if (tx.inMessage?.info.dest instanceof Address && tx.inMessage.info.dest.equals(f.pool.address) && b && b.remainingBits >= 32 && b.preloadUint(32) === 0x4d48004a) poolTx = tx;
        }
        const sync = [...poolTx.outMessages.values()].find((m: any) => m.info.type === 'internal' && m.body.beginParse().preloadUint(32) === 0x4d48004b);
        expectNoFailures(await f.chain.sendMessage(sync as any));
        expect((await f.data()).workerActive).toBe(true);        // waiting for the fee payouts
        await f.wait(601);
        expectNoFailures(await f.poke(f.bob));
        const v = await f.data();
        expect(v.workerActive).toBe(false);
        expect(await f.shares(f.alice.address)).toBe(0n);
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();
    });

    it('deposits are priced at the worse of TWAP and spot (no stale-TWAP arbitrage)', async () => {
        const f = await ready();
        const start = (await f.poolState()).tick;
        await f.moveTo(start - 80n);                    // a real move inside the deviation band
        const sn = await f.snap();
        const ov = f.modelView(sn);
        expect(ov.spot).toBeLessThan(ov.twap);
        const M2 = await import('./model');
        const x0 = sn.v.idle0 + sn.v.exp0 - sn.v.owe0;
        const x1 = sn.v.idle1 + sn.v.exp1 - sn.v.owe1;
        const atTwap = M2.quoteShares(10n * GRAM_1, 0n, ov.twap, ov.twap, M.sqrtAt(Number(ov.twap)), sn.v.supply, x0, x1, sn.pos, sn.fees, 1000n);
        const quoted = f.modelShares(sn, 10n * GRAM_1, 0n);
        expect(quoted).toBeLessThan(atTwap);
        const before = await f.shares(f.bob.address);
        const r = await f.depositGram(f.bob, 10n * GRAM_1);
        expectNoFailures(r);
        expect(refusals(r)).toEqual([]);
        expect((await f.shares(f.bob.address)) - before).toBe(quoted);
    });
});
