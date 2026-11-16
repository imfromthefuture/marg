// Copies of the Marg DEX v2 (dex/v2/contracts/messages.tact, shared.tact) and TEP-74/TEP-89
// definitions the vault sends or receives. Tact only imports from inside a project root, so these
// are verbatim copies: same opcodes, same field order, same widths. vaults/tests/math.spec.ts
// checks that each one serializes exactly like the dex/v2 build.

// ---------------------------------------------------------------------------
// TEP-74 / TEP-89
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

message(0x595f07bc) JettonBurn {
    queryId: Int as uint64;
    amount: Int as coins;
    responseDestination: Address?;
    customPayload: Cell?;
}

message(0x7bdd97de) JettonBurnNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    sender: Address;
    responseDestination: Address?;
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
// Marg DEX v2 (shared.tact)
// ---------------------------------------------------------------------------

struct PoolKey {
    token0: Address;
    token1: Address;
    tickSpacing: Int as uint16;
    ext: Cell?;
}

struct KeyExt {
    hook: Address?;
    hookFlags: Int as uint8;
    hookShareBps: Int as uint16;
    hookFeeMin: Int as uint32;
    hookFeeMax: Int as uint32;
    initializer: Address?;
    launchFeePips: Int as uint32;
    launchDuration: Int as uint32;
    minLockSecs: Int as uint32;
    taxRecipient: Address?;
    buyTaxBps: Int as uint16;
    sellTaxBps: Int as uint16;
}

// ---------------------------------------------------------------------------
// Marg DEX v2 (messages.tact): the observation and notifying-op messages the vault uses (§6.14 of
// dex/v2/DESIGN.md), and GramPayout
// ---------------------------------------------------------------------------

message(0x4d480081) PoolObserve {
    queryId: Int as uint64;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    payload: Cell?;
}

message(0x4d480082) PoolObservation {
    queryId: Int as uint64;
    initialized: Bool;
    sqrtPriceX96: Int as uint160;
    tick: Int as int24;
    liquidity: Int as uint128;
    tickCumulative: Int as int64;
    time: Int as uint32;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    rangeOk: Bool;
    feeGrowthInside0X128: Int as uint256;
    feeGrowthInside1X128: Int as uint256;
    payload: Cell?;
}

message(0x4d480049) PositionDecreaseNotify {
    queryId: Int as uint64;
    liquidityDelta: Int as uint128;
    amount0Min: Int as coins;
    amount1Min: Int as coins;
    deadline: Int as uint32;
    recipient: Address?;
}

message(0x4d480083) BurnReceipt {
    queryId: Int as uint64;
    index: Int as uint64;
    ok: Bool;
    code: Int as uint16;
    liquidityDelta: Int as uint128;
    liquidity: Int as uint128;
    amount0: Int as coins;
    amount1: Int as coins;
    fees0: Int as coins;
    fees1: Int as coins;
    fgInside0: Int as uint256;
    fgInside1: Int as uint256;
}

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

message(0x4d480084) MintReceipt {
    queryId: Int as uint64;
    ok: Bool;
    code: Int as uint16;
    owner: Address;
    index: Int as uint64;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    liquidity: Int as uint128;
    amount0: Int as coins;
    amount1: Int as coins;
    refund0: Int as coins;
    refund1: Int as coins;
    fgInside0: Int as uint256;
    fgInside1: Int as uint256;
}

message(0x4d480061) GramPayout {
    queryId: Int as uint64;
    reason: Int as uint8;
    amount: Int as coins;
    payload: Cell?;
}

// DEX constants the vault depends on (dex/v2/contracts/constants.tact).
const DEX_OBSERVE_VALUE: Int = ton("0.03");
const DEX_DECREASE_NOTIFY_GAS: Int = ton("0.3");
const DEX_MINT_GAS: Int = ton("0.6");
const DEX_MINT_NOTIFY_GAS: Int = ton("0.05");
const DEX_MIN_POSITION_LIQUIDITY: Int = 1000;
