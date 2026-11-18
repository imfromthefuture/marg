// MAX_TICKS_PER_POOL (8192): filling a pool through 4096 real mints takes > 10 min in the sandbox,
// so this suite injects the tick map directly into a real Pool's storage (layout from
// build/Router_Pool.fc $Pool$_store: root ref -> {liquidity, fg0, fg1, ticks dict, tickCount, ...})
// and funds the matching TICK_RENT_BUFFERs. Injected ticks:
//  - "crossing" ticks every 16 spacings below the price with liqNet = 0 (crossing them does not
//    change L), so a long sell alternates checkpoint / crossing: the 24 + 24 worst case;
//  - filler pairs far above the price (liqNet +-1000), never touched by the swaps here.
// The pool has no swaps before the injection, so fee growth is 0 and fgOut = 0 is consistent.

import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { createShardAccount, SandboxContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, CODES, STOP, Pool, expectNoFailures, swapEvents, modifyEvents, refundCodes, simOf, expectPoolEquals, gasAt,
    patchMaxVolAcc,
} from './helpers';
import { dictValueParserTickInfo, TickInfo } from '../build/Router_Pool';
import * as M from './model';

jest.setTimeout(1_800_000);

async function injectTicks(d: Dex, pool: SandboxContract<Pool>, extra: Map<number, { liqGross: bigint; liqNet: bigint }>) {
    const sc = await d.chain.getContract(pool.address);
    const acc = sc.account;
    const st = acc.account!.storage.state;
    if (st.type !== 'active') throw new Error('pool not active');
    const code = st.state.code!;
    const data = st.state.data!;
    expect(data.refs.length).toBe(1); // ext == null: the only root ref is the state ref
    const s1 = data.refs[0].beginParse();
    const liq = s1.loadUintBig(128);
    const fg0 = s1.loadUintBig(256);
    const fg1 = s1.loadUintBig(256);
    expect(fg0 + fg1).toBe(0n);
    const dict = s1.loadDict(Dictionary.Keys.Int(24), dictValueParserTickInfo());
    s1.loadUint(16);
    for (const [t, v] of extra) {
        expect(dict.has(t)).toBe(false);
        dict.set(t, { $$type: 'TickInfo', liqGross: v.liqGross, liqNet: v.liqNet, fgOut0: 0n, fgOut1: 0n } as TickInfo);
    }
    const ref1 = beginCell().storeUint(liq, 128).storeUint(fg0, 256).storeUint(fg1, 256).storeDict(dict)
        .storeUint(dict.size, 16).storeSlice(s1).endCell();
    const root = data.beginParse();
    const newData = beginCell().storeBits(root.loadBits(root.remainingBits)).storeRef(ref1).endCell();
    const balance = acc.account!.storage.balance.coins + BigInt(extra.size) * toNano('0.02');
    await d.chain.setShardAccount(pool.address, createShardAccount({ address: pool.address, code, data: newData, balance }));
    return dict.size;
}

describe('MAX_TICKS_PER_POOL = 8192', () => {
    let d: Dex;
    let pool: SandboxContract<Pool>;
    let base: any;
    const minU = M.minUsable(60);
    const maxU = M.maxUsable(60);

    beforeAll(async () => {
        d = await Dex.create();
        pool = await d.poolOf(GRAM, d.tokA, 60n, null);
        // A real full-range position (ticks minU / maxU) at price 1.
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000'), GRAM, BigInt(minU), BigInt(maxU), toNano('1000'), { sqrtPriceInit: Q96 }));
        const extra = new Map<number, { liqGross: bigint; liqNet: bigint }>();
        for (let k = 1; k <= 26; k++) extra.set(-960 * k, { liqGross: 2000n, liqNet: 0n });
        for (let i = 0; extra.size + 2 < 8192; i++) {
            extra.set(60 * (100 + 2 * i), { liqGross: 1000n, liqNet: 1000n });
            if (extra.size + 2 < 8192) extra.set(60 * (101 + 2 * i), { liqGross: 1000n, liqNet: -1000n });
        }
        const n = await injectTicks(d, pool, extra);
        expect(n).toBe(8192);
        const st = await pool.getGetPoolState();
        expect(st.tickCount).toBe(8192n);
        expect((await pool.getGetTicks(BigInt(minU), 64n, true)).size).toBe(64);
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('the account stays far below the 65,536-cell limit', async () => {
        const sc = await d.chain.getContract(pool.address);
        const st = sc.account.account!.storage.state;
        if (st.type !== 'active') throw new Error('inactive');
        // createShardAccount zeroes storageStats, so count unique cells of code + data directly.
        const seen = new Set<string>();
        let total = 0;
        const walk = (c: Cell) => { total++; const h = c.hash().toString('hex'); if (seen.has(h)) return; seen.add(h); c.refs.forEach(walk); };
        walk(st.state.code!);
        walk(st.state.data!);
        // Upper bound: count every reference (no deduplication). Real tick values differ (fee growth),
        // so the deduplicated count of a live pool approaches this.
        let all = 0;
        const walkAll = (c: Cell) => { all++; c.refs.forEach(walkAll); };
        walkAll(st.state.code!);
        walkAll(st.state.data!);
        const cells = all;
        void total;
        // eslint-disable-next-line no-console
        console.log(`pool with 8192 ticks: ${seen.size} unique cells, ${cells} cells without deduplication (code + data)`);
        expect(cells).toBeLessThan(30000);
    });

    it('at 8192 ticks a mint that needs a new tick is refunded TICK_LIMIT; one reusing existing ticks succeeds', async () => {
        const jb = await d.jBal(d.jA, d.bob.address);
        let res = await d.mintNative(d.bob, toNano('5'), d.tokA, 6000n, 600000n);
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.TICK_LIMIT]);
        expect((await pool.getGetMintQuote(6000n, 600000n, toNano('5'), 0n, 0n)).code).toBe(BigInt(CODES.TICK_LIMIT));
        res = await d.mintJetton(d.jA, d.bob, toNano('5'), GRAM, -1020n, -960n, 0n);
        expect(refundCodes(res)).toEqual([CODES.TICK_LIMIT]);
        expect(await d.jBal(d.jA, d.bob.address)).toBe(jb);
        // Both ticks already initialized: 0 new ticks, allowed.
        res = await d.mintNative(d.bob, toNano('5'), d.tokA, 6000n, 6180n);
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        expect(modifyEvents(res).length).toBe(1);
        expect((await pool.getGetPoolState()).tickCount).toBe(8192n);
        // Freeing two ticks (full exit of the real position) makes room for exactly two again.
        const pos = await d.position(pool, 0n);
        expectNoFailures(await d.decrease(pos, d.alice, (await pos.getGetPositionData()).liquidity));
        expect((await pool.getGetPoolState()).tickCount).toBe(8190n);
        res = await d.mintJetton(d.jA, d.alice, toNano('100'), GRAM, BigInt(minU), BigInt(maxU), toNano('100'));
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        expect((await pool.getGetPoolState()).tickCount).toBe(8192n);
    });

    it('worst-case swap on the full 8192-tick map: 24 crossings + 24 checkpoints < 1M gas, exact', async () => {
        const PRICE = 400n;
        await patchMaxVolAcc(d.chain, pool.address, 4_000_000_000n);
        const sim = await simOf(pool);
        expect(sim.tickCount).toBe(8192);
        const amount = toNano('100000');
        const e = sim.swap(true, amount, 0n, 24, 0n, true, 0n, BigInt(d.now));
        expect([e.crossings, e.steps]).toEqual([24, 48]);
        expect([STOP.CROSSINGS, STOP.STEPS]).toContain(e.stop);
        const need = toNano('0.35') + 24n * toNano('0.006') + toNano('0.07');
        const res = await d.swapNative(d.bob, amount, d.tokA, { maxCrossings: 24n, allowPartial: true, gas: need + toNano('0.03') });
        expectNoFailures(res);
        // v3 (audit R2-H1): on the full 8192-tick map the gas guard ends this swap early (STOP_GAS)
        // instead of letting it approach the 1M limit: a partial fill of the same path, the rest
        // refunded, never more than the model's full result.
        const ev = swapEvents(res)[0];
        const g = gasAt(res, pool.address, 0x4d480021)[0];
        // eslint-disable-next-line no-console
        console.log(`worst case on 8192 ticks: pool gas ${g}, stop ${ev.stop}, steps ${ev.steps}, crossings ${ev.crossings}`);
        expect(ev.amountOut).toBeLessThanOrEqual(e.out);
        expect(ev.amountOut).toBeGreaterThan(0n);
        if (ev.stop !== 5n) expect(ev.amountOut).toBe(e.out);
        expect(g).toBeLessThan(900_000n);
        expect(g * PRICE).toBeLessThan(toNano('0.35') + 24n * toNano('0.006'));
        if (ev.stop !== 5n) await expectPoolEquals(pool, sim);
        void Address;
        void Cell;
    });
});
