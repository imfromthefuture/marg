// v4 regression tests for the DEX side of the security issue register (pitch/issue-register.md).
// Each test replays the scenario of an earlier attack PoC and asserts that the attack now FAILS
// (the fixed behaviour holds):
//  - V3-M2   a refused PositionDecrease no longer pays the pool's surplus to the owner (was audit4-burn-surplus)
//  - R8B-2 / R9B-6   Router SetPlatformFee has a floor of 85 bps (0.85%) and a cap of 100
//  - R6A-4   CollectProtocolFees needs PROTOCOL_COLLECT_GAS; Router rent reserve 0.55 (was audit8a-payfees)
//  - v3 fixes R2-H1, R2-M2, M-1, M-2, L-3 and the surplus sweep (was audit3-v3)
import { Address, beginCell, Dictionary, toNano } from '@ton/core';
import { Blockchain } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, expectNoFailures, refundCodes, swapEvents, gasAt, extCell, gramPayouts, OP, isqrt, txOk,
    failedAt, REASON, CODES, modifyEvents,
} from './helpers';

jest.setTimeout(1_800_000);

const sqrtOfTick = (t: number) => isqrt(BigInt(Math.floor(1.0001 ** t * 2 ** 40)) << 152n);
const poolTx = (res: any, pool: Address) => res.transactions.filter((t: any) => (t.inMessage?.info.dest as Address)?.equals?.(pool));
const own = (x: any): bigint => x.reserve0 + x.protocolFees0 + x.hookFees0 + x.taxFees + x.platformFees;
const keepOf = (st: any) => toNano('0.05') + st.tickCount * toNano('0.02') + st.endowment + own(st);

// Config params 20 / 21: gas price in nanoGram per gas.
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

// Gram stranded in the pool: a non-bounceable message whose compute fails (stand-in for any failed
// Router -> Pool transaction, which v3 keeps for SweepPoolSurplus -> treasury).
async function strand(d: Dex, pool: Address, amount: bigint) {
    const victim = await d.chain.treasury('victim', { balance: toNano('10000') });
    await victim.send({ to: pool, value: amount, bounce: false, body: beginCell().storeUint(0x4d480021, 32).storeUint(0, 8).endCell() });
}

describe('V3-M2: a refused decrease never pays the pool surplus to the position owner', () => {
    it('300 Gram stranded in the pool: a decrease refused by the Pool (deadline 1) returns at most the caller\'s value; SweepPoolSurplus sends the surplus to the treasury', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -6000n, 6000n, toNano('1000'), { sqrtPriceInit: Q96 }));
        await strand(d, pool.address, toNano('300'));
        const st = await pool.getGetPoolState();
        const surplus = (await d.gram(pool.address)) - keepOf(st);
        expect(surplus).toBeGreaterThan(toNano('299'));

        // The attacker opens a dust position (anyone can on a plain key) ...
        const eve = d.carol;
        expectNoFailures(await d.mintNative(eve, toNano('0.001'), d.tokA, 600n, 1200n, {}));
        const idx = (await pool.getGetPoolState()).nextPositionId - 1n;
        const pos = await d.position(pool, idx);
        const st1 = await pool.getGetPoolState();
        const pool1 = await d.gram(pool.address);
        const eve0 = await d.gram(eve.address);
        // ... and sends a decrease the Pool refuses: deadline already passed (the Position does not check it).
        const value = toNano('0.3');
        const res = await d.decrease(pos, eve, 0n, { deadline: 1n, value });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.DEADLINE]);
        expect(modifyEvents(res)).toEqual([]);
        const gain = (await d.gram(eve.address)) - eve0;
        // The caller gets back its own value minus gas (plus at most its Position's own spare Gram), never the surplus;
        // the pool keeps its whole balance from before the message.
        expect(gain).toBeLessThan(toNano('0.01'));
        expect(-gain).toBeLessThan(value);
        expect(await d.gram(pool.address)).toBeGreaterThanOrEqual(pool1);
        const st2 = await pool.getGetPoolState();
        expect(st2.reserve0).toBe(st1.reserve0);
        expect((await pos.getGetPositionData()).busy).toBe(false);
        // The surplus is still in the pool ...
        expect((await d.gram(pool.address)) - keepOf(st2)).toBeGreaterThan(toNano('299'));
        // ... and SweepPoolSurplus (anyone) sends it to the treasury.
        const tr0 = await d.gram(d.treasury.address);
        const sw = await d.router.send(d.alice.getSender(), { value: toNano('0.2') }, { $$type: 'SweepPoolSurplus', queryId: 0n, key: st.key });
        expectNoFailures(sw);
        expect((await d.gram(d.treasury.address)) - tr0).toBeGreaterThan(toNano('299'));
        expect(gramPayouts(sw, d.treasury.address).map((x) => x.reason)).toEqual([REASON.SURPLUS]);
        await d.checkSolvency([pool]);
        // The LP and the attacker can still withdraw their own liquidity.
        const pd = await (await d.position(pool, 0n)).getGetPositionData();
        expectNoFailures(await d.decrease(await d.position(pool, 0n), d.alice, pd.liquidity, { value: toNano('0.3') }));
    });
});

describe('R8B-2 / R9B-6: Router SetPlatformFee floor', () => {
    it('refuses bps < 85 ("Fee below floor") and > 100; accepts every rate in 85..100; only the admin', async () => {
        const d = await Dex.create();
        const set = (bps: bigint, from = d.admin) =>
            d.router.send(from.getSender(), { value: toNano('0.1') }, { $$type: 'SetPlatformFee', queryId: 0n, bps });
        expect(await d.router.getGetPlatformFee()).toBe(100n);
        for (const bad of [0n, 1n, 50n, 74n, 75n, 84n, 101n, 1000n]) {
            const res = await set(bad);
            expect(failedAt(res, d.router.address).length).toBe(1);
            expect(await d.router.getGetPlatformFee()).toBe(100n);
        }
        for (const ok of [85n, 86n, 90n, 99n, 100n, 85n]) {
            expectNoFailures(await set(ok));
            expect(await d.router.getGetPlatformFee()).toBe(ok);
        }
        expect(failedAt(await set(100n, d.bob), d.router.address).length).toBe(1);
        expect(await d.router.getGetPlatformFee()).toBe(85n);
    });
});

describe('R6A-4 / R8A-4: CollectProtocolFees value and the Router reserve (was audit8a-payfees)', () => {
    let d: Dex;
    let pool: any;
    let pj: any;
    let key: any;
    let keyJ: any;
    let snap: any;

    beforeAll(async () => {
        d = await Dex.create();
        pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -6000n, 6000n, toNano('1000'), { sqrtPriceInit: Q96 }));
        pj = await d.poolOf(d.tokA, d.tokB, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), d.tokB, -1200n, 1200n, 0n, { viaAccount: true, sqrtPriceInit: Q96 }));
        expectNoFailures(await d.mintJetton(d.jB, d.alice, toNano('1000'), d.tokA, -1200n, 1200n, 0n, { viaAccount: true, sqrtPriceInit: Q96 }));
        expect((await pj.getGetPoolState()).initialized).toBe(true);
        const s = await pool.getGetPoolState();
        key = { $$type: 'PoolKey', token0: s.key.token0, token1: s.key.token1, tickSpacing: s.key.tickSpacing, ext: s.key.ext };
        const sj = await pj.getGetPoolState();
        keyJ = { $$type: 'PoolKey', token0: sj.key.token0, token1: sj.key.token1, tickSpacing: sj.key.tickSpacing, ext: sj.key.ext };
        expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('25'), d.tokB));
        expectNoFailures(await d.swapJetton(d.jB, d.bob, toNano('40'), d.tokA));
        expectNoFailures(await d.swapNative(d.bob, toNano('30'), d.tokA));
        expectNoFailures(await d.swapJetton(d.jA, d.bob, toNano('70'), GRAM));
        const sj2 = await pj.getGetPoolState();
        expect(sj2.protocolFees0).toBeGreaterThan(0n);
        expect(sj2.protocolFees1).toBeGreaterThan(0n);
        snap = d.chain.snapshot();
    });

    it('0.2 Gram (the old COLLECT_GAS) is refused at the Router and bounced; nothing is left in the pool. Exactly 0.35 pays both jetton legs at 67 and 400 nanoGram/gas and returns the change', async () => {
        const config0 = d.chain.config;
        for (const [name, p, k] of [['jetton/jetton', pj, keyJ], ['Gram/jetton', pool, key]] as const) {
            for (const price of [67n, 400n]) {
                await d.chain.loadFrom(snap);
                d.chain.setConfig(config0);
                setGasPrice(d.chain, price);
                const s0 = await p.getGetPoolState();
                const g0 = await d.gram(p.address);
                // The old minimum: the Router refuses before anything reaches the pool; the value bounces.
                let res = await d.router.send(d.carol.getSender(), { value: toNano('0.2') }, { $$type: 'CollectProtocolFees', queryId: 2n, key: k });
                expect(failedAt(res, d.router.address).length).toBe(1);
                expect(res.transactions.some((t: any) => (t.inMessage?.info.dest as Address)?.equals?.(p.address))).toBe(false);
                expect(await d.gram(p.address)).toBe(g0);
                // Exactly PROTOCOL_COLLECT_GAS: paid, the caller gets the change, no failure.
                const c0 = await d.gram(d.carol.address);
                res = await d.router.send(d.carol.getSender(), { value: toNano('0.35') }, { $$type: 'CollectProtocolFees', queryId: 2n, key: k });
                expectNoFailures(res);
                const s1 = await p.getGetPoolState();
                expect([s1.protocolFees0, s1.protocolFees1]).toEqual([0n, 0n]);
                const back = res.transactions.filter((t: any) => (t.inMessage?.info.dest as Address)?.equals?.(d.carol.address) && t.inMessage?.info.type === 'internal');
                expect(back.length).toBeGreaterThanOrEqual(1);
                expect(c0 - (await d.gram(d.carol.address))).toBeLessThan(toNano('0.35'));
                if (name === 'Gram/jetton') {
                    expect(gramPayouts(res, d.treasury.address).map((x) => [x.reason, x.amount, x.value]))
                        .toEqual([[REASON.PROTOCOL_FEE, s0.protocolFees0, s0.protocolFees0 + toNano('0.01')]]);
                }
                await d.checkSolvency([p]);
            }
        }
        d.chain.setConfig(config0);
    });

    it('WithdrawRouterExcess leaves ROUTER_RENT_RESERVE (0.55); admin only; after 10 idle years the Router has no storage debt', async () => {
        await d.chain.loadFrom(snap);
        await d.router.send(d.carol.getSender(), { value: toNano('2') }, null);
        let res = await d.router.send(d.admin.getSender(), { value: toNano('0.05') }, { $$type: 'WithdrawRouterExcess', queryId: 1n });
        expectNoFailures(res);
        expect(await d.gram(d.router.address)).toBe(toNano('0.55'));
        res = await d.router.send(d.bob.getSender(), { value: toNano('0.05') }, { $$type: 'WithdrawRouterExcess', queryId: 1n });
        expect(failedAt(res, d.router.address).length).toBe(1);
        d.chain.now = d.now + 10 * 365 * 86400;
        res = await d.router.send(d.admin.getSender(), { value: toNano('0.05') }, { $$type: 'WithdrawRouterExcess', queryId: 1n });
        const rtx: any = res.transactions.find((t) => t.inMessage?.info.dest?.toString() === d.router.address.toString())!.description;
        expect(rtx.storagePhase?.storageFeesDue ?? 0n).toBe(0n);
    });
});

// ---------------------------------------------------------------------------
// v3 fixes (was audit3-v3)
// ---------------------------------------------------------------------------

// The F1b layout (plain pool or hook key, spacing 1): 24 dust ticks between checkpoints, deep trie.
async function adversarial(ext: any) {
    const d = await Dex.create();
    const o = { tickSpacing: 1n, ext };
    await d.poolOf(GRAM, d.tokA, 1n, ext);
    const B = 32512;
    expectNoFailures(await d.mintJetton(d.jA, d.alice, 50_000_000_000_000_000n, GRAM, BigInt(B - 4000), BigInt(B + 4000), toNano('3000000'),
        { ...o, sqrtPriceInit: sqrtOfTick(B - 3) }));
    for (let k = 0; k < 24; k += 2) {
        expectNoFailures(await d.mintNative(d.carol, 100_000_000n, d.tokA, BigInt(B + 8 * k + 4), BigInt(B + 8 * k + 12), o));
    }
    for (let j = 8; j <= 14; j++) {
        if (((B >> j) & 1) === 0) continue;
        const t = B - (1 << j);
        expectNoFailures(await d.mintJetton(d.jA, d.carol, 100_000_000n, GRAM, BigInt(t), BigInt(t + 1), 0n, o));
    }
    for (let j = 8; j <= 19; j++) {
        if (((B >> j) & 1) === 1) continue;
        const t = B + (1 << j);
        expectNoFailures(await d.mintNative(d.carol, 100_000_000n, d.tokA, BigInt(t), BigInt(t + 1), o));
    }
    d.chain.now = d.now + 600;
    expectNoFailures(await d.swapJetton(d.jA, d.carol, 40_000_000_000_000_000n, GRAM, { ...o, maxCrossings: 24n, allowPartial: true }));
    d.chain.now = d.now + 5;
    return { d, o, pool: await d.poolOf(GRAM, d.tokA, 1n, ext) };
}

describe('R2-H1: no swap can run out of gas on an adversarial tick layout; nothing is stranded', () => {
    for (const hooked of [false, true]) {
        for (const allowPartial of [true, false]) {
            it(`${hooked ? 'hook key (after-swap hook, 20% share)' : 'plain pool'}, allowPartial ${allowPartial}: the victim swap completes under the gas limit`, async () => {
                const tmp = await Dex.create();
                const ext = hooked ? extCell({ hook: (await tmp.chain.treasury('carol')).address, hookFlags: 1n, hookShareBps: 2000n }) : null;
                const { d, o, pool } = await adversarial(ext);
                const st = await pool.getGetPoolState();
                const pool0 = await d.gram(pool.address);
                const bob0 = await d.gram(d.bob.address);
                const res = await d.swapNative(d.bob, toNano('500000'), d.tokA, {
                    ...o, maxCrossings: 24n, allowPartial,
                    ...(ext ? { referral: d.carol.address, refBps: 10n, fwdTon: toNano('0.05'), fwdPayload: beginCell().storeUint(1, 32).endCell(), gas: toNano('1') } : {}),
                });
                const cp: any = (poolTx(res, pool.address)[0].description as any).computePhase;
                const ev = swapEvents(res)[0];
                expect(cp.success).toBe(true);
                expect(cp.gasUsed).toBeLessThan(950_000n);
                expect(res.transactions.filter((t: any) => !txOk(t)).length).toBe(0);
                const st2 = await pool.getGetPoolState();
                // Everything bob paid that the pool did not book came back.
                expect((await d.gram(pool.address)) - pool0 - (own(st2) - own(st))).toBeLessThan(toNano('0.01'));
                if (!allowPartial && ev === undefined) expect(bob0 - (await d.gram(d.bob.address))).toBeLessThan(toNano('1'));
            });
        }
    }

    it('max-feature taxed key (hook + tax + platform fee + referral + forward payload) whose own initializer lays out the ticks: under the gas limit, nothing stranded', async () => {
        const tmp = await Dex.create();
        const carol = await tmp.chain.treasury('carol');
        const dave = await tmp.chain.treasury('dave');
        const ext = extCell({
            hook: dave.address, hookFlags: 1n, hookShareBps: 2000n, initializer: carol.address,
            taxRecipient: dave.address, buyTaxBps: 1000n, sellTaxBps: 1000n,
        });
        const d = await Dex.create();
        await d.chain.treasury('dave');
        const o = { tickSpacing: 1n, ext };
        const pool = await d.poolOf(GRAM, d.tokA, 1n, ext);
        const B = 32512;
        expectNoFailures(await d.mintJetton(d.jA, d.carol, 50_000_000_000_000_000n, GRAM, BigInt(B - 4000), BigInt(B + 4000), toNano('3000000'),
            { ...o, sqrtPriceInit: sqrtOfTick(B - 3) }));
        for (let k = 0; k < 24; k += 2) {
            expectNoFailures(await d.mintNative(d.carol, 100_000_000n, d.tokA, BigInt(B + 8 * k + 4), BigInt(B + 8 * k + 12), o));
        }
        for (let j = 8; j <= 14; j++) {
            if (((B >> j) & 1) === 0) continue;
            expectNoFailures(await d.mintJetton(d.jA, d.carol, 100_000_000n, GRAM, BigInt(B - (1 << j)), BigInt(B - (1 << j) + 1), 0n, o));
        }
        for (let j = 8; j <= 19; j++) {
            if (((B >> j) & 1) === 1) continue;
            expectNoFailures(await d.mintNative(d.carol, 100_000_000n, d.tokA, BigInt(B + (1 << j)), BigInt(B + (1 << j) + 1), o));
        }
        d.chain.now = d.now + 600;
        expectNoFailures(await d.swapJetton(d.jA, d.carol, 40_000_000_000_000_000n, GRAM, { ...o, maxCrossings: 24n, allowPartial: true }));
        d.chain.now = d.now + 5;
        const st = await pool.getGetPoolState();
        const p0 = await d.gram(pool.address);
        const res = await d.swapNative(d.bob, toNano('500000'), d.tokA, {
            ...o, maxCrossings: 24n, allowPartial: true, referral: d.carol.address, refBps: 10n,
            fwdTon: toNano('0.05'), fwdPayload: beginCell().storeUint(1, 32).endCell(), gas: toNano('1'),
        });
        const cp: any = (poolTx(res, pool.address)[0].description as any).computePhase;
        expect(cp.success).toBe(true);
        expect(cp.gasUsed).toBeLessThan(950_000n);
        expect(res.transactions.filter((t: any) => !txOk(t)).length).toBe(0);
        const st2 = await pool.getGetPoolState();
        expect((await d.gram(pool.address)) - p0 - (own(st2) - own(st))).toBeLessThan(toNano('0.01'));
    });

    it('24 crossings over shallow ticks fill completely (the gas guard never triggers on ordinary swaps)', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('100000'), GRAM, -60000n, 60000n, toNano('100000'), { sqrtPriceInit: Q96 }));
        for (let i = 1; i <= 24; i++) {
            expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('10'), GRAM, BigInt(-60 * i), BigInt(-60 * i + 60), 0n));
        }
        const res = await d.swapJetton(d.jA, d.bob, toNano('5000'), GRAM, { maxCrossings: 24n, allowPartial: true });
        expectNoFailures(res);
        expect(swapEvents(res)[0].stop).not.toBe(5n);
        expect(gasAt(res, pool.address, OP.PoolSwap)[0]).toBeLessThan(1_000_000n);
    });
});

describe('v3: unaccounted Gram is never paid to the next caller and can be swept to the treasury', () => {
    it('stranded Gram stays through a buy and a sell; SweepPoolSurplus sends it to the treasury; a second sweep finds nothing; LPs withdraw', async () => {
        const d = await Dex.create();
        const pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -6000n, 6000n, toNano('1000'), { sqrtPriceInit: Q96 }));
        const eve = await d.chain.treasury('eve', { balance: toNano('10000') });
        await strand(d, pool.address, toNano('300'));
        const st = await pool.getGetPoolState();
        expect((await d.gram(pool.address)) - keepOf(st)).toBeGreaterThan(toNano('299'));
        const eve0 = await d.gram(eve.address);
        const jb = await d.jBal(d.jA, eve.address);
        expectNoFailures(await d.swapNative(eve, toNano('1'), d.tokA, { maxCrossings: 2n }));
        expect((await d.gram(eve.address)) - eve0).toBeLessThan(0n);
        expect((await d.jBal(d.jA, eve.address)) - jb).toBeGreaterThan(0n);
        const e1 = await d.gram(eve.address);
        const res = await d.swapJetton(d.jA, eve, await d.jBal(d.jA, eve.address), GRAM, { maxCrossings: 2n });
        expectNoFailures(res);
        expect((await d.gram(eve.address)) - e1).toBeLessThan(swapEvents(res)[0].amountOut);
        const tr0 = await d.gram(d.treasury.address);
        const c0 = await d.gram(d.carol.address);
        expectNoFailures(await d.router.send(d.carol.getSender(), { value: toNano('0.2') }, { $$type: 'SweepPoolSurplus', queryId: 0n, key: st.key }));
        expect((await d.gram(d.treasury.address)) - tr0).toBeGreaterThan(toNano('299'));
        expect(c0 - (await d.gram(d.carol.address))).toBeLessThan(toNano('0.05'));
        const tr1 = await d.gram(d.treasury.address);
        expectNoFailures(await d.router.send(d.carol.getSender(), { value: toNano('0.2') }, { $$type: 'SweepPoolSurplus', queryId: 0n, key: st.key }));
        expect(await d.gram(d.treasury.address)).toBe(tr1);
        const pos = await d.position(pool, 0n);
        const pd = await pos.getGetPositionData();
        const r = await d.decrease(pos, d.alice, pd.liquidity, { value: toNano('0.3') });
        expectNoFailures(r);
        expect(refundCodes(r)).toEqual([]);
    });
});

describe('v3 M-2: the Router treasury must be basechain', () => {
    it('SetTreasury to workchain -1 is refused; the treasury is unchanged', async () => {
        const d = await Dex.create();
        const res = await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, {
            $$type: 'SetTreasury', queryId: 0n, treasury: Address.parse('-1:' + '11'.repeat(32)),
        });
        expect(res.transactions.some((t: any) => !txOk(t))).toBe(true);
        expect((await d.router.getGetRouterData()).treasury.equals(d.treasury.address)).toBe(true);
    });
});

describe('v3 L-3: a collect or sweep with a key whose pool does not exist refunds the caller', () => {
    it('CollectTax / CollectPlatformFees / CollectProtocolFees / SweepPoolSurplus: no failure, the caller pays only gas and the new pool\'s storage', async () => {
        const d = await Dex.create();
        const key = { $$type: 'PoolKey' as const, token0: GRAM, token1: d.tokA, tickSpacing: 60n, ext: null };
        for (const m of ['CollectTax', 'CollectPlatformFees', 'CollectProtocolFees', 'SweepPoolSurplus'] as const) {
            const c0 = await d.gram(d.carol.address);
            const res = await d.router.send(d.carol.getSender(), { value: toNano('0.4') }, { $$type: m, queryId: 0n, key } as any);
            expect(res.transactions.filter((t: any) => !txOk(t)).length).toBe(0);
            expect(c0 - (await d.gram(d.carol.address))).toBeLessThan(toNano('0.12'));
        }
    });
});

describe('v3 M-1 / R2-M1: only the launch master adds liquidity to a launch pool', () => {
    it('a third-party range order on a launch key (Gram above the price, jettons below) is refused (218) and refunded', async () => {
        const d = await Dex.create();
        const taxTo = await d.chain.treasury('taxTo');
        const JET = 1_000_000_000_000_000_000n;
        expectNoFailures(await d.jA.send(d.admin.getSender(), { value: toNano('0.2') }, {
            $$type: 'TestMint', queryId: 0n, to: d.alice.address, amount: JET,
            responseDestination: d.admin.address, forwardTonAmount: 0n, forwardPayload: null,
        }));
        const LO = { tickSpacing: 10n, launchFeePips: 900000n, launchDuration: 15n, taxRecipient: taxTo.address, buyTaxBps: 500n, sellTaxBps: 500n };
        const key = await d.launchKey(d.tokA, d.alice.address, LO);
        const o = { tickSpacing: 10n, ext: key.ext };
        const pool = await d.poolOf(GRAM, d.tokA, 10n, key.ext);
        expectNoFailures(await d.launch(d.jA, d.alice, JET, isqrt((JET << 192n) / toNano('1500')), d.carol.address, d.alice.address, LO));
        const st = await pool.getGetPoolState();
        const t = Math.floor(Number(st.tick) / 10) * 10;
        const b0 = await d.gram(d.bob.address);
        let res = await d.mintNative(d.bob, toNano('50'), d.tokA, BigInt(t + 100), BigInt(t + 200), o);
        expect(refundCodes(res)).toContain(218);
        expect(b0 - (await d.gram(d.bob.address))).toBeLessThan(toNano('1'));
        expectNoFailures(await d.swapNative(d.bob, toNano('5'), d.tokA, { ...o, maxCrossings: 2n, allowPartial: true }));
        const jb = await d.jBal(d.jA, d.bob.address);
        res = await d.mintJetton(d.jA, d.bob, jb, GRAM, BigInt(t - 200), BigInt(t - 100), 0n, o);
        expect(refundCodes(res)).toContain(218);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb);
        expect((await pool.getGetPoolState()).nextPositionId).toBe(st.nextPositionId);
    });
});

describe('v3 R2-M2: storage rent is never charged to the next caller', () => {
    for (const years of [3, 10]) {
        it(`${years}y idle pool: buy, sell, mint and decrease all work and the buyer pays none of the pool's rent`, async () => {
            const d = await Dex.create();
            const pool = await d.poolOf(GRAM, d.tokA, 60n, null);
            expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, -6000n, 6000n, toNano('1000'), { sqrtPriceInit: Q96 }));
            for (let i = 1; i <= 20; i++) {
                expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1'), GRAM, BigInt(-6000 - 120 * i), BigInt(-6000 - 120 * i + 60), 0n));
            }
            const pos = await d.position(pool, 0n);
            d.chain.now = d.now + years * 365 * 86400;
            const snap = d.chain.snapshot();
            const stI = await pool.getGetPoolState();
            const p0 = await d.gram(pool.address);
            let res = await d.swapNative(d.bob, toNano('1'), d.tokA, { maxCrossings: 1n, gas: toNano('0.37') });
            expectNoFailures(res);
            const rent = BigInt((poolTx(res, pool.address)[0] as any).description.storagePhase?.storageFeesCollected ?? 0n);
            const stJ = await pool.getGetPoolState();
            // The pool's balance moved by what it booked minus its own rent: the buyer paid none of it.
            expect((await d.gram(pool.address)) - p0).toBe(own(stJ) - own(stI) - rent);
            await d.chain.loadFrom(snap);
            res = await d.swapJetton(d.jA, d.bob, toNano('1'), GRAM, { maxCrossings: 1n, gas: toNano('0.37') });
            expectNoFailures(res);
            const ev = swapEvents(res)[0];
            expect(gramPayouts(res, d.bob.address).reduce((s: bigint, x: any) => s + x.value, 0n)).toBeGreaterThan(ev.amountOut);
            await d.chain.loadFrom(snap);
            expectNoFailures(await d.mintNative(d.bob, toNano('5'), d.tokA, 6000n, 12000n, { gas: toNano('0.62') }));
            await d.chain.loadFrom(snap);
            res = await d.decrease(pos, d.alice, 1000n, { value: toNano('0.25') });
            expect(refundCodes(res)).toEqual([]);
            expect((await pos.getGetPositionData()).busy).toBe(false);
        });
    }
});
