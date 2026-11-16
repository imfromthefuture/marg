// Seeded random operations against the real DEX. After every operation:
//  - solvency: accounted USDT (idle1 + fee1) <= the vault's USDT wallet; owed Gram <= the vault's balance;
//  - the vault's positions equal the NFTs' real liquidity, nothing in flight, phase IDLE;
//  - deposits mint exactly the reference-model shares; withdrawals pay exactly shares/supply of idle and
//    of every position (no user can extract more than their pro-rata claim);
//  - NAV per share (reference model at the pool's current price, uncollected fees included) never
//    decreases for the remaining holders because of someone else's deposit or withdrawal.
// At the end everyone exits; only the dead shares' dust remains.

import { BlockchainTransaction, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { Address, toNano } from '@ton/core';
import { VaultFx, GRAM_1, USDT, PHASE, DEAD_SHARES, gramPaidTo, txOk } from './fixture';
import { gramPayouts, REASON, rng } from '../../dex/v2/tests/helpers';
import * as M from '../../dex/v2/tests/model';
import { priceQ64, valueOf, navAt } from './model';

// v3 burns round each leg down: amounts(dL) + amounts(L - dL) can be one unit per token below
// amounts(L). That dust stays in the Pool (nobody gets it); allow it per operation.
const ROUNDING = 3n << 64n;
const OPS_REFUSABLE = new Set([0x56410004, 0x56410005]);

function checkTxs(f: VaultFx, res: SendMessageResult, label: string) {
    const bad = res.transactions.filter((tx: BlockchainTransaction) => {
        if (txOk(tx)) return false;
        const d = tx.inMessage?.info.dest;
        const b = tx.inMessage?.body.beginParse();
        const op = b && b.remainingBits >= 32 ? b.preloadUint(32) : -1;
        if (d instanceof Address && d.equals(f.vault.address) && OPS_REFUSABLE.has(op)) return false;   // vault refusal (bounces)
        return true;
    });
    if (bad.length) {
        for (const tx of bad) {
            const cp: any = (tx.description as any).computePhase;
            // eslint-disable-next-line no-console
            const b = tx.inMessage?.body.beginParse();
            console.log(label, 'unexpected failure at', tx.inMessage?.info.dest?.toString(), 'exit', cp?.exitCode,
                'action', (tx.description as any).actionPhase?.resultCode,
                'op', b && b.remainingBits >= 32 ? b.preloadUint(32).toString(16) : '-',
                'value', tx.inMessage?.info.type === 'internal' ? tx.inMessage.info.value.coins : '-');
        }
    }
    expect(bad.length).toBe(0);
}

// Reference NAV at the pool's current price (positions, uncollected fees net of the perf fee).
async function navPerShare(f: VaultFx) {
    const sn = await f.snap();
    const nav = navAt(sn.ps.tick, sn.ps.sqrtPriceX96, sn.v.idle0 + sn.v.exp0 - sn.v.owe0, sn.v.idle1 + sn.v.exp1 - sn.v.owe1,
        sn.pos, sn.fees, sn.v.strategy.perfFeeBps);
    return { nav, supply: sn.v.supply };
}

describe('random invariant run', () => {
    it('220 seeded operations: solvency, exact pro-rata, no value extraction', async () => {
        const f = await VaultFx.create();
        const seed = Number(process.env.VAULT_SEED ?? 20261112);
        const r = rng(seed);
        let rebalances = 0;
        const users: SandboxContract<TreasuryContract>[] = [f.alice, f.bob, f.carol];
        await f.wait(2000);
        const counts: Record<string, number> = {};
        const N = 220;
        for (let step = 0; step < N; step++) {
            const roll = r.next();
            let kind: string;
            if (roll < 0.14) kind = 'depGram';
            else if (roll < 0.28) kind = 'depUsdt';
            else if (roll < 0.36) kind = 'depBoth';
            else if (roll < 0.52) kind = 'withdraw';
            else if (roll < 0.66) kind = 'swapGram';
            else if (roll < 0.80) kind = 'swapUsdt';
            else if (roll < 0.93) kind = 'rebalance';
            else if (roll < 0.96) kind = 'time';
            else if (roll < 0.975) kind = 'donate';
            else if (roll < 0.99) kind = 'poke';
            else kind = 'collect';
            counts[kind] = (counts[kind] ?? 0) + 1;
            const label = `#${step} ${kind}`;
            const who = r.pick(users);

            if (kind === 'depGram' || kind === 'depUsdt' || kind === 'depBoth') {
                const a0 = kind === 'depUsdt' ? 0n : r.big(GRAM_1 / 10n, 80n * GRAM_1);
                const a1 = kind === 'depGram' ? 0n : r.big(USDT / 10n, 250n * USDT);
                const sn = await f.snap();
                const ov = f.modelView(sn);
                const okNow = ov.ready && (ov.spot - ov.twap <= sn.v.strategy.maxDeviation && ov.twap - ov.spot <= sn.v.strategy.maxDeviation);
                const expected = okNow ? f.modelShares(sn, a0, a1) : 0n;
                const before = await f.shares(who.address);
                const nb = await navPerShare(f);
                const res = a1 === 0n ? await f.depositGram(who, a0) : await f.depositUsdt(who, a1, a0);
                checkTxs(f, res, label);
                const got = (await f.shares(who.address)) - before;
                expect(got).toBe(expected);
                const na = await navPerShare(f);
                expect((na.nav + ROUNDING) * nb.supply).toBeGreaterThanOrEqual(nb.nav * na.supply);
            } else if (kind === 'withdraw') {
                const bal = await f.shares(who.address);
                if (bal === 0n) continue;
                const s = r.next() < 0.3 ? bal : r.big(1n, bal);
                const sn = await f.snap();
                const split = f.modelSplit(sn, s);
                const ps = await f.poolState();
                let p0 = 0n;
                let p1 = 0n;
                split.dL.forEach((dL, i) => {
                    if (dL === 0n) return;
                    const am = M.amountsForLiquidity(Number(ps.tick), ps.sqrtPriceX96, Number(sn.pos[i].tL), Number(sn.pos[i].tU), dL, false);
                    p0 += am.a;
                    p1 += am.b;
                });
                const nb = await navPerShare(f);
                const ub = await f.usdtBal(who.address);
                const res = await f.withdraw(who, s);
                checkTxs(f, res, label);
                expect(gramPaidTo(res, who.address, 1)).toBe(split.g);
                const fromPool = gramPayouts(res, who.address).filter((g) => g.reason === REASON.POSITION_OUT).reduce((a, g) => a + g.amount, 0n);
                expect(fromPool).toBe(p0);
                expect((await f.usdtBal(who.address)) - ub).toBe(split.u + p1);
                const na = await navPerShare(f);
                expect((na.nav + ROUNDING) * nb.supply).toBeGreaterThanOrEqual(nb.nav * na.supply);
                // the payout never exceeds the pro-rata value of the shares (same price as the NAV)
                const pSpot = priceQ64(ps.sqrtPriceX96);
                const paid = valueOf(split.g + p0, split.u + p1, pSpot);
                expect(paid * nb.supply).toBeLessThanOrEqual(nb.nav * s + ROUNDING * nb.supply);
            } else if (kind === 'swapGram') {
                const res = await f.swapGram(f.mallory, r.big(GRAM_1, 150n * GRAM_1), { allowPartial: true });
                checkTxs(f, res, label);
            } else if (kind === 'swapUsdt') {
                const res = await f.swapUsdt(f.mallory, r.big(USDT, 450n * USDT), { allowPartial: true });
                checkTxs(f, res, label);
            } else if (kind === 'rebalance') {
                // refresh the anchor and let the TWAP settle (or the cooldown pass) so many attempts run
                checkTxs(f, await f.poke(), label);
                await f.wait(r.next() < 0.6 ? 2000 : 86400);
                const lr = (await f.data()).lastRebalance;
                const res = await f.rebalance(f.keeper);
                checkTxs(f, res, label);
                if ((await f.data()).lastRebalance !== lr) rebalances += 1;
            } else if (kind === 'time') {
                await f.wait(r.next() < 0.15 ? 86400 : r.int(5, 7200));
            } else if (kind === 'donate') {
                // a swap output sent to the vault through the DEX (notified): surplus for the holders
                const nb = await navPerShare(f);
                const res = r.next() < 0.5
                    ? await f.swapGram(f.mallory, r.big(GRAM_1 / 10n, 5n * GRAM_1), { receiver: f.vault.address, fwdTon: toNano('0.02'), allowPartial: true })
                    : await f.swapUsdt(f.mallory, r.big(USDT / 10n, 15n * USDT), { receiver: f.vault.address, allowPartial: true });
                checkTxs(f, res, label);
                const v1 = await f.data();
                expect(v1.idle0 + v1.idle1).toBeGreaterThanOrEqual(0n);
                expect(nb.supply).toBe(v1.supply);
            } else if (kind === 'poke') {
                checkTxs(f, await f.poke(who), label);
            } else {
                const res = await f.vault.send(f.carol.getSender(), { value: toNano('0.3') }, { $$type: 'CollectFees', queryId: 1n });
                checkTxs(f, res, label);
            }

            if (process.env.VAULT_TRACE) {
                const vv = await f.data();
                const bal1 = await f.usdtBal(f.vault.address);
                // eslint-disable-next-line no-console
                console.log(label, 'idle1', vv.idle1, 'fee1', vv.fee1, 'exp1', vv.exp1, 'wallet', bal1, 'slack', bal1 - vv.idle1 - vv.fee1);
            }
            const v = await f.data();
            expect(v.phase).toBe(PHASE.IDLE);
            expect(v.workerActive).toBe(false);
            expect(v.queueLength).toBe(0n);
            expect(v.exp0).toBe(0n);
            expect(v.exp1).toBe(0n);
            expect([v.opCount, v.depCount, v.pendGram, v.pendUsdt, v.owe0, v.owe1]).toEqual([0n, 0n, 0n, 0n, 0n, 0n]);
            await f.expectSolvent();
            await f.expectPositionsMatchNfts();
        }
        // eslint-disable-next-line no-console
        console.log('seed', seed, 'operation mix', counts, 'rebalances executed', rebalances);
        expect(N).toBeGreaterThanOrEqual(200);
        expect(rebalances).toBeGreaterThanOrEqual(5);

        // Everyone exits. Only the dead shares remain, with their pro-rata dust.
        const navBefore = await navPerShare(f);
        for (const u of [f.alice, f.bob, f.carol, f.admin]) {
            const s = await f.shares(u.address);
            if (s > 0n) {
                const res = await f.withdraw(u, s);
                checkTxs(f, res, 'exit');
            }
        }
        const v = await f.data();
        expect(v.supply).toBe(DEAD_SHARES);
        const navAfter = await navPerShare(f);
        // dust = what the dead shares own (+ rounding in the vault's favour)
        expect(navAfter.nav).toBeLessThanOrEqual((navBefore.nav * DEAD_SHARES) / navBefore.supply * 2n + (1000n << 64n));
        await f.expectSolvent();
        await f.expectPositionsMatchNfts();
    }, 1_800_000);
});
