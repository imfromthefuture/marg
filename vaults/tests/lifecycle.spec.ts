// Full lifecycle with conservation checks: open -> deposits -> trading -> rebalance -> trading ->
// every holder withdraws -> performance fee collected. Per token, at the pool's current price,
// the vault's holdings (idle + fee + in flight + position principal + uncollected fees) change by
// exactly what entered or left: a deposit adds its legs, a rebalance moves value without creating
// or losing any (DEX rounding only), a withdrawal removes exactly what the withdrawer received, a
// fee collection exactly what the treasury received. At the end nothing is owed, held or stranded.

import { Address, toNano } from '@ton/core';
import { VaultFx, GRAM_1, USDT, PHASE, DEAD_SHARES, OPV, expectNoFailures, refusals, gramPaidTo, events } from './fixture';
import { loadRebalanceEvent } from '../build/Vault_Vault';

const ROUND = 10n;      // DEX rounding per token and operation (units)

describe('lifecycle', () => {
    it('deposit / rebalance / withdraw: holdings are conserved at every step; nothing is left owed or stranded', async () => {
        const f = await VaultFx.create();
        await f.swapGram(f.carol, 3n * GRAM_1);
        await f.wait(3700);
        const check = async () => {
            await f.expectSolvent();
            await f.expectPositionsMatchNfts();
            const v = await f.data();
            expect([v.opCount, v.depCount, v.queueLength, v.workerActive, v.due0, v.due1, v.opGas, v.exp0, v.exp1])
                .toEqual([0n, 0n, 0n, false, 0n, 0n, 0n, 0n, 0n]);
        };
        await check();

        // deposits: holdings grow by exactly the deposited legs
        const deps: [any, bigint, bigint][] = [[f.alice, 200n * GRAM_1, 600n * USDT], [f.bob, 0n, 300n * USDT], [f.carol, 0n, 0n]];
        for (const [who, g, u] of deps) {
            const hb = await f.holdings();
            const r = u > 0n ? await f.depositUsdt(who, u, g) : await f.depositGram(who, 150n * GRAM_1);
            expectNoFailures(r);
            expect(refusals(r)).toEqual([]);
            const ha = await f.holdings();
            expect(ha.h0 - hb.h0).toBe(u > 0n ? g : 150n * GRAM_1);
            expect(ha.h1 - hb.h1).toBe(u);
            expect(await f.shares(who.address)).toBeGreaterThan(0n);
            await check();
        }

        // trading earns fees
        for (let i = 0; i < 4; i++) {
            expectNoFailures(await f.swapGram(f.mallory, 40n * GRAM_1));
            expectNoFailures(await f.swapUsdt(f.mallory, 120n * USDT));
        }
        const sn = await f.snap();
        expect(sn.fees.some((x) => x.f0 > 0n && x.f1 > 0n)).toBe(true);

        // rebalance: the price left the base range; value is only moved (fees compounded)
        await f.moveTo((await f.poolState()).tick - 1400n);
        await f.warm(4000);
        expectNoFailures(await f.poke());
        const hb = await f.holdings();
        const oldPos = await f.positions();
        const rb = await f.rebalance();
        expectNoFailures(rb);
        const ev = events(rb).filter((e) => e.op === OPV.RebalanceEvent).map((e) => Number(loadRebalanceEvent(e.body.clone()).stage));
        expect(ev).toEqual([1, 2, 3]);
        expect((await f.data()).phase).toBe(PHASE.IDLE);
        const newPos = await f.positions();
        expect(newPos.length).toBeGreaterThan(0);
        expect(newPos.every((p) => !oldPos.some((o) => o.index === p.index))).toBe(true);
        const ha = await f.holdings();
        expect(hb.h0 - ha.h0).toBeGreaterThanOrEqual(0n);
        expect(hb.h0 - ha.h0).toBeLessThanOrEqual(ROUND);
        expect(hb.h1 - ha.h1).toBeGreaterThanOrEqual(0n);
        expect(hb.h1 - ha.h1).toBeLessThanOrEqual(ROUND);
        await check();

        // more trading on the new ranges
        for (let i = 0; i < 3; i++) {
            expectNoFailures(await f.swapUsdt(f.mallory, 90n * USDT));
            expectNoFailures(await f.swapGram(f.mallory, 30n * GRAM_1));
        }

        // every holder exits (one in two steps): holdings shrink by exactly what each received
        const exits: [any, bigint][] = [
            [f.alice, (await f.shares(f.alice.address)) / 2n],
            [f.bob, await f.shares(f.bob.address)],
            [f.carol, await f.shares(f.carol.address)],
            [f.alice, 0n],
            [f.admin, await f.shares(f.admin.address)],
        ];
        for (const [who, s0] of exits) {
            const s = s0 > 0n ? s0 : await f.shares(who.address);
            const b = await f.holdings();
            const ub = await f.usdtBal(who.address);
            const r = await f.withdraw(who, s);
            expectNoFailures(r);
            const got0 = gramPaidTo(r, who.address, 1);
            const got1 = (await f.usdtBal(who.address)) - ub;
            const a = await f.holdings();
            const d0 = b.h0 - a.h0 - got0;
            const d1 = b.h1 - a.h1 - got1;
            expect(d0 >= -ROUND && d0 <= ROUND).toBe(true);
            expect(d1 >= -ROUND && d1 <= ROUND).toBe(true);
            expect(got0 + got1).toBeGreaterThan(0n);
            await check();
        }
        expect(await f.shares(f.alice.address)).toBe(0n);
        let v = await f.data();
        expect(v.supply).toBe(DEAD_SHARES);

        // the performance fee goes to the treasury, exactly
        expect(v.fee0).toBeGreaterThan(0n);
        expect(v.fee1).toBeGreaterThan(0n);
        const treasury = v.treasury;           // the vault's treasury (the admin by default)
        const tb = await f.usdtBal(treasury);
        const hb2 = await f.holdings();
        const cf = await f.vault.send(f.carol.getSender(), { value: toNano('0.2') }, { $$type: 'CollectFees', queryId: 1n });
        expectNoFailures(cf);
        expect(gramPaidTo(cf, treasury, 2)).toBe(v.fee0);
        expect((await f.usdtBal(treasury)) - tb).toBe(v.fee1);
        const ha2 = await f.holdings();
        expect(hb2.h0 - ha2.h0).toBe(v.fee0);
        expect(hb2.h1 - ha2.h1).toBe(v.fee1);

        // the end: only the dead shares' dust is left; USDT accounting is exact (nothing stranded)
        v = await f.data();
        expect([v.fee0, v.fee1]).toEqual([0n, 0n]);
        expect(await f.usdtBal(f.vault.address)).toBe(v.idle1);
        expect(await f.gram(f.vault.address)).toBeGreaterThanOrEqual(v.idle0 + v.heldGas);
        await check();
        const n = await f.vault.getGetNav();
        expect(n.supply).toBe(DEAD_SHARES);
        expect(n.nav).toBeGreaterThan(0n);
        void Address;
    });
});
