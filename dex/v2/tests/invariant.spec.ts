// Randomized invariant suite (fixed seed, 300 operations over 3 pools).
//
// Every operation is mirrored in the independent BigInt simulator (model.ts PoolSim) and, after
// each one, the WHOLE on-chain pool state (price, tick, L, fee growth, reserves, fee buckets,
// volatility state, every initialized tick) must equal the simulator exactly. On top of that:
//  - a per-party jetton ledger (users, referral, treasury, hook) must match the chain exactly,
//    so no operation creates or loses value;
//  - each Router jetton wallet holds exactly what the pools owe (reserves + protocol + hook fees);
//  - native pools hold at least their Gram reserves + fee buckets;
//  - Σ (principal + fees) withdrawable by all positions <= reserves, per token (every 10 ops);
//  - active L == Σ in-range position L, Σ liqNet == 0, liqGross == Σ position L per tick;
//  - fee growth only moves forward (mod 2^256), fee buckets never negative;
//  - finally everyone exits and only rounding dust is left.

import { Address, beginCell, Cell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, Pool, Position, TestJettonMaster, expectNoFailures, swapEvents, modifyEvents, refundCodes,
    gramPayouts, expectPoolEquals, rng, extCell, encodeSqrtPrice, storeHookSetFee, storeHookCollectFees, REASON,
    failedAt, masterOf,
} from './helpers';
import { TestHook } from '../build/TestHook_TestHook';
import * as M from './model';

jest.setTimeout(3_600_000);

const OPS = 300;
const SEED = 0x5eed2026;

type PoolRec = {
    name: string;
    pool: SandboxContract<Pool>;
    sim: M.PoolSim;
    ext: Cell | null;
    spacing: number;
    t0: Address;
    t1: Address;
    native: boolean;
    preset: M.Preset;
    hook?: SandboxContract<TestHook>;
};
type PosRec = {
    pr: PoolRec;
    index: bigint;
    pos: SandboxContract<Position>;
    owner: SandboxContract<TreasuryContract>;
    tL: number;
    tU: number;
    liq: bigint;
    fg0: bigint;
    fg1: bigint;
    lockedUntil: bigint;
};

describe('v2 invariant: 300 seeded random operations, chain == model after every step', () => {
    let d: Dex;
    let ref: SandboxContract<TreasuryContract>;
    let hook: SandboxContract<TestHook>;
    let taxman: SandboxContract<TreasuryContract>;
    const pools: PoolRec[] = [];
    const positions: PosRec[] = [];
    const ledger = new Map<string, bigint>();
    const parties: Address[] = [];
    const stats: Record<string, number> = {};
    const R = rng(SEED);
    const key = (who: Address, tok: Address) => who.toString() + '|' + tok.toString();
    const bump = (who: Address, tok: Address, v: bigint) => {
        if (tok.equals(GRAM) || v === 0n) return;
        const k = key(who, tok);
        if (!ledger.has(k)) throw new Error('party not tracked ' + who.toString());
        ledger.set(k, ledger.get(k)! + v);
    };
    const count = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };

    async function checkLedger() {
        for (const who of parties) {
            for (const [m, tok] of [[d.jA, d.tokA], [d.jB, d.tokB]] as [SandboxContract<TestJettonMaster>, Address][]) {
                expect([who.toString(), tok.toString(), await d.jBal(m, who)]).toEqual([who.toString(), tok.toString(), ledger.get(key(who, tok))]);
            }
        }
        // Router wallets hold exactly what the pools owe.
        for (const tok of [d.tokA, d.tokB]) {
            let owed = 0n;
            for (const pr of pools) {
                if (pr.t0.equals(tok)) owed += pr.sim.reserve0 + pr.sim.protocolFees0 + pr.sim.hookFees0;
                if (pr.t1.equals(tok)) owed += pr.sim.reserve1 + pr.sim.protocolFees1 + pr.sim.hookFees1;
            }
            expect(await d.routerHolds(tok)).toBe(owed);
        }
        for (const pr of pools) {
            if (pr.native) {
                expect(await d.gram(pr.pool.address)).toBeGreaterThanOrEqual(pr.sim.reserve0 + pr.sim.protocolFees0 + pr.sim.hookFees0 + pr.sim.taxFees + pr.sim.platformFees);
            }
        }
    }

    const prevFg = new Map<string, [bigint, bigint]>();
    async function checkPools(label: string, deep: boolean) {
        for (const pr of pools) {
            await expectPoolEquals(pr.pool, pr.sim, `${label} ${pr.name}`);
            // Active liquidity and tick bookkeeping agree with the open positions.
            const mine = positions.filter((p) => p.pr === pr && p.liq > 0n);
            const active = mine.filter((p) => p.tL <= pr.sim.tick && pr.sim.tick < p.tU).reduce((a, p) => a + p.liq, 0n);
            expect(pr.sim.L).toBe(active);
            let net = 0n;
            for (const [t, ti] of pr.sim.ticks) {
                net += ti.liqNet;
                const gross = mine.filter((p) => p.tL === t || p.tU === t).reduce((a, p) => a + p.liq, 0n);
                expect(ti.liqGross).toBe(gross);
            }
            expect(net).toBe(0n);
            // Fee growth is monotone (mod 2^256) and fee buckets are never negative.
            const pf = prevFg.get(pr.name) ?? [0n, 0n];
            expect(M.subMod(pr.sim.fg0, pf[0]) < (1n << 255n)).toBe(true);
            expect(M.subMod(pr.sim.fg1, pf[1]) < (1n << 255n)).toBe(true);
            prevFg.set(pr.name, [pr.sim.fg0, pr.sim.fg1]);
            for (const v of [pr.sim.protocolFees0, pr.sim.protocolFees1, pr.sim.hookFees0, pr.sim.hookFees1, pr.sim.reserve0, pr.sim.reserve1, pr.sim.taxFees, pr.sim.platformFees]) {
                expect(v >= 0n).toBe(true);
            }
            // TWAP accumulator.
            const obs = await pr.pool.getGetObserve();
            if (pr.sim.initialized) {
                expect(obs.tickCumulative).toBe(pr.sim.tickCumulative + BigInt(pr.sim.tick) * (BigInt(d.now) - pr.sim.obsTs));
            }
            if (deep) {
                // Σ withdrawable <= reserves, and the getter agrees with the model per position.
                let w0 = 0n;
                let w1 = 0n;
                for (const p of positions.filter((q) => q.pr === pr)) {
                    const g = await pr.pool.getGetPositionAmounts(BigInt(p.tL), BigInt(p.tU), p.liq, p.fg0, p.fg1, p.liq);
                    const m = pr.sim.burn(p.tL, p.tU, p.liq, p.liq, p.fg0, p.fg1, 0n, 0n, false);
                    expect([g.amount0, g.amount1, g.fees0, g.fees1]).toEqual([m.amount0, m.amount1, m.fees0, m.fees1]);
                    w0 += g.amount0 + g.fees0;
                    w1 += g.amount1 + g.fees1;
                }
                expect(w0).toBeLessThanOrEqual(pr.sim.reserve0);
                expect(w1).toBeLessThanOrEqual(pr.sim.reserve1);
            }
        }
    }

    // ---------------------------------------------------------------- operations

    async function mint(pr: PoolRec, user: SandboxContract<TreasuryContract>, tL: number, tU: number, a0: bigint, a1: bigint,
                        owner: SandboxContract<TreasuryContract>, sqrtInit = 0n) {
        const t = BigInt(d.now);
        const index = pr.sim.nextPositionId;
        const isInitializer = pr.sim.ext.initializer === null || pr.sim.ext.initializer === user.address.toString();
        const exp = pr.sim.mint(tL, tU, a0, a1, 0n, sqrtInit, t, pr.preset, { allowInit: true, userIsInitializer: isInitializer });
        const o = { ext: pr.ext, tickSpacing: BigInt(pr.spacing), owner: owner.address, sqrtPriceInit: sqrtInit };
        let res;
        if (pr.native) {
            if (a1 === 0n) res = await d.mintNative(user, a0, pr.t1, BigInt(tL), BigInt(tU), o);
            else res = await d.mintJetton(masterOf(d, pr.t1), user, a1, GRAM, BigInt(tL), BigInt(tU), a0, o);
            expectNoFailures(res);
            if (exp.code === 0) bump(user.address, pr.t1, -exp.use1);
        } else if (a0 > 0n && a1 > 0n) {
            const r1 = await d.mintJetton(masterOf(d, pr.t0), user, a0, pr.t1, BigInt(tL), BigInt(tU), 0n, { ...o, viaAccount: true });
            expectNoFailures(r1);
            res = await d.mintJetton(masterOf(d, pr.t1), user, a1, pr.t0, BigInt(tL), BigInt(tU), 0n, { ...o, viaAccount: true });
            expectNoFailures(res);
            if (exp.code === 0) { bump(user.address, pr.t0, -exp.use0); bump(user.address, pr.t1, -exp.use1); }
        } else {
            const single0 = a0 > 0n;
            res = await d.mintJetton(masterOf(d, single0 ? pr.t0 : pr.t1), user, single0 ? a0 : a1, single0 ? pr.t1 : pr.t0,
                BigInt(tL), BigInt(tU), 0n, o);
            expectNoFailures(res);
            if (exp.code === 0) { bump(user.address, pr.t0, -exp.use0); bump(user.address, pr.t1, -exp.use1); }
        }
        if (exp.code !== 0) {
            expect(refundCodes(res)).toEqual([exp.code]);
            expect(modifyEvents(res)).toEqual([]);
            count(`mint refund ${exp.code}`);
            return null;
        }
        count('mint');
        const ev = modifyEvents(res);
        expect(ev.length).toBe(1);
        expect([ev[0].liquidityDelta, ev[0].amount0, ev[0].amount1, ev[0].index]).toEqual([exp.liq, exp.use0, exp.use1, index]);
        if (pr.native && a0 > exp.use0) {
            // The Gram leg remainder comes back (it rides with the excess, so >= the amount).
            const back = gramPayouts(res, user.address).filter((p) => p.reason === REASON.MINT_REFUND);
            expect(back.length).toBe(1);
            expect(back[0].amount).toBe(a0 - exp.use0);
        }
        const pos = await d.position(pr.pool, index);
        const pd = await pos.getGetPositionData();
        let lockedUntil = pr.sim.ext.minLockSecs > 0n ? t + pr.sim.ext.minLockSecs : 0n;
        // LAUNCH_DECAY: liquidity added inside the launch window is locked until it ends.
        const launchEnd = pr.sim.fs.startTs + pr.sim.ext.launchDuration;
        if (pr.sim.ext.launchFeePips > 0n && t < launchEnd && launchEnd > lockedUntil) lockedUntil = launchEnd;
        expect([pd.initialized, pd.owner.toString(), pd.liquidity, pd.fgLast0, pd.fgLast1, pd.lockedUntil, pd.busy])
            .toEqual([true, owner.address.toString(), exp.liq, exp.inside0, exp.inside1, lockedUntil, false]);
        const rec: PosRec = { pr, index, pos, owner, tL, tU, liq: exp.liq, fg0: exp.inside0, fg1: exp.inside1, lockedUntil };
        positions.push(rec);
        return rec;
    }

    const collectPlatform = (u: SandboxContract<TreasuryContract>, key: any) => d.router.send(u.getSender(), { value: toNano('0.3') }, {
        $$type: 'CollectPlatformFees', queryId: 4n,
        key: { $$type: 'PoolKey', token0: key.token0, token1: key.token1, tickSpacing: key.tickSpacing, ext: key.ext },
    });

    async function swap(pr: PoolRec, user: SandboxContract<TreasuryContract>, zfo: boolean, amount: bigint,
                        o: { limit?: bigint; maxCrossings?: number; allowPartial?: boolean; refBps?: bigint; minOut?: bigint;
                             receiver?: SandboxContract<TreasuryContract> }) {
        const t = BigInt(d.now);
        const maxC = o.maxCrossings ?? 24;
        const refBps = o.refBps ?? 0n;
        const limit = o.limit ?? 0n;
        const allowPartial = o.allowPartial ?? false;
        const receiver = o.receiver ?? user;
        const exp0 = pr.sim.swap(zfo, amount, limit, maxC, refBps, allowPartial, 0n, t, false);
        const minOut = o.minOut === -1n ? exp0.out + 1n : (o.minOut ?? 0n);
        // The getter (minOut 0) agrees with the model.
        const q = await pr.pool.getGetQuote(zfo, amount, limit, BigInt(maxC), refBps, allowPartial);
        expect([q.code, q.amountOut, q.consumed, q.refFee, q.refund, q.feeTotal, q.protocolFee, q.hookFee, q.sqrtPriceAfter,
            q.tickAfter, q.liquidityAfter, q.crossings, q.steps, q.stop, q.tax, q.platformFee]).toEqual([
            BigInt(exp0.code), exp0.out, exp0.consumed, exp0.refFee, exp0.refund, exp0.feeTotal, exp0.proto, exp0.hook,
            exp0.sqrtP, BigInt(exp0.tick), exp0.L, BigInt(exp0.crossings), BigInt(exp0.steps), BigInt(exp0.stop), exp0.tax, exp0.plat]);
        const exp = pr.sim.swap(zfo, amount, limit, maxC, refBps, allowPartial, minOut, t, true);
        const so = {
            ext: pr.ext, tickSpacing: BigInt(pr.spacing), limit, maxCrossings: BigInt(maxC), allowPartial,
            referral: refBps > 0n ? ref.address : null, refBps, minOut, receiver: receiver.address,
        };
        const tokIn = zfo ? pr.t0 : pr.t1;
        const tokOut = zfo ? pr.t1 : pr.t0;
        let res;
        if (tokIn.equals(GRAM)) res = await d.swapNative(user, amount, pr.t1, so);
        else res = await d.swapJetton(masterOf(d, tokIn), user, amount, zfo ? pr.t1 : pr.t0, so);
        expectNoFailures(res);
        if (exp.code !== 0) {
            expect(refundCodes(res)).toEqual([exp.code]);
            expect(swapEvents(res)).toEqual([]);
            if (tokIn.equals(GRAM)) {
                const back = gramPayouts(res, user.address).filter((p) => p.reason === REASON.SWAP_REFUND);
                expect(back.map((b) => b.amount)).toEqual([amount]);
            }
            count(`swap refund ${exp.code}`);
            return exp;
        }
        count(exp.stop === M.STOP_REASONS.FILLED ? 'swap filled' : `swap stop ${exp.stop}`);
        const ev = swapEvents(res);
        expect(ev.length).toBe(1);
        const buyTax = zfo ? exp.tax + exp.plat : 0n;     // buy tax + buy platform fee (both from the Gram input)
        expect([ev[0].amountOut, ev[0].amountIn, ev[0].refFee, ev[0].feeTotal, ev[0].protocolFee, ev[0].hookFee,
            ev[0].sqrtPriceX96, ev[0].tick, ev[0].liquidity, ev[0].crossings, ev[0].steps, ev[0].stop, ev[0].tax]).toEqual([
            exp.out, exp.consumed + exp.refFee + buyTax, exp.refFee, exp.feeTotal, exp.proto, exp.hook, exp.sqrtP, BigInt(exp.tick),
            exp.L, BigInt(exp.crossings), BigInt(exp.steps), BigInt(exp.stop), exp.tax]);
        expect(ev[0].platformFee).toBe(exp.plat);
        if (exp.plat > 0n) count('swap with platform fee');
        // Direct payouts (same transaction): platform fee to the treasury, tax at its threshold.
        expect(gramPayouts(res, d.treasury.address).filter((p) => p.reason === REASON.PLATFORM).map((p) => p.amount))
            .toEqual(exp.platPaid > 0n ? [exp.platPaid] : []);
        expect(gramPayouts(res).filter((p) => p.reason === REASON.TAX).map((p) => p.amount)).toEqual(exp.taxPaid > 0n ? [exp.taxPaid] : []);
        if (exp.taxPaid > 0n) count('tax auto-payout');
        expect(exp.consumed + exp.refFee + exp.refund + buyTax).toBe(amount);
        if (exp.tax > 0n) count(zfo ? 'swap with buy tax' : 'swap with sell tax');
        // Payouts: output, referral, partial refund, each exactly once and exactly the model amount.
        if (tokOut.equals(GRAM)) {
            const outs = gramPayouts(res, receiver.address).filter((p) => p.reason === REASON.SWAP_OUT);
            expect(outs.map((p) => p.amount)).toEqual([exp.out]);
            expect(outs[0].value).toBeGreaterThanOrEqual(exp.out);
        } else {
            bump(receiver.address, tokOut, exp.out);
        }
        if (tokIn.equals(GRAM)) {
            expect(gramPayouts(res, ref.address).filter((p) => p.reason === REASON.REFERRAL).map((p) => p.amount))
                .toEqual(exp.refFee > 0n ? [exp.refFee] : []);
            expect(gramPayouts(res, user.address).filter((p) => p.reason === REASON.PARTIAL_REFUND).map((p) => p.amount))
                .toEqual(exp.refund > 0n ? [exp.refund] : []);
        } else {
            bump(user.address, tokIn, -amount + exp.refund);
            bump(ref.address, tokIn, exp.refFee);
        }
        return exp;
    }

    async function decrease(p: PosRec, delta: bigint, recipient: SandboxContract<TreasuryContract>) {
        const pr = p.pr;
        const t = BigInt(d.now);
        const res = await d.decrease(p.pos, p.owner, delta, { recipient: recipient.address });
        if (delta > 0n && t < p.lockedUntil) {
            // MIN_LP_LOCK: the Position refuses (its bounce returns the value); nothing changes.
            expect(failedAt(res, p.pos.address).length).toBe(1);
            expect(modifyEvents(res)).toEqual([]);
            expect((await p.pos.getGetPositionData()).liquidity).toBe(p.liq);
            count('decrease locked');
            return;
        }
        expectNoFailures(res);
        const exp = pr.sim.burn(p.tL, p.tU, p.liq, delta, p.fg0, p.fg1);
        expect(exp.code).toBe(0);
        count(delta === 0n ? 'collect' : delta === p.liq ? 'decrease full' : 'decrease partial');
        const ev = modifyEvents(res);
        expect(ev.length).toBe(1);
        expect([ev[0].liquidityDelta, ev[0].amount0, ev[0].amount1, ev[0].fees0, ev[0].fees1])
            .toEqual([-delta, exp.amount0, exp.amount1, exp.fees0, exp.fees1]);
        const out0 = exp.amount0 + exp.fees0;
        const out1 = exp.amount1 + exp.fees1;
        if (pr.native) {
            expect(gramPayouts(res, recipient.address).filter((x) => x.reason === REASON.POSITION_OUT).map((x) => x.amount))
                .toEqual(out0 > 0n ? [out0] : []);
        } else {
            bump(recipient.address, pr.t0, out0);
        }
        bump(recipient.address, pr.t1, out1);
        p.liq -= delta;
        p.fg0 = exp.inside0;
        p.fg1 = exp.inside1;
        const pd = await p.pos.getGetPositionData();
        expect([pd.liquidity, pd.fgLast0, pd.fgLast1, pd.busy]).toEqual([p.liq, p.fg0, p.fg1, false]);
    }

    // ---------------------------------------------------------------- setup

    beforeAll(async () => {
        d = await Dex.create();
        ref = await d.chain.treasury('referral');
        taxman = await d.chain.treasury('taxman');
        hook = d.chain.openContract(await TestHook.fromInit(d.carol.address, 0n));
        await hook.send(d.carol.getSender(), { value: toNano('5') }, null);
        for (const who of [d.alice.address, d.bob.address, d.carol.address, ref.address, d.treasury.address, hook.address]) {
            parties.push(who);
            for (const [m, tok] of [[d.jA, d.tokA], [d.jB, d.tokB]] as [SandboxContract<TestJettonMaster>, Address][]) {
                ledger.set(key(who, tok), await d.jBal(m, who));
            }
        }

        // P1: Gram/A, spacing 60, plain key.
        const p1 = await d.poolOf(GRAM, d.tokA, 60n, null);
        pools.push({ name: 'P1 Gram/A s60', pool: p1, sim: new M.PoolSim(60), ext: null, spacing: 60, t0: GRAM, t1: d.tokA,
            native: true, preset: M.PRESETS[60] });
        // P2: Gram/B, spacing 10, every plugin: hook (all flags, 15% share, fee control), launch decay, LP lock, initializer,
        // TAX (3% buy, 5% sell).
        const ext2 = extCell({
            hook: hook.address, hookFlags: 7n, hookShareBps: 1500n, hookFeeMin: 100n, hookFeeMax: 20000n,
            initializer: d.alice.address, launchFeePips: 100000n, launchDuration: 3600n, minLockSecs: 600n,
            taxRecipient: taxman.address, buyTaxBps: 300n, sellTaxBps: 500n,
        });
        const p2 = await d.poolOf(GRAM, d.tokB, 10n, ext2);
        pools.push({ name: 'P2 Gram/B s10 plugins', pool: p2, ext: ext2, spacing: 10, t0: GRAM, t1: d.tokB, native: true,
            preset: M.PRESETS[10], hook,
            sim: new M.PoolSim(10, { hookShareBps: 1500n, launchFeePips: 100000n, launchDuration: 3600n,
                initializer: d.alice.address.toString(), minLockSecs: 600n, buyTaxBps: 300n, sellTaxBps: 500n }) });
        // P3: A/B jetton/jetton, spacing 200.
        const p3 = await d.poolOf(d.tokA, d.tokB, 200n, null);
        const aFirst = BigInt('0x' + d.tokA.hash.toString('hex')) < BigInt('0x' + d.tokB.hash.toString('hex'));
        pools.push({ name: 'P3 A/B s200', pool: p3, sim: new M.PoolSim(200, M.PLAIN_EXT, false), ext: null, spacing: 200,
            t0: aFirst ? d.tokA : d.tokB, t1: aFirst ? d.tokB : d.tokA, native: false, preset: M.PRESETS[200] });

        // Seed liquidity (also initializes the pools).
        expect(await mint(pools[0], d.alice, -600, 600, toNano('1000'), toNano('1000'), d.alice, Q96)).not.toBeNull();
        // bob cannot initialize P2 (initializer = alice): refunded NOT_INITIALIZER.
        expect(await mint(pools[1], d.bob, 6000, 8000, toNano('500'), toNano('2000'), d.bob, encodeSqrtPrice(2n, 1n))).toBeNull();
        expect(await mint(pools[1], d.alice, 6000, 8000, toNano('500'), toNano('2000'), d.alice, encodeSqrtPrice(2n, 1n))).not.toBeNull();
        expect(await mint(pools[2], d.bob, -10000, 4000, toNano('1000'), toNano('1000'), d.bob, encodeSqrtPrice(1n, 2n))).not.toBeNull();
        await checkPools('setup', true);
        await checkLedger();
    });

    afterAll(() => {
        // eslint-disable-next-line no-console
        console.log('invariant op mix:\n' + Object.entries(stats).sort().map(([k, v]) => `  ${k}: ${v}`).join('\n'));
    });

    it(`runs ${OPS} random operations with exact model agreement and all invariants`, async () => {
        const users = [d.alice, d.bob, d.carol];
        for (let i = 0; i < OPS; i++) {
            const pr = R.pick(pools);
            const user = R.pick(users);
            const roll = R.next();
            const s = pr.spacing;
            if (roll < 0.45) {
                // --- swap
                const zfo = R.next() < 0.5;
                const mag = R.int(3, 12); // 1e3 .. 1e12 nano units
                const amount = R.big(10n ** BigInt(mag - 1), 10n ** BigInt(mag)) * BigInt(R.int(1, 5));
                const o: Parameters<typeof swap>[4] = {
                    maxCrossings: R.next() < 0.2 ? R.int(1, 3) : 24,
                    allowPartial: R.next() < 0.5,
                    refBps: R.next() < 0.3 ? BigInt(R.int(1, 10)) : 0n,
                    receiver: R.next() < 0.2 ? R.pick(users) : user,
                };
                const lr = R.next();
                if (lr < 0.15 && pr.sim.initialized) {
                    // a price limit a few spacings away in the swap direction
                    const k = R.int(1, 30);
                    const tt = Math.max(M.minUsable(s), Math.min(M.maxUsable(s), pr.sim.tick + (zfo ? -k : k) * s));
                    o.limit = M.sqrtAt(tt);
                } else if (lr < 0.18 && pr.sim.initialized) {
                    o.limit = zfo ? pr.sim.sqrtP + 1n : pr.sim.sqrtP - 1n; // wrong side: BAD_PRICE_LIMIT
                }
                if (R.next() < 0.05) o.minOut = -1n; // one more than possible: SLIPPAGE
                await swap(pr, user, zfo, amount, o);
            } else if (roll < 0.65) {
                // --- mint: ranges around, below, above, at the current tick, full range
                const base = Math.floor(pr.sim.tick / s) * s;
                const kind = R.int(0, 5);
                let tL: number;
                let tU: number;
                if (kind === 0) { tL = M.minUsable(s); tU = M.maxUsable(s); }
                else if (kind === 1) { tL = base; tU = base + s * R.int(1, 10); }          // lower edge at the price
                else if (kind === 2) { tU = base; tL = base - s * R.int(1, 10); }          // upper edge at the price (below)
                else { const c = base + s * R.int(-15, 15); tL = c - s * R.int(1, 12); tU = c + s * R.int(1, 12); }
                tL = Math.max(M.minUsable(s), tL);
                tU = Math.min(M.maxUsable(s), tU);
                if (tL >= tU) { tL = base - s; tU = base + s; }
                const a0 = R.next() < 0.15 ? 0n : R.big(toNano('0.001'), toNano('300'));
                const a1 = R.next() < 0.15 ? 0n : R.big(toNano('0.001'), toNano('300'));
                if (a0 === 0n && a1 === 0n) continue;
                // Native pools: the mint entry is chosen by which token the range needs.
                let x0 = a0;
                let x1 = a1;
                if (pr.sim.tick < tL) x1 = 0n;
                else if (pr.sim.tick >= tU) x0 = 0n;
                if (x0 === 0n && x1 === 0n) x0 = toNano('1');
                if (pr.sim.tick >= tU && x1 === 0n) x1 = toNano('1');
                if (pr.sim.tick < tL && x0 === 0n) x0 = toNano('1');
                const owner = R.next() < 0.8 ? user : R.pick(users);
                await mint(pr, user, tL, tU, x0, x1, owner);
            } else if (roll < 0.85) {
                // --- decrease / collect
                const mine = positions.filter((p) => p.pr === pr && p.liq > 0n);
                if (mine.length === 0) continue;
                const p = R.pick(mine);
                const k = R.next();
                const delta = k < 0.3 ? 0n : k < 0.6 ? p.liq : R.big(1n, p.liq);
                await decrease(p, delta, R.next() < 0.8 ? p.owner : R.pick(users));
            } else if (roll < 0.89) {
                // --- NFT transfer
                const mine = positions.filter((p) => p.pr === pr);
                if (mine.length === 0) continue;
                const p = R.pick(mine);
                const to = R.pick(users);
                const res = await p.pos.send(p.owner.getSender(), { value: toNano('0.1') }, {
                    $$type: 'NftTransfer', queryId: 9n, newOwner: to.address, responseDestination: p.owner.address,
                    customPayload: null, forwardAmount: 0n, forwardPayload: beginCell().storeBit(0).endCell().beginParse(),
                });
                expectNoFailures(res);
                p.owner = to;
                expect((await p.pos.getGetPositionData()).owner.equals(to.address)).toBe(true);
                count('nft transfer');
            } else if (roll < 0.94) {
                // --- time passes (volatility filter/decay periods, launch decay, LP lock)
                d.chain.now = d.now + R.pick([1, 5, 15, 31, 120, 400, 700, 1200]);
                count('time');
            } else if (roll < 0.96) {
                // --- protocol fee collection (anyone), always to the treasury
                const st = await pr.pool.getGetPoolState();
                const res = await d.router.send(user.getSender(), { value: toNano('0.3') }, {
                    $$type: 'CollectProtocolFees', queryId: 3n,
                    key: { $$type: 'PoolKey', token0: st.key.token0, token1: st.key.token1, tickSpacing: st.key.tickSpacing, ext: st.key.ext },
                });
                expectNoFailures(res);
                if (pr.native) {
                    expect(gramPayouts(res, d.treasury.address).filter((x) => x.reason === REASON.PROTOCOL_FEE).map((x) => x.amount))
                        .toEqual(pr.sim.protocolFees0 > 0n ? [pr.sim.protocolFees0] : []);
                } else {
                    bump(d.treasury.address, pr.t0, pr.sim.protocolFees0);
                }
                bump(d.treasury.address, pr.t1, pr.sim.protocolFees1);
                pr.sim.protocolFees0 = 0n;
                pr.sim.protocolFees1 = 0n;
                count('protocol collect');
                if (pr.native) {
                    // TAX: anyone triggers, the key's taxRecipient gets exactly the accrued tax.
                    const r2 = await d.collectTax(user, st.key);
                    expectNoFailures(r2);
                    expect(gramPayouts(r2, taxman.address).filter((x) => x.reason === REASON.TAX).map((x) => x.amount))
                        .toEqual(pr.sim.taxFees > 0n ? [pr.sim.taxFees] : []);
                    pr.sim.taxFees = 0n;
                    count('tax collect');
                    // PLATFORM FEE: anyone flushes the carried (sub-minimum) fees to the treasury.
                    const r3 = await collectPlatform(user, st.key);
                    expectNoFailures(r3);
                    expect(gramPayouts(r3, d.treasury.address).filter((x) => x.reason === REASON.PLATFORM).map((x) => x.amount))
                        .toEqual(pr.sim.platformFees > 0n ? [pr.sim.platformFees] : []);
                    if (pr.sim.platformFees > 0n) count('platform collect');
                    pr.sim.platformFees = 0n;
                }
            } else if (roll < 0.975 && pr.hook) {
                // --- hook collects its share
                const res = await pr.hook.send(d.carol.getSender(), { value: toNano('0.5') }, {
                    $$type: 'HookCmd', target: pr.pool.address, value: toNano('0.3'), bounce: true,
                    body: beginCell().store(storeHookCollectFees({ $$type: 'HookCollectFees', queryId: 0n })).endCell(),
                });
                expectNoFailures(res);
                expect(gramPayouts(res, pr.hook.address).filter((x) => x.reason === REASON.HOOK_FEE).map((x) => x.amount))
                    .toEqual(pr.sim.hookFees0 > 0n ? [pr.sim.hookFees0] : []);
                bump(pr.hook.address, pr.t1, pr.sim.hookFees1);
                pr.sim.hookFees0 = 0n;
                pr.sim.hookFees1 = 0n;
                count('hook collect');
            } else if (roll < 0.99 && pr.hook) {
                // --- hook sets the base fee within [100, 20000]
                const fee = BigInt(R.int(100, 20000));
                const res = await pr.hook.send(d.carol.getSender(), { value: toNano('0.2') }, {
                    $$type: 'HookCmd', target: pr.pool.address, value: toNano('0.05'), bounce: true,
                    body: beginCell().store(storeHookSetFee({ $$type: 'HookSetFee', queryId: 0n, feePips: fee })).endCell(),
                });
                expectNoFailures(res);
                pr.sim.fs.hookFeeSet = true;
                pr.sim.fs.hookFeePips = fee;
                count('hook set fee');
            } else {
                // --- admin changes the protocol share within the cap
                const bps = BigInt(R.int(0, 2500));
                const st = await pr.pool.getGetPoolState();
                const res = await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, {
                    $$type: 'SetProtocolShare', queryId: 4n, shareBps: bps,
                    key: { $$type: 'PoolKey', token0: st.key.token0, token1: st.key.token1, tickSpacing: st.key.tickSpacing, ext: st.key.ext },
                });
                expectNoFailures(res);
                pr.sim.fs.protocolShareBps = bps;
                count('protocol share');
            }
            await checkPools(`op ${i}`, i % 10 === 9);
            await checkLedger();
        }
    });

    it('everyone exits: all positions withdrawn, all fees collected, only rounding dust remains', async () => {
        d.chain.now = d.now + 3600; // past every LP lock
        for (const p of positions) {
            if (p.liq > 0n) await decrease(p, p.liq, p.owner);
            // A last collect is a no-op (fees were paid with the full decrease).
            const g = await p.pr.pool.getGetPositionAmounts(BigInt(p.tL), BigInt(p.tU), p.liq, p.fg0, p.fg1, 0n);
            expect(g.fees0 + g.fees1).toBe(0n);
        }
        for (const pr of pools) {
            const st = await pr.pool.getGetPoolState();
            const res = await d.router.send(d.bob.getSender(), { value: toNano('0.3') }, {
                $$type: 'CollectProtocolFees', queryId: 3n,
                key: { $$type: 'PoolKey', token0: st.key.token0, token1: st.key.token1, tickSpacing: st.key.tickSpacing, ext: st.key.ext },
            });
            expectNoFailures(res);
            if (!pr.native) bump(d.treasury.address, pr.t0, pr.sim.protocolFees0);
            bump(d.treasury.address, pr.t1, pr.sim.protocolFees1);
            pr.sim.protocolFees0 = 0n;
            pr.sim.protocolFees1 = 0n;
            if (pr.native) {
                const r3 = await d.collectTax(d.bob, st.key);
                expectNoFailures(r3);
                expect(gramPayouts(r3, taxman.address).filter((x) => x.reason === REASON.TAX).map((x) => x.amount))
                    .toEqual(pr.sim.taxFees > 0n ? [pr.sim.taxFees] : []);
                pr.sim.taxFees = 0n;
                const r4 = await collectPlatform(d.bob, st.key);
                expectNoFailures(r4);
                expect(gramPayouts(r4, d.treasury.address).filter((x) => x.reason === REASON.PLATFORM).map((x) => x.amount))
                    .toEqual(pr.sim.platformFees > 0n ? [pr.sim.platformFees] : []);
                pr.sim.platformFees = 0n;
            }
            if (pr.hook) {
                const r2 = await pr.hook.send(d.carol.getSender(), { value: toNano('0.5') }, {
                    $$type: 'HookCmd', target: pr.pool.address, value: toNano('0.3'), bounce: true,
                    body: beginCell().store(storeHookCollectFees({ $$type: 'HookCollectFees', queryId: 0n })).endCell(),
                });
                expectNoFailures(r2);
                bump(pr.hook.address, pr.t1, pr.sim.hookFees1);
                pr.sim.hookFees0 = 0n;
                pr.sim.hookFees1 = 0n;
            }
        }
        await checkPools('exit', true);
        await checkLedger();
        for (const pr of pools) {
            const st = await pr.pool.getGetPoolState();
            expect(st.liquidity).toBe(0n);
            expect(st.tickCount).toBe(0n);
            expect(st.protocolFees0 + st.protocolFees1 + st.hookFees0 + st.hookFees1 + st.taxFees + st.platformFees).toBe(0n);
            // Rounding always favours the pool, by a few units per operation at most.
            expect(st.reserve0).toBeLessThan(BigInt(10 * (OPS + 10)));
            expect(st.reserve1).toBeLessThan(BigInt(10 * (OPS + 10)));
            // eslint-disable-next-line no-console
            console.log(`${pr.name}: dust left reserve0=${st.reserve0} reserve1=${st.reserve1}`);
        }
    });
});
