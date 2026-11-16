// Marg DEX v2 math for the web app: Uniswap v3 TickMath / SqrtPriceMath / LiquidityMath, ported
// from dex/v2/tests/model.ts (the reference the contracts are tested against). Pure on purpose:
// no imports, so web/scripts/dexmath.test.ts can check it against that model with plain node.
//
// Conventions: token0 / token1 are the pool's sorted tokens (Gram is always token0). sqrtPriceX96 is
// sqrt(token1 per token0) in Q64.96. The UI shows prices as "token0 per token1" (Gram per token),
// so a higher UI price is a LOWER tick. Prices here are in base units; the UI scales them by the
// token's decimals (dex.ts priceScale), since USDT has 6 and Gram 9.

export const Q96 = 1n << 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const Q128 = 1n << 128n;
const MAX_U256 = (1n << 256n) - 1n;

const mulDiv = (a: bigint, b: bigint, c: bigint) => (a * b) / c;
const mulDivC = (a: bigint, b: bigint, c: bigint) => { const p = a * b; return p / c + (p % c === 0n ? 0n : 1n); };
const divC = (a: bigint, b: bigint) => (a + b - 1n) / b;
const bmin = (a: bigint, b: bigint) => (a < b ? a : b);

// --- TickMath ---
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
    if (a > MAX_TICK) throw new Error('tick out of range');
    let ratio = (a & 1) ? 0xfffcb933bd6fad37aa2d162d1a594001n : Q128;
    for (const [bit, c] of C) if (a & bit) ratio = (ratio * c) >> 128n;
    if (tick > 0) ratio = MAX_U256 / ratio;
    return (ratio >> 32n) + ((ratio & 0xffffffffn) === 0n ? 0n : 1n);
}

// Greatest tick with sqrtAt(tick) <= sqrtP: a float estimate, then exact steps.
export function tickAt(sqrtP: bigint): number {
    if (sqrtP < MIN_SQRT_RATIO || sqrtP >= MAX_SQRT_RATIO) throw new Error('price out of range');
    let t = Math.floor((2 * (bigLn(sqrtP) - 96 * Math.LN2)) / Math.log(1.0001));
    t = Math.max(MIN_TICK, Math.min(MAX_TICK, t));
    while (t > MIN_TICK && sqrtAt(t) > sqrtP) t--;
    while (t < MAX_TICK && sqrtAt(t + 1) <= sqrtP) t++;
    return t;
}

// ln of a BigInt without losing range (sqrtP goes up to 2^160).
function bigLn(n: bigint): number {
    const bits = n.toString(2).length;
    const shift = Math.max(0, bits - 53);
    return Math.log(Number(n >> BigInt(shift))) + shift * Math.LN2;
}

export const minUsable = (s: number) => -Math.floor(MAX_TICK / s) * s;
export const maxUsable = (s: number) => Math.floor(MAX_TICK / s) * s;

// --- SqrtPriceMath / LiquidityMath ---
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
const liq0 = (a: bigint, b: bigint, x: bigint) => mulDiv(x, mulDiv(a, b, Q96), b - a);
const liq1 = (a: bigint, b: bigint, y: bigint) => mulDiv(y, Q96, b - a);

export function liquidityForAmounts(sqrtP: bigint, sA: bigint, sB: bigint, x: bigint, y: bigint) {
    if (sqrtP <= sA) return liq0(sA, sB, x);
    if (sqrtP < sB) return bmin(liq0(sqrtP, sB, x), liq1(sA, sqrtP, y));
    return liq1(sA, sB, y);
}

// Same rule as the Pool (by tick, not by sqrtP): below the range only token0, above only token1.
export function amountsForLiquidity(tick: number, sqrtP: bigint, tL: number, tU: number, L: bigint, up: boolean) {
    const sA = sqrtAt(tL);
    const sB = sqrtAt(tU);
    if (tick < tL) return { a0: amount0Delta(sA, sB, L, up), a1: 0n };
    if (tick < tU) return { a0: amount0Delta(sqrtP, sB, L, up), a1: amount1Delta(sA, sqrtP, L, up) };
    return { a0: 0n, a1: amount1Delta(sA, sB, L, up) };
}

// Which legs a range needs at the current price.
export function rangeSides(tick: number, tL: number, tU: number): { need0: boolean; need1: boolean } {
    if (tick < tL) return { need0: true, need1: false };
    if (tick < tU) return { need0: true, need1: true };
    return { need0: false, need1: true };
}

// Uniswap-style deposit: the user fixes one leg, the other follows from the range. Amounts round
// up, so the Pool's min(liq0, liq1) lands on the liquidity of the fixed leg (the excess is refunded).
export function depositFor(tick: number, sqrtP: bigint, tL: number, tU: number, side: 0 | 1, amount: bigint) {
    const sA = sqrtAt(tL);
    const sB = sqrtAt(tU);
    const { need0, need1 } = rangeSides(tick, tL, tU);
    if (amount <= 0n || (side === 0 && !need0) || (side === 1 && !need1)) return { L: 0n, a0: 0n, a1: 0n };
    let L: bigint;
    if (side === 0) L = need1 ? liq0(sqrtP, sB, amount) : liq0(sA, sB, amount);
    else L = need0 ? liq1(sA, sqrtP, amount) : liq1(sA, sB, amount);
    const use = amountsForLiquidity(tick, sqrtP, tL, tU, L, true);
    return { L, a0: side === 0 ? amount : use.a0, a1: side === 1 ? amount : use.a1 };
}

// --- prices (UI price = token0 per token1, e.g. Gram per token) ---

// 2^192 / sqrtP^2 as a float.
export function sqrtToPrice(sqrtP: bigint): number {
    if (sqrtP <= 0n) return 0;
    return Math.exp(192 * Math.LN2 - 2 * bigLn(sqrtP));
}

export const tickToPrice = (tick: number) => Math.pow(1.0001, -tick);

// Tick for a UI price (not rounded to a spacing), clamped to the tick range.
export function priceToTick(price: number): number {
    if (!(price > 0) || !Number.isFinite(price)) return 0;
    const t = Math.round(-Math.log(price) / Math.log(1.0001)) + 0; // + 0: no -0
    return Math.max(MIN_TICK, Math.min(MAX_TICK, t));
}

// sqrtPriceX96 for a UI price (used to initialize a new pool).
export function priceToSqrt(price: number): bigint {
    const t = priceToTick(price);
    return sqrtAt(Math.max(MIN_TICK, Math.min(MAX_TICK - 1, t)));
}

export function nearestUsable(tick: number, spacing: number): number {
    const t = Math.round(tick / spacing) * spacing;
    return Math.max(minUsable(spacing), Math.min(maxUsable(spacing), t));
}

// [tickLower, tickUpper] for a UI price range (minPrice < maxPrice). A higher price is a lower tick,
// so maxPrice sets tickLower. Always at least one spacing wide.
export function rangeToTicks(minPrice: number, maxPrice: number, spacing: number): [number, number] {
    let tL = nearestUsable(priceToTick(maxPrice), spacing);
    let tU = nearestUsable(priceToTick(minPrice), spacing);
    if (tL >= tU) {
        if (tU + spacing <= maxUsable(spacing)) tU = tL + spacing;
        else tL = tU - spacing;
    }
    return [tL, tU];
}

export const fullRange = (spacing: number): [number, number] => [minUsable(spacing), maxUsable(spacing)];

// Market cap of a 1e18-unit supply in nanoGram: 1e18 · 2^192 / sqrtP^2.
export function mcapNano(sqrtP: bigint, supply = 10n ** 18n): bigint {
    if (sqrtP <= 0n) return 0n;
    return (supply << 192n) / (sqrtP * sqrtP);
}

// --- trades ---

// Instant estimate of a swap that stays inside the active liquidity (no tick crossing), for the UI
// while the exact get_quote is on its way. feePips: 1e6 = 100%. Buy tax comes off the input, sell
// tax off the output, as in the pool. Approximate when the swap would cross a tick.
export function estimateOut(sqrtP: bigint, L: bigint, zeroForOne: boolean, amountIn: bigint, feePips: bigint, taxInBps: number, taxOutBps: number): bigint {
    if (L <= 0n || sqrtP <= 0n || amountIn <= 0n) return 0n;
    const afterTax = amountIn - (amountIn * BigInt(taxInBps)) / 10_000n;
    const net = afterTax - (afterTax * feePips) / 1_000_000n;
    let out: bigint;
    if (zeroForOne) {
        const next = mulDivC(L << 96n, sqrtP, (L << 96n) + net * sqrtP);
        out = amount1Delta(next, sqrtP, L, false);
    } else {
        const next = sqrtP + mulDiv(net, Q96, L);
        out = amount0Delta(sqrtP, next, L, false);
    }
    return out - (out * BigInt(taxOutBps)) / 10_000n;
}

export const minOutFor = (amountOut: bigint, slippageBps: number) => (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;

// How far the trade moves the pool price, 0..1.
export function priceImpact(sqrtBefore: bigint, sqrtAfter: bigint): number {
    if (sqrtBefore <= 0n || sqrtAfter <= 0n) return 0;
    const r = Math.exp(2 * (bigLn(sqrtAfter) - bigLn(sqrtBefore)));
    return Math.abs(1 - r);
}

// Anti-snipe extra (pips) of a launch key at time t, as in the Pool.
export function launchExtra(feePips: bigint, duration: bigint, startTs: bigint, t: bigint): bigint {
    if (feePips === 0n || duration === 0n || t >= startTs + duration) return 0n;
    const left = startTs + duration - t;
    return (feePips * (left < duration ? left : duration)) / duration;
}

// sqrtP bounds that keep the price within ±slippage (the mint's price guard).
export function sqrtBand(sqrtP: bigint, slippageBps: number): [bigint, bigint] {
    const s = slippageBps / 10_000;
    const lo = BigInt(Math.floor(Math.sqrt(1 - s) * 1e9));
    const hi = BigInt(Math.ceil(Math.sqrt(1 + s) * 1e9));
    let min = (sqrtP * lo) / 1_000_000_000n;
    let max = (sqrtP * hi) / 1_000_000_000n;
    if (min < MIN_SQRT_RATIO) min = MIN_SQRT_RATIO;
    if (max >= MAX_SQRT_RATIO) max = MAX_SQRT_RATIO - 1n;
    return [min, max];
}
