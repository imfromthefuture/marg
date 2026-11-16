import "./shared";

// Marg DEX v2 messages. Our own opcodes use the prefix 0x4d48 ("MH").
// The TEP-74 / TEP-62 messages are copied here on purpose (not imported from v1 or the launchpad).

// ---------------------------------------------------------------------------
// TEP-74 jetton messages
// ---------------------------------------------------------------------------

message(0x0f8a7ea5) JettonTransfer {
    queryId: Int as uint64;
    amount: Int as coins;
    destination: Address;
    responseDestination: Address?;
    customPayload: Cell?;
    forwardTonAmount: Int as coins;
    forwardPayload: Slice as remaining;
}

message(0x178d4519) JettonTransferInternal {
    queryId: Int as uint64;
    amount: Int as coins;
    sender: Address;
    responseDestination: Address?;
    forwardTonAmount: Int as coins;
    forwardPayload: Slice as remaining;
}

message(0x7362d09c) JettonNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    sender: Address;
    forwardPayload: Slice as remaining;
}

message(0xd53276db) JettonExcesses {
    queryId: Int as uint64;
}

message(0x2c76b973) ProvideWalletAddress {
    queryId: Int as uint64;
    ownerAddress: Address;
    includeAddress: Bool;
}

message(0xd1735400) TakeWalletAddress {
    queryId: Int as uint64;
    walletAddress: Address;
    ownerAddress: Cell?;
}

struct JettonData {
    totalSupply: Int;
    mintable: Bool;
    adminAddress: Address?;
    jettonContent: Cell;
    jettonWalletCode: Cell;
}

struct JettonWalletData {
    balance: Int;
    owner: Address;
    master: Address;
    code: Cell;
}

// ---------------------------------------------------------------------------
// TEP-62 NFT messages (Position = item, Pool = collection)
// ---------------------------------------------------------------------------

message(0x5fcc3d14) NftTransfer {
    queryId: Int as uint64;
    newOwner: Address;
    responseDestination: Address?;
    customPayload: Cell?;
    forwardAmount: Int as coins;
    forwardPayload: Slice as remaining;
}

message(0x05138d91) OwnershipAssigned {
    queryId: Int as uint64;
    prevOwner: Address;
    forwardPayload: Slice as remaining;
}

message(0x2fcb26a2) GetStaticData {
    queryId: Int as uint64;
}

message(0x8b771735) ReportStaticData {
    queryId: Int as uint64;
    index: Int as uint256;
    collection: Address;
}

struct NftData {
    initialized: Bool;
    index: Int;
    collection: Address;
    owner: Address?;
    content: Cell?;
}

struct CollectionData {
    nextItemIndex: Int;
    content: Cell;
    owner: Address?;
}

// ---------------------------------------------------------------------------
// Core structs
// ---------------------------------------------------------------------------

struct FeePreset {
    baseFeePips: Int as uint32;
    varFeeControl: Int as uint32;   // A; 0 disables the volatility fee
    filterPeriod: Int as uint16;
    decayPeriod: Int as uint16;
    reductionBps: Int as uint16;
    maxVolAcc: Int as uint32;
}

struct FeeState {
    baseFeePips: Int as uint32;
    varFeeControl: Int as uint32;
    filterPeriod: Int as uint16;
    decayPeriod: Int as uint16;
    reductionBps: Int as uint16;
    maxVolAcc: Int as uint32;
    volAcc: Int as uint32;
    volRef: Int as uint32;
    idxRef: Int as int32;
    lastTs: Int as uint32;
    startTs: Int as uint32;
    protocolShareBps: Int as uint16;
    hookFeeSet: Bool;
    hookFeePips: Int as uint32;
}

// 768 bits: one cell per initialized tick.
struct TickInfo {
    liqGross: Int as uint128;
    liqNet: Int as int128;
    fgOut0: Int as uint256;
    fgOut1: Int as uint256;
}

struct MintParams {
    tickLower: Int as int24;
    tickUpper: Int as int24;
    sqrtPriceInitX96: Int as uint160;
    minLiquidity: Int as uint128;
    owner: Address;
    refundTo: Address;
    deadline: Int as uint32;
    // Mint price guard (review finding 8): refund SLIPPAGE unless min <= sqrtPrice <= max at
    // execution (0 = no bound). minLiquidity alone does not protect an over-supplied side.
    sqrtPriceMinX96: Int as uint160;
    sqrtPriceMaxX96: Int as uint160;
}

// ---------------------------------------------------------------------------
// Forward payloads (inside JettonNotification.forwardPayload, Either inline/ref)
// ---------------------------------------------------------------------------

message(0x4d480001) SwapPayload {
    otherToken: Address;            // Router wallet of the output token, or GRAM
    tickSpacing: Int as uint16;
    ext: Cell?;
    minOut: Int as coins;
    sqrtPriceLimitX96: Int as uint160;  // 0 = none
    maxCrossings: Int as uint8;     // 1..32
    allowPartial: Bool;
    deadline: Int as uint32;
    receiver: Address?;
    refundTo: Address?;
    referral: Address?;
    refBps: Int as uint16;
    fwdTon: Int as coins;
    fwdPayload: Cell?;
}

message(0x4d480002) MintPayload {
    otherToken: Address;
    tickSpacing: Int as uint16;
    ext: Cell?;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    gramAmount: Int as coins;       // > 0: dual native mint, the Gram rides in forwardTonAmount
    viaAccount: Bool;               // jetton/jetton in-range mint through a MintAccount
    sqrtPriceInitX96: Int as uint160;
    minLiquidity: Int as uint128;
    owner: Address?;
    refundTo: Address?;
    deadline: Int as uint32;
    sqrtPriceMinX96: Int as uint160;    // 0 = no bound
    sqrtPriceMaxX96: Int as uint160;    // 0 = no bound
}

// One cell (802 bits) so a launchpad can build it by hand.
message(0x4d480003) GraduatePayload {
    gramAmount: Int as coins;
    tickSpacing: Int as uint16;
    launchFeePips: Int as uint32;
    launchDuration: Int as uint32;
    feeClaimer: Address;
    refundTo: Address;
    deadline: Int as uint32;
}

// ---------------------------------------------------------------------------
// User / admin -> Router
// ---------------------------------------------------------------------------

message(0x4d480011) SwapNative {
    queryId: Int as uint64;
    amount: Int as coins;
    otherToken: Address;
    tickSpacing: Int as uint16;
    ext: Cell?;
    minOut: Int as coins;
    sqrtPriceLimitX96: Int as uint160;
    maxCrossings: Int as uint8;
    allowPartial: Bool;
    deadline: Int as uint32;
    receiver: Address?;
    refundTo: Address?;
    referral: Address?;
    refBps: Int as uint16;
    fwdTon: Int as coins;
    fwdPayload: Cell?;
}

message(0x4d480012) MintNative {
    queryId: Int as uint64;
    amount: Int as coins;
    otherToken: Address;
    tickSpacing: Int as uint16;
    ext: Cell?;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    sqrtPriceInitX96: Int as uint160;
    minLiquidity: Int as uint128;
    owner: Address?;
    refundTo: Address?;
    deadline: Int as uint32;
    sqrtPriceMinX96: Int as uint160;    // 0 = no bound
    sqrtPriceMaxX96: Int as uint160;    // 0 = no bound
}

message(0x4d480013) CollectProtocolFees {
    queryId: Int as uint64;
    key: PoolKey;
}

message(0x4d480014) SetProtocolShare {
    queryId: Int as uint64;
    key: PoolKey;
    shareBps: Int as uint16;
}

message(0x4d480015) SetCreationPaused {
    queryId: Int as uint64;
    paused: Bool;
}

message(0x4d480016) SetTreasury {
    queryId: Int as uint64;
    treasury: Address;
}

message(0x4d480017) TransferAdmin {
    queryId: Int as uint64;
    newAdmin: Address;
}

message(0x4d480018) ClaimAdmin {
    queryId: Int as uint64;
}

message(0x4d480019) WithdrawRouterExcess {
    queryId: Int as uint64;
}

message(0x4d48001a) AddFeePreset {
    queryId: Int as uint64;
    tickSpacing: Int as uint16;
    preset: FeePreset;
}

// Anyone; the pool's accrued tax always goes to key.ext.taxRecipient.
message(0x4d48001b) CollectTax {
    queryId: Int as uint64;
    key: PoolKey;
}

// Admin: set the global PLATFORM FEE in [0, PLATFORM_FEE_CAP_BPS] (1%).
message(0x4d48001d) SetPlatformFee {
    queryId: Int as uint64;
    bps: Int as uint16;
}

// Anyone: pay a launch pool's carried (sub-PLATFORM_MIN_PAYOUT) platform fees to the treasury.
message(0x4d48001e) CollectPlatformFees {
    queryId: Int as uint64;
    key: PoolKey;
}

// ---------------------------------------------------------------------------
// Router -> Pool
// ---------------------------------------------------------------------------

message(0x4d480021) PoolSwap {
    queryId: Int as uint64;
    fromUser: Address;
    zeroForOne: Bool;
    amountIn: Int as coins;
    minOut: Int as coins;
    sqrtPriceLimitX96: Int as uint160;
    maxCrossings: Int as uint8;
    allowPartial: Bool;
    deadline: Int as uint32;
    receiver: Address;
    refundTo: Address;
    referral: Address?;
    refBps: Int as uint16;
    fwdTon: Int as coins;
    fwdPayload: Cell?;
    platformBps: Int as uint16;     // the Router's current PLATFORM FEE (charged on launch keys only)
    platformTo: Address;            // its recipient (the Router's treasury)
}

message(0x4d480022) PoolMint {
    queryId: Int as uint64;
    fromUser: Address;
    amount0: Int as coins;
    amount1: Int as coins;
    params: MintParams;
    viaAccount: Bool;
    allowInit: Bool;
    preset: FeePreset;
}

message(0x4d480023) PoolGraduate {
    queryId: Int as uint64;
    fromUser: Address;
    amount0: Int as coins;
    amount1: Int as coins;
    feeClaimer: Address;
    refundTo: Address;
    deadline: Int as uint32;
    allowInit: Bool;
    preset: FeePreset;
}

message(0x4d480024) PoolSetProtocolShare {
    queryId: Int as uint64;
    shareBps: Int as uint16;
    excessTo: Address;
}

message(0x4d480025) PoolCollectProtocol {
    queryId: Int as uint64;
    treasury: Address;
    excessTo: Address;
}

// Direct launch (§6.11): initialize at the start price, mint the jetton-only locked position, and
// (optionally) run the dev buy, all in one Pool transaction.
message(0x4d480026) PoolLaunch {
    queryId: Int as uint64;
    fromUser: Address;
    amount1: Int as coins;
    sqrtPriceX96: Int as uint160;
    feeClaimer: Address;
    refundTo: Address;
    deadline: Int as uint32;
    devBuy: Int as coins;
    minDevOut: Int as coins;
    devReceiver: Address;
    allowInit: Bool;
    preset: FeePreset;
    platformBps: Int as uint16;     // PLATFORM FEE of the dev buy (and the pool's initial last-seen rate)
    platformTo: Address;
}

message(0x4d480027) PoolCollectTax {
    queryId: Int as uint64;
    excessTo: Address;
}

message(0x4d480029) PoolCollectPlatform {
    queryId: Int as uint64;
    treasury: Address;
    excessTo: Address;
}

// ---------------------------------------------------------------------------
// Pool -> Router: the only way jettons leave the Router's wallets
// ---------------------------------------------------------------------------

message(0x4d480031) PayTo {
    queryId: Int as uint64;
    key: PoolKey;                   // identifies (and authenticates) the commanding pool
    wallet: Address;                // token0 or token1, never GRAM
    amount: Int as coins;
    to: Address;
    excessTo: Address;
    fwdTon: Int as coins;
    fwdPayload: Cell?;
    reason: Int as uint8;
}

// ---------------------------------------------------------------------------
// Positions and MintAccount
// ---------------------------------------------------------------------------

message(0x4d480041) PositionInit {
    queryId: Int as uint64;
    owner: Address;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    liquidity: Int as uint128;
    fgInside0: Int as uint256;
    fgInside1: Int as uint256;
    lockedUntil: Int as uint32;
}

message(0x4d480042) PositionDecrease {
    queryId: Int as uint64;
    liquidityDelta: Int as uint128;     // 0 = collect fees only
    amount0Min: Int as coins;
    amount1Min: Int as coins;
    deadline: Int as uint32;
    recipient: Address?;
}

message(0x4d480043) PoolBurn {
    queryId: Int as uint64;
    index: Int as uint64;
    owner: Address;
    recipient: Address;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    liquidity: Int as uint128;
    liquidityDelta: Int as uint128;
    fgLast0: Int as uint256;
    fgLast1: Int as uint256;
    amount0Min: Int as coins;
    amount1Min: Int as coins;
    deadline: Int as uint32;
}

message(0x4d480044) PositionSync {
    queryId: Int as uint64;
    ok: Bool;
    code: Int as uint16;
    liquidity: Int as uint128;
    fgInside0: Int as uint256;
    fgInside1: Int as uint256;
}

// allowInit and preset ride along so a via-account mint can initialize the pool (§15 deviation).
message(0x4d480045) MintAccountDeposit {
    queryId: Int as uint64;
    amount0: Int as coins;
    amount1: Int as coins;
    params: MintParams;
    allowInit: Bool;
    preset: FeePreset;
}

message(0x4d480046) CbMint {
    queryId: Int as uint64;
    user: Address;
    amount0: Int as coins;
    amount1: Int as coins;
    params: MintParams;
    allowInit: Bool;
    preset: FeePreset;
}

message(0x4d480047) CbMintRefund {
    queryId: Int as uint64;
    user: Address;
    amount0: Int as coins;
    amount1: Int as coins;
}

message(0x4d480048) MintAccountRefund {
    queryId: Int as uint64;
}

// MintAccount -> Pool when an arriving leg's params differ from the parked leg's (review issue 2):
// no pairing; each leg goes back to its OWN refundTo (amount0/1 -> refundTo, stored0/1 -> storedTo).
message(0x4d48004c) CbMintReject {
    queryId: Int as uint64;
    user: Address;
    amount0: Int as coins;
    amount1: Int as coins;
    refundTo: Address;
    stored0: Int as coins;
    stored1: Int as coins;
    storedTo: Address;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

message(0x4d480051) HookAfterSwap {
    queryId: Int as uint64;
    fromUser: Address;
    zeroForOne: Bool;
    amountIn: Int as coins;         // consumed + referral fee
    amountOut: Int as coins;
    sqrtPriceX96: Int as uint160;
    tick: Int as int24;
    liquidity: Int as uint128;
    feePips: Int as uint32;         // last step
}

message(0x4d480052) HookAfterModify {
    queryId: Int as uint64;
    owner: Address;
    index: Int as uint64;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    liquidityDelta: Int as int129;
    amount0: Int as coins;
    amount1: Int as coins;
}

message(0x4d480053) HookSetFee {
    queryId: Int as uint64;
    feePips: Int as uint32;
}

message(0x4d480054) HookCollectFees {
    queryId: Int as uint64;
}

// ---------------------------------------------------------------------------
// Payouts and events
// ---------------------------------------------------------------------------

message(0x4d480061) GramPayout {
    queryId: Int as uint64;
    reason: Int as uint8;
    amount: Int as coins;
    payload: Cell?;
}

message(0x4d480071) SwapEvent {
    fromUser: Address;
    zeroForOne: Bool;
    amountIn: Int as coins;
    amountOut: Int as coins;
    refFee: Int as coins;
    feeTotal: Int as coins;
    protocolFee: Int as coins;
    hookFee: Int as coins;
    sqrtPriceX96: Int as uint160;
    tick: Int as int24;
    liquidity: Int as uint128;
    crossings: Int as uint8;
    steps: Int as uint8;
    stop: Int as uint8;
    tax: Int as coins;              // TAX plugin, in Gram (buy: part of amountIn; sell: amountOut is net of it)
    platformFee: Int as coins;      // PLATFORM FEE, in Gram (like tax: buy part of amountIn; sell amountOut net of it)
}

message(0x4d480072) ModifyEvent {
    owner: Address;
    index: Int as uint64;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    liquidityDelta: Int as int129;
    amount0: Int as coins;
    amount1: Int as coins;
    fees0: Int as coins;
    fees1: Int as coins;
}

message(0x4d480073) RefundEvent {
    queryId: Int as uint64;
    user: Address;
    code: Int as uint16;
}

message(0x4d480074) InitializeEvent {
    sqrtPriceX96: Int as uint160;
    tick: Int as int24;
    initializer: Address?;
    graduation: Bool;
}

// Direct launch result: names the canonical key of the launched token.
message(0x4d480075) LaunchEvent {
    key: PoolKey;
    feeClaimer: Address;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    liquidity: Int as uint128;
    amount1: Int as coins;          // jettons in the locked position
    devIn: Int as coins;            // Gram taken by the dev buy (0 = none or refused)
    devOut: Int as coins;           // jettons paid to devReceiver
}

// ---------------------------------------------------------------------------
// Observation and notifying ops (DESIGN.md §6.14, additive: every message above is unchanged)
// ---------------------------------------------------------------------------

// Anyone -> Pool (value >= OBSERVE_VALUE, else the Pool throws and a bounceable request bounces).
// A pure read, answered with PoolObservation to the sender.
message(0x4d480081) PoolObserve {
    queryId: Int as uint64;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    payload: Cell?;                 // echoed
}

// Pool -> the PoolObserve sender (bounce: false, the remaining value). All values at `time`.
message(0x4d480082) PoolObservation {
    queryId: Int as uint64;
    initialized: Bool;              // false: every price field is 0
    sqrtPriceX96: Int as uint160;
    tick: Int as int24;
    liquidity: Int as uint128;      // active liquidity
    tickCumulative: Int as int64;   // Σ tick·dt, extrapolated to `time` (= get_observe)
    time: Int as uint32;            // the Pool's now()
    tickLower: Int as int24;        // echoed
    tickUpper: Int as int24;
    rangeOk: Bool;                  // valid range AND both ticks initialized (v3 snapshotCumulativesInside)
    feeGrowthInside0X128: Int as uint256;   // v3 getFeeGrowthInside(tickLower, tickUpper); 0 unless rangeOk
    feeGrowthInside1X128: Int as uint256;
    payload: Cell?;
}

// owner -> Position: PositionDecrease whose result is reported to the owner (value >= DECREASE_NOTIFY_GAS).
message(0x4d480049) PositionDecreaseNotify {
    queryId: Int as uint64;
    liquidityDelta: Int as uint128;     // 0 = collect fees only
    amount0Min: Int as coins;
    amount1Min: Int as coins;
    deadline: Int as uint32;
    recipient: Address?;
}

// Position -> Pool: PoolBurn of a notifying decrease (same fields).
message(0x4d48004a) PoolBurnNotify {
    queryId: Int as uint64;
    index: Int as uint64;
    owner: Address;
    recipient: Address;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    liquidity: Int as uint128;
    liquidityDelta: Int as uint128;
    fgLast0: Int as uint256;
    fgLast1: Int as uint256;
    amount0Min: Int as coins;
    amount1Min: Int as coins;
    deadline: Int as uint32;
}

// Pool -> Position: PositionSync of a notifying decrease, plus the amounts the Position relays.
message(0x4d48004b) PositionSyncNotify {
    queryId: Int as uint64;
    ok: Bool;
    code: Int as uint16;
    liquidity: Int as uint128;
    fgInside0: Int as uint256;
    fgInside1: Int as uint256;
    liquidityDelta: Int as uint128;
    amount0: Int as coins;
    amount1: Int as coins;
    fees0: Int as coins;
    fees1: Int as coins;
}

// Position -> owner: the result of a notifying decrease, sent once the Position is free again
// (it replaces the JettonExcesses of a plain decrease and carries the same remaining value).
// Exactly one per accepted PositionDecreaseNotify: ok, a Pool refusal (code), or a bounced PoolBurn
// (code = BURN_BOUNCED).
message(0x4d480083) BurnReceipt {
    queryId: Int as uint64;
    index: Int as uint64;
    ok: Bool;
    code: Int as uint16;
    liquidityDelta: Int as uint128;     // removed (0 when !ok)
    liquidity: Int as uint128;          // the position's liquidity after the op
    amount0: Int as coins;              // principal paid to the recipient
    amount1: Int as coins;
    fees0: Int as coins;                // fees paid to the recipient
    fees1: Int as coins;
    fgInside0: Int as uint256;          // the position's fee checkpoint after the op
    fgInside1: Int as uint256;
}

// Notifying mint entries: same fields as MintPayload (minus viaAccount, which they refuse) and
// MintNative. The payer (fromUser) gets a MintReceipt; jetton refunds carry NOTIFY_FWD_TON.
message(0x4d480005) MintNotifyPayload {
    otherToken: Address;
    tickSpacing: Int as uint16;
    ext: Cell?;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    gramAmount: Int as coins;
    sqrtPriceInitX96: Int as uint160;
    minLiquidity: Int as uint128;
    owner: Address?;
    refundTo: Address?;
    deadline: Int as uint32;
    sqrtPriceMinX96: Int as uint160;
    sqrtPriceMaxX96: Int as uint160;
}

message(0x4d48001c) MintNativeNotify {
    queryId: Int as uint64;
    amount: Int as coins;
    otherToken: Address;
    tickSpacing: Int as uint16;
    ext: Cell?;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    sqrtPriceInitX96: Int as uint160;
    minLiquidity: Int as uint128;
    owner: Address?;
    refundTo: Address?;
    deadline: Int as uint32;
    sqrtPriceMinX96: Int as uint160;
    sqrtPriceMaxX96: Int as uint160;
}

// Router -> Pool (bounce: false + StateInit, like PoolMint).
message(0x4d480028) PoolMintNotify {
    queryId: Int as uint64;
    fromUser: Address;
    amount0: Int as coins;
    amount1: Int as coins;
    params: MintParams;
    allowInit: Bool;
    preset: FeePreset;
}

// Pool -> fromUser (the authenticated payer, never a third party): the result of a notifying mint,
// sent before the refunds. Exactly one per PoolMintNotify.
message(0x4d480084) MintReceipt {
    queryId: Int as uint64;
    ok: Bool;
    code: Int as uint16;
    owner: Address;
    index: Int as uint64;               // position index (0 when !ok)
    tickLower: Int as int24;
    tickUpper: Int as int24;
    liquidity: Int as uint128;
    amount0: Int as coins;              // used
    amount1: Int as coins;
    refund0: Int as coins;              // paid back to params.refundTo
    refund1: Int as coins;
    fgInside0: Int as uint256;          // the new position's fee checkpoint
    fgInside1: Int as uint256;
}

// ---------------------------------------------------------------------------
// Getter structs
// ---------------------------------------------------------------------------

struct RouterData {
    admin: Address;
    pendingAdmin: Address?;
    treasury: Address;
    creationPaused: Bool;
}

struct PoolState {
    key: PoolKey;
    initialized: Bool;
    sqrtPriceX96: Int;
    tick: Int;
    liquidity: Int;
    feeGrowth0X128: Int;
    feeGrowth1X128: Int;
    reserve0: Int;
    reserve1: Int;
    protocolFees0: Int;
    protocolFees1: Int;
    hookFees0: Int;
    hookFees1: Int;
    tickCount: Int;
    nextPositionId: Int;
    fs: FeeState;
    feePipsNow: Int;
    endowment: Int;         // Σ TICK_INIT_FEE ever paid: permanent storage endowment (part of keep)
    taxFees: Int;           // TAX plugin: Gram owed to key.ext.taxRecipient (part of keep)
    platformFees: Int;      // PLATFORM FEE carried below PLATFORM_MIN_PAYOUT (part of keep)
    platformBps: Int;       // last PLATFORM FEE rate seen from the Router (what get_quote uses)
}

struct Quote {
    amountOut: Int;
    consumed: Int;
    refFee: Int;
    refund: Int;
    feeTotal: Int;
    protocolFee: Int;
    hookFee: Int;
    sqrtPriceAfter: Int;
    tickAfter: Int;
    liquidityAfter: Int;
    crossings: Int;
    steps: Int;
    stop: Int;
    code: Int;
    tax: Int;               // TAX plugin (Gram). amountOut is what the receiver gets, net of a sell tax
    platformFee: Int;       // PLATFORM FEE (Gram). amountOut is also net of a sell-side platform fee
}

struct MintQuote {
    liquidity: Int;
    use0: Int;
    use1: Int;
    code: Int;
}

struct PositionAmounts {
    amount0: Int;
    amount1: Int;
    fees0: Int;
    fees1: Int;
}

struct Observation {
    tickCumulative: Int;
    time: Int;
}

struct PositionData {
    pool: Address;
    index: Int;
    initialized: Bool;
    owner: Address;
    tickLower: Int;
    tickUpper: Int;
    liquidity: Int;
    fgLast0: Int;
    fgLast1: Int;
    lockedUntil: Int;
    busy: Bool;
}

struct MintAccountData {
    pool: Address;
    user: Address;
    pending0: Int;
    pending1: Int;
    params: MintParams?;
}
