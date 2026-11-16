import "../vault_math";

// TESTS ONLY. Getters over the copied v3 math, compared with dex/v2's MathHarness.
contract VaultMathHarness {
    init() {}

    receive() {}

    get fun sqrt_at(tick: Int): Int { return sqrtAt(tick); }
    get fun tick_at(sqrtP: Int): Int { return tickAt(sqrtP); }
    get fun sub_mod(a: Int, b: Int): Int { return subMod(a, b); }
    get fun amount0_delta(a: Int, b: Int, liq: Int, up: Bool): Int { return amount0Delta(a, b, liq, up); }
    get fun amount1_delta(a: Int, b: Int, liq: Int, up: Bool): Int { return amount1Delta(a, b, liq, up); }
    get fun liq_for_amounts(sqrtP: Int, sA: Int, sB: Int, x: Int, y: Int): Int { return liquidityForAmounts(sqrtP, sA, sB, x, y); }
    get fun amounts_for_liq(tick: Int, sqrtP: Int, tL: Int, tU: Int, liq: Int, up: Bool): Pair { return amountsForLiquidity(tick, sqrtP, tL, tU, liq, up); }
}
