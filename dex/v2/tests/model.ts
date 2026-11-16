// Independent BigInt reference of the v2 math (Uniswap v3 TickMath / SqrtPriceMath / SwapMath /
// LiquidityMath, mod-2^256 fee growth, Meteora volatility fee, and the swap loop with virtual fee
// checkpoints). Ported from the Solidity sources and DESIGN.md, not from the Tact code.

export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
export const MAX_U256 = (1n << 256n) - 1n;
export const MAX_U128 = (1n << 128n) - 1n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
export const PIPS = 1_000_000n;
export const BPS = 10_000n;
export const MAX_STEPS = 48;
export const CHECKPOINT_SPACINGS = 8;
export const VA_UNIT = 10_000n;
export const MAX_DYNAMIC_FEE_PIPS = 50_000n;

// PLATFORM FEE (constants.tact). The scope switch is read from the contract source, so flipping
// PLATFORM_FEE_ALL_GRAM_POOLS there flips the model (and every test that uses platformCharged).
import * as fs_ from 'fs';
import * as path_ from 'path';
const CONSTS = fs_.readFileSync(path_.join(__dirname, '../contracts/constants.tact'), 'utf8');
export const PLATFORM_FEE_ALL_GRAM_POOLS = /const PLATFORM_FEE_ALL_GRAM_POOLS: Bool = true;/.test(CONSTS);
export const PLATFORM_FEE_CAP_BPS = 100n;
export const PLATFORM_MIN_PAYOUT = 10_000_000n;     // 0.01
export const TAX_MIN_PAYOUT = 100_000_000n;         // 0.1
export const TAX_PAYOUT_GAS = 40_000_000n;          // 0.04
export const PAYOUT_MSG_GAS = 10_000_000n;          // 0.01
// Pool.platformCharged(): Gram pools only; all of them or launch keys (an initializer) only.
export const platformCharged = (gramPool: boolean, initializer: unknown) =>
    gramPool && (PLATFORM_FEE_ALL_GRAM_POOLS || (initializer !== null && initializer !== undefined));

// floor division for possibly negative numerators (TVM semantics); BigInt `/` truncates.
export function fdiv(a: bigint, b: bigint): bigint {
    const q = a / b;
    return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}
const fdivN = (a: number, b: number) => Math.floor(a / b);
const mulDiv = (a: bigint, b: bigint, c: bigint) => (a * b) / c;
const mulDivC = (a: bigint, b: bigint, c: bigint) => { const p = a * b; return p / c + (p % c === 0n ? 0n : 1n); };
const divC = (a: bigint, b: bigint) => (a + b - 1n) / b;
const bmin = (a: bigint, b: bigint) => (a < b ? a : b);
const bmax = (a: bigint, b: bigint) => (a > b ? a : b);
const babs = (a: bigint) => (a < 0n ? -a : a);

export const addMod = (a: bigint, b: bigint) => (a + b) & MAX_U256;
export const subMod = (a: bigint, b: bigint) => (a - b + (1n << 256n)) & MAX_U256;

// --- TickMath (v3) ---
const C: [number, bigint][] = [
    [0x2, 0xfff97272373d413259a46990580e213an], [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20, 0xff973b41fa98c081472e6896dfb254c0n], [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200, 0xf987a7253ac413176f2b074cf7815e54n], [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000, 0x31be135f97d08fd981231505542fcfa6n], [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000, 0x5d6af8dedb81196699c329225ee604n], [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000, 0x48a170391f7dc42444e8fa2n],
];

export function sqrtAt(tick: number): bigint {
    const a = Math.abs(tick);
    if (a > MAX_TICK) throw new Error('tick');
    let ratio = (a & 1) ? 0xfffcb933bd6fad37aa2d162d1a594001n : Q128;
    for (const [bit, c] of C) if (a & bit) ratio = (ratio * c) >> 128n;
    if (tick > 0) ratio = MAX_U256 / ratio;
    return (ratio >> 32n) + ((ratio & 0xffffffffn) === 0n ? 0n : 1n);
}

// Greatest tick with sqrtAt(tick) <= sqrtP (binary search: independent of the log2 algorithm).
export function tickAt(sqrtP: bigint): number {
    if (sqrtP < MIN_SQRT_RATIO || sqrtP >= MAX_SQRT_RATIO) throw new Error('price');
    let lo = MIN_TICK;
    let hi = MAX_TICK;
    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (sqrtAt(mid) <= sqrtP) lo = mid; else hi = mid - 1;
    }
    return lo;
}

export const minUsable = (s: number) => -Math.floor(887272 / s) * s;
export const maxUsable = (s: number) => Math.floor(887272 / s) * s;
export const maxLiquidityPerTick = (s: number) => MAX_U128 / BigInt((maxUsable(s) - minUsable(s)) / s + 1);

// --- SqrtPriceMath ---
export function amount0Delta(a: bigint, b: bigint, L: bigint, up: boolean) {
    if (a > b) [a, b] = [b, a];
    const n1 = L << 96n;
    const n2 = b - a;
    return up ? divC(mulDivC(n1, n2, b), a) : mulDiv(n1, n2, b) / a;
}
export function amount1Delta(a: bigint, b: bigint, L: bigint, up: boolean) {
    if (a > b) [a, b] = [b, a];
    return up ? mulDivC(L, b - a, Q96) : mulDiv(L, b - a, Q96);
}
export function nextSqrt0Up(sqrtP: bigint, L: bigint, amount: bigint) {
    if (amount === 0n) return sqrtP;
    const n1 = L << 96n;
    const product = amount * sqrtP;
    if (product <= MAX_U256 && n1 + product <= MAX_U256) return mulDivC(n1, sqrtP, n1 + product);
    return divC(n1, n1 / sqrtP + amount);
}
export const nextSqrt1Down = (sqrtP: bigint, L: bigint, amount: bigint) => sqrtP + mulDiv(amount, Q96, L);

export function swapStep(sqrtP: bigint, target: bigint, L: bigint, rem: bigint, fee: bigint) {
    const z = sqrtP >= target;
    const remLessFee = mulDiv(rem, PIPS - fee, PIPS);
    let amountIn = z ? amount0Delta(target, sqrtP, L, true) : amount1Delta(sqrtP, target, L, true);
    const next = remLessFee >= amountIn ? target : (z ? nextSqrt0Up(sqrtP, L, remLessFee) : nextSqrt1Down(sqrtP, L, remLessFee));
    const max = next === target;
    let amountOut: bigint;
    if (z) {
        if (!max) amountIn = amount0Delta(next, sqrtP, L, true);
        amountOut = amount1Delta(next, sqrtP, L, false);
    } else {
        if (!max) amountIn = amount1Delta(sqrtP, next, L, true);
        amountOut = amount0Delta(sqrtP, next, L, false);
    }
    const feeAmount = max ? mulDivC(amountIn, fee, PIPS - fee) : rem - amountIn;
    return { sqrtNext: next, amountIn, amountOut, fee: feeAmount };
}

// --- LiquidityMath ---
const liq0 = (a: bigint, b: bigint, x: bigint) => mulDiv(x, mulDiv(a, b, Q96), b - a);
const liq1 = (a: bigint, b: bigint, y: bigint) => mulDiv(y, Q96, b - a);
export function liquidityForAmounts(sqrtP: bigint, sA: bigint, sB: bigint, x: bigint, y: bigint) {
    if (sqrtP <= sA) return liq0(sA, sB, x);
    if (sqrtP < sB) return bmin(liq0(sqrtP, sB, x), liq1(sA, sqrtP, y));
    return liq1(sA, sB, y);
}
export function amountsForLiquidity(tick: number, sqrtP: bigint, tL: number, tU: number, L: bigint, up: boolean) {
    const sA = sqrtAt(tL);
    const sB = sqrtAt(tU);
    if (tick < tL) return { a: amount0Delta(sA, sB, L, up), b: 0n };
    if (tick < tU) return { a: amount0Delta(sqrtP, sB, L, up), b: amount1Delta(sA, sqrtP, L, up) };
    return { a: 0n, b: amount1Delta(sA, sB, L, up) };
}

// --- fees ---
export const variableFee = (A: bigint, va: bigint, s: bigint) => (A === 0n || va === 0n ? 0n : divC(A * (va * s) ** 2n, 10n ** 14n));
export function launchExtra(f: bigint, d: bigint, start: bigint, t: bigint) {
    if (f === 0n || d === 0n || t >= start + d) return 0n;
    return (f * bmin(start + d - t, d)) / d;
}

// --- engine: swap ---
export type TickInfo = { liqGross: bigint; liqNet: bigint; fgOut0: bigint; fgOut1: bigint };
export type FeeState = {
    baseFeePips: bigint; varFeeControl: bigint; filterPeriod: bigint; decayPeriod: bigint; reductionBps: bigint;
    maxVolAcc: bigint; volAcc: bigint; volRef: bigint; idxRef: bigint; lastTs: bigint; startTs: bigint;
    protocolShareBps: bigint; hookFeeSet: boolean; hookFeePips: bigint;
};
export type PoolModel = {
    sqrtP: bigint; tick: number; L: bigint; fg0: bigint; fg1: bigint;
    ticks: Map<number, TickInfo>; fs: FeeState; spacing: number;
    launchFeePips: bigint; launchDuration: bigint; hookShareBps: bigint;
};

export function computeSwap(p: PoolModel, zfo: boolean, budget: bigint, limit: bigint, maxCrossings: number, t: bigint) {
    const s = p.spacing;
    const S = BigInt(s);
    const fs = { ...p.fs };
    const elapsed = bmax(0n, t - fs.lastTs);
    if (elapsed >= fs.filterPeriod) {
        fs.idxRef = BigInt(fdivN(p.tick, s));
        fs.volRef = elapsed < fs.decayPeriod ? (fs.volAcc * fs.reductionBps) / BPS : 0n;
    }
    const launch = launchExtra(p.launchFeePips, p.launchDuration, fs.startTs, t);
    const base = fs.hookFeeSet ? fs.hookFeePips : fs.baseFeePips;
    const K = CHECKPOINT_SPACINGS * s;
    const ticks = new Map([...p.ticks].map(([k, v]) => [k, { ...v }]));
    const sorted = () => [...ticks.keys()].sort((a, b) => a - b);
    const prevLe = (x: number) => { const k = sorted().filter((v) => v <= x); return k.length ? k[k.length - 1] : null; };
    const nextGt = (x: number) => { const k = sorted().filter((v) => v > x); return k.length ? k[0] : null; };

    let { sqrtP, tick, L, fg0, fg1 } = p;
    let rem = budget;
    let out = 0n, feeTotal = 0n, proto = 0n, hook = 0n;
    let crossings = 0, steps = 0, stop = 0, va = fs.volAcc, lastFee = 0n;
    let nextInit = zfo ? prevLe(tick) : nextGt(tick);
    for (;;) {
        if (!(rem > 0n && sqrtP !== limit)) break;
        if (steps === MAX_STEPS) { stop = 3; break; }
        if (nextInit === null && L === 0n) { stop = 4; break; }
        let tgt = nextInit ?? (zfo ? minUsable(s) : maxUsable(s));
        let init = nextInit !== null;
        const idx = BigInt(fdivN(tick, s));
        const vaRaw = fs.volRef + babs(fs.idxRef - idx) * VA_UNIT;
        va = bmin(fs.maxVolAcc, vaRaw);
        // va pinned at maxVolAcc while moving away from the reference: the fee cannot change, no checkpoint.
        const pinned = vaRaw >= fs.maxVolAcc && (zfo ? idx <= fs.idxRef : idx >= fs.idxRef);
        if (fs.varFeeControl > 0n && L > 0n && !pinned) {
            let cp = zfo ? fdivN(tick, K) * K : (fdivN(tick, K) + 1) * K;
            if (zfo && cp === tick && sqrtAt(cp) >= sqrtP) cp -= K;
            if (zfo ? cp > tgt : cp < tgt) { tgt = cp; init = false; }
        }
        const sqrtTgt = sqrtAt(tgt);
        const target = zfo ? bmax(sqrtTgt, limit) : bmin(sqrtTgt, limit);
        const fee = bmin(base + variableFee(fs.varFeeControl, va, S), MAX_DYNAMIC_FEE_PIPS) + launch;
        lastFee = fee;
        const st = swapStep(sqrtP, target, L, rem, fee);
        rem -= st.amountIn + st.fee;
        out += st.amountOut;
        steps += 1;
        feeTotal += st.fee;
        const pr = (st.fee * fs.protocolShareBps) / BPS;
        const h = (st.fee * p.hookShareBps) / BPS;
        proto += pr;
        hook += h;
        if (L > 0n) {
            const g = mulDiv(st.fee - pr - h, Q128, L);
            if (zfo) fg0 = addMod(fg0, g); else fg1 = addMod(fg1, g);
        }
        if (st.sqrtNext === sqrtTgt) {
            if (init) {
                const ti = ticks.get(tgt)!;
                ti.fgOut0 = subMod(fg0, ti.fgOut0);
                ti.fgOut1 = subMod(fg1, ti.fgOut1);
                L = zfo ? L - ti.liqNet : L + ti.liqNet;
                crossings += 1;
                nextInit = zfo ? prevLe(tgt - 1) : nextGt(tgt);
            }
            tick = zfo ? tgt - 1 : tgt;
            sqrtP = st.sqrtNext;
            if (init && crossings >= maxCrossings && rem > 0n) { stop = 2; break; }
        } else if (st.sqrtNext !== sqrtP) {
            sqrtP = st.sqrtNext;
            tick = tickAt(sqrtP);
        }
    }
    if (rem === 0n) stop = 0; else if (sqrtP === limit) stop = 1;
    // Meteora: the stored va is the one of the final active bin (final tick).
    if (steps > 0) va = bmin(fs.maxVolAcc, fs.volRef + babs(fs.idxRef - BigInt(fdivN(tick, s))) * VA_UNIT);
    fs.volAcc = va;
    fs.lastTs = t;
    return { out, remaining: rem, feeTotal, proto, hook, sqrtP, tick, L, fg0, fg1, ticks, fs, crossings, steps, stop, lastFee };
}

// ---------------------------------------------------------------------------
// Ticks, fee growth inside, mint / burn and a stateful pool simulator (DESIGN.md §4.5, §5.2,
// §6.1-§6.4). Written from the spec (and the v3 Solidity), not from the Tact code.
// ---------------------------------------------------------------------------

export const MIN_POSITION_LIQUIDITY = 1000n;
export const MAX_TICKS_PER_POOL = 8192;
export const MAX_COINS = (1n << 120n) - 1n;
export const MAX_CROSSINGS_CAP = 24;
export const MAX_REF_FEE_BPS = 10n;
export const DEFAULT_PROTOCOL_SHARE_BPS = 1000n;

export const CODES = {
    DEADLINE: 201, SLIPPAGE: 202, LOW_GAS: 204, CREATION_PAUSED: 207, ZERO_OUT: 208, OVERFLOW: 209,
    BAD_REF_BPS: 212, NOT_INITIALIZED: 217, NOT_INITIALIZER: 218, BAD_TICKS: 219, PRICE_OUT_OF_RANGE: 220,
    LIQUIDITY_BELOW_MIN: 221, PARTIAL_NOT_ALLOWED: 222, NO_LIQUIDITY: 223, TICK_LIMIT: 224, MATH_FAILURE: 229,
    BAD_PRICE_LIMIT: 230, ALREADY_INITIALIZED: 231, BAD_CROSSINGS: 232,
};

export function feeGrowthInside(ticks: Map<number, TickInfo>, tick: number, tL: number, tU: number, fg0: bigint, fg1: bigint) {
    const lo = ticks.get(tL) ?? { liqGross: 0n, liqNet: 0n, fgOut0: 0n, fgOut1: 0n };
    const hi = ticks.get(tU) ?? { liqGross: 0n, liqNet: 0n, fgOut0: 0n, fgOut1: 0n };
    const b0 = tick >= tL ? lo.fgOut0 : subMod(fg0, lo.fgOut0);
    const b1 = tick >= tL ? lo.fgOut1 : subMod(fg1, lo.fgOut1);
    const a0 = tick < tU ? hi.fgOut0 : subMod(fg0, hi.fgOut0);
    const a1 = tick < tU ? hi.fgOut1 : subMod(fg1, hi.fgOut1);
    return { a: subMod(subMod(fg0, b0), a0), b: subMod(subMod(fg1, b1), a1) };
}

export type Preset = { baseFeePips: bigint; varFeeControl: bigint; filterPeriod: bigint; decayPeriod: bigint; reductionBps: bigint; maxVolAcc: bigint };
export const PRESETS: Record<number, Preset> = {
    1: { baseFeePips: 100n, varFeeControl: 400000n, filterPeriod: 10n, decayPeriod: 120n, reductionBps: 5000n, maxVolAcc: 350000n },
    10: { baseFeePips: 500n, varFeeControl: 40000n, filterPeriod: 30n, decayPeriod: 600n, reductionBps: 5000n, maxVolAcc: 350000n },
    60: { baseFeePips: 3000n, varFeeControl: 4500n, filterPeriod: 30n, decayPeriod: 600n, reductionBps: 5000n, maxVolAcc: 350000n },
    200: { baseFeePips: 10000n, varFeeControl: 600n, filterPeriod: 30n, decayPeriod: 600n, reductionBps: 5000n, maxVolAcc: 350000n },
};

// buyTaxBps / sellTaxBps: TAX plugin (Gram pools only; Gram is token0, so a buy is zeroForOne).
export type ExtModel = { hookShareBps: bigint; launchFeePips: bigint; launchDuration: bigint; initializer: string | null; minLockSecs: bigint;
    buyTaxBps?: bigint; sellTaxBps?: bigint };
export const PLAIN_EXT: ExtModel = { hookShareBps: 0n, launchFeePips: 0n, launchDuration: 0n, initializer: null, minLockSecs: 0n };

// out = what the receiver gets (net of a sell tax); grossOut = what leaves the pool reserves.
export type SwapOutcome = {
    code: number; out: bigint; grossOut: bigint; tax: bigint; plat: bigint; platPaid: bigint; taxPaid: bigint; consumed: bigint; refFee: bigint; refund: bigint; feeTotal: bigint; proto: bigint; hook: bigint;
    sqrtP: bigint; tick: number; L: bigint; crossings: number; steps: number; stop: number; lastFee: bigint;
};
export type MintOutcome = { code: number; liq: bigint; use0: bigint; use1: bigint; inside0: bigint; inside1: bigint; newTicks: number };
export type BurnOutcome = { code: number; amount0: bigint; amount1: bigint; fees0: bigint; fees1: bigint; inside0: bigint; inside1: bigint; deleted: number };

const isValidTicks = (tL: number, tU: number, s: number) =>
    tL < tU && tL % s === 0 && tU % s === 0 && tL >= minUsable(s) && tU <= maxUsable(s);

// One pool, mirrored op by op. All fields are public so tests can compare with the chain.
export class PoolSim {
    initialized = false;
    sqrtP = 0n;
    tick = 0;
    L = 0n;
    fg0 = 0n;
    fg1 = 0n;
    ticks = new Map<number, TickInfo>();
    reserve0 = 0n;
    reserve1 = 0n;
    protocolFees0 = 0n;
    protocolFees1 = 0n;
    hookFees0 = 0n;
    hookFees1 = 0n;
    taxFees = 0n;
    platformFees = 0n;          // carried below PLATFORM_MIN_PAYOUT
    platformBps = PLATFORM_FEE_CAP_BPS;   // the Router's rate as the pool last saw it
    nextPositionId = 0n;
    tickCumulative = 0n;
    obsTs = 0n;
    fs: FeeState = {
        baseFeePips: 0n, varFeeControl: 0n, filterPeriod: 0n, decayPeriod: 0n, reductionBps: 0n, maxVolAcc: 0n,
        volAcc: 0n, volRef: 0n, idxRef: 0n, lastTs: 0n, startTs: 0n, protocolShareBps: DEFAULT_PROTOCOL_SHARE_BPS,
        hookFeeSet: false, hookFeePips: 0n,
    };

    // gramPool: token0 == GRAM (the PLATFORM FEE is only taken in Gram).
    constructor(public spacing: number, public ext: ExtModel = PLAIN_EXT, public gramPool = true) {}

    get charged() { return platformCharged(this.gramPool, this.ext.initializer); }
    get taxed() { return (this.ext.buyTaxBps ?? 0n) > 0n || (this.ext.sellTaxBps ?? 0n) > 0n; }

    get tickCount() { return this.ticks.size; }

    model(): PoolModel {
        return {
            sqrtP: this.sqrtP, tick: this.tick, L: this.L, fg0: this.fg0, fg1: this.fg1, ticks: this.ticks, fs: this.fs,
            spacing: this.spacing, launchFeePips: this.ext.launchFeePips, launchDuration: this.ext.launchDuration,
            hookShareBps: this.ext.hookShareBps,
        };
    }

    // §6.1 + §5.2 (simulate) and, when code == 0 and commit, the state update.
    swap(zfo: boolean, amountIn: bigint, limitIn: bigint, maxCrossings: number, refBpsIn: bigint, allowPartial: boolean,
         minOut: bigint, t: bigint, commit = true, platBps?: bigint): SwapOutcome {
        const idle: SwapOutcome = {
            code: 0, out: 0n, grossOut: 0n, tax: 0n, plat: 0n, platPaid: 0n, taxPaid: 0n, consumed: 0n, refFee: 0n, refund: 0n, feeTotal: 0n, proto: 0n, hook: 0n,
            sqrtP: this.sqrtP, tick: this.tick, L: this.L, crossings: 0, steps: 0, stop: 0, lastFee: 0n,
        };
        const fail = (code: number) => ({ ...idle, code });
        if (!this.initialized) return fail(CODES.NOT_INITIALIZED);
        if (refBpsIn < 0n || refBpsIn > MAX_REF_FEE_BPS) return fail(CODES.BAD_REF_BPS);
        if (maxCrossings < 1 || maxCrossings > MAX_CROSSINGS_CAP) return fail(CODES.BAD_CROSSINGS);
        if (amountIn <= 0n) return fail(CODES.ZERO_OUT);
        const lim = limitIn === 0n ? (zfo ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n) : limitIn;
        const limOk = zfo ? lim > MIN_SQRT_RATIO && lim < this.sqrtP : lim > this.sqrtP && lim < MAX_SQRT_RATIO;
        if (!limOk) return fail(CODES.BAD_PRICE_LIMIT);
        // TAX: buy tax on the gross Gram input (like the referral), sell tax on the Gram output.
        // PLATFORM FEE: same sides as the tax, at platBps (the rate the Router passes).
        const buyTax = zfo ? (this.ext.buyTaxBps ?? 0n) : 0n;
        const sellTax = zfo ? 0n : (this.ext.sellTaxBps ?? 0n);
        const pb = this.charged ? platBps ?? this.platformBps : 0n;
        if (pb < 0n || pb > PLATFORM_FEE_CAP_BPS) return fail(CODES.BAD_REF_BPS);
        if (this.charged && commit) this.platformBps = pb;
        const buyPlat = zfo ? pb : 0n;
        const sellPlat = zfo ? 0n : pb;
        const R = (amountIn * refBpsIn) / BPS;
        const X = (amountIn * buyTax) / BPS;
        const P = (amountIn * buyPlat) / BPS;
        const S = amountIn - R - X - P;
        let r: ReturnType<typeof computeSwap>;
        try {
            r = computeSwap(this.model(), zfo, S, lim, maxCrossings, t);
        } catch {
            return fail(CODES.MATH_FAILURE);
        }
        const c = S - r.remaining;
        let refFee = R;
        let tax = X;
        let plat = P;
        let refund = 0n;
        if (c < S) {
            const k = BPS - refBpsIn - buyTax - buyPlat;
            refFee = bmin(R, (c * refBpsIn) / k);
            tax = bmin(X, (c * buyTax) / k);
            plat = bmin(P, (c * buyPlat) / k);
            refund = amountIn - c - refFee - tax - plat;
        }
        if (sellTax > 0n) tax = (r.out * sellTax) / BPS;
        if (sellPlat > 0n) plat = (r.out * sellPlat) / BPS;
        const net = zfo ? r.out : r.out - tax - plat;
        const o: SwapOutcome = {
            code: 0, out: net, grossOut: r.out, tax, plat, platPaid: 0n, taxPaid: 0n, consumed: c, refFee, refund, feeTotal: r.feeTotal, proto: r.proto, hook: r.hook,
            sqrtP: r.sqrtP, tick: r.tick, L: r.L, crossings: r.crossings, steps: r.steps, stop: r.stop, lastFee: r.lastFee,
        };
        const resIn = zfo ? this.reserve0 : this.reserve1;
        const resOut = zfo ? this.reserve1 : this.reserve0;
        const protoIn = zfo ? this.protocolFees0 : this.protocolFees1;
        const hookIn = zfo ? this.hookFees0 : this.hookFees1;
        if (r.out === 0n) o.code = r.stop === 4 && c === 0n ? CODES.NO_LIQUIDITY : CODES.ZERO_OUT;
        else if (r.remaining > 0n && !allowPartial) o.code = CODES.PARTIAL_NOT_ALLOWED;
        else if (net < minOut) o.code = CODES.SLIPPAGE;
        else if (resIn + c - r.proto - r.hook > MAX_COINS || protoIn + r.proto > MAX_COINS || hookIn + r.hook > MAX_COINS ||
                 this.taxFees + tax > MAX_COINS || this.platformFees + plat > MAX_COINS) o.code = CODES.OVERFLOW;
        else if (r.out > resOut || refund < 0n) o.code = CODES.MATH_FAILURE;
        if (o.code !== 0 || !commit) return o;

        this.tickCumulative += BigInt(this.tick) * (t - this.obsTs);
        this.obsTs = t;
        this.sqrtP = r.sqrtP;
        this.tick = r.tick;
        this.L = r.L;
        this.fg0 = r.fg0;
        this.fg1 = r.fg1;
        this.ticks = r.ticks;
        this.fs = r.fs;
        const netIn = c - r.proto - r.hook;
        this.taxFees += tax;
        this.platformFees += plat;
        if (zfo) {
            this.reserve0 += netIn; this.protocolFees0 += r.proto; this.hookFees0 += r.hook; this.reserve1 -= r.out;
        } else {
            this.reserve1 += netIn; this.protocolFees1 += r.proto; this.hookFees1 += r.hook; this.reserve0 -= r.out;
        }
        // Direct payouts in the same transaction (Pool.takePayouts).
        if (this.platformFees >= PLATFORM_MIN_PAYOUT) { o.platPaid = this.platformFees; this.platformFees = 0n; }
        if (this.taxed && this.taxFees >= TAX_MIN_PAYOUT) { o.taxPaid = this.taxFees; this.taxFees = 0n; }
        return o;
    }

    private updateTick(ticks: Map<number, TickInfo>, t: number, delta: bigint, upper: boolean, maxLiq: bigint) {
        const cur = ticks.get(t);
        const info = cur ? { ...cur } : { liqGross: 0n, liqNet: 0n, fgOut0: 0n, fgOut1: 0n };
        const before = info.liqGross;
        const after = before + delta;
        if (after < 0n || after > maxLiq) throw new Error('liq');
        if (before === 0n && t <= this.tick) { info.fgOut0 = this.fg0; info.fgOut1 = this.fg1; }
        info.liqGross = after;
        info.liqNet = upper ? info.liqNet - delta : info.liqNet + delta;
        if (after === 0n) ticks.delete(t); else ticks.set(t, info);
        return (before === 0n) !== (after === 0n);
    }

    // §6.2. `user` / `initializer` checks are done by the caller through `initCode`.
    mint(tL: number, tU: number, a0: bigint, a1: bigint, minL: bigint, sqrtInit: bigint, t: bigint,
         preset: Preset, opts: { allowInit?: boolean; userIsInitializer?: boolean; commit?: boolean; sqrtMin?: bigint; sqrtMax?: bigint } = {}): MintOutcome {
        const fail = (code: number): MintOutcome => ({ code, liq: 0n, use0: 0n, use1: 0n, inside0: 0n, inside1: 0n, newTicks: 0 });
        const saved = { sqrtP: this.sqrtP, tick: this.tick };
        let initNow = false;
        if (!this.initialized) {
            if (sqrtInit === 0n) return fail(CODES.NOT_INITIALIZED);
            if (opts.allowInit === false) return fail(CODES.CREATION_PAUSED);
            if (this.ext.initializer !== null && !opts.userIsInitializer) return fail(CODES.NOT_INITIALIZER);
            if (sqrtInit < MIN_SQRT_RATIO || sqrtInit >= MAX_SQRT_RATIO) return fail(CODES.PRICE_OUT_OF_RANGE);
            this.sqrtP = sqrtInit;
            this.tick = tickAt(sqrtInit);
            initNow = true;
        }
        const restore = () => { if (initNow) { this.sqrtP = saved.sqrtP; this.tick = saved.tick; } };
        if ((opts.sqrtMin && this.sqrtP < opts.sqrtMin) || (opts.sqrtMax && this.sqrtP > opts.sqrtMax)) {
            restore();
            return fail(CODES.SLIPPAGE);
        }
        const s = this.spacing;
        if (!isValidTicks(tL, tU, s)) { restore(); return fail(CODES.BAD_TICKS); }
        const sA = sqrtAt(tL);
        const sB = sqrtAt(tU);
        let liq = bmin(liquidityForAmounts(this.sqrtP, sA, sB, a0, a1), MAX_U128);
        let use = amountsForLiquidity(this.tick, this.sqrtP, tL, tU, liq, true);
        for (let i = 0; i < 3 && (use.a > a0 || use.b > a1) && liq > 0n; i++) {
            liq -= 1n;
            use = amountsForLiquidity(this.tick, this.sqrtP, tL, tU, liq, true);
        }
        if (use.a > a0 || use.b > a1) { restore(); return fail(CODES.MATH_FAILURE); }
        if (liq < bmax(minL, MIN_POSITION_LIQUIDITY)) { restore(); return fail(CODES.LIQUIDITY_BELOW_MIN); }
        const ticks = new Map([...this.ticks].map(([k, v]) => [k, { ...v }]));
        const maxLiq = maxLiquidityPerTick(s);
        let flipped = 0;
        try {
            if (this.updateTick(ticks, tL, liq, false, maxLiq)) flipped++;
            if (this.updateTick(ticks, tU, liq, true, maxLiq)) flipped++;
        } catch {
            restore();
            return fail(CODES.MATH_FAILURE);
        }
        if (this.ticks.size + flipped > MAX_TICKS_PER_POOL) { restore(); return fail(CODES.TICK_LIMIT); }
        if (this.reserve0 + use.a > MAX_COINS || this.reserve1 + use.b > MAX_COINS) { restore(); return fail(CODES.OVERFLOW); }
        const inside = feeGrowthInside(ticks, this.tick, tL, tU, this.fg0, this.fg1);
        const o: MintOutcome = { code: 0, liq, use0: use.a, use1: use.b, inside0: inside.a, inside1: inside.b, newTicks: flipped };
        if (opts.commit === false) { restore(); return o; }
        if (initNow) {
            this.initialized = true;
            this.fs = {
                // Meteora: the volatility reference index starts at the active bin (initial tick).
                ...preset, volAcc: 0n, volRef: 0n, idxRef: BigInt(fdivN(this.tick, this.spacing)), lastTs: t, startTs: t,
                protocolShareBps: DEFAULT_PROTOCOL_SHARE_BPS, hookFeeSet: false, hookFeePips: 0n,
            };
            this.obsTs = t;
        }
        this.ticks = ticks;
        if (tL <= this.tick && this.tick < tU) this.L += liq;
        this.reserve0 += use.a;
        this.reserve1 += use.b;
        this.nextPositionId += 1n;
        return o;
    }

    // §6.3 computeBurn + outcome checks (deadline / gas are the caller's).
    burn(tL: number, tU: number, posLiq: bigint, delta: bigint, fgLast0: bigint, fgLast1: bigint,
         min0 = 0n, min1 = 0n, commit = true): BurnOutcome {
        const inside = feeGrowthInside(this.ticks, this.tick, tL, tU, this.fg0, this.fg1);
        const fees0 = (posLiq * subMod(inside.a, fgLast0)) >> 128n;
        const fees1 = (posLiq * subMod(inside.b, fgLast1)) >> 128n;
        let amt = { a: 0n, b: 0n };
        const ticks = new Map([...this.ticks].map(([k, v]) => [k, { ...v }]));
        let deleted = 0;
        let L = this.L;
        if (delta > 0n) {
            amt = amountsForLiquidity(this.tick, this.sqrtP, tL, tU, delta, false);
            if (this.updateTick(ticks, tL, -delta, false, MAX_U128)) deleted++;
            if (this.updateTick(ticks, tU, -delta, true, MAX_U128)) deleted++;
            if (tL <= this.tick && this.tick < tU) L -= delta;
        }
        const o: BurnOutcome = { code: 0, amount0: amt.a, amount1: amt.b, fees0, fees1, inside0: inside.a, inside1: inside.b, deleted };
        if (amt.a + fees0 < min0 || amt.b + fees1 < min1) o.code = CODES.SLIPPAGE;
        else if (amt.a + fees0 > this.reserve0 || amt.b + fees1 > this.reserve1) o.code = CODES.MATH_FAILURE;
        if (o.code !== 0 || !commit) return o;
        this.ticks = ticks;
        this.L = L;
        this.reserve0 -= amt.a + fees0;
        this.reserve1 -= amt.b + fees1;
        return o;
    }

    // §6.11 direct launch: init at the floor-aligned start tick tU, jetton-only position
    // [minUsable, tU], deposit rounding dust booked as protocol fee, then the optional dev buy with
    // the launch-decay fee waived (same transaction as the initialization).
    launch(sqrtPrice: bigint, amount1: bigint, t: bigint, preset: Preset, dev?: { amount: bigint; minOut: bigint }) {
        const s = this.spacing;
        if (sqrtPrice < MIN_SQRT_RATIO || sqrtPrice >= MAX_SQRT_RATIO) return { code: CODES.PRICE_OUT_OF_RANGE };
        const tU = fdivN(tickAt(sqrtPrice), s) * s;
        const tL = minUsable(s);
        if (tU <= tL || tU > maxUsable(s)) return { code: CODES.BAD_TICKS };
        const m = this.mint(tL, tU, 0n, amount1, 0n, sqrtAt(tU), t, preset, { userIsInitializer: true });
        if (m.code !== 0) return { code: m.code };
        this.protocolFees1 += amount1 - m.use1;
        let devSwap: SwapOutcome | null = null;
        if (dev && dev.amount > 0n) {
            const saved = this.ext;
            this.ext = { ...saved, launchFeePips: 0n };
            devSwap = this.swap(true, dev.amount, 0n, 2, 0n, false, dev.minOut, t, true);
            this.ext = saved;
        }
        return { code: 0, tL, tU, mint: m, dust: amount1 - m.use1, dev: devSwap };
    }

    feePipsNow(t: bigint) {
        const s = BigInt(this.spacing);
        const fs = { ...this.fs };
        const elapsed = bmax(0n, t - fs.lastTs);
        if (elapsed >= fs.filterPeriod) {
            fs.idxRef = BigInt(fdivN(this.tick, this.spacing));
            fs.volRef = elapsed < fs.decayPeriod ? (fs.volAcc * fs.reductionBps) / BPS : 0n;
        }
        const va = bmin(fs.maxVolAcc, fs.volRef + babs(fs.idxRef - BigInt(fdivN(this.tick, this.spacing))) * VA_UNIT);
        const base = fs.hookFeeSet ? fs.hookFeePips : fs.baseFeePips;
        return bmin(base + variableFee(fs.varFeeControl, va, s), MAX_DYNAMIC_FEE_PIPS) +
            launchExtra(this.ext.launchFeePips, this.ext.launchDuration, fs.startTs, t);
    }
}

// Graduation price (§4.7), from the spec.
export function sqrtFromAmounts(a0: bigint, a1: bigint): bigint {
    const isq = (n: bigint) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
    if (a0 <= 0n || a1 <= 0n) return 0n;
    if (a1 < (a0 << 64n)) return isq((a1 << 192n) / a0);
    if (a1 < (a0 << 128n)) return isq((a1 << 128n) / a0) << 32n;
    return 0n;
}

export const STOP_REASONS = { FILLED: 0, LIMIT: 1, CROSSINGS: 2, STEPS: 3, NO_LIQUIDITY: 4 };
