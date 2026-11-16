import "./messages";
import "./constants";
import "./math";

// Fee model (DESIGN.md §5). Pure: receivers and getters call the same functions.

// Meteora variable fee: ceil(A * (va * spacing)^2 / 1e14). A == 0 disables it.
fun variableFee(a: Int, va: Int, spacing: Int): Int {
    if (a == 0 || va == 0) {
        return 0;
    }
    let x = va * spacing;
    return divC(a * x * x, 100000000000000);
}

// LAUNCH_DECAY plugin: linear decay from launchFeePips at startTs to 0 at startTs + duration.
fun launchExtra(launchFeePips: Int, launchDuration: Int, startTs: Int, t: Int): Int {
    if (launchFeePips == 0 || launchDuration == 0) {
        return 0;
    }
    let end = startTs + launchDuration;
    if (t >= end) {
        return 0;
    }
    let left = min(end - t, launchDuration);
    return launchFeePips * left / launchDuration;
}

// Base fee in force: a hook-set fee (FEE_CONTROL) replaces the preset base fee.
fun baseFeeOf(fs: FeeState): Int {
    return fs.hookFeeSet ? fs.hookFeePips : fs.baseFeePips;
}

// Volatility accumulator at the start of a step whose current tick is `tick`.
fun volAt(fs: FeeState, tick: Int, spacing: Int): Int {
    return min(fs.maxVolAcc, fs.volRef + abs(fs.idxRef - tick / spacing) * VA_UNIT);
}

fun stepFeePips(fs: FeeState, va: Int, spacing: Int, launch: Int): Int {
    return feeFor(baseFeeOf(fs), fs.varFeeControl, va, spacing, launch);
}

// The per-step fee from hoisted scalars (the swap loop calls this directly).
fun feeFor(base: Int, a: Int, va: Int, spacing: Int, launch: Int): Int {
    return min(base + variableFee(a, va, spacing), MAX_DYNAMIC_FEE_PIPS) + launch;
}

// Once per swap, before the first step (Meteora reference update).
fun refreshRefs(fs: FeeState, tick: Int, spacing: Int, t: Int): FeeState {
    let elapsed = max(0, t - fs.lastTs);
    if (elapsed >= fs.filterPeriod) {
        fs.idxRef = tick / spacing;
        fs.volRef = elapsed < fs.decayPeriod ? fs.volAcc * fs.reductionBps / BPS : 0;
    }
    return fs;
}
