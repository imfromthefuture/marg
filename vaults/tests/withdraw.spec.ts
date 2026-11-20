import { Address, toNano } from '@ton/core';
import { VaultFx, GRAM_1, USDT, PHASE, WITHDRAW_GAS, expectNoFailures, gramPaidTo, vaultFailures } from './fixture';
import { gramPayouts, REASON, stepN, drain, msg } from '../../dex/v2/tests/helpers';
import * as M from '../../dex/v2/tests/model';
import * as M2 from './model';

async function withHolders() {
    const f = await VaultFx.create();
    await f.swapGram(f.carol, 3n * GRAM_1);
    await f.wait(3700);
    expectNoFailures(await f.depositUsdt(f.alice, 600n * USDT, 200n * GRAM_1));
    expectNoFailures(await f.depositUsdt(f.bob, 300n * USDT, 0n));
    return f;
}

// Exact in-kind payout of a withdrawal processed immediately (no swaps in between): the positions'
// fees are collected first (net of the performance fee they join idle), then shares/supply of idle
// is paid by the vault and shares/supply of every position's liquidity by the Pool.
async function expectProRata(f: VaultFx, who: any, shares: bigint) {
    const sn = await f.snap();
    const split = f.modelSplit(sn, shares);
    const ps = await f.poolState();
    let p0 = 0n;
    let p1 = 0n;
    split.dL.forEach((dL, i) => {
        if (dL === 0n) return;
        const am = M.amountsForLiquidity(Number(ps.tick), ps.sqrtPriceX96, Number(sn.pos[i].tL), Number(sn.pos[i].tU), dL, false);
        p0 += am.a;
        p1 += am.b;
    });
    const ub = await f.usdtBal(who.address);
    const res = await f.withdraw(who, shares);
    expectNoFailures(res);
    // audit H-1/H-2: the Pool pays the vault; the vault forwards the principal (Gram as VaultPayout reason 1)
    expect(gramPaidTo(res, who.address, 1)).toBe(split.g + p0);
    expect(gramPayouts(res, who.address).filter((g) => g.reason === REASON.POSITION_OUT).length).toBe(0);
    expect((await f.usdtBal(who.address)) - ub).toBe(split.u + p1);
    const v = await f.data();
    expect(v.supply).toBe(sn.v.supply - shares);
    const perf0 = sn.fees.reduce((a, x) => a + (x.f0 * 1000n) / 10000n, 0n);
    const perf1 = sn.fees.reduce((a, x) => a + (x.f1 * 1000n) / 10000n, 0n);
    expect(v.fee0 - sn.v.fee0).toBe(perf0);
    expect(v.fee1 - sn.v.fee1).toBe(perf1);
    const pos = await f.positions();
    sn.pos.forEach((p, i) => {
        const now = pos.find((x) => x.slot === p.slot);
        expect(now ? now.L : 0n).toBe(p.L - split.dL[i]);
        if (now) expect(now.reserved).toBe(0n);
    });
    expect([v.workerActive, v.opCount, v.exp0, v.exp1, v.due0, v.due1, v.opGas]).toEqual([false, 0n, 0n, 0n, 0n, 0n, 0n]);
    await f.expectPositionsMatchNfts();
    await f.expectSolvent();
    return res;
}

describe('withdrawals', () => {
    it('pay exactly shares/supply of idle and of every position, in kind (the Pool pays the vault, the vault forwards)', async () => {
        const f = await withHolders();
        await expectProRata(f, f.alice, (await f.shares(f.alice.address)) / 3n);
        await expectProRata(f, f.bob, await f.shares(f.bob.address));
        await expectProRata(f, f.admin, (await f.shares(f.admin.address)) / 2n);
        await expectProRata(f, f.alice, await f.shares(f.alice.address));
    });

    it('fees accrued in the positions are collected first: the withdrawer gets exactly his share of them, net of the performance fee', async () => {
        const f = await withHolders();
        for (let i = 0; i < 4; i++) {
            expectNoFailures(await f.swapGram(f.carol, 20n * GRAM_1));
            expectNoFailures(await f.swapUsdt(f.carol, 60n * USDT));
        }
        const sn = await f.snap();
        expect(sn.fees[0].f0).toBeGreaterThan(0n);
        expect(sn.fees[0].f1).toBeGreaterThan(0n);
        const withFees = f.modelSplit(sn, await f.shares(f.bob.address));
        const without = M2.withdrawSplit(await f.shares(f.bob.address), sn.v.supply, sn.v.idle0, sn.v.idle1, sn.pos);
        expect(withFees.u).toBeGreaterThan(without.u);
        await expectProRata(f, f.bob, await f.shares(f.bob.address));
    });

    it('several withdrawals queue behind the worker and each is priced when it runs', async () => {
        const f = await withHolders();
        const sa = await f.shares(f.alice.address);
        const sb = await f.shares(f.bob.address);
        // Alice's burn is still being executed (stepped) when Bob's arrives: Bob waits in the queue.
        const w = await f.shareWallet(f.alice.address);
        const body = (await import('../build/Vault_VaultWallet')).storeJettonBurn;
        const { beginCell } = await import('@ton/core');
        const burn = beginCell().store(body({ $$type: 'JettonBurn', queryId: 1n, amount: sa, responseDestination: null, customPayload: null })).endCell();
        const { it: iter } = await stepN(f.chain, msg(f.alice.address, w.address, WITHDRAW_GAS + toNano('0.1'), burn), 3);
        let d = await f.data();
        expect(d.workerActive).toBe(true);
        const wb = await f.shareWallet(f.bob.address);
        const burnB = beginCell().store(body({ $$type: 'JettonBurn', queryId: 2n, amount: sb, responseDestination: null, customPayload: null })).endCell();
        // The sandbox queue is global: step until the vault has handled Bob's burn notification.
        const it2 = await f.chain.sendMessageIter(msg(f.bob.address, wb.address, WITHDRAW_GAS + toNano('0.1'), burnB));
        for (;;) {
            const r = await it2.next();
            if (r.done) break;
            const tx = r.value;
            const dst = tx.inMessage?.info.dest;
            const src = tx.inMessage?.info.src;
            if (dst instanceof Address && dst.equals(f.vault.address) && src instanceof Address && src.equals(wb.address)) break;
        }
        d = await f.data();
        expect(d.queueLength).toBe(1n);           // Bob waits: Alice's position ops are still in flight
        expect(d.workerActive).toBe(true);
        await drain(it2);
        await drain(iter);
        d = await f.data();
        expect(d.workerActive).toBe(false);
        expect(d.queueLength).toBe(0n);
        expect(await f.shares(f.bob.address)).toBe(0n);
        expect(await f.shares(f.alice.address)).toBe(0n);
        expect(d.supply).toBe((await f.shares(f.admin.address)) + 1_000_000n);
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();
    });

    it('refused (shares restored, Gram returned) on low gas or a non-basechain recipient', async () => {
        const f = await withHolders();
        const s = await f.shares(f.bob.address);
        const gb = await f.gram(f.bob.address);
        const low = await f.withdraw(f.bob, s, { value: WITHDRAW_GAS - toNano('0.1') });
        expect(low.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        expect(await f.shares(f.bob.address)).toBe(s);
        expect(gb - (await f.gram(f.bob.address))).toBeLessThan(toNano('0.05'));
        const mc = new Address(-1, Buffer.alloc(32, 1));
        const bad = await f.withdraw(f.bob, s, { recipient: mc });
        expect(bad.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        expect(await f.shares(f.bob.address)).toBe(s);
        // another basechain recipient is fine
        const ub = await f.usdtBal(f.carol.address);
        expectNoFailures(await f.withdraw(f.bob, s, { recipient: f.carol.address }));
        expect(await f.usdtBal(f.carol.address)).toBeGreaterThan(ub);
        expect(await f.shares(f.bob.address)).toBe(0n);
    });

    it('withdrawals keep working while deposits are paused', async () => {
        const f = await withHolders();
        await f.vault.send(f.admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetDepositsPaused', queryId: 1n, paused: true });
        await expectProRata(f, f.alice, await f.shares(f.alice.address));
    });

    it('a burn notification from a wallet that is not the sender\'s share wallet is refused', async () => {
        const f = await withHolders();
        const { storeJettonBurnNotification } = await import('../build/Vault_Vault');
        const { beginCell } = await import('@ton/core');
        const body = beginCell().store(storeJettonBurnNotification({
            $$type: 'JettonBurnNotification', queryId: 1n, amount: 1000n, sender: f.alice.address, responseDestination: null,
        })).endCell();
        const r = await f.mallory.send({ to: f.vault.address, value: WITHDRAW_GAS, body });
        expect(r.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        expect((await f.data()).queueLength).toBe(0n);
    });
});
