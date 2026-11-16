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
// Launchpad configuration
// ---------------------------------------------------------------------------

// Bonding-curve and graduation settings, copied into each token at creation.
// All TON values are in nanoTON, token values in jetton units (9 decimals).
struct CurveParams {
    maxSupply: Int as coins;        // hard cap, e.g. 1B tokens
    virtualTon: Int as coins;       // virtual TON reserve at start (sets start mcap)
    virtualTokens: Int as coins;    // virtual token reserve at start
    graduationTon: Int as coins;    // real TON raised (after fees) that triggers graduation
    platformFeeBps: Int as uint16;  // our fee on every curve trade (the only trading fee)
    graduationFee: Int as coins;    // taken from raised TON at graduation, to treasury
    lpJettonValue: Int as coins;    // TON attached to the jetton leg of provide_lp
    lpJettonForward: Int as coins;  // forward TON for the router notification
    lpTonForward: Int as coins;     // forward TON for the pTON leg
}

struct DexConfig {
    router: Address;            // STON.fi v2 router
    routerPtonWallet: Address;  // router's pTON wallet
    lpReceiver: Address;        // receives the LP tokens (burn address)
}

struct CurveState {
    graduated: Bool;
    tonReserve: Int;      // virtual + real
    tokenReserve: Int;    // virtual tokens left on the curve
    realTon: Int;         // TON raised, backing the curve
    tokensSold: Int;
    totalSupply: Int;
    platformFeeBps: Int;
    graduationTon: Int;
    platformFeesAccrued: Int;
}

// ---------------------------------------------------------------------------
// Launchpad messages
// ---------------------------------------------------------------------------

// User -> master: buy on the curve. Attach tonAmount + gas; leftover is refunded.
message(0x6b1a2c01) Buy {
    queryId: Int as uint64;
    tonAmount: Int as coins;
    minTokensOut: Int as coins;
}

// Owner -> own wallet: sell back to the curve.
message(0x6b1a2c02) Sell {
    queryId: Int as uint64;
    amount: Int as coins;
    minTonOut: Int as coins;
}

// Wallet -> master
message(0x6b1a2c03) SellNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    minTonOut: Int as coins;
    seller: Address;
}

// Master -> seller, carries the TON proceeds
message(0x6b1a2c04) SellPayout {
    queryId: Int as uint64;
    amount: Int as coins;
}

// Anyone -> master: pay accrued platform fees to the treasury
message(0x6b1a2c05) ClaimFees {
    queryId: Int as uint64;
}

// Factory -> master on deployment
message(0x6b1a2c08) Setup {
    content: Cell;
    creator: Address;
    treasury: Address;
    initialBuy: Int as coins;
    params: CurveParams;
    dex: DexConfig;
}

// Creator -> factory
message(0x6b1a2c10) CreateToken {
    queryId: Int as uint64;
    content: Cell;              // TEP-64 metadata
    tier: Int as uint8;         // liquidity tier: 0 low, 1 mid, 2 high
    initialBuy: Int as coins;   // optional dev buy, executed in the deploy transaction
}

// Admin -> factory
message(0x6b1a2c11) UpdateParams {
    tier: Int as uint8;
    params: CurveParams;
    launchFee: Int as coins;
}

message(0x6b1a2c12) UpdateDex {
    dex: DexConfig;
}

message(0x6b1a2c13) SetTreasury {
    treasury: Address;
}

message(0x6b1a2c14) TransferAdmin {
    newAdmin: Address;
}

// Admin -> factory: lower the platform fee on a token that is already live
message(0x6b1a2c16) AdminLowerPlatformFee {
    index: Int as uint64;
    newFeeBps: Int as uint16;
}

// Factory -> master
message(0x6b1a2c17) LowerPlatformFee {
    newFeeBps: Int as uint16;
    excessTo: Address;
}

// Factory -> creator after launch
message(0x6b1a2c15) TokenCreated {
    queryId: Int as uint64;
    index: Int as uint64;
    master: Address;
}

// Graduation event, emitted for the indexer
// Emitted (external out) on every curve trade, read by the indexer.
// ton is the gross amount: paid by a buyer incl. fees, or taken from the curve by a seller before fees.
message(0x6b1a2c21) Trade {
    isBuy: Bool;
    trader: Address;
    ton: Int as coins;
    tokens: Int as coins;
    tonReserve: Int as coins;
    tokenReserve: Int as coins;
    realTon: Int as coins;
}

message(0x6b1a2c20) Graduated {
    poolTokens: Int as coins;
    poolTon: Int as coins;
}
