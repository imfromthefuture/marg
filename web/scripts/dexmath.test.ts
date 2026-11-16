// Checks web/src/dexmath.ts against the DEX reference model (dex/v2/tests/model.ts).
// Run from the repo root with node (it compiles the types):
//   node --experimental-transform-types --no-warnings web/scripts/dexmath.test.ts
import assert from 'node:assert/strict';
import * as w from '../src/dexmath.ts';
import * as m from '../../dex/v2/tests/model.ts';

let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log('ok', name); };

// Deterministic pseudo-random numbers.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const rint = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const rbig = (max: bigint) => (BigInt(Math.floor(rnd() * 2 ** 52)) * max) / 2n ** 52n;

check('sqrtAt == model at 2000 ticks and the bounds', () => {
    for (const t of [m.MIN_TICK, m.MAX_TICK, 0, 1, -1]) assert.equal(w.sqrtAt(t), m.sqrtAt(t));
    for (let i = 0; i < 2000; i++) {
        const t = rint(m.MIN_TICK, m.MAX_TICK);
        assert.equal(w.sqrtAt(t), m.sqrtAt(t));
    }
});

check('tickAt == model (binary search) for random prices, tick edges and bounds', () => {
    for (let i = 0; i < 400; i++) {
        const t = rint(m.MIN_TICK, m.MAX_TICK - 1);
        const s = m.sqrtAt(t);
        assert.equal(w.tickAt(s), m.tickAt(s));
        assert.equal(w.tickAt(s - 1n > m.MIN_SQRT_RATIO ? s - 1n : s), m.tickAt(s - 1n > m.MIN_SQRT_RATIO ? s - 1n : s));
        const mid = s + rbig(m.sqrtAt(t + 1) - s);
        assert.equal(w.tickAt(mid), m.tickAt(mid));
    }
    assert.equal(w.tickAt(m.MIN_SQRT_RATIO), m.MIN_TICK);
    assert.equal(w.tickAt(m.MAX_SQRT_RATIO - 1n), m.MAX_TICK - 1);
});

check('price <-> tick <-> sqrtPriceX96 round trips', () => {
    for (const p of [1e-12, 2.6e-6, 0.001, 1, 3.14159, 1e6, 1e15]) {
        const t = w.priceToTick(p);
        const back = w.tickToPrice(t);
        assert.ok(Math.abs(back / p - 1) < 1e-4, `price ${p} -> tick ${t} -> ${back}`);
        const sp = w.sqrtToPrice(m.sqrtAt(t));
        assert.ok(Math.abs(sp / back - 1) < 1e-9, `sqrtToPrice ${sp} vs ${back}`);
        assert.equal(w.tickAt(w.priceToSqrt(p)), t);
    }
    // Market cap of a launch at sqrtPriceX96 (launch/README: 1e18 · 2^192 / sqrtP^2).
    const s = m.sqrtAt(-140000);
    assert.equal(w.mcapNano(s), (10n ** 18n * 2n ** 192n) / (s * s));
});

check('rangeToTicks: usable, ordered, at least one spacing, higher price = lower tick', () => {
    for (const s of [1, 10, 60, 200]) {
        for (let i = 0; i < 200; i++) {
            const p = Math.exp((rnd() - 0.5) * 40);
            const a = p * (0.5 + rnd() * 0.5);
            const b = p * (1 + rnd());
            const [tL, tU] = w.rangeToTicks(a, b, s);
            assert.ok(tL < tU && tL % s === 0 && tU % s === 0);
            assert.ok(tL >= m.minUsable(s) && tU <= m.maxUsable(s));
            assert.ok(w.tickToPrice(tU) <= w.tickToPrice(tL));
        }
        assert.deepEqual(w.fullRange(s), [m.minUsable(s), m.maxUsable(s)]);
    }
});

check('depositFor: the model Pool mints the computed liquidity (±3) and refunds dust only', () => {
    let inRange = 0;
    for (let i = 0; i < 600; i++) {
        const s = [1, 10, 60, 200][i % 4];
        const sim = new m.PoolSim(s);
        const t0 = rint(-200000, 200000);
        const sqrtInit = m.sqrtAt(t0) + rbig(m.sqrtAt(t0 + 1) - m.sqrtAt(t0));
        const width = rint(1, 400) * s;
        const offset = rint(-500, 500) * s;
        const tL = Math.floor(t0 / s) * s + offset - Math.floor(width / s / 2) * s;
        const tU = tL + width;
        if (tL < m.minUsable(s) || tU > m.maxUsable(s)) continue;
        const tick = m.tickAt(sqrtInit);
        const side: 0 | 1 = (rnd() < 0.5 ? 0 : 1);
        const sides = w.rangeSides(tick, tL, tU);
        const fixed: 0 | 1 = sides.need0 && sides.need1 ? side : sides.need0 ? 0 : 1;
        const amount = 10n ** 9n + rbig(10n ** 15n);
        const d = w.depositFor(tick, sqrtInit, tL, tU, fixed, amount);
        if (d.L < 1000n) continue;
        const res = sim.mint(tL, tU, d.a0, d.a1, 0n, sqrtInit, 0n, m.PRESETS[s]);
        assert.equal(res.code, 0, `mint code ${res.code}`);
        assert.ok(res.use0 <= d.a0 && res.use1 <= d.a1);
        // The Pool may step L down by up to 3 so the rounded-up amounts fit (model.ts mint).
        assert.ok(res.liq - d.L <= 3n && d.L - res.liq <= 3n, `liq ${res.liq} vs ${d.L}`);
        if (sides.need0 && sides.need1) {
            inRange++;
            // The leg the user did not type is only rounding above what the Pool uses.
            const other = fixed === 0 ? d.a1 - res.use1 : d.a0 - res.use0;
            assert.ok(other <= 2n + (fixed === 0 ? d.a1 : d.a0) / 10n ** 9n, `excess ${other}`);
        }
        const ref = m.amountsForLiquidity(tick, sqrtInit, tL, tU, d.L, true);
        const mine = w.amountsForLiquidity(tick, sqrtInit, tL, tU, d.L, true);
        assert.equal(mine.a0, ref.a);
        assert.equal(mine.a1, ref.b);
        assert.equal(w.liquidityForAmounts(sqrtInit, m.sqrtAt(tL), m.sqrtAt(tU), d.a0, d.a1),
            m.liquidityForAmounts(sqrtInit, m.sqrtAt(tL), m.sqrtAt(tU), d.a0, d.a1));
    }
    assert.ok(inRange > 50, `only ${inRange} in-range cases`);
});

check('slippage: minOut, price band and the model swap honouring minOut', () => {
    assert.equal(w.minOutFor(1_000_000n, 100), 990_000n);
    assert.equal(w.minOutFor(999n, 300), 969n);
    const sim = new m.PoolSim(60);
    const init = m.sqrtAt(-60000);
    assert.equal(sim.mint(-120000, 0, 10n ** 15n, 10n ** 15n, 0n, init, 1000n, m.PRESETS[60]).code, 0);
    const quote = sim.swap(true, 10n ** 12n, 0n, 24, 0n, false, 0n, 1000n, false);
    assert.equal(quote.code, 0);
    const minOut = w.minOutFor(quote.out, 100);
    assert.equal(sim.swap(true, 10n ** 12n, 0n, 24, 0n, false, minOut, 1000n, false).code, 0);
    assert.notEqual(sim.swap(true, 10n ** 12n, 0n, 24, 0n, false, quote.out + 1n, 1000n, false).code, 0);
    const impact = w.priceImpact(init, quote.sqrtP);
    assert.ok(impact > 0 && impact < 1);
    const [lo, hi] = w.sqrtBand(init, 100);
    assert.ok(lo < init && hi > init);
    assert.ok(Math.abs(Number(hi * 10n ** 6n / init) / 1e6 - Math.sqrt(1.01)) < 1e-5);
    assert.equal(w.launchExtra(150_000n, 300n, 1000n, 1000n), m.launchExtra(150_000n, 300n, 1000n, 1000n));
    assert.equal(w.launchExtra(150_000n, 300n, 1000n, 1150n), m.launchExtra(150_000n, 300n, 1000n, 1150n));
    assert.equal(w.launchExtra(150_000n, 300n, 1000n, 1400n), 0n);
});

console.log(`${n} checks passed`);
