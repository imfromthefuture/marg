import "./messages";
import "./constants";
import "./dict";

// Uniswap v3 math ported to TVM (DESIGN.md §4). Every function is pure and may throw only on a
// broken invariant (callers run it inside try and turn a throw into CODE_MATH_FAILURE).

struct Pair {
    a: Int;
    b: Int;
}

struct StepResult {
    sqrtNext: Int;
    amountIn: Int;
    amountOut: Int;
    fee: Int;
}

// ---------------------------------------------------------------------------
// mod 2^256 (v3 relies on uint256 wraparound; TVM throws on overflow)
// ---------------------------------------------------------------------------

fun addMod(a: Int, b: Int): Int {
    let room = MAX_U256 - a;
    if (b <= room) {
        return a + b;
    }
    return b - room - 1;
}

fun subMod(a: Int, b: Int): Int {
    if (a >= b) {
        return a - b;
    }
    return (MAX_U256 - b) + 1 + a;
}

inline fun divC(a: Int, b: Int): Int {
    return (a + b - 1) / b;
}

// ---------------------------------------------------------------------------
// TickMath
// ---------------------------------------------------------------------------

fun sqrtAt(tick: Int): Int {
    let absTick = abs(tick);
    if (absTick > MAX_TICK) {
        throw(CODE_MATH_FAILURE);
    }
    let ratio = (absTick & 0x1) != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : Q128;
    if ((absTick & 0x2) != 0) { ratio = mulShr(ratio, 0xfff97272373d413259a46990580e213a, 128); }
    if ((absTick & 0x4) != 0) { ratio = mulShr(ratio, 0xfff2e50f5f656932ef12357cf3c7fdcc, 128); }
    if ((absTick & 0x8) != 0) { ratio = mulShr(ratio, 0xffe5caca7e10e4e61c3624eaa0941cd0, 128); }
    if ((absTick & 0x10) != 0) { ratio = mulShr(ratio, 0xffcb9843d60f6159c9db58835c926644, 128); }
    if ((absTick & 0x20) != 0) { ratio = mulShr(ratio, 0xff973b41fa98c081472e6896dfb254c0, 128); }
    if ((absTick & 0x40) != 0) { ratio = mulShr(ratio, 0xff2ea16466c96a3843ec78b326b52861, 128); }
    if ((absTick & 0x80) != 0) { ratio = mulShr(ratio, 0xfe5dee046a99a2a811c461f1969c3053, 128); }
    if ((absTick & 0x100) != 0) { ratio = mulShr(ratio, 0xfcbe86c7900a88aedcffc83b479aa3a4, 128); }
    if ((absTick & 0x200) != 0) { ratio = mulShr(ratio, 0xf987a7253ac413176f2b074cf7815e54, 128); }
    if ((absTick & 0x400) != 0) { ratio = mulShr(ratio, 0xf3392b0822b70005940c7a398e4b70f3, 128); }
    if ((absTick & 0x800) != 0) { ratio = mulShr(ratio, 0xe7159475a2c29b7443b29c7fa6e889d9, 128); }
    if ((absTick & 0x1000) != 0) { ratio = mulShr(ratio, 0xd097f3bdfd2022b8845ad8f792aa5825, 128); }
    if ((absTick & 0x2000) != 0) { ratio = mulShr(ratio, 0xa9f746462d870fdf8a65dc1f90e061e5, 128); }
    if ((absTick & 0x4000) != 0) { ratio = mulShr(ratio, 0x70d869a156d2a1b890bb3df62baf32f7, 128); }
    if ((absTick & 0x8000) != 0) { ratio = mulShr(ratio, 0x31be135f97d08fd981231505542fcfa6, 128); }
    if ((absTick & 0x10000) != 0) { ratio = mulShr(ratio, 0x9aa508b5b7a84e1c677de54f3e99bc9, 128); }
    if ((absTick & 0x20000) != 0) { ratio = mulShr(ratio, 0x5d6af8dedb81196699c329225ee604, 128); }
    if ((absTick & 0x40000) != 0) { ratio = mulShr(ratio, 0x2216e584f5fa1ea926041bedfe98, 128); }
    if ((absTick & 0x80000) != 0) { ratio = mulShr(ratio, 0x48a170391f7dc42444e8fa2, 128); }
    if (tick > 0) {
        ratio = MAX_U256 / ratio;
    }
    return (ratio >> 32) + ((ratio & 0xffffffff) == 0 ? 0 : 1);
}

// Greatest tick t with sqrtAt(t) <= sqrtP.
fun tickAt(sqrtP: Int): Int {
    if (sqrtP < MIN_SQRT_RATIO || sqrtP >= MAX_SQRT_RATIO) {
        throw(CODE_MATH_FAILURE);
    }
    let ratio = sqrtP << 32;
    let msb = ubitsize(ratio) - 1;
    let r = msb >= 128 ? ratio >> (msb - 127) : ratio << (127 - msb);
    let log2v = (msb - 128) << 64;
    let sh = 63;
    repeat (14) {
        r = (r * r) >> 127;
        let f = r >> 128;
        log2v = log2v | (f << sh);
        r = r >> f;
        sh -= 1;
    }
    let logS = log2v * 255738958999603826347141;
    let tLow = (logS - 3402992956809132418596140100660247210) >> 128;
    let tHigh = (logS + 291339464771989622907027621153398088495) >> 128;
    if (tLow == tHigh) {
        return tLow;
    }
    return sqrtAt(tHigh) <= sqrtP ? tHigh : tLow;
}

fun minUsable(s: Int): Int {
    return -((-MIN_TICK) / s) * s;
}

fun maxUsable(s: Int): Int {
    return (MAX_TICK / s) * s;
}

fun maxLiquidityPerTick(s: Int): Int {
    return MAX_U128 / ((maxUsable(s) - minUsable(s)) / s + 1);
}

// ---------------------------------------------------------------------------
// SqrtPriceMath (a < b; callers sort)
// ---------------------------------------------------------------------------

fun amount0Delta(a: Int, b: Int, liq: Int, up: Bool): Int {
    let n1 = liq << 96;
    let n2 = b - a;
    if (up) {
        return divC(mulDivC(n1, n2, b), a);
    }
    return mulDiv(n1, n2, b) / a;
}

fun amount1Delta(a: Int, b: Int, liq: Int, up: Bool): Int {
    if (up) {
        return mulDivC(liq, b - a, Q96);
    }
    return mulDiv(liq, b - a, Q96);
}

// zeroForOne input: the price goes down, rounded up.
fun nextSqrtFromAmount0Up(sqrtP: Int, liq: Int, amount: Int): Int {
    if (amount == 0) {
        return sqrtP;
    }
    let n1 = liq << 96;
    if (amount <= (MAX_U256 - n1) / sqrtP) {
        return mulDivC(n1, sqrtP, n1 + amount * sqrtP);
    }
    return divC(n1, n1 / sqrtP + amount);
}

// oneForZero input: the price goes up, rounded down.
fun nextSqrtFromAmount1Down(sqrtP: Int, liq: Int, amount: Int): Int {
    return sqrtP + mulDiv(amount, Q96, liq);
}

// ---------------------------------------------------------------------------
// SwapMath.computeSwapStep, exact-in (v3)
// ---------------------------------------------------------------------------

fun swapStep(sqrtP: Int, sqrtTarget: Int, liq: Int, rem: Int, feePips: Int): StepResult {
    let z = sqrtP >= sqrtTarget;
    let remLessFee = mulDiv(rem, PIPS - feePips, PIPS);
    let amountIn = z ? amount0Delta(sqrtTarget, sqrtP, liq, true) : amount1Delta(sqrtP, sqrtTarget, liq, true);
    let sqrtNext = sqrtTarget;
    if (remLessFee < amountIn) {
        sqrtNext = z ? nextSqrtFromAmount0Up(sqrtP, liq, remLessFee) : nextSqrtFromAmount1Down(sqrtP, liq, remLessFee);
    }
    let isMax = sqrtNext == sqrtTarget;
    let amountOut = 0;
    if (z) {
        if (!isMax) {
            amountIn = amount0Delta(sqrtNext, sqrtP, liq, true);
        }
        amountOut = amount1Delta(sqrtNext, sqrtP, liq, false);
    } else {
        if (!isMax) {
            amountIn = amount1Delta(sqrtP, sqrtNext, liq, true);
        }
        amountOut = amount0Delta(sqrtP, sqrtNext, liq, false);
    }
    let fee = isMax ? mulDivC(amountIn, feePips, PIPS - feePips) : rem - amountIn;
    return StepResult { sqrtNext, amountIn, amountOut, fee };
}

// ---------------------------------------------------------------------------
// LiquidityMath
// ---------------------------------------------------------------------------

fun liqForAmount0(a: Int, b: Int, x: Int): Int {
    return mulDiv(x, mulDiv(a, b, Q96), b - a);
}

fun liqForAmount1(a: Int, b: Int, y: Int): Int {
    return mulDiv(y, Q96, b - a);
}

fun liquidityForAmounts(sqrtP: Int, sA: Int, sB: Int, x: Int, y: Int): Int {
    if (sqrtP <= sA) {
        return liqForAmount0(sA, sB, x);
    }
    if (sqrtP < sB) {
        return min(liqForAmount0(sqrtP, sB, x), liqForAmount1(sA, sqrtP, y));
    }
    return liqForAmount1(sA, sB, y);
}

// Tick-based branch, exactly like v3 _modifyPosition.
fun amountsForLiquidity(tick: Int, sqrtP: Int, tL: Int, tU: Int, liq: Int, up: Bool): Pair {
    let sA = sqrtAt(tL);
    let sB = sqrtAt(tU);
    if (tick < tL) {
        return Pair { a: amount0Delta(sA, sB, liq, up), b: 0 };
    }
    if (tick < tU) {
        return Pair { a: amount0Delta(sqrtP, sB, liq, up), b: amount1Delta(sA, sqrtP, liq, up) };
    }
    return Pair { a: 0, b: amount1Delta(sA, sB, liq, up) };
}

// Graduation: sqrt(a1/a0) in Q64.96, floor. 0 when out of range.
fun sqrtFromAmounts(a0: Int, a1: Int): Int {
    if (a0 <= 0 || a1 <= 0) {
        return 0;
    }
    if (a1 < (a0 << 64)) {
        return isqrt(mulDiv(a1, 1 << 192, a0));
    }
    if (a1 < (a0 << 128)) {
        return isqrt(mulDiv(a1, 1 << 128, a0)) << 32;
    }
    return 0;
}
