import "./messages";

// The native coin (Gram) is identified by the zero address. Its hash is 0, so it always
// sorts first: a native pool is always (GRAM, jettonWallet).
const GRAM: Address = address("0:0000000000000000000000000000000000000000000000000000000000000000");

// --- fees (basis points) ---
const BPS: Int = 10000;
const DEFAULT_LP_FEE_BPS: Int = 25;        // 0.25%, stays in the reserves
const DEFAULT_PROTOCOL_FEE_BPS: Int = 5;   // 0.05%, accrues for the treasury
const MAX_LP_FEE_BPS: Int = 100;           // hard cap 1%, checked in Router AND Pool
const MAX_PROTOCOL_FEE_BPS: Int = 50;      // hard cap 0.5%
const MAX_REF_FEE_BPS: Int = 10;           // hard cap 0.1%, chosen per swap

// --- liquidity ---
const MIN_LIQUIDITY: Int = 1000;           // locked forever on the first deposit
const MAX_COINS: Int = 1329227995784915872903807060280344575; // 2^120 - 1, largest `coins`
// A deposit counterpart below this many base units is "coarse": see calcAddLiquidity.
const COARSE_UNITS: Int = 1000000;

// --- storage buffers (kept outside any reserves) ---
const ROUTER_MIN_STORAGE: Int = ton("0.05");
const POOL_MIN_STORAGE: Int = ton("0.05");
const LP_ACCOUNT_MIN_STORAGE: Int = ton("0.01");
const LP_WALLET_MIN_STORAGE: Int = ton("0.01");
const LP_WALLET_GAS: Int = ton("0.015");

// --- gas (starting points; tests measure and tune to ~1.5x observed) ---
const LP_MINT_VALUE: Int = ton("0.05");        // value attached to an LP mint (wallet deploy + excess)
const JETTON_PAYOUT_VALUE: Int = ton("0.07");  // fixed value of one non-final Pool -> Router PayTo
const SWAP_GAS: Int = ton("0.2");
const PROVIDE_GAS: Int = ton("0.3");
const PROVIDE_BOTH_GAS: Int = ton("0.25");
const BURN_GAS: Int = ton("0.25");             // documented value to attach to JettonBurn
const BURN_POOL_GAS: Int = ton("0.2");         // checked by the Pool
const LP_ACCOUNT_REFUND_GAS: Int = ton("0.2");
const COLLECT_GAS: Int = ton("0.2");
const ADMIN_GAS: Int = ton("0.05");
const ROUTER_REFUND_MIN: Int = ton("0.08");    // below this a jetton refund cannot be paid for

// --- payout reasons (GramPayout.reason / PayTo.reason) ---
const REASON_SWAP_OUT: Int = 1;
const REASON_SWAP_REFUND: Int = 2;
const REASON_PROVIDE_REFUND: Int = 3;
const REASON_LP_EXCESS: Int = 4;
const REASON_BURN_OUT: Int = 5;
const REASON_REFERRAL: Int = 6;
const REASON_PROTOCOL_FEE: Int = 7;
const REASON_LP_ACCOUNT_REFUND: Int = 8;
const REASON_INVALID_REFUND: Int = 9;

// --- refund codes (RefundEvent.code) ---
const CODE_DEADLINE: Int = 201;
const CODE_SLIPPAGE: Int = 202;
const CODE_EMPTY_POOL: Int = 203;
const CODE_LOW_GAS: Int = 204;
const CODE_BAD_PAYLOAD: Int = 205;
const CODE_SAME_TOKEN: Int = 206;
const CODE_CREATION_PAUSED: Int = 207;
const CODE_ZERO_OUT: Int = 208;
const CODE_OVERFLOW: Int = 209;
const CODE_LP_BELOW_MIN: Int = 210;
const CODE_POOL_NOT_EMPTY: Int = 211;
const CODE_BAD_REF_BPS: Int = 212;
const CODE_BAD_TOKEN: Int = 213;
const CODE_TRANSFER_BOUNCED: Int = 214;   // a Router JettonTransfer bounced (broken jetton)
const CODE_BAD_RECIPIENT: Int = 215;      // a receiver/refundTo/lpReceiver/referral was the Router itself
const CODE_FWD_DROPPED: Int = 216;        // payout delivered without fwdTon/fwdPayload (value too low for them)

// --- forward payloads (SwapPayload.fwdPayload / SwapNative.fwdPayload) ---
// The payload travels Router -> Pool -> Router -> Router wallet -> receiver wallet -> receiver,
// so its forward fee is paid on up to 5 hops; 6 leaves margin for fee rounding at each hop.
const PAYLOAD_HOPS: Int = 6;
// Larger payloads are refused: a bounded cell count bounds both the fee estimate and its gas.
const MAX_PAYLOAD_CELLS: Int = 32;
// Value a Router payout transfer needs besides fwdTon and forward fees: the Router's own gas and
// a standard wallet's check (2 * wallet gas + its storage minimum), with margin.
const PAYOUT_WALLET_MIN: Int = ton("0.06");

// --- payload opcodes (to dispatch before parsing) ---
const OP_SWAP_PAYLOAD: Int = 0x4d470001;
const OP_PROVIDE_LP_PAYLOAD: Int = 0x4d470002;
const OP_PROVIDE_BOTH_PAYLOAD: Int = 0x4d470003;

// ---------------------------------------------------------------------------
// Pure helpers. Getters and receivers call the same functions, so quotes match execution.
// ---------------------------------------------------------------------------

inline fun gram(): Address {
    return GRAM;
}

// Pairs are sorted by the 256-bit account id. Only basechain ids are accepted, so the hash
// alone is unambiguous.
fun sortKey(a: Address): Int {
    return parseStdAddress(a.asSlice()).address;
}

fun isBasechain(a: Address): Bool {
    return parseStdAddress(a.asSlice()).workchain == 0;
}

// Floor square root. The stdlib sqrt rounds, so correct it to the floor.
fun isqrt(n: Int): Int {
    if (n <= 0) {
        return 0;
    }
    let s = sqrt(n);
    while (s * s > n) {
        s -= 1;
    }
    while ((s + 1) * (s + 1) <= n) {
        s += 1;
    }
    return s;
}

// Ceil division for non-negative a and positive b.
inline fun ceilDiv(a: Int, b: Int): Int {
    return (a + b - 1) / b;
}

// Exact-in swap. Fees come off the input: the LP fee stays in the reserves, the protocol fee
// and the referral fee are taken out of it. Output rounds down (pool-favoured).
fun calcSwapOut(amountIn: Int, reserveIn: Int, reserveOut: Int,
                lpFeeBps: Int, protocolFeeBps: Int, refBps: Int): ExpectedOut {
    if (amountIn <= 0 || reserveIn <= 0 || reserveOut <= 0) {
        return ExpectedOut { amountOut: 0, protocolFee: 0, refFee: 0 };
    }
    let protocolFee = amountIn * protocolFeeBps / BPS;
    let refFee = amountIn * refBps / BPS;
    let inWithFee = amountIn * (BPS - lpFeeBps - protocolFeeBps - refBps);
    let amountOut = inWithFee * reserveOut / (reserveIn * BPS + inWithFee);
    return ExpectedOut { amountOut, protocolFee, refFee };
}

// LP minted for a deposit. First deposit: isqrt(a0*a1) - MIN_LIQUIDITY (0 if not above it).
// Later deposits take the ratio-optimal amounts: the side with the smaller LP claim limits, and
// the other side (the counterpart) is matched to it. Pool-favoured rounding has two forms:
// - ceil the counterpart: the depositor gives away < 1 base unit of the counterpart. That is
//   negligible (< 1 ppm) once the counterpart amount reaches COARSE_UNITS, and it needs no refund
//   on the limiting side, so it is used there.
// - floor the counterpart, then ceil the limiting side to match: the loss is < 1 unit of the
//   limiting side, at the price of refunding a little of it. Used for a coarse counterpart (a
//   0-decimal jetton or a drained reserve), where rounding up could cost a whole valuable unit.
// Either way the pool is never short-changed and the LP minted rounds down.
// Returns lp = 0 when nothing would be minted.
fun calcAddLiquidity(a0: Int, a1: Int, r0: Int, r1: Int, supply: Int): ExpectedLp {
    if (a0 <= 0 || a1 <= 0) {
        return ExpectedLp { lp: 0, use0: 0, use1: 0 };
    }
    if (supply == 0) {
        let liq = isqrt(a0 * a1);
        if (liq <= MIN_LIQUIDITY) {
            return ExpectedLp { lp: 0, use0: a0, use1: a1 };
        }
        return ExpectedLp { lp: liq - MIN_LIQUIDITY, use0: a0, use1: a1 };
    }
    if (r0 <= 0 || r1 <= 0) {
        return ExpectedLp { lp: 0, use0: 0, use1: 0 };
    }
    let lp0 = a0 * supply / r0;
    let lp1 = a1 * supply / r1;
    let use0 = a0;
    let use1 = a1;
    if (lp0 <= lp1) {
        let c = ceilDiv(a0 * r1, r0);
        if (c >= COARSE_UNITS) {
            use1 = min(a1, c);
        } else {
            use1 = min(a1, a0 * r1 / r0);
            use0 = min(a0, ceilDiv(use1 * r0, r1));
        }
    } else {
        let c = ceilDiv(a1 * r0, r1);
        if (c >= COARSE_UNITS) {
            use0 = min(a0, c);
        } else {
            use0 = min(a0, a1 * r0 / r1);
            use1 = min(a1, ceilDiv(use0 * r1, r0));
        }
    }
    let minted = min(use0 * supply / r0, use1 * supply / r1);
    return ExpectedLp { lp: minted, use0, use1 };
}

// Pro-rata burn, rounding down.
fun calcBurn(amount: Int, r0: Int, r1: Int, supply: Int): ExpectedBurn {
    if (amount <= 0 || supply <= 0 || amount > supply) {
        return ExpectedBurn { out0: 0, out1: 0 };
    }
    return ExpectedBurn { out0: amount * r0 / supply, out1: amount * r1 / supply };
}

// Forward fees the swap's output payload costs on all its remaining hops, or -1 when it has more
// than MAX_PAYLOAD_CELLS distinct cells. Never throws (callers include non-bounceable paths).
fun payloadFee(p: Cell?): Int {
    if (p == null) {
        return 0;
    }
    let fee = -1;
    try {
        let size = p!!.computeDataSize(MAX_PAYLOAD_CELLS);
        fee = PAYLOAD_HOPS * getForwardFee(size.cells, size.bits, false);
    } catch (e) {
        fee = -1;
    }
    return fee;
}

// Forward fee of one Router -> wallet JettonTransfer carrying `p` (one body cell plus the payload);
// -1 if the payload is too large to measure.
fun transferFee(p: Cell?): Int {
    if (p == null) {
        return getForwardFee(1, 1023, false);
    }
    let fee = -1;
    try {
        let size = p!!.computeDataSize(MAX_PAYLOAD_CELLS);
        fee = getForwardFee(size.cells + 1, size.bits + 1023, false);
    } catch (e) {
        fee = -1;
    }
    return fee;
}

// Jetton forward payload in the Either form expected by TEP-74: bit 0 inline, bit 1 in a ref.
fun eitherPayload(payload: Cell?): Slice {
    if (payload == null) {
        return beginCell().storeBool(false).asSlice();
    }
    return beginCell().storeBool(true).storeRef(payload!!).asSlice();
}
