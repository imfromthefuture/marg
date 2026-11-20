import "./messages";

// The native coin (Gram) is the zero address: hash 0, so it always sorts first (token0).
const GRAM: Address = address("0:0000000000000000000000000000000000000000000000000000000000000000");

// --- fixed point and limits ---
const Q96: Int = 0x1000000000000000000000000;                                   // 2^96
const Q128: Int = 0x100000000000000000000000000000000;                          // 2^128
const MAX_U256: Int = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
const MAX_U128: Int = 0xffffffffffffffffffffffffffffffff;
const MIN_TICK: Int = -887272;
const MAX_TICK: Int = 887272;
const MIN_SQRT_RATIO: Int = 4295128739;
const MAX_SQRT_RATIO: Int = 1461446703485210103287273052203988822378723970342;
const PIPS: Int = 1000000;
const BPS: Int = 10000;
const MAX_COINS: Int = 1329227995784915872903807060280344575;                  // 2^120 - 1
const MAX_CROSSINGS_CAP: Int = 24;         // measured: see DESIGN.md §15 (spec fallback from 32)
const MAX_STEPS: Int = 48;                 // measured: see DESIGN.md §15 (spec fallback from 64)
const CHECKPOINT_SPACINGS: Int = 8;
const MAX_TICKS_PER_POOL: Int = 8192;
const MIN_POSITION_LIQUIDITY: Int = 1000;
const VA_UNIT: Int = 10000;
const MAX_TICK_SPACING: Int = 16384;
const LOCKED_FOREVER: Int = 0xFFFFFFFF;

// --- fees and caps (code constants: the admin cannot change them) ---
const MAX_BASE_FEE_PIPS: Int = 20000;          // 2%
const MAX_DYNAMIC_FEE_PIPS: Int = 50000;       // 5% base + variable
// 90% extra at t = init, decaying linearly to 0 (anti-snipe, e.g. 90% over 15 s). With the 5% dynamic
// cap the total is <= 95% of the input (PIPS - fee >= 50000 in swapStep): it can never reach 100%.
const MAX_LAUNCH_FEE_PIPS: Int = 900000;
const MAX_LAUNCH_DURATION: Int = 3600;
const MAX_MIN_LOCK: Int = 2592000;             // 30 days
const DEFAULT_PROTOCOL_SHARE_BPS: Int = 1000;  // 10% of every swap fee
const MAX_PROTOCOL_SHARE_BPS: Int = 2500;      // 25%
const MAX_HOOK_SHARE_BPS: Int = 2000;          // 20%
const MAX_REF_FEE_BPS: Int = 10;               // 0.1% of the input
const TAX_MAX_BPS: Int = 1000;                 // TAX plugin: 10% buy / 10% sell, each
// PLATFORM FEE (Gram pools; see PLATFORM_FEE_ALL_GRAM_POOLS for which keys): a share of the Gram side of
// every swap, paid straight to the Router's treasury. One global rate in the Router, initially the
// cap; the admin may set it anywhere in [0, cap] (SetPlatformFee), applied to every pool at once.
// THE scope switch (Pool.platformCharged() and Router.platformGas() both read only this):
//   false = launch keys only (ext.initializer != null) of Gram pools (the product decision);
//   true  = every Gram pool (token0 == GRAM), plain keys included.
const PLATFORM_FEE_ALL_GRAM_POOLS: Bool = false;
const PLATFORM_FEE_CAP_BPS: Int = 100;         // 1%, also the initial rate
// v4 (audit R8B-2): the platform fee cannot go below this, so a sandwich around a buyback (which swaps with
// minOut 0) stays unprofitable, also on tokens with a large creator vault (thinner pool).
const PLATFORM_FEE_MIN_BPS: Int = 85;          // 0.85% (0.75% is the sandwich break-even, audit R9B-6)
const PLATFORM_MIN_PAYOUT: Int = ton("0.01");  // below this the fee is carried in Pool.platformFees
// TAX auto-payout: once a taxed pool's taxFees reach this, the swap that crosses it pays the whole
// taxFees to taxRecipient (GramPayout reason TAX) in the same transaction. Below it the tax accrues
// (CollectTax still works).
const TAX_MIN_PAYOUT: Int = ton("0.1");

// --- hook flags ---
const HOOK_AFTER_SWAP: Int = 1;
const HOOK_AFTER_MODIFY: Int = 2;
const HOOK_FEE_CONTROL: Int = 4;
const HOOK_FLAGS_MASK: Int = 7;
// Router-internal marker in extFlags() results (not a hook flag): the key has the TAX plugin.
const TAXED_FLAG: Int = 256;
// Router-internal marker in extFlags() results: the key has an initializer (a launch key). With
// PLATFORM_FEE_ALL_GRAM_POOLS = false only such keys (of Gram pools) pay the PLATFORM FEE.
const LAUNCH_FLAG: Int = 512;

// --- swap stop reasons ---
const STOP_FILLED: Int = 0;
const STOP_LIMIT: Int = 1;
const STOP_CROSSINGS: Int = 2;
const STOP_STEPS: Int = 3;
const STOP_NO_LIQUIDITY: Int = 4;
const STOP_GAS: Int = 5;               // v3: the swap loop reached SWAP_GAS_STOP
// v3 (audit R2-H1): the swap loop stops once the transaction has used this much gas (at most;
// see swapGasStop), which leaves room for the commit, payouts and state write below TON's
// 1,000,000 gas limit per transaction.
const SWAP_GAS_STOP: Int = 650000;

// --- storage buffers ---
const ROUTER_MIN_STORAGE: Int = ton("0.05");
// v4 (audit R4A-2): WithdrawRouterExcess leaves this much, about 10 years of the Router's rent, so a quiet
// Router never runs into storage debt (which would eat the fixed-value PayTo of an LP exit).
const ROUTER_RENT_RESERVE: Int = ton("0.55");
const POOL_MIN_STORAGE: Int = ton("0.05");
const POSITION_MIN_STORAGE: Int = ton("0.02");
const MINT_ACCOUNT_MIN_STORAGE: Int = ton("0.01");
const TICK_RENT_BUFFER: Int = ton("0.02");     // refundable: returned when the tick is deleted
// Non-refundable anti-spam fee per newly initialized tick (review finding: dust ticks could fill
// MAX_TICKS_PER_POOL / the crossing cap almost for free). It stays in the Pool for good as a
// storage endowment (part of keep(); nobody, the admin included, can withdraw it).
const TICK_INIT_FEE: Int = ton("0.1");

// --- gas (tuned by gas tests to >= 1.5x measured) ---
const SWAP_BASE_GAS: Int = ton("0.35");    // base + MAX_STEPS non-crossing steps at 400 nanoGram/gas
const CROSS_GAS: Int = ton("0.006");       // extra cost of one crossing (dict get+set+walk)
const JETTON_PAYOUT_VALUE: Int = ton("0.07");
const HOOK_NOTIFY_VALUE: Int = ton("0.01");
// One direct fee payout (GramPayout, value = the fee, sent with SendPayGasSeparately): forward fee
// + action margin. swapGas adds it for a launch key (platform fee) and again for a taxed key.
const PAYOUT_MSG_GAS: Int = ton("0.01");
// Attached on top of an auto tax payout for the recipient's compute: the launch master keeps
// exactly TAX_IN_GAS = 0.04 from a tax payout's value for its split (launch/contracts/jetton.tact
// taxIn: x = min(amount, value - TAX_IN_GAS)), so with this the whole amount is split.
const TAX_PAYOUT_GAS: Int = ton("0.04");
const MINT_GAS: Int = ton("0.6");          // Pool need <= 0.5 (2 new ticks incl. TICK_INIT_FEE) + hop costs
const GRADUATE_GAS: Int = ton("0.5");      // Pool need <= 0.42 + hop costs
const LAUNCH_GAS: Int = ton("0.5");        // direct launch without dev buy: Pool need <= 0.43 + hop costs
const DEV_BUY_GAS: Int = ton("0.18");      // added when devBuy > 0 (swap compute + the jetton payout + the launch report)
const DEV_BUY_POOL_GAS: Int = ton("0.05"); // Pool-side compute of the dev buy (on top of MINT_POOL_GAS)
const POSITION_DEPLOY_VALUE: Int = ton("0.03");
const DECREASE_GAS: Int = ton("0.25");
const BURN_POOL_GAS: Int = ton("0.2");
const POSITION_SYNC_VALUE: Int = ton("0.02");
const COLLECT_GAS: Int = ton("0.2");
// v4 (audit R6A-4): CollectProtocolFees can pay two jetton legs (2 x JETTON_PAYOUT_VALUE) on a jetton/jetton
// pool; the caller gets the unused part back.
const PROTOCOL_COLLECT_GAS: Int = ton("0.35");
// v4 (audit R6B-2): the launch-outcome report to the master (GramPayout reason 19 next to a filled dev buy);
// the master's handler takes ~55k gas, so this covers a gas-price rise of ~10x.
const LAUNCH_REPORT_VALUE: Int = ton("0.04");
const ADMIN_GAS: Int = ton("0.05");
const ROUTER_REFUND_MIN: Int = ton("0.08");
const MINT_ACCOUNT_REFUND_GAS: Int = ton("0.2");
// Gas the Pool itself needs for a mint (compute + Position deploy fees), excluding buffers.
const MINT_POOL_GAS: Int = ton("0.08");
// Observation and notifying ops (§6.14).
const OBSERVE_VALUE: Int = ton("0.03");        // minimum PoolObserve value (>= 1.5x the measured cost)
const NOTIFY_FWD_TON: Int = ton("0.01");       // forward_ton_amount of a notified jetton payout / refund
const RECEIPT_VALUE: Int = ton("0.01");        // MintReceipt value (paid from the mint's gas)
const DECREASE_NOTIFY_GAS: Int = ton("0.3");   // PositionDecreaseNotify minimum value
const MINT_NOTIFY_GAS: Int = ton("0.05");      // added to MINT_GAS for a notifying mint
const RECEIPT_FLOOR: Int = ton("0.008");       // a BurnReceipt always carries at least this (if the Position has it)

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
const REASON_PARTIAL_REFUND: Int = 10;
const REASON_POSITION_OUT: Int = 11;
const REASON_HOOK_FEE: Int = 12;
const REASON_MINT_REFUND: Int = 13;
const REASON_TAX: Int = 14;
const REASON_PLATFORM: Int = 15;
const REASON_SURPLUS: Int = 16;     // v3: SweepPoolSurplus payout to the treasury
// v3 (audit V3-M1): refunds that only PoolLaunch sends (only the key's initializer can cause one),
// so the launch master can tell its launch outcome from refunds anyone can trigger.
const REASON_LAUNCH_REFUND: Int = 17;        // PoolLaunch refused: deposit (and dev buy) returned
const REASON_LAUNCH_DEVBUY_REFUND: Int = 18; // launch done, the dev buy could not fill: its Gram returned
const REASON_LAUNCH_DONE: Int = 19;          // launch done without a dev buy: the remaining value (amount 0)

// --- refund codes (RefundEvent.code, PositionSync.code, Quote.code) ---
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
const CODE_TRANSFER_BOUNCED: Int = 214;
const CODE_BAD_RECIPIENT: Int = 215;
const CODE_FWD_DROPPED: Int = 216;
const CODE_NOT_INITIALIZED: Int = 217;
const CODE_NOT_INITIALIZER: Int = 218;
const CODE_BAD_TICKS: Int = 219;
const CODE_PRICE_OUT_OF_RANGE: Int = 220;
const CODE_LIQUIDITY_BELOW_MIN: Int = 221;
const CODE_PARTIAL_NOT_ALLOWED: Int = 222;
const CODE_NO_LIQUIDITY: Int = 223;
const CODE_TICK_LIMIT: Int = 224;
const CODE_LOCKED: Int = 225;
const CODE_BUSY: Int = 226;
const CODE_BAD_KEY: Int = 227;
const CODE_BAD_TICK_SPACING: Int = 228;
const CODE_MATH_FAILURE: Int = 229;
const CODE_BAD_PRICE_LIMIT: Int = 230;
const CODE_ALREADY_INITIALIZED: Int = 231;
const CODE_BAD_CROSSINGS: Int = 232;
const CODE_BURN_BOUNCED: Int = 233;     // BurnReceipt: the PoolBurnNotify bounced (nothing changed)
const CODE_MINT_MISMATCH: Int = 234;    // MintAccount: the legs' params differ, both refunded

// --- forward payloads (copied from v1) ---
const PAYLOAD_HOPS: Int = 6;
const MAX_PAYLOAD_CELLS: Int = 32;
const PAYOUT_WALLET_MIN: Int = ton("0.06");

// --- payload opcodes ---
const OP_SWAP_PAYLOAD: Int = 0x4d480001;
const OP_MINT_PAYLOAD: Int = 0x4d480002;
const OP_GRADUATE_PAYLOAD: Int = 0x4d480003;
const OP_LAUNCH_PAYLOAD: Int = 0x4d480004;
const OP_MINT_NOTIFY_PAYLOAD: Int = 0x4d480005;

// ---------------------------------------------------------------------------
// Small helpers (copied from v1)
// ---------------------------------------------------------------------------

fun sortKey(a: Address): Int {
    return parseStdAddress(a.asSlice()).address;
}

// True only for a plain addr_std in workchain 0 (no anycast). Never throws: Tact 1.6 loads every
// Address with LDMSGADDR and does not verify it, so a payload can carry addr_none, addr_extern,
// addr_var, an anycast or a non-existent workchain. A message to such an address fails the action
// phase, which on a non-bounceable hop strands the assets (review finding 1 / 3).
fun isBasechain(a: Address): Bool {
    let s = a.asSlice();
    return s.bits() == 267 && s.refs() == 0 && s.preloadUint(11) == 1024;   // 0b100 + int8 0
}

fun isBasechainOpt(a: Address?): Bool {
    return a == null || isBasechain(a!!);
}

// Floor square root (stdlib sqrt rounds).
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

// Forward fees of a swap's output payload on all remaining hops; -1 if too large. Never throws.
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

fun eitherPayload(payload: Cell?): Slice {
    if (payload == null) {
        return beginCell().storeBool(false).asSlice();
    }
    return beginCell().storeBool(true).storeRef(payload!!).asSlice();
}

// KeyExt of a key; a null ext is the all-zero plain pool. Throws on a malformed cell.
fun extOf(ext: Cell?): KeyExt {
    if (ext == null) {
        return KeyExt {
            hook: null, hookFlags: 0, hookShareBps: 0, hookFeeMin: 0, hookFeeMax: 0,
            initializer: null, launchFeePips: 0, launchDuration: 0, minLockSecs: 0,
            taxRecipient: null, buyTaxBps: 0, sellTaxBps: 0,
        };
    }
    return KeyExt.fromCell(ext!!);
}

// TAX plugin rules, checked by the Router (extFlags) and again by the Pool at initialization:
// each tax <= TAX_MAX_BPS; a recipient iff some tax is set; a taxed key needs an initializer (so
// only that address can create it) and a Gram pool (the tax is always taken in Gram).
fun taxValid(e: KeyExt, gramPool: Bool): Bool {
    if (e.buyTaxBps > TAX_MAX_BPS || e.sellTaxBps > TAX_MAX_BPS) {
        return false;
    }
    let taxed = e.buyTaxBps > 0 || e.sellTaxBps > 0;
    if (taxed != (e.taxRecipient != null)) {
        return false;
    }
    return !taxed || (gramPool && e.initializer != null);
}

fun feeStateFromPreset(p: FeePreset, t: Int): FeeState {
    return FeeState {
        baseFeePips: p.baseFeePips,
        varFeeControl: p.varFeeControl,
        filterPeriod: p.filterPeriod,
        decayPeriod: p.decayPeriod,
        reductionBps: p.reductionBps,
        maxVolAcc: p.maxVolAcc,
        volAcc: 0,
        volRef: 0,
        idxRef: 0,
        lastTs: t,
        startTs: t,
        protocolShareBps: DEFAULT_PROTOCOL_SHARE_BPS,
        hookFeeSet: false,
        hookFeePips: 0,
    };
}

fun emptyFeeState(): FeeState {
    return FeeState {
        baseFeePips: 0, varFeeControl: 0, filterPeriod: 0, decayPeriod: 0, reductionBps: 0,
        maxVolAcc: 0, volAcc: 0, volRef: 0, idxRef: 0, lastTs: 0, startTs: 0,
        protocolShareBps: DEFAULT_PROTOCOL_SHARE_BPS, hookFeeSet: false, hookFeePips: 0,
    };
}
