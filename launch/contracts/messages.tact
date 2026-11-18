import "./dex_shared";

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
    walletAddress: Address?;        // null = addr_none (TEP-89: the owner cannot have a wallet)
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

// ---------------------------------------------------------------------------
// Marg direct launch (opcode prefix 0x4d4c). The DEX payload / key structs come from
// dex/v2/contracts/shared.tact (one definition for both projects).
// ---------------------------------------------------------------------------

// Creator -> Factory. Attach get_create_value(devBuy) (launchFee + devBuy + gas).
message(0x4d4c0001) CreateToken {
    queryId: Int as uint64;
    content: Cell;                  // TEP-64 content cell (on-chain or off-chain layout)
    devBuy: Int as coins;           // Gram to buy with in the launch transaction (0 = none)
    minDevOut: Int as coins;        // dev buy slippage bound (0 = none)
    buyTaxBps: Int as uint16;       // 0 (off) or 100..500 (1%..5%); 0/0 = normal token
    sellTaxBps: Int as uint16;      // 0 (off) or 100..500
    taxWallet: Address?;            // wallet share receiver; null = the creator (ignored when walletBps = 0)
    rewardsBps: Int as uint16;      // split of the collected tax: holder rewards
    walletBps: Int as uint16;       //                              the tax wallet
    buybackBps: Int as uint16;      //                              buyback and burn
                                    // the three sum to 10000 when a tax is on; ignored (stored 0) when untaxed
    antiSnipePips: Int as uint32;   // DEX LAUNCH_DECAY extra fee at t0 (<= 900000 = 90%), fading to 0; 0 = off
    antiSnipeDuration: Int as uint32; // seconds (1..3600); 0 = off. Both 0 or both non-zero
    startMcap: Int as coins;        // the chosen liquidity tier's startMcap (get_factory_data: low / mid / high)
    tickSpacing: Int as uint16;     // and its tickSpacing; a pair matching no current tier is refused (bounced)
    // Creator vault (optional): vaultBps of the supply is minted to LaunchVault(master) instead of the pool and
    // unlocks to the creator after vaultLock seconds, linearly over vaultVest seconds (0 = all at the end of the lock).
    vaultBps: Int as uint16;        // 0 (no vault; lock/vest ignored) or 1..5000 (<= 50%)
    vaultLock: Int as uint32;       // vaultBps > 0: 7 days..365 days
    vaultVest: Int as uint32;       // vaultBps > 0: 0..365 days
}

// Per-token launch record, stored in the token master (getter get_launch_info).
struct LaunchInfo {
    creator: Address;
    router: Address;
    feeClaimer: Address;            // owner of the locked position (the treasury at launch time)
    tickSpacing: Int as uint16;
    launchFeePips: Int as uint32;
    launchDuration: Int as uint32;
    sqrtPriceX96: Int as uint160;   // requested start price; the pool floors its tick to the spacing
    taxRecipient: Address?;         // the DEX key's taxRecipient: this token's master when taxed, else null
    buyTaxBps: Int as uint16;
    sellTaxBps: Int as uint16;
    taxWallet: Address?;            // non-null iff walletBps > 0
    rewardsBps: Int as uint16;
    walletBps: Int as uint16;
    buybackBps: Int as uint16;
    buybackCap: Int as coins;       // max Gram per buyback = 1% of the start market cap
    createdAt: Int as uint32;
    vaultBps: Int as uint16;        // 0 = no vault (then vaultLock = vaultVest = 0)
    vaultLock: Int as uint32;
    vaultVest: Int as uint32;
}

// Factory -> new master (once).
// (queryId and index come first, followed by a coins field, so that a bounced LaunchSetup carries exactly
// those two: a bounce body is 224 bits after the opcode and has no refs.)
message(0x4d4c0002) LaunchSetup {
    queryId: Int as uint64;
    index: Int as uint64;
    launchFee: Int as coins;        // v3: held by the master until the launch outcome is known
    content: Cell;
    info: LaunchInfo;
    devBuy: Int as coins;
    minDevOut: Int as coins;
    routerValue: Int as coins;      // forwardTonAmount for the Router (gas + devBuy)
    poolCodeHash: Int as uint256;   // v3: the DEX Pool code (hash, depth): the master derives its pool address
    poolCodeDepth: Int as uint16;
}

// Factory -> external (event): a LaunchSetup bounced (the master could not run it); the whole value was
// returned to the creator when the factory still knew it (the last FACTORY_PENDING launches).
message(0x4d4c0025) LaunchBounced {
    queryId: Int as uint64;
    index: Int as uint64;
    creator: Address?;
    value: Int as coins;
}

// Admin -> Factory
message(0x4d4c0010) LowerLaunchFee {
    queryId: Int as uint64;
    fee: Int as coins;              // must be below the current fee
}

message(0x4d4c0011) SetLaunchParams {
    queryId: Int as uint64;
    tier: Int as uint8;             // 0 low, 1 mid, 2 high
    params: LaunchParams;
}

message(0x4d4c0012) SetTreasury {
    queryId: Int as uint64;
    treasury: Address;
}

message(0x4d4c0013) TransferAdmin {
    queryId: Int as uint64;
    newAdmin: Address;              // the current admin cancels by transferring to itself
}

message(0x4d4c0014) ClaimAdmin {
    queryId: Int as uint64;
}

message(0x4d4c0015) WithdrawExcess {
    queryId: Int as uint64;
}

// Parameters applied to NEW launches only.
// (The anti-snipe fee is chosen per launch in CreateToken, not here.)
struct LaunchParams {
    startMcap: Int as coins;        // nanoGram for the whole 1B supply; start price = startMcap / 1e9 tokens
    tickSpacing: Int as uint16;     // a DEX fee preset (200 = 1% base fee)
}

// Liquidity tiers a creator picks from: a higher start market cap is a deeper pool (the same buy moves
// the price less). Low is pump-style, high suits big communities.
struct LaunchTiers {
    low: LaunchParams;
    mid: LaunchParams;
    high: LaunchParams;
}

struct PoolCode {
    hash: Int;
    depth: Int;
}

struct FactoryData {
    admin: Address;
    pendingAdmin: Address?;
    treasury: Address;
    router: Address;
    launchFee: Int;
    tiers: LaunchTiers;
    nextIndex: Int;
}

// Factory -> external (event)
message(0x4d4c0021) TokenLaunched {
    queryId: Int as uint64;
    index: Int as uint64;
    master: Address;
    creator: Address;
    devBuy: Int as coins;
    buyTaxBps: Int as uint16;
    sellTaxBps: Int as uint16;
    taxWallet: Address?;
    rewardsBps: Int as uint16;
    walletBps: Int as uint16;
    buybackBps: Int as uint16;
    antiSnipePips: Int as uint32;
    antiSnipeDuration: Int as uint32;
    vaultBps: Int as uint16;
    vaultLock: Int as uint32;
    vaultVest: Int as uint32;
}

// ---------------------------------------------------------------------------
// Creator vault (LaunchVault(master), one per token; see vault.tact)
// ---------------------------------------------------------------------------

// Master -> new vault (once, at launch).
message(0x4d4c0040) VaultSetup {
    queryId: Int as uint64;
    beneficiary: Address;
    wallet: Address;                // the vault's jetton wallet (owner = the vault, never tracked for rewards)
    total: Int as coins;
    start: Int as uint32;
    lock: Int as uint32;
    vest: Int as uint32;
}

// Beneficiary -> vault: send what is unlocked and not yet claimed (attach >= get_claim_value(); the rest comes back).
message(0x4d4c0041) ClaimVault {
    queryId: Int as uint64;
}

// Beneficiary -> vault: hand the vault (future claims) to another address.
message(0x4d4c0042) TransferVaultBeneficiary {
    queryId: Int as uint64;
    newBeneficiary: Address;
}

// Vault -> external (event)
message(0x4d4c0043) VaultClaimed {
    queryId: Int as uint64;
    beneficiary: Address;
    amount: Int as coins;
    claimed: Int as coins;
}

struct VaultData {
    beneficiary: Address;
    total: Int;
    claimed: Int;
    start: Int;
    lock: Int;
    vest: Int;
    unlockedNow: Int;
    claimableNow: Int;
}

// ---------------------------------------------------------------------------
// Tax split, holder rewards, buyback and burn (all in the token master)
// ---------------------------------------------------------------------------

// Wallet -> Master: the owner's tracked balance changed by delta (rewards tokens only).
// (delta comes before owner so that a bounced checkpoint still carries it: 224-bit bounce body.)
message(0x4d4c0030) RewardCheckpoint {
    queryId: Int as uint64;
    delta: Int as int64;
    owner: Address;
}

// Wallet -> Master: pay my rewards (sent only when no checkpoint is in flight). The snapshot is the
// wallet's own reward state; the master adds what accrued since lastAcc and pays the owner.
message(0x4d4c0031) RewardClaim {
    queryId: Int as uint64;
    delta: Int as int64;
    owner: Address;
    acked: Int as coins;
    lastAcc: Int as uint256;
    frac: Int as uint64;
    owed: Int as coins;
}

// Master -> Wallet (bounce: false): the checkpoint / claim was applied at accumulator `acc`.
message(0x4d4c0032) RewardAck {
    queryId: Int as uint64;
    acc: Int as uint256;
    delta: Int as int64;
    claim: Bool;
    frac: Int as uint64;            // claim only: the new sub-nanoGram remainder
}

// Owner -> own wallet
message(0x4d4c0033) ClaimRewards {
    queryId: Int as uint64;
}

message(0x4d4c0034) SyncRewards {
    queryId: Int as uint64;
}

// Anyone -> Master. Harvest: the master asks the Router to pay the pool's accrued tax to itself,
// paying the Router gas from the buyback balance (rate-limited); the payout runs the split and,
// when due, the buyback. Buyback: run a due buyback now. Both refund the caller's value.
message(0x4d4c0035) Harvest {
    queryId: Int as uint64;
}

message(0x4d4c0036) Buyback {
    queryId: Int as uint64;
}

// Events (external-out)
message(0x4d4c0022) TaxSplitEvent {
    amount: Int as coins;
    rewards: Int as coins;
    wallet: Int as coins;
    buyback: Int as coins;
    extra: Int as coins;            // non-tax Gram swept with it (gas leftovers): to buyback, else wallet, else rewards
}

message(0x4d4c0023) BuybackEvent {
    queryId: Int as uint64;
    amount: Int as coins;
}

message(0x4d4c0024) BurnEvent {
    amount: Int as coins;
    totalSupply: Int as coins;
}

struct RewardState {
    synced: Int as int128;          // balance last reported to the master (sent, not bounced)
    acked: Int as coins;            // shares the master has applied for this owner (acks received)
    lastAcc: Int as uint256;        // master accumulator at the last ack
    frac: Int as uint64;            // sub-nanoGram remainder, scaled by REWARD_SCALE
    owed: Int as coins;             // unclaimed rewards up to lastAcc, nanoGram
    inFlight: Int as uint32;        // checkpoints/claims sent and not yet acked or bounced
}

// Current Gram values of the reward messages (gas amounts priced with the chain config).
struct RewardValues {
    checkpoint: Int;                // sent with every RewardCheckpoint (a tracked transfer needs 1 or 2 on top)
    claim: Int;                     // minimum ClaimRewards value
    sync: Int;                      // minimum SyncRewards value
    ack: Int;                       // claim ack (master -> wallet)
}

struct RewardsData {
    scale: Int;
    acc: Int;                       // Gram per share, scaled by `scale`
    totalShares: Int;               // sum of tracked holder balances
    accrued: Int;                   // Gram handed to holders (in acc or carried)
    claimed: Int;
    carry: Int;                     // accrued while totalShares was 0: added to the next accrual
}

struct BuybackStatus {
    balance: Int;                   // Gram in the buyback bucket
    nextAllowedAt: Int;             // unix time of the next allowed buyback
    nextAmount: Int;                // Gram the next buyback would swap (0 = below the minimum)
    wouldRun: Bool;                 // a Buyback / tax payout now would buy back
    harvestDue: Bool;               // a Harvest now would be paid from the bucket
    nextHarvestAt: Int;             // bucket-paid harvest
    nextCallerHarvestAt: Int;       // caller-paid harvest (attach get_harvest_value(); any split)
    cap: Int;
    spent: Int;                     // Gram swapped so far (refunds subtracted)
    burned: Int;                    // tokens burned by the master
    count: Int;
}

struct TaxData {
    taxIn: Int;                     // Gram split so far
    rewardsBps: Int;
    walletBps: Int;
    buybackBps: Int;
    taxWallet: Address?;
    walletPaid: Int;
    rewardsAccrued: Int;
    buybackIn: Int;
}

// ---------------------------------------------------------------------------
// Marg DEX v2 messages the master sends or receives. Layouts are copies of
// dex/v2/contracts/messages.tact (launch/tests asserts they serialize identically).
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

message(0x4d48001b) CollectTax {
    queryId: Int as uint64;
    key: PoolKey;
}

message(0x4d480061) GramPayout {
    queryId: Int as uint64;
    reason: Int as uint8;
    amount: Int as coins;
    payload: Cell?;
}
