import { Address, beginCell, Cell, toNano } from '@ton/core';
import { internal } from '@ton/sandbox';
import {
    refusals, stepParallel, VaultFx, GRAM_1, USDT, PHASE, SPACING, P0, OPD, REBALANCE_GAS, WITHDRAW_GAS, DEPOSIT_GAS,
    expectNoFailures, vaultFailures, eitherRef, GRAM,
} from './fixture';
import { drain, msg } from '../../dex/v2/tests/helpers';
import {
    Vault_errors, storePoolObservation, storeMintReceipt, storeBurnReceipt, storeGramPayout, storeRebalance, storeJettonExcesses,
    storeOpenPayload, storeDepositNative,
} from '../build/Vault_Vault';
import { storeJettonBurn } from '../build/Vault_VaultWallet';

const err = (name: string) => Number(Object.keys(Vault_errors).find((k) => (Vault_errors as any)[k].message === name));

async function ready() {
    const f = await VaultFx.create();
    await f.swapGram(f.carol, 3n * GRAM_1);
    await f.wait(3700);
    expectNoFailures(await f.depositUsdt(f.alice, 300n * USDT, 100n * GRAM_1));
    return f;
}

const obsBody = (queryId: bigint, tick: bigint, sqrtP: bigint, time: bigint, cum = 0n) => beginCell().store(storePoolObservation({
    $$type: 'PoolObservation', queryId, initialized: true, sqrtPriceX96: sqrtP, tick, liquidity: 1n, tickCumulative: cum, time,
    tickLower: 0n, tickUpper: 0n, rangeOk: false, feeGrowthInside0X128: 0n, feeGrowthInside1X128: 0n, payload: null,
})).endCell();

// Step a message's trace until `pred` holds (or it ends).
async function stepUntil(it: AsyncIterator<any>, pred: () => Promise<boolean>, max = 200) {
    for (let i = 0; i < max; i++) {
        if (await pred()) return true;
        const r = await it.next();
        if (r.done) return false;
    }
    return pred();
}

describe('forged messages', () => {
    it('observations, receipts, payouts and excesses are accepted only from the real pool / positions / wallet', async () => {
        const f = await ready();
        const sn = await f.snap();
        // a forged observation (any round) from anyone but the pool: refused before anything is parsed
        const r1 = await f.mallory.send({ to: f.vault.address, value: toNano('0.1'), body: obsBody((6n << 56n) | (1n << 8n) | 255n, -50000n, 2n ** 80n, BigInt(f.now)) });
        expect(r1.transactions).toHaveTransaction({ to: f.vault.address, success: false, exitCode: err('Not pool') });
        const mr = beginCell().store(storeMintReceipt({
            $$type: 'MintReceipt', queryId: (1n << 56n) | 1n, ok: true, code: 0n, owner: f.vault.address, index: 0n, tickLower: -60n, tickUpper: 60n,
            liquidity: 10n ** 12n, amount0: 0n, amount1: 0n, refund0: 0n, refund1: 0n, fgInside0: 0n, fgInside1: 0n,
        })).endCell();
        const r2 = await f.mallory.send({ to: f.vault.address, value: toNano('0.1'), body: mr });
        expect(r2.transactions).toHaveTransaction({ to: f.vault.address, success: false, exitCode: err('Not pool') });
        const br = beginCell().store(storeBurnReceipt({
            $$type: 'BurnReceipt', queryId: (2n << 56n) | 1n, index: 0n, ok: true, code: 0n, liquidityDelta: 0n, liquidity: 0n,
            amount0: 10n ** 15n, amount1: 10n ** 12n, fees0: 0n, fees1: 0n, fgInside0: 0n, fgInside1: 0n,
        })).endCell();
        const r3 = await f.mallory.send({ to: f.vault.address, value: toNano('0.1'), body: br });
        expect(vaultFailures(r3, f.vault.address).length).toBe(0);
        const gp = beginCell().store(storeGramPayout({ $$type: 'GramPayout', queryId: 0n, reason: 11n, amount: 10n ** 15n, payload: null })).endCell();
        const r4 = await f.mallory.send({ to: f.vault.address, value: toNano('0.1'), body: gp });
        expect(vaultFailures(r4, f.vault.address).length).toBe(0);
        const ex = beginCell().store(storeJettonExcesses({ $$type: 'JettonExcesses', queryId: 1n })).endCell();
        await f.mallory.send({ to: f.vault.address, value: toNano('0.1'), body: ex });
        const after = await f.snap();
        expect(after.v.idle0).toBe(sn.v.idle0);
        expect(after.v.idle1).toBe(sn.v.idle1);
        expect(after.o).toEqual(sn.o);
        expect(after.pos).toEqual(sn.pos);
        await f.expectSolvent();
    });

    it('a deposit is priced only on ITS OWN observation from the real pool: a forged one is refused, a stale (delayed) one refunds', async () => {
        const f = await ready();
        // 1) forged: while the deposit's round is in flight, mallory answers it with a fake price
        const body = beginCell().store(storeDepositNative({ $$type: 'DepositNative', queryId: 1n, amount: 10n * GRAM_1, minShares: 0n, receiver: null })).endCell();
        const { it } = await stepParallel(f.chain, msg(f.bob.address, f.vault.address, 10n * GRAM_1 + DEPOSIT_GAS + toNano('0.05'), body), 1);
        const deps = await f.vault.getGetDeposits();
        expect(deps.size).toBe(1);
        const round = BigInt([...deps.keys()][0]);
        const forged = await f.mallory.send({ to: f.vault.address, value: toNano('0.1'),
            body: obsBody((6n << 56n) | (round << 8n) | 0n, -200000n, 2n ** 70n, BigInt(f.now)) });
        expect(forged.transactions).toHaveTransaction({ to: f.vault.address, success: false, exitCode: err('Not pool') });
        expect((await f.vault.getGetDeposits()).size).toBe(1);
        const sn = await f.snap();
        const expected = f.modelShares(sn, 10n * GRAM_1, 0n);
        await drain(it);
        expect(await f.shares(f.bob.address)).toBe(expected);       // priced by the real pool's answer

        // 2) stale: the real observation is delayed beyond MAX_OBS_AGE before it reaches the vault
        const { it: it2 } = await stepParallel(f.chain, msg(f.carol.address, f.vault.address, 10n * GRAM_1 + DEPOSIT_GAS + toNano('0.05'), body), 0);
        let reply: any = null;
        for (let i = 0; i < 20 && !reply; i++) {
            const r = await it2.next();
            if (r.done) break;
            const tx = r.value;
            if (tx.inMessage?.info.dest instanceof Address && tx.inMessage.info.dest.equals(f.pool.address)) {
                reply = [...tx.outMessages.values()].find((m: any) => m.body.beginParse().preloadUint(32) === OPD.PoolObservation);
            }
        }
        expect(reply).toBeTruthy();
        await f.wait(200);
        const late = await f.chain.sendMessage(reply);
        expectNoFailures(late);
        expect(refusals(late)).toEqual([2]);
        expect(await f.shares(f.carol.address)).toBe(0n);
        expect((await f.data()).depCount).toBe(0n);
        await f.expectSolvent();
    });

    it('USDT sent to the vault through the DEX (a swap output with forward_ton_amount) is surplus for the holders, never a fee', async () => {
        const f = await ready();
        const sn = await f.snap();
        // mallory swaps Gram -> USDT with receiver = vault (fwdTon > 0: the vault is notified, sender = Router)
        const res = await f.swapGram(f.mallory, 20n * GRAM_1, { receiver: f.vault.address, fwdTon: toNano('0.02') });
        expectNoFailures(res);
        const v = await f.data();
        const arrived = (await f.usdtBal(f.vault.address)) - sn.v.idle1 - sn.v.fee1;
        expect(v.idle1 - sn.v.idle1).toBe(arrived);
        expect(v.fee1).toBe(sn.v.fee1);
        expect(arrived).toBeGreaterThan(0n);
        expect(v.opCount).toBe(0n);
        await f.expectSolvent();
    });

    it('a mint made FOR the vault by someone else (owner = vault) is invisible to it: no receipt, untracked donation', async () => {
        const f = await ready();
        const before = await f.positions();
        const spoof = await f.d.router.send(f.mallory.getSender(), { value: toNano('2') }, {
            $$type: 'MintNativeNotify', queryId: (1n << 56n) | 1n, amount: GRAM_1, otherToken: f.d.tokA, tickSpacing: SPACING, ext: null,
            tickLower: before[0].tU, tickUpper: before[0].tU + 600n, sqrtPriceInitX96: 0n, minLiquidity: 0n, owner: f.vault.address,
            refundTo: f.mallory.address, deadline: BigInt(f.now + 600), sqrtPriceMinX96: 0n, sqrtPriceMaxX96: 0n,
        });
        expectNoFailures(spoof);
        const idx = (await f.poolState()).nextPositionId - 1n;
        expect((await (await f.position(idx)).getGetPositionData()).owner.equals(f.vault.address)).toBe(true);
        // the receipt went to the payer (mallory), not to the vault
        expect(spoof.transactions.filter((tx) => tx.inMessage?.info.dest instanceof Address && tx.inMessage.info.dest.equals(f.vault.address)).length).toBe(0);
        expect(await f.positions()).toEqual(before);
        await f.wait(86400);
        expectNoFailures(await f.rebalance());
        expect((await f.data()).phase).toBe(PHASE.IDLE);
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();
    });

    it('a bounced PositionDecreaseNotify (the NFT threw) is a definite failure: the worker moves on and the user is paid', async () => {
        const f = await ready();
        const s = await f.shares(f.alice.address);
        const w = await f.shareWallet(f.alice.address);
        const burn = beginCell().store(storeJettonBurn({ $$type: 'JettonBurn', queryId: 1n, amount: s, responseDestination: null, customPayload: null })).endCell();
        const { it } = await stepParallel(f.chain, msg(f.alice.address, w.address, WITHDRAW_GAS + toNano('0.1'), burn), 2);
        // The vault has sent COLLECT ops; drop them (never drained) and deliver a bounce instead.
        const ops = await f.vault.getGetOps();
        const collects = [...ops.keys()].filter((k) => ops.get(k)!.kind === 3n);
        expect(collects.length).toBeGreaterThan(0);
        const ub = await f.usdtBal(f.alice.address);
        for (const q of collects) {
            const o = ops.get(q)!;
            const posAddr = await f.vault.getGetPositionAddress(o.index);
            const bounced = beginCell().storeUint(0xffffffff, 32).storeUint(OPD.PositionDecreaseNotify, 32).storeUint(q, 64).storeUint(0n, 128).endCell();
            const r = await f.chain.sendMessage(internal({ from: posAddr, to: f.vault.address, value: toNano('0.3'), body: bounced, bounced: true, bounce: false }));
            expectNoFailures(r);
        }
        const v = await f.data();
        expect(v.workerActive).toBe(false);
        expect(await f.usdtBal(f.alice.address)).toBeGreaterThan(ub);
        expect(await f.shares(f.alice.address)).toBe(0n);
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();
    });
});

describe('first depositor and inflation', () => {
    it('nobody can deposit before the admin opens the vault, and only the admin can open it', async () => {
        const f = await VaultFx.create({ open: false });
        const d = await f.depositGram(f.alice, GRAM_1);
        expect(d.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        const ub = await f.usdtBal(f.mallory.address);
        const p = beginCell().store(storeOpenPayload({ $$type: 'OpenPayload', gramAmount: 10n * GRAM_1, sqrtPriceInitX96: P0, receiver: null })).endCell();
        await f.sendUsdt(f.mallory, 100n * USDT, 12n * GRAM_1, eitherRef(p));
        expect(await f.usdtBal(f.mallory.address)).toBe(ub);
        expect((await f.data()).phase).toBe(PHASE.SETUP);
        // below the minimum opening value: refunded
        const ab = await f.usdtBal(f.admin.address);
        await f.open(1n * GRAM_1, 1n * USDT, P0);
        expect(await f.usdtBal(f.admin.address)).toBe(ab);
        expect((await f.data()).phase).toBe(PHASE.SETUP);
    });

    // Minimal opening (10 USDT of value); the attacker adds his own liquidity to the canonical pool and
    // donates a huge USDT swap output to the vault (the only donation the vault counts).
    async function donate(f: VaultFx, amountGram: bigint) {
        expectNoFailures(await f.d.mintJetton(f.usdt, f.mallory, 15_000_000n * USDT, GRAM, -887220n, 887220n, 5_000_000n * GRAM_1, { gas: toNano('0.7') }));
        const res = await f.swapGram(f.mallory, amountGram, { receiver: f.vault.address, fwdTon: toNano('0.02') });
        expectNoFailures(res);
    }

    it('a huge donation after a minimal opening cannot make a victim deposit round down materially', async () => {
        const f = await VaultFx.create({ seed0: 2n * GRAM_1, seed1: 5n * USDT });
        await f.wait(3700);
        await donate(f, 400_000n * GRAM_1);
        const v0 = await f.data();
        expect(v0.idle1).toBeGreaterThan(1_000_000n * USDT);
        await f.warm(3700);                     // the moved price must be the TWAP before anyone deposits
        expectNoFailures(await f.poke());
        const n = await f.vault.getGetNav();
        expect(n.supply).toBeGreaterThanOrEqual(10_000_000_000n);
        // victim deposits 100 USDT
        const sn = await f.snap();
        const quote = f.modelShares(sn, 0n, 100n * USDT);
        expect(quote).toBeGreaterThan(0n);
        expectNoFailures(await f.depositUsdt(f.bob, 100n * USDT, 0n, quote));
        const shares = await f.shares(f.bob.address);
        expect(shares).toBe(quote);
        // the victim's claim is worth its deposit to within one share unit
        const n2 = await f.vault.getGetNav();
        const claim = (n2.nav * shares) / n2.supply;
        const paid = 100n * USDT << 64n;
        expect(paid - claim).toBeLessThan((n2.nav / n2.supply) + (n2.nav / 10n ** 12n));
        // immediately exiting returns ~ the deposit, in kind (value at the pool price)
        const ub = await f.usdtBal(f.bob.address);
        expectNoFailures(await f.withdraw(f.bob, shares));
        expect((await f.usdtBal(f.bob.address)) - ub).toBeGreaterThan(0n);
        await f.expectSolvent();
    });

    it('minShares protects a deposit front-run by a donation', async () => {
        const f = await VaultFx.create({ seed0: 2n * GRAM_1, seed1: 5n * USDT });
        await f.wait(3700);
        expectNoFailures(await f.poke());
        const quote = await f.vault.getGetPreviewDeposit(0n, 100n * USDT);
        expect(quote).toBeGreaterThan(0n);
        await donate(f, 1000n * GRAM_1);
        const ub = await f.usdtBal(f.bob.address);
        const r = await f.depositUsdt(f.bob, 100n * USDT, 0n, (quote * 99n) / 100n);
        expect(refusals(r).length).toBe(1);
        expect(await f.usdtBal(f.bob.address)).toBe(ub);
        expect(await f.shares(f.bob.address)).toBe(0n);
    });
});

describe('admin powers are capped', () => {
    it('fee cap, strategy caps, roles, two-step transfer; no admin path moves funds', async () => {
        const f = await ready();
        const send = (from: any, body: any) => f.vault.send(from.getSender(), { value: toNano('0.05') }, body);
        const r1 = await send(f.admin, { $$type: 'SetPerfFee', queryId: 1n, bps: 2001n });
        expect(r1.transactions).toHaveTransaction({ to: f.vault.address, success: false, exitCode: err('Fee above cap') });
        expectNoFailures(await send(f.admin, { $$type: 'SetPerfFee', queryId: 1n, bps: 2000n }));
        expect((await f.data()).strategy.perfFeeBps).toBe(2000n);
        expectNoFailures(await send(f.admin, { $$type: 'SetPerfFee', queryId: 1n, bps: 0n }));
        const r2 = await send(f.alice, { $$type: 'SetPerfFee', queryId: 1n, bps: 0n });
        expect(r2.transactions).toHaveTransaction({ to: f.vault.address, success: false, exitCode: err('Not admin') });

        const bad = [
            { baseHalfWidth: 30n }, { baseHalfWidth: 50040n }, { limitWidth: 0n }, { threshold: 5000n },
            { cooldown: 60n }, { cooldown: 2592001n }, { twapWindow: 10n }, { twapWindow: 86401n },
            { maxDeviation: 0n }, { maxDeviation: 501n }, { perfFeeBps: 2500n },
        ];
        for (const patch of bad) {
            const r = await f.setStrategy(patch as any);
            expect(r.transactions).toHaveTransaction({ to: f.vault.address, success: false, exitCode: err('Outside caps') });
        }
        expectNoFailures(await f.setStrategy({ baseHalfWidth: 600n, threshold: 300n, twapWindow: 600n, maxDeviation: 50n }));

        // two-step admin transfer
        expectNoFailures(await send(f.admin, { $$type: 'VaultTransferAdmin', queryId: 1n, newAdmin: f.carol.address }));
        expect((await f.data()).admin.equals(f.admin.address)).toBe(true);
        const wrong = await send(f.bob, { $$type: 'VaultClaimAdmin', queryId: 1n });
        expect(wrong.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        expectNoFailures(await send(f.carol, { $$type: 'VaultClaimAdmin', queryId: 1n }));
        expect((await f.data()).admin.equals(f.carol.address)).toBe(true);
        const old = await send(f.admin, { $$type: 'SetDepositsPaused', queryId: 1n, paused: true });
        expect(old.transactions).toHaveTransaction({ to: f.vault.address, success: false });

        // the (new) admin pauses deposits: withdrawals still work, funds untouched
        const sn = await f.snap();
        expectNoFailures(await send(f.carol, { $$type: 'SetDepositsPaused', queryId: 1n, paused: true }));
        expectNoFailures(await f.withdraw(f.alice, await f.shares(f.alice.address)));
        expect(await f.shares(f.alice.address)).toBe(0n);
        // treasury change only redirects future performance fees
        expectNoFailures(await send(f.carol, { $$type: 'SetTreasury', queryId: 1n, treasury: f.carol.address }));
        const after = await f.data();
        expect(after.fee0).toBeGreaterThanOrEqual(sn.v.fee0);
        await f.expectSolvent();
    });
});
