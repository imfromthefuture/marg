import "../messages";
import "../constants";
import "../dict";
import "../math";
import "../fees";
import "../engine";

// TESTS ONLY. Exposes the pure math to vector tests against the BigInt model (tests/model.ts).
contract MathHarness {
    init() {}

    receive() {}

    get fun sqrt_at(tick: Int): Int { return sqrtAt(tick); }
    get fun tick_at(sqrtP: Int): Int { return tickAt(sqrtP); }
    get fun add_mod(a: Int, b: Int): Int { return addMod(a, b); }
    get fun sub_mod(a: Int, b: Int): Int { return subMod(a, b); }
    get fun amount0_delta(a: Int, b: Int, liq: Int, up: Bool): Int { return amount0Delta(a, b, liq, up); }
    get fun amount1_delta(a: Int, b: Int, liq: Int, up: Bool): Int { return amount1Delta(a, b, liq, up); }
    get fun next_sqrt0(sqrtP: Int, liq: Int, amount: Int): Int { return nextSqrtFromAmount0Up(sqrtP, liq, amount); }
    get fun next_sqrt1(sqrtP: Int, liq: Int, amount: Int): Int { return nextSqrtFromAmount1Down(sqrtP, liq, amount); }
    get fun swap_step(sqrtP: Int, target: Int, liq: Int, rem: Int, fee: Int): StepResult { return swapStep(sqrtP, target, liq, rem, fee); }
    get fun liq_for_amounts(sqrtP: Int, sA: Int, sB: Int, x: Int, y: Int): Int { return liquidityForAmounts(sqrtP, sA, sB, x, y); }
    get fun amounts_for_liq(tick: Int, sqrtP: Int, tL: Int, tU: Int, liq: Int, up: Bool): Pair { return amountsForLiquidity(tick, sqrtP, tL, tU, liq, up); }
    get fun sqrt_from_amounts(a0: Int, a1: Int): Int { return sqrtFromAmounts(a0, a1); }
    get fun variable_fee(a: Int, va: Int, spacing: Int): Int { return variableFee(a, va, spacing); }
    get fun launch_extra(f: Int, d: Int, start: Int, t: Int): Int { return launchExtra(f, d, start, t); }
    get fun max_liq_per_tick(s: Int): Int { return maxLiquidityPerTick(s); }
}
