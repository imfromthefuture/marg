import { Address, beginCell, toNano } from '@ton/core';
import { refusals, stepParallel, VaultFx, GRAM_1, USDT, PHASE, SPACING, REBALANCE_GAS, WITHDRAW_GAS, expectNoFailures, gramPaidTo, vaultFailures, OPV } from './fixture';
import { stepN, drain, msg, exitCodes } from '../../dex/v2/tests/helpers';
import { Vault, Vault_errors, storeRebalance, loadRebalanceEvent } from '../build/Vault_Vault';
import { events } from '../../dex/v2/tests/helpers';
import * as M from '../../dex/v2/tests/model';

const floorS = (t: bigint, s: bigint) => {
    const q = t / s;
    return (t % s !== 0n && t < 0n ? q - 1n : q) * s;
};

function errOf(name: string) {
    const e: any = Vault_errors;
    const k = Object.keys(e).find((x) => e[x]?.message === name);
    if (!k) throw new Error('no error ' + name);
    return Number(k);
}

// RebalanceEvent stage 5 codes: 1 not ready, 2 deviation, 3 not needed, 4 stale, 5 no pool.
function refusedWith(res: any) {
    return events(res).filter((e) => e.op === OPV.RebalanceEvent).map((e) => loadRebalanceEvent(e.body.clone()))
        .filter((e) => e.stage === 5n).map((e) => Number(e.code));
}

async function opened() {
    const f = await VaultFx.create();
    await f.wait(1900);
    return f;
}

describe('rebalance', () => {
    it('past the threshold: closes, then mints a new base around the TWAP and a limit with the leftovers', async () => {
        const f = await opened();
        const start = (await f.poolState()).tick;
        await f.moveTo(start - 700n);
        await f.warm(4000);
        const sn = await f.snap();
        const ov = f.modelView(sn);
        expect(ov.ready).toBe(true);
        const oldIdx = sn.pos.map((p) => p.index);
        const kb = await f.gram(f.keeper.address);
        const res = await f.rebalance();
        expectNoFailures(res);
        const v = await f.data();
        expect(v.phase).toBe(PHASE.IDLE);
        expect(v.rebStep).toBe(0n);
        expect(v.exp0).toBe(0n);
        expect(v.exp1).toBe(0n);
        const pos = await f.positions();
        const base = pos.find((p) => p.slot === 0)!;
        expect(base.tL).toBe(floorS(ov.twap - 1200n, SPACING));
        expect(base.tU).toBe(floorS(ov.twap + 1200n, SPACING) + SPACING);
        expect(pos.length).toBe(2);         // base + limit
        const lim = pos.find((p) => p.slot === 1)!;
        expect(lim.tL >= floorS(ov.twap + 100n, SPACING) + SPACING || lim.tU <= floorS(ov.twap - 100n, SPACING)).toBe(true);
        for (const i of oldIdx) {
            expect((await (await f.position(i)).getGetPositionData()).liquidity).toBe(0n);
        }
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();
        // keeper paid only the real cost (well under a tenth of what it attached)
        expect(kb - (await f.gram(f.keeper.address))).toBeLessThan(toNano('1.5'));   // mostly DEX tick fees (0.12/new tick)
        expect(v.lastRebalance).toBe(BigInt(f.now));
    });

    it('out of range: the vault ends up single-sided and deploys it as a limit range', async () => {
        const f = await opened();
        const p0 = (await f.positions())[0];
        await f.moveTo(p0.tL - 200n);
        expect((await f.poolState()).tick).toBeLessThan(p0.tL);
        await f.warm(4000);
        expectNoFailures(await f.rebalance());
        const pos = await f.positions();
        const v = await f.data();
        expect(v.phase).toBe(PHASE.IDLE);
        expect(pos.length).toBeGreaterThanOrEqual(1);
        const spot = (await f.poolState()).tick;
        // all-Gram after the move: the Gram is deployed above the price (single-sided)
        const lim = pos.find((p) => p.slot === 1)!;
        expect(lim.tL).toBeGreaterThan(spot);
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();
    });

    it('is refused when not needed, too soon, by a non-keeper, or with too little gas; allowed after the cooldown', async () => {
        const f = await opened();
        const kb = await f.gram(f.keeper.address);
        const nn = await f.rebalance();
        expectNoFailures(nn);
        expect(refusedWith(nn)).toEqual([3]);           // checked on its own fresh observation
        expect((await f.data()).phase).toBe(PHASE.IDLE);
        expect(kb - (await f.gram(f.keeper.address))).toBeLessThan(toNano('0.1'));   // budget refunded
        await f.wait(86400);
        const low = await f.rebalance(undefined, REBALANCE_GAS - toNano('0.01'));
        expect(low.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        // keeper role
        expectNoFailures(await f.vault.send(f.admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetKeeper', queryId: 1n, keeper: f.keeper.address }));
        const other = await f.rebalance(f.alice);
        expect(other.transactions).toHaveTransaction({ to: f.vault.address, success: false, exitCode: errOf('Not keeper') });
        const ok = await f.rebalance(f.keeper);     // cooldown elapsed: periodic recompounding
        expectNoFailures(ok);
        expect(refusedWith(ok)).toEqual([]);
        const soon = await f.rebalance(f.keeper);
        expect(soon.transactions).toHaveTransaction({ to: f.vault.address, success: false, exitCode: errOf('Too soon') });
        // audit L-2: no keeper means admin only (never permissionless: no Rebalance spam)
        expectNoFailures(await f.vault.send(f.admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetKeeper', queryId: 1n, keeper: null }));
        await f.wait(86400);
        const spam = await f.rebalance(f.alice);
        expect(spam.transactions).toHaveTransaction({ to: f.vault.address, success: false, exitCode: errOf('Not keeper') });
        const r2 = await f.rebalance(f.admin);
        expectNoFailures(r2);
        expect(refusedWith(r2)).toEqual([]);
        await f.expectPositionsMatchNfts();
    });

    it('needs TWAP history: without an anchor at least one window old it is refused (not ready)', async () => {
        const f = await VaultFx.create({ poke: false });
        await f.wait(86400);
        const r = await f.rebalance();
        expectNoFailures(r);
        expect(refusedWith(r)).toEqual([1]);            // its own observation is the first anchor
        await f.wait(1900);
        const r2 = await f.rebalance();
        expectNoFailures(r2);
        expect(refusedWith(r2)).toEqual([]);
    });

    it('TWAP guard: a manipulated spot blocks rebalances and deposits until the price is real for a window', async () => {
        const f = await opened();
        await f.wait(86400);                               // cooldown passed: a rebalance would be allowed
        const start = (await f.poolState()).tick;
        await f.moveTo(start - 400n);                      // attacker pushes the price in this block
        const rb = await f.rebalance();
        expectNoFailures(rb);
        expect(refusedWith(rb)).toEqual([2]);
        const dg = await f.depositGram(f.alice, 10n * GRAM_1);
        expectNoFailures(dg);
        expect(refusals(dg)).toEqual([2]);
        expect(await f.shares(f.alice.address)).toBe(0n);
        const ub = await f.usdtBal(f.bob.address);
        await f.depositUsdt(f.bob, 50n * USDT);
        expect(await f.usdtBal(f.bob.address)).toBe(ub);   // refunded
        expect(await f.vault.getGetPreviewDeposit(0n, 50n * USDT)).toBe(0n);
        // the attacker cannot leave the price there for free: once it held for a full window it is the price
        await f.wait(4000);
        expectNoFailures(await f.poke());
        expect((await f.vault.getGetOracle()).twapTick).toBeLessThan(start - 300n);
        const ok = await f.rebalance();
        expectNoFailures(ok);
        expect(refusedWith(ok)).toEqual([]);
        expectNoFailures(await f.depositGram(f.alice, 10n * GRAM_1));
        expect(await f.shares(f.alice.address)).toBeGreaterThan(0n);
    });

    it('compounds fees: both tokens\' fees arrive notified and are counted without any claim; 10% performance fee to the treasury', async () => {
        const f = await opened();
        expectNoFailures(await f.vault.send(f.admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetTreasury', queryId: 1n, treasury: f.treasury.address }));
        for (let i = 0; i < 6; i++) {
            expectNoFailures(await f.swapGram(f.carol, 40n * GRAM_1));
            expectNoFailures(await f.swapUsdt(f.carol, 120n * USDT));
        }
        await f.wait(86400);
        const p = (await f.positions())[0];
        const nft = await (await f.position(p.index)).getGetPositionData();
        const pa = await f.pool.getGetPositionAmounts(nft.tickLower, nft.tickUpper, nft.liquidity, nft.fgLast0, nft.fgLast1, nft.liquidity);
        expect(pa.fees0).toBeGreaterThan(0n);
        expect(pa.fees1).toBeGreaterThan(0n);
        const before = await f.data();
        const res = await f.rebalance();
        expectNoFailures(res);
        const after = await f.data();
        expect(after.fee0 - before.fee0).toBe((pa.fees0 * 1000n) / 10000n);
        expect(after.fee1 - before.fee1).toBe((pa.fees1 * 1000n) / 10000n);
        expect([after.exp0, after.exp1, after.owe0, after.owe1]).toEqual([0n, 0n, 0n, 0n]);
        await f.expectSolvent();
        // treasury collects (anyone may trigger)
        const tb = await f.usdtBal(f.treasury.address);
        const c = await f.vault.send(f.alice.getSender(), { value: toNano('0.3') }, { $$type: 'CollectFees', queryId: 1n });
        expectNoFailures(c);
        expect(gramPaidTo(c, f.treasury.address, 2)).toBe(after.fee0);
        expect((await f.usdtBal(f.treasury.address)) - tb).toBe(after.fee1);
        const z = await f.data();
        expect(z.fee0).toBe(0n);
        expect(z.fee1).toBe(0n);
        await f.expectSolvent();
    });

    it('deposits during a rebalance are refused, withdrawals are queued and run when it ends', async () => {
        const f = await opened();
        expectNoFailures(await f.depositUsdt(f.bob, 300n * USDT, 100n * GRAM_1));
        await f.wait(86400);
        const body = beginCell().store(storeRebalance({ $$type: 'Rebalance', queryId: 1n })).endCell();
        const { it } = await stepN(f.chain, msg(f.keeper.address, f.vault.address, REBALANCE_GAS + toNano('0.1'), body), 2);
        expect((await f.data()).phase).toBe(PHASE.REB);
        // A deposit sent now reaches the vault while it is rebalancing (global FIFO queue).
        const dep = await f.depositGram(f.alice, 10n * GRAM_1);
        const depTx = dep.transactions.filter((tx) => {
            const b = tx.inMessage?.body.beginParse();
            return tx.inMessage?.info.dest instanceof Address && tx.inMessage.info.dest.equals(f.vault.address) &&
                b && b.remainingBits >= 32 && b.preloadUint(32) === 0x56410004;
        });
        expect(depTx.length).toBe(1);
        expect((depTx[0].description as any).computePhase.success).toBe(false);
        expect(await f.shares(f.alice.address)).toBe(0n);
        await drain(it);
        expect((await f.data()).phase).toBe(PHASE.IDLE);

        // Withdrawal mid-rebalance: queued, then executed automatically at the end.
        await f.wait(86400);
        const { it: it2 } = await stepN(f.chain, msg(f.keeper.address, f.vault.address, REBALANCE_GAS + toNano('0.1'), body), 2);
        const sb = await f.shares(f.bob.address);
        const ub = await f.usdtBal(f.bob.address);
        const wd = await f.withdraw(f.bob, sb);
        expectNoFailures(wd);
        await drain(it2);
        const v = await f.data();
        expect(v.phase).toBe(PHASE.IDLE);
        expect(v.queueLength).toBe(0n);
        expect(v.workerActive).toBe(false);
        expect(await f.shares(f.bob.address)).toBe(0n);
        expect(await f.usdtBal(f.bob.address)).toBeGreaterThan(ub);
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();
    });

    it('a stalled rebalance can be aborted by anyone after the timeout; late messages still reconcile', async () => {
        const f = await opened();
        await f.wait(86400);
        const body = beginCell().store(storeRebalance({ $$type: 'Rebalance', queryId: 1n })).endCell();
        const { it } = await stepParallel(f.chain, msg(f.keeper.address, f.vault.address, REBALANCE_GAS + toNano('0.1'), body), 0);
        // run until the closes are sent, then stall the rest of the trace
        for (let i = 0; i < 40; i++) {
            const ops = await f.vault.getGetOps();
            if ([...ops.values()].some((o) => o.kind === 2n)) break;
            await it.next();
        }
        expect([...(await f.vault.getGetOps()).values()].some((o) => o.kind === 2n)).toBe(true);
        const early = await f.vault.send(f.alice.getSender(), { value: toNano('0.1') }, { $$type: 'AbortRebalance', queryId: 1n });
        expect(early.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        await f.wait(1801);
        const kb = await f.gram(f.keeper.address);
        const ab = await f.vault.send(f.alice.getSender(), { value: toNano('0.1') }, { $$type: 'AbortRebalance', queryId: 1n });
        expectNoFailures(ab);
        expect((await f.data()).phase).toBe(PHASE.IDLE);
        expect(await f.gram(f.keeper.address)).toBeGreaterThan(kb + toNano('2'));   // budget refunded
        await drain(it);
        // the closes landed after the abort: positions gone, both legs credited on arrival (notified)
        const v = await f.data();
        expect([v.exp0, v.exp1, v.opCount]).toEqual([0n, 0n, 0n]);
        expect((await f.positions()).length).toBe(0);
        await f.expectSolvent();
        // the vault is fully usable again: in-kind withdrawal of idle funds, deposits, rebalance
        await f.wait(60);
        expectNoFailures(await f.withdraw(f.admin, (await f.shares(f.admin.address)) / 2n));
        expectNoFailures(await f.rebalance());
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();
    });
});
