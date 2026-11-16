// Deposits are accepted, observed (one PoolObserve per live position, sent AFTER the deposit
// arrived) and priced when their own observation round is in: min(TWAP quote, spot quote), NAV
// including uncollected fees (feeGrowthInside), deviation guard. Refusals refund both legs.

import { Address, beginCell, toNano } from '@ton/core';
import { refusals, VaultFx, GRAM_1, USDT, PHASE, DEPOSIT_GAS, PAYOUT, OPV, OPD, expectNoFailures, eitherRef, vaultFailures, gramPaidTo } from './fixture';
import * as VM from './model';

async function ready() {
    const f = await VaultFx.create();
    await f.swapGram(f.carol, 3n * GRAM_1);        // some price action so the oracle has a path
    await f.wait(3700);
    return f;
}


describe('deposits', () => {
    it('Gram only, USDT only and both: shares equal the reference model (TWAP from the pool accumulator)', async () => {
        const f = await ready();
        for (const [who, a0, a1] of [[f.alice, 50n * GRAM_1, 0n], [f.bob, 0n, 120n * USDT], [f.carol, 7n * GRAM_1, 33n * USDT]] as const) {
            const sn = await f.snap();
            const expected = f.modelShares(sn, a0, a1);
            expect(expected).toBeGreaterThan(0n);
            const before = await f.shares(who.address);
            const ub = await f.usdtBal(who.address);
            const res = a1 === 0n ? await f.depositGram(who, a0) : await f.depositUsdt(who, a1, a0);
            expectNoFailures(res);
            expect((await f.shares(who.address)) - before).toBe(expected);
            const v = await f.data();
            expect(v.idle0).toBe(sn.v.idle0 + a0);
            expect(v.idle1).toBe(sn.v.idle1 + a1);
            expect(v.supply).toBe(sn.v.supply + expected);
            expect([v.depCount, v.pendGram, v.pendUsdt]).toEqual([0n, 0n, 0n]);
            expect(ub - (await f.usdtBal(who.address))).toBe(a1);
            // the price came from a PoolObserve sent after the deposit arrived
            const obs = res.transactions.filter((tx) => tx.inMessage?.info.dest instanceof Address &&
                tx.inMessage.info.dest.equals(f.pool.address) && tx.inMessage.body.beginParse().preloadUint(32) === OPD.PoolObserve);
            expect(obs.length).toBe((await f.positions()).length);
            await f.expectSolvent();
        }
    });

    it('NAV counts uncollected fees (feeGrowthInside, net of the performance fee): a deposit pays for them', async () => {
        const f = await ready();
        for (let i = 0; i < 6; i++) {
            expectNoFailures(await f.swapGram(f.carol, 40n * GRAM_1));
            expectNoFailures(await f.swapUsdt(f.carol, 120n * USDT));
        }
        const sn = await f.snap();
        expect(sn.fees[0].f0).toBeGreaterThan(0n);
        expect(sn.fees[0].f1).toBeGreaterThan(0n);
        const expected = f.modelShares(sn, 0n, 100n * USDT);
        const ov = f.modelView(sn);
        const noFees = VM.quoteShares(0n, 100n * USDT, ov.twap, ov.spot, ov.spotSqrtP, sn.v.supply,
            sn.v.idle0, sn.v.idle1, sn.pos, [], 1000n);
        expect(expected).toBeLessThan(noFees);          // fees in NAV: fewer shares for the same deposit
        expectNoFailures(await f.depositUsdt(f.bob, 100n * USDT));
        expect(await f.shares(f.bob.address)).toBe(expected);
        // the vault's reading of the fees equals the pool's
        const p = (await f.positions())[0];
        expect([p.uf0, p.uf1]).toEqual([sn.fees[0].f0, sn.fees[0].f1]);
        const nav = await f.vault.getGetNav();
        expect(nav.total0).toBeGreaterThan(sn.v.idle0);
    });

    it('a deposit gets the same share price as the vault (NAV per share is preserved, rounding down)', async () => {
        const f = await ready();
        expectNoFailures(await f.depositGram(f.alice, GRAM_1));        // fresh observation for the NAV getter
        const n0 = await f.vault.getGetNav();
        await f.depositUsdt(f.bob, 500n * USDT, 100n * GRAM_1);
        const n1 = await f.vault.getGetNav();
        expect(n1.nav * n0.supply).toBeGreaterThanOrEqual(n0.nav * n1.supply);
    });

    it('minShares above the quote refunds both legs (Gram and USDT paths)', async () => {
        const f = await ready();
        const sn = await f.snap();
        const q = f.modelShares(sn, 10n * GRAM_1, 0n);
        const ga = await f.gram(f.alice.address);
        const g = await f.depositGram(f.alice, 10n * GRAM_1, q + 1n);
        expectNoFailures(g);
        expect(refusals(g)).toEqual([3]);
        expect(gramPaidTo(g, f.alice.address, PAYOUT.REFUND)).toBe(10n * GRAM_1);
        expect(ga - (await f.gram(f.alice.address))).toBeLessThan(toNano('0.2'));
        expect(await f.shares(f.alice.address)).toBe(0n);

        const ub = await f.usdtBal(f.bob.address);
        const gb = await f.gram(f.bob.address);
        const q2 = f.modelShares(sn, 2n * GRAM_1, 30n * USDT);
        const r = await f.depositUsdt(f.bob, 30n * USDT, 2n * GRAM_1, q2 + 1n);
        expectNoFailures(r);
        expect(await f.usdtBal(f.bob.address)).toBe(ub);
        expect(gb - (await f.gram(f.bob.address))).toBeLessThan(toNano('0.2'));
        expect(await f.shares(f.bob.address)).toBe(0n);
        const v = await f.data();
        expect([v.idle0, v.idle1, v.pendGram, v.pendUsdt]).toEqual([sn.v.idle0, sn.v.idle1, 0n, 0n]);
        await f.expectSolvent();
    });

    it('refused before the TWAP window has elapsed, while paused, and with too little gas; unknown payloads refunded', async () => {
        const f = await VaultFx.create();
        const idle1Start = (await f.data()).idle1;
        const early = await f.depositGram(f.alice, GRAM_1);
        expectNoFailures(early);
        expect(refusals(early)).toEqual([2]);              // oracle not ready
        expect(gramPaidTo(early, f.alice.address, PAYOUT.REFUND)).toBe(GRAM_1);
        await f.wait(3700);
        const pause = await f.vault.send(f.admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetDepositsPaused', queryId: 1n, paused: true });
        expectNoFailures(pause);
        const p1 = await f.depositGram(f.alice, GRAM_1);
        expect(p1.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        const ub = await f.usdtBal(f.bob.address);
        await f.depositUsdt(f.bob, 10n * USDT);
        expect(await f.usdtBal(f.bob.address)).toBe(ub);
        await f.vault.send(f.admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetDepositsPaused', queryId: 1n, paused: false });
        // low gas: forward value below DEPOSIT_GAS but enough to refund
        await f.sendUsdt(f.bob, 10n * USDT, toNano('0.1'), f.depositPayload(0n));
        expect(await f.usdtBal(f.bob.address)).toBe(ub);
        const lowNative = await f.vault.send(f.alice.getSender(), { value: GRAM_1 + DEPOSIT_GAS - 1n }, {
            $$type: 'DepositNative', queryId: 1n, amount: GRAM_1, minShares: 0n, receiver: null,
        });
        expect(lowNative.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        // unknown payload: refunded
        await f.sendUsdt(f.bob, 10n * USDT, toNano('0.2'), eitherRef(beginCell().storeUint(0xdeadbeef, 32).endCell()));
        expect(await f.usdtBal(f.bob.address)).toBe(ub);
        expect((await f.data()).idle1).toBe(idle1Start);
        await f.expectSolvent();
    });

    it('a deposit to a different receiver, and share transfers between holders', async () => {
        const f = await ready();
        const p = eitherRef(beginCell().store((await import('../build/Vault_Vault')).storeDepositPayload({
            $$type: 'DepositPayload', gramAmount: 0n, minShares: 0n, receiver: f.carol.address,
        })).endCell());
        expectNoFailures(await f.sendUsdt(f.bob, 100n * USDT, DEPOSIT_GAS + toNano('0.05'), p));
        const s = await f.shares(f.carol.address);
        expect(s).toBeGreaterThan(0n);
        const w = await f.shareWallet(f.carol.address);
        const tr = await w.send(f.carol.getSender(), { value: toNano('0.1') }, {
            $$type: 'JettonTransfer', queryId: 1n, amount: s / 3n, destination: f.alice.address,
            responseDestination: f.carol.address, customPayload: null, forwardTonAmount: 0n,
            forwardPayload: beginCell().storeBit(0).endCell().beginParse(),
        });
        expectNoFailures(tr);
        expect(await f.shares(f.alice.address)).toBe(s / 3n);
        expect(await f.shares(f.carol.address)).toBe(s - s / 3n);
        const jd = await f.vault.getGetJettonData();
        expect(jd.totalSupply).toBe((await f.data()).supply);
    });

    it('USDT notifications that do not come from the vault wallet are ignored (no credit, no refund)', async () => {
        const f = await ready();
        const sn = await f.snap();
        const { storeJettonNotification } = await import('../build/Vault_Vault') as any;
        const body = beginCell().store(storeJettonNotification({
            $$type: 'JettonNotification', queryId: 1n, amount: 1_000_000n * USDT, sender: f.mallory.address,
            forwardPayload: f.depositPayload(0n),
        })).endCell();
        const r = await f.mallory.send({ to: f.vault.address, value: toNano('0.5'), body });
        expect(vaultFailures(r, f.vault.address).length).toBe(0);
        expect(await f.shares(f.mallory.address)).toBe(0n);
        expect((await f.data()).idle1).toBe(sn.v.idle1);
    });
});
