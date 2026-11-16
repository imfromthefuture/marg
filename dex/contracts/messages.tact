// Marg DEX messages. Opcodes of our own messages use the prefix 0x4d47 ("MG").
// The standard jetton messages are copied here on purpose (not imported from ../contracts):
// the DEX must not depend on files owned by the launchpad.

// ---------------------------------------------------------------------------
// TEP-74 / TEP-89 jetton messages (layouts must match the standard exactly)
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

// The standard burn_notification layout plus a trailing Maybe ^Cell that carries RemoveParams.
// Same opcode as the standard JettonBurnNotification, so that one must not be declared here.
message(0x7bdd97de) LpBurnNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    sender: Address;
    responseDestination: Address?;
    customPayload: Cell?;
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
// Forward payloads, carried inside JettonNotification.forwardPayload
// (Either: bit 0 = inline, bit 1 = in a ref). Declared as messages so that
// fromSlice() checks the opcode.
// ---------------------------------------------------------------------------

// Larger than one cell: Tact moves the tail fields into a ref. Build it with storeSwapPayload.
message(0x4d470001) SwapPayload {
    askToken: Address;          // Router's jetton wallet of the output token, or GRAM
    minOut: Int as coins;
    deadline: Int as uint32;
    receiver: Address?;         // default: the jetton sender
    refundTo: Address?;         // default: the jetton sender; also receives excess gas
    referral: Address?;         // null forces refBps = 0
    refBps: Int as uint16;      // <= MAX_REF_FEE_BPS
    fwdTon: Int as coins;       // forward TON for a jetton output
    fwdPayload: Cell?;          // forward payload for the output (jetton notification or GramPayout.payload)
}

message(0x4d470002) ProvideLpPayload {
    otherToken: Address;        // the other side of the pair (jetton wallet id or GRAM)
    minLpOut: Int as coins;
    deadline: Int as uint32;
    lpReceiver: Address?;
    refundTo: Address?;
}

// Fits in one cell (847 bits) so the launchpad can build it by hand.
message(0x4d470003) ProvideBothPayload {
    gramAmount: Int as coins;   // the Gram leg, carried as forward value of the jetton transfer
    minLpOut: Int as coins;
    deadline: Int as uint32;
    lpReceiver: Address;
    refundTo: Address;
    requireEmpty: Bool;         // refund unless this deposit creates the pool (anti-squatting)
}

// Burn parameters, carried as JettonBurn.customPayload.
struct RemoveParams {
    min0: Int as coins;
    min1: Int as coins;
    deadline: Int as uint32;
}

// ---------------------------------------------------------------------------
// User / admin -> Router
// ---------------------------------------------------------------------------

message(0x4d470011) SwapNative {
    queryId: Int as uint64;
    amount: Int as coins;
    askToken: Address;
    minOut: Int as coins;
    deadline: Int as uint32;
    receiver: Address?;
    refundTo: Address?;
    referral: Address?;
    refBps: Int as uint16;
    fwdTon: Int as coins;
    fwdPayload: Cell?;
}

message(0x4d470012) ProvideLpNative {
    queryId: Int as uint64;
    amount: Int as coins;
    otherToken: Address;
    minLpOut: Int as coins;
    deadline: Int as uint32;
    lpReceiver: Address?;
    refundTo: Address?;
}

message(0x4d470013) CollectProtocolFees {
    queryId: Int as uint64;
    tokenA: Address;
    tokenB: Address;
}

message(0x4d470014) SetPoolFees {
    queryId: Int as uint64;
    tokenA: Address;
    tokenB: Address;
    lpFeeBps: Int as uint16;
    protocolFeeBps: Int as uint16;
}

message(0x4d470015) SetCreationPaused {
    queryId: Int as uint64;
    paused: Bool;
}

message(0x4d470016) SetTreasury {
    queryId: Int as uint64;
    treasury: Address;
}

message(0x4d470017) TransferAdmin {
    queryId: Int as uint64;
    newAdmin: Address;
}

message(0x4d470018) ClaimAdmin {
    queryId: Int as uint64;
}

message(0x4d470019) WithdrawRouterExcess {
    queryId: Int as uint64;
}

// ---------------------------------------------------------------------------
// Router -> Pool
// ---------------------------------------------------------------------------

message(0x4d470021) PoolSwap {
    queryId: Int as uint64;
    fromUser: Address;
    inIsToken0: Bool;
    amountIn: Int as coins;
    minOut: Int as coins;
    deadline: Int as uint32;
    receiver: Address;
    refundTo: Address;
    referral: Address?;
    refBps: Int as uint16;
    fwdTon: Int as coins;
    fwdPayload: Cell?;
}

message(0x4d470022) PoolProvide {
    queryId: Int as uint64;
    user: Address;
    amount0: Int as coins;
    amount1: Int as coins;
    minLpOut: Int as coins;
    deadline: Int as uint32;
    lpReceiver: Address;
    refundTo: Address;
    allowCreate: Bool;
    requireEmpty: Bool;
}

message(0x4d470023) PoolSetFees {
    queryId: Int as uint64;
    lpFeeBps: Int as uint16;
    protocolFeeBps: Int as uint16;
    excessTo: Address;
}

message(0x4d470024) PoolCollectFees {
    queryId: Int as uint64;
    treasury: Address;
    excessTo: Address;
}

// ---------------------------------------------------------------------------
// Pool -> Router: the only way jettons ever leave the Router's wallets
// ---------------------------------------------------------------------------

message(0x4d470031) PayTo {
    queryId: Int as uint64;
    token0: Address;            // identifies (and authenticates) the commanding pool
    token1: Address;
    wallet: Address;            // which Router wallet pays: token0 or token1, never GRAM
    amount: Int as coins;
    to: Address;
    excessTo: Address;
    fwdTon: Int as coins;
    fwdPayload: Cell?;
    reason: Int as uint8;
}

// ---------------------------------------------------------------------------
// Pool <-> LpAccount, user -> LpAccount
// ---------------------------------------------------------------------------

message(0x4d470041) LpAccountDeposit {
    queryId: Int as uint64;
    amount0: Int as coins;
    amount1: Int as coins;
    minLpOut: Int as coins;
    lpReceiver: Address;
    refundTo: Address;
    allowCreate: Bool;
    isNative: Bool;             // pending0 is Gram held by the LpAccount itself
}

message(0x4d470042) CbAddLiquidity {
    queryId: Int as uint64;
    user: Address;
    amount0: Int as coins;
    amount1: Int as coins;
    minLpOut: Int as coins;
    lpReceiver: Address;
    refundTo: Address;
    allowCreate: Bool;
}

message(0x4d470043) CbRefund {
    queryId: Int as uint64;
    user: Address;
    amount0: Int as coins;
    amount1: Int as coins;
}

message(0x4d470044) LpAccountRefund {
    queryId: Int as uint64;
}

// ---------------------------------------------------------------------------
// Payouts and events
// ---------------------------------------------------------------------------

// Body of every Gram payout from a Pool. When it is the last send, value = amount + leftover gas.
message(0x4d470051) GramPayout {
    queryId: Int as uint64;
    reason: Int as uint8;
    amount: Int as coins;
    payload: Cell?;
}

message(0x4d470061) SwapEvent {
    fromUser: Address;
    inIsToken0: Bool;
    amountIn: Int as coins;
    amountOut: Int as coins;
    protocolFee: Int as coins;
    refFee: Int as coins;
    reserve0: Int as coins;
    reserve1: Int as coins;
}

message(0x4d470062) LiquidityEvent {
    user: Address;
    isAdd: Bool;
    amount0: Int as coins;
    amount1: Int as coins;
    lp: Int as coins;
    reserve0: Int as coins;
    reserve1: Int as coins;
    totalSupply: Int as coins;
}

message(0x4d470063) RefundEvent {
    queryId: Int as uint64;
    user: Address;
    code: Int as uint16;
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

struct PoolData {
    router: Address;
    token0: Address;
    token1: Address;
    reserve0: Int;
    reserve1: Int;
    totalSupply: Int;
    lpFeeBps: Int;
    protocolFeeBps: Int;
    protocolFee0: Int;
    protocolFee1: Int;
    isNative: Bool;
}

struct LpAccountData {
    pool: Address;
    user: Address;
    pending0: Int;
    pending1: Int;
    isNative: Bool;
}

struct ExpectedOut {
    amountOut: Int;
    protocolFee: Int;
    refFee: Int;
}

struct ExpectedLp {
    lp: Int;
    use0: Int;
    use1: Int;
}

struct ExpectedBurn {
    out0: Int;
    out1: Int;
}
