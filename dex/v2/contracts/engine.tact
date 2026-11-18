import "./messages";
import "./constants";
import "./dict";
import "./math";
import "./fees";

// The pure tick engine (DESIGN.md §6.1, §6.2, §6.3, §6.4). Receivers and getters call these same
// functions on the same state, so quotes equal execution. Nothing here touches contract storage:
// the caller commits the returned values only if every outcome check passes.

struct SwapIn {
    sqrtP: Int;
    tick: Int;
    liquidity: Int;
    fg0: Int;
    fg1: Int;
    ticks: map<Int as int24, TickInfo>;
    fs: FeeState;
    spacing: Int;
    launchFeePips: Int;
    launchDuration: Int;
    hookShareBps: Int;
    zeroForOne: Bool;
    budget: Int;            // S = input after the referral fee
    limit: Int;             // resolved, strictly beyond the current price
    maxCrossings: Int;
    t: Int;
    gasStop: Int;           // v3: stop the loop once gasConsumed() exceeds this (swapGasStop)
}

struct SwapRes {
    out: Int;
    remaining: Int;
    feeTotal: Int;
    proto: Int;
    hook: Int;
    sqrtP: Int;
    tick: Int;
    liquidity: Int;
    fg0: Int;
    fg1: Int;
    ticks: map<Int as int24, TickInfo>;
    fs: FeeState;
    crossings: Int;
    steps: Int;
    stop: Int;
    lastFee: Int;
}

struct MintIn {
    sqrtP: Int;
    tick: Int;
    liquidity: Int;
    fg0: Int;
    fg1: Int;
    ticks: map<Int as int24, TickInfo>;
    tickCount: Int;
    spacing: Int;
    tL: Int;
    tU: Int;
    a0: Int;
    a1: Int;
    minL: Int;
}

struct MintRes {
    code: Int;
    liq: Int;               // position liquidity
    use0: Int;
    use1: Int;
    liquidity: Int;         // new active liquidity
    ticks: map<Int as int24, TickInfo>;
    tickCount: Int;
    newTicks: Int;
    inside0: Int;
    inside1: Int;
}

struct BurnIn {
    sqrtP: Int;
    tick: Int;
    liquidity: Int;
    fg0: Int;
    fg1: Int;
    ticks: map<Int as int24, TickInfo>;
    tickCount: Int;
    tL: Int;
    tU: Int;
    posLiq: Int;
    delta: Int;
    fgLast0: Int;
    fgLast1: Int;
}

struct BurnRes {
    amount0: Int;
    amount1: Int;
    fees0: Int;
    fees1: Int;
    inside0: Int;
    inside1: Int;
    liquidity: Int;
    ticks: map<Int as int24, TickInfo>;
    tickCount: Int;
}

struct TickUpdate {
    ticks: map<Int as int24, TickInfo>;
    flipped: Bool;          // initialized (mint) or deleted (burn)
}

// ---------------------------------------------------------------------------
// Swap
// ---------------------------------------------------------------------------

// v3 (audit R2-H1): gas the swap loop may use. The Router makes every swap attach
// SWAP_BASE_GAS + maxCrossings * CROSS_GAS for compute (sized at 1.5x the measured cost of an
// ordinary swap); the loop stops at two thirds of what that buys at today's gas price, and never
// above SWAP_GAS_STOP. So the swap always finishes, its payouts stay funded, and an adversarial
// tick layout only ends it early (partial fill or refund), never out of gas.
fun swapGasStop(maxCrossings: Int): Int {
    let budget = SWAP_BASE_GAS + maxCrossings * CROSS_GAS;
    return min(SWAP_GAS_STOP, budget * 1000000 / getComputeFee(1000000, false) * 2 / 3);
}

fun computeSwap(s: SwapIn): SwapRes {
    let spacing = s.spacing;
    let zfo = s.zeroForOne;
    let fs = refreshRefs(s.fs, s.tick, spacing, s.t);
    let launch = launchExtra(s.launchFeePips, s.launchDuration, fs.startTs, s.t);
    let a = fs.varFeeControl;
    // Loop invariants hoisted out of the FeeState struct (same formula as volAt / stepFeePips).
    let base = baseFeeOf(fs);
    let maxVa = fs.maxVolAcc;
    let volRef = fs.volRef;
    let idxRef = fs.idxRef;
    let protoBps = fs.protocolShareBps;
    let hookBps = s.hookShareBps;
    let lim = s.limit;
    let maxCross = s.maxCrossings;
    let k = CHECKPOINT_SPACINGS * spacing;
    let minU = minUsable(spacing);
    let maxU = maxUsable(spacing);

    let sqrtP = s.sqrtP;
    let tick = s.tick;
    let liq = s.liquidity;
    let fg0 = s.fg0;
    let fg1 = s.fg1;
    let ticks = s.ticks;
    let rem = s.budget;
    let out = 0;
    let feeTotal = 0;
    let proto = 0;
    let hook = 0;
    let crossings = 0;
    let steps = 0;
    let stop = STOP_FILLED;
    let va = fs.volAcc;
    let lastFee = 0;
    let done = false;

    let nextInit: Int? = zfo ? tickPrevLe(tick, ticks, 24) : tickNextGt(tick, ticks, 24);

    let startIdx = tick / spacing;
    let fresh = max(0, s.t - s.fs.lastTs) >= s.fs.filterPeriod;

    while (!done && rem > 0 && sqrtP != lim) {
        if (steps == MAX_STEPS) {
            stop = STOP_STEPS;
            done = true;
        } else if (steps > 0 && gasConsumed() > s.gasStop) {
            // v3 (audit R2-H1): a swap must never run out of the 1M per-transaction gas limit.
            // Router -> Pool is non-bounceable, so an out-of-gas abort would strand the input.
            // Whatever the tick layout, stop here and let the normal partial / refund path run.
            stop = STOP_GAS;
            done = true;
        } else if (nextInit == null && liq == 0) {
            // Never walk an empty book to the extremes.
            stop = STOP_NO_LIQUIDITY;
            done = true;
        } else {
            let tgt = nextInit != null ? nextInit!! : (zfo ? minU : maxU);
            let isInit = nextInit != null;
            let idx = tick / spacing;
            let vaRaw = volRef + abs(idxRef - idx) * VA_UNIT;
            va = min(maxVa, vaRaw);
            // Once va is pinned at maxVolAcc and the price keeps moving away from the reference,
            // the fee can no longer change, so no checkpoint is needed: same fee, fewer steps
            // (review finding 7: spacing 1 no longer stops at 48 x 8 ticks = 3.9% per swap).
            let pinned = vaRaw >= maxVa && (zfo ? idx <= idxRef : idx >= idxRef);
            if (a > 0 && liq > 0 && !pinned) {
                // Virtual fee checkpoint every CHECKPOINT_SPACINGS spacings, so the volatility
                // fee rises during a large swap even without initialized ticks.
                let cp = zfo ? (tick / k) * k : (tick / k + 1) * k;
                if (zfo && cp == tick && sqrtAt(cp) >= sqrtP) {
                    cp -= k;
                }
                if (zfo ? cp > tgt : cp < tgt) {
                    tgt = cp;
                    isInit = false;
                }
            }
            let sqrtTgtTick = sqrtAt(tgt);
            let target = zfo ? max(sqrtTgtTick, lim) : min(sqrtTgtTick, lim);
            let fee = feeFor(base, a, va, spacing, launch);
            lastFee = fee;

            let st = swapStep(sqrtP, target, liq, rem, fee);
            rem -= st.amountIn + st.fee;
            if (rem < 0) {
                throw(CODE_MATH_FAILURE);
            }
            out += st.amountOut;
            steps += 1;
            feeTotal += st.fee;
            let p = st.fee * protoBps / BPS;
            let h = st.fee * hookBps / BPS;
            proto += p;
            hook += h;
            if (liq > 0) {
                let g = mulDiv(st.fee - p - h, Q128, liq);
                if (zfo) {
                    fg0 = addMod(fg0, g);
                } else {
                    fg1 = addMod(fg1, g);
                }
            }

            if (st.sqrtNext == sqrtTgtTick) {
                if (isInit) {
                    // v3 Tick.cross
                    let ti = ticks.get(tgt)!!;
                    ti.fgOut0 = subMod(fg0, ti.fgOut0);
                    ti.fgOut1 = subMod(fg1, ti.fgOut1);
                    ticks.set(tgt, ti);
                    liq = zfo ? liq - ti.liqNet : liq + ti.liqNet;
                    if (liq < 0) {
                        throw(CODE_MATH_FAILURE);
                    }
                    crossings += 1;
                    nextInit = zfo ? tickPrevLe(tgt - 1, ticks, 24) : tickNextGt(tgt, ticks, 24);
                }
                tick = zfo ? tgt - 1 : tgt;
                sqrtP = st.sqrtNext;
                if (isInit && crossings >= maxCross && rem > 0) {
                    stop = STOP_CROSSINGS;
                    done = true;
                }
            } else if (st.sqrtNext != sqrtP) {
                sqrtP = st.sqrtNext;
                tick = tickAt(sqrtP);
            }
        }
    }
    if (rem == 0) {
        stop = STOP_FILLED;
    } else if (sqrtP == lim) {
        stop = STOP_LIMIT;
    }
    // Meteora stores va for the final active bin: recompute it at the final tick. Taking it from
    // the start of the last step (review finding 6) let a swap ending exactly on a checkpoint
    // store volRef and pay no variable fee forever.
    if (steps > 0) {
        va = min(maxVa, volRef + abs(idxRef - tick / spacing) * VA_UNIT);
    }
    fs.volAcc = va;
    // v3 (audit R2-L1): only a swap that refreshed the references or moved the active index
    // restarts the filter period. Dust swaps that move nothing can no longer keep a stale,
    // high reference alive forever (pinning the variable fee at its maximum).
    if (fresh || tick / spacing != startIdx) {
        fs.lastTs = s.t;
    }
    return SwapRes {
        out, remaining: rem, feeTotal, proto, hook,
        sqrtP, tick, liquidity: liq, fg0, fg1, ticks, fs,
        crossings, steps, stop, lastFee,
    };
}

// ---------------------------------------------------------------------------
// Ticks, fee growth inside
// ---------------------------------------------------------------------------

fun feeGrowthInside(ticks: map<Int as int24, TickInfo>, tick: Int, tL: Int, tU: Int, fg0: Int, fg1: Int): Pair {
    let lo0 = 0;
    let lo1 = 0;
    let hi0 = 0;
    let hi1 = 0;
    let lo = ticks.get(tL);
    if (lo != null) {
        lo0 = lo!!.fgOut0;
        lo1 = lo!!.fgOut1;
    }
    let hi = ticks.get(tU);
    if (hi != null) {
        hi0 = hi!!.fgOut0;
        hi1 = hi!!.fgOut1;
    }
    let below0 = tick >= tL ? lo0 : subMod(fg0, lo0);
    let below1 = tick >= tL ? lo1 : subMod(fg1, lo1);
    let above0 = tick < tU ? hi0 : subMod(fg0, hi0);
    let above1 = tick < tU ? hi1 : subMod(fg1, hi1);
    return Pair {
        a: subMod(subMod(fg0, below0), above0),
        b: subMod(subMod(fg1, below1), above1),
    };
}

// v3 Tick.update. delta > 0 adds liquidity, delta < 0 removes it (and deletes an emptied tick).
fun updateTick(ticks: map<Int as int24, TickInfo>, t: Int, tickCurrent: Int, delta: Int,
               fg0: Int, fg1: Int, upper: Bool, maxLiq: Int): TickUpdate {
    let cur = ticks.get(t);
    let info = TickInfo { liqGross: 0, liqNet: 0, fgOut0: 0, fgOut1: 0 };
    if (cur != null) {
        info = cur!!;
    }
    let grossBefore = info.liqGross;
    let grossAfter = grossBefore + delta;
    if (grossAfter < 0 || grossAfter > maxLiq) {
        throw(CODE_MATH_FAILURE);
    }
    if (grossBefore == 0 && t <= tickCurrent) {
        info.fgOut0 = fg0;
        info.fgOut1 = fg1;
    }
    info.liqGross = grossAfter;
    info.liqNet = upper ? info.liqNet - delta : info.liqNet + delta;
    if (grossAfter == 0) {
        ticks.set(t, null);
    } else {
        ticks.set(t, info);
    }
    return TickUpdate { ticks, flipped: (grossBefore == 0) != (grossAfter == 0) };
}

fun ticksValid(tL: Int, tU: Int, spacing: Int): Bool {
    return tL < tU && tL % spacing == 0 && tU % spacing == 0 &&
        tL >= minUsable(spacing) && tU <= maxUsable(spacing);
}

// ---------------------------------------------------------------------------
// Mint (new position)
// ---------------------------------------------------------------------------

fun computeMint(m: MintIn): MintRes {
    let fail = MintRes {
        code: 0, liq: 0, use0: 0, use1: 0, liquidity: m.liquidity, ticks: m.ticks,
        tickCount: m.tickCount, newTicks: 0, inside0: 0, inside1: 0,
    };
    if (!ticksValid(m.tL, m.tU, m.spacing)) {
        fail.code = CODE_BAD_TICKS;
        return fail;
    }
    let sA = sqrtAt(m.tL);
    let sB = sqrtAt(m.tU);
    let liq = min(liquidityForAmounts(m.sqrtP, sA, sB, m.a0, m.a1), MAX_U128);
    let use = amountsForLiquidity(m.tick, m.sqrtP, m.tL, m.tU, liq, true);
    // Rounding up the amounts can exceed the deposit by a unit: shave L (at most 3 times).
    let tries = 0;
    while ((use.a > m.a0 || use.b > m.a1) && tries < 3 && liq > 0) {
        liq -= 1;
        use = amountsForLiquidity(m.tick, m.sqrtP, m.tL, m.tU, liq, true);
        tries += 1;
    }
    if (use.a > m.a0 || use.b > m.a1) {
        fail.code = CODE_MATH_FAILURE;
        return fail;
    }
    if (liq < max(m.minL, MIN_POSITION_LIQUIDITY)) {
        fail.code = CODE_LIQUIDITY_BELOW_MIN;
        return fail;
    }
    let maxLiq = maxLiquidityPerTick(m.spacing);
    let u1 = updateTick(m.ticks, m.tL, m.tick, liq, m.fg0, m.fg1, false, maxLiq);
    let u2 = updateTick(u1.ticks, m.tU, m.tick, liq, m.fg0, m.fg1, true, maxLiq);
    let newTicks = (u1.flipped ? 1 : 0) + (u2.flipped ? 1 : 0);
    if (m.tickCount + newTicks > MAX_TICKS_PER_POOL) {
        fail.code = CODE_TICK_LIMIT;
        return fail;
    }
    let active = m.liquidity;
    if (m.tL <= m.tick && m.tick < m.tU) {
        active += liq;
    }
    let inside = feeGrowthInside(u2.ticks, m.tick, m.tL, m.tU, m.fg0, m.fg1);
    return MintRes {
        code: 0, liq, use0: use.a, use1: use.b, liquidity: active, ticks: u2.ticks,
        tickCount: m.tickCount + newTicks, newTicks, inside0: inside.a, inside1: inside.b,
    };
}

// ---------------------------------------------------------------------------
// Burn (decrease) / collect
// ---------------------------------------------------------------------------

fun computeBurn(b: BurnIn): BurnRes {
    // Fee growth inside is read before the ticks may be deleted (v3 order).
    let inside = feeGrowthInside(b.ticks, b.tick, b.tL, b.tU, b.fg0, b.fg1);
    let fees0 = mulShr(b.posLiq, subMod(inside.a, b.fgLast0), 128);
    let fees1 = mulShr(b.posLiq, subMod(inside.b, b.fgLast1), 128);
    let ticks = b.ticks;
    let tickCount = b.tickCount;
    let active = b.liquidity;
    let amt = Pair { a: 0, b: 0 };
    if (b.delta > 0) {
        amt = amountsForLiquidity(b.tick, b.sqrtP, b.tL, b.tU, b.delta, false);
        let u1 = updateTick(ticks, b.tL, b.tick, -b.delta, b.fg0, b.fg1, false, MAX_U128);
        let u2 = updateTick(u1.ticks, b.tU, b.tick, -b.delta, b.fg0, b.fg1, true, MAX_U128);
        ticks = u2.ticks;
        tickCount -= (u1.flipped ? 1 : 0) + (u2.flipped ? 1 : 0);
        if (b.tL <= b.tick && b.tick < b.tU) {
            active -= b.delta;
            if (active < 0) {
                throw(CODE_MATH_FAILURE);
            }
        }
    }
    return BurnRes {
        amount0: amt.a, amount1: amt.b, fees0, fees1,
        inside0: inside.a, inside1: inside.b,
        liquidity: active, ticks, tickCount,
    };
}
