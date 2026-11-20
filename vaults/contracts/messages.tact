import "./dex_types";

// Marg liquidity vault messages. Opcode prefix 0x5641 ("VA").

struct Strategy {
    baseHalfWidth: Int as uint24;   // ticks each side of the TWAP tick (multiple of tickSpacing)
    limitWidth: Int as uint24;      // width of the single-sided limit range (multiple of tickSpacing)
    threshold: Int as uint24;       // |spot - base center| that triggers a rebalance
    cooldown: Int as uint32;        // a rebalance is always allowed this long after the last one
    twapWindow: Int as uint32;      // seconds (the TWAP covers at least this; DESIGN §8)
    maxDeviation: Int as uint16;    // max |spot - twap| ticks for deposits and rebalances
    perfFeeBps: Int as uint16;      // performance fee on collected LP fees
}

// --- setup / admin ---

message(0x56410001) VaultSetup {
    queryId: Int as uint64;
    poolCode: Cell;                 // checked against the init poolCodeHash
    positionCode: Cell;             // checked against the init positionCodeHash
    content: Cell;                  // TEP-64 share metadata
}

// Seed deposit (admin only, once): USDT transfer payload, the Gram leg rides in forwardTonAmount.
// sqrtPriceInitX96: the price the admin expects. The pool must be within maxDeviation of it (or
// uninitialized: then the seed mint initializes the canonical pool at this price).
message(0x56410002) OpenPayload {
    gramAmount: Int as coins;
    sqrtPriceInitX96: Int as uint160;
    receiver: Address?;
}

message(0x5641000a) SetPerfFee {
    queryId: Int as uint64;
    bps: Int as uint16;
}

message(0x5641000b) SetKeeper {
    queryId: Int as uint64;
    keeper: Address?;
}

message(0x5641000c) SetTreasury {
    queryId: Int as uint64;
    treasury: Address;
}

message(0x5641000d) SetDepositsPaused {
    queryId: Int as uint64;
    paused: Bool;
}

message(0x5641000e) SetStrategy {
    queryId: Int as uint64;
    strategy: Strategy;
}

message(0x5641000f) VaultTransferAdmin {
    queryId: Int as uint64;
    newAdmin: Address;
}

message(0x56410010) VaultClaimAdmin {
    queryId: Int as uint64;
}

// --- users ---

// USDT (+ optional Gram in forwardTonAmount) deposit payload.
message(0x56410003) DepositPayload {
    gramAmount: Int as coins;
    minShares: Int as coins;
    receiver: Address?;
}

message(0x56410004) DepositNative {
    queryId: Int as uint64;
    amount: Int as coins;
    minShares: Int as coins;
    receiver: Address?;
}

// --- keeper / anyone ---

message(0x56410005) Rebalance {
    queryId: Int as uint64;
}

// Anyone, paid: refresh the price observation (TWAP anchors), and push a stalled step forward.
message(0x56410007) Poke {
    queryId: Int as uint64;
}

message(0x56410008) AbortRebalance {
    queryId: Int as uint64;
}

message(0x56410009) CollectFees {
    queryId: Int as uint64;
}

// Anyone, paid (audit M-1): time-based recovery of state a lost DEX reply left behind. Refunds
// deposits whose observation never came back (after DEP_TIMEOUT), resolves position ops whose
// receipt never came (after RECOVERY_DELAY: a fresh collect re-reads the Position's own record),
// writes off mints and payouts that never came (after RECOVERY_DELAY). DESIGN §11.1.
message(0x56410011) Recover {
    queryId: Int as uint64;
}

// --- payouts ---

message(0x56410012) VaultPayout {
    queryId: Int as uint64;
    reason: Int as uint8;           // 1 withdraw, 2 perf fee, 3 gas refund, 4 deposit refund
    amount: Int as coins;
}

// --- events ---

message(0x56410071) DepositEvent {
    receiver: Address;
    amount0: Int as coins;
    amount1: Int as coins;
    shares: Int as coins;
    twapTick: Int as int24;
}

message(0x56410072) WithdrawEvent {
    recipient: Address;
    shares: Int as coins;
    amount0: Int as coins;          // idle part (position principal is paid by the Pool)
    amount1: Int as coins;
    dL0: Int as uint128;
    dL1: Int as uint128;
}

message(0x56410073) RebalanceEvent {
    stage: Int as uint8;            // 1 start, 2 minted, 3 end, 4 aborted, 5 refused
    code: Int as uint8;             // stage 5: 1 oracle not ready, 2 price deviation, 3 not needed, 4 stale, 5 no pool
    twapTick: Int as int24;
    spotTick: Int as int24;
}

message(0x56410074) DepositRefusedEvent {
    from: Address;
    amount0: Int as coins;
    amount1: Int as coins;
    code: Int as uint8;             // 1 not open / paused / busy, 2 oracle, 3 below minShares, 4 changed meanwhile, 5 bad request, 6 timed out (Recover)
}

// A user decrease the DEX refused MAX_UDEC_TRIES times (audit H-1 terminal path): the liquidity
// stays with the holders and the withdrawer gets `shares` new shares worth it (DESIGN §5.1).
message(0x56410075) WithdrawFailedEvent {
    recipient: Address;
    slot: Int as uint8;
    dL: Int as uint128;
    shares: Int as coins;
}

// Recover (audit M-1): what was resolved. kind 1 deposit refunded, 2 mint written off, 3 position op
// re-synced (collect sent), 4 payout written off, 5 stale re-sync dropped.
message(0x56410076) RecoverEvent {
    kind: Int as uint8;
    queryId: Int as uint64;
}

// --- getters ---

struct Pos {
    index: Int as uint64;
    tL: Int as int24;
    tU: Int as int24;
    L: Int as uint128;
    reserved: Int as uint128;       // part of L promised to the withdrawal being executed
    busy: Int as uint64;            // queryId of the op in flight on this NFT, 0 = free
    uf0: Int as coins;              // uncollected fees at the last observation (gross)
    uf1: Int as coins;
    oRound: Int as uint32;          // observation round that set uf0/uf1
    addr: Address;                  // the NFT's address (cached)
}

// The Position's fee checkpoint (its fgLast), from the MintReceipt / BurnReceipts.
struct Fg {
    fg0: Int as uint256;
    fg1: Int as uint256;
}

struct Op {
    kind: Int as uint8;
    ctx: Int as uint8;              // 1 rebalance / opening, 2 withdrawal worker, 0 none
    slot: Int as uint8;
    index: Int as uint64;           // position index
    done: Bool;                     // receipt (or definite failure) seen
    ok: Bool;
    dL: Int as uint128;             // position op: liquidity delta; mint: minimum liquidity
    a0: Int as coins;               // mint: Gram sent
    a1: Int as coins;               // mint: USDT sent
    r0: Int as int128;              // Gram still expected from the DEX for this op (< 0: arrived early)
    r1: Int as int128;
    f0: Int as coins;               // performance fee still to take from this op's arrivals
    f1: Int as coins;
    tL: Int as int24;
    tU: Int as int24;
    user: Address?;                 // user decrease: the withdrawer (the DEX pays the vault, the vault forwards)
    retries: Int as uint8;
    at: Int as uint32;              // when the op was sent (Recover)
    g: Int as coins;                // user decrease: gas held for forwarding the withdrawer's legs
    u0: Int as coins;               // user decrease: still to forward to the withdrawer once its leg arrived
    u1: Int as coins;
    ref: Int as uint64;             // re-sync collect: the op whose receipt was lost
}

// Last observation of the pool (spot) and up to 3 TWAP anchors: the pool's own tickCumulative at
// the pool's own time (DESIGN §8).
struct Oracle {
    spotTick: Int as int24;
    spotSqrtP: Int as uint160;
    spotTs: Int as uint32;          // the pool's time of the last observation (0 = none)
    spotCum: Int as int64;
    c0: Int as int64;
    t0: Int as uint32;
    c1: Int as int64;
    t1: Int as uint32;
    c2: Int as int64;
    t2: Int as uint32;
}

struct Reb {
    step: Int as uint8;
    startedAt: Int as uint32;
    budget: Int as coins;
    payer: Address;
    round: Int as uint32;           // observation round it waits for (0 = none)
    need: Int as uint8;             // replies of that round still missing
    twap: Int as int24;             // TWAP tick the new ranges are built around
    since: Int as uint32;           // first op sequence number of this rebalance
    spot: Int as int24;             // spot tick of the rebalance's own observation (mint price band, audit L-3)
}

// A deposit waiting for its own observation round (keyed by round).
struct Dep {
    from: Address;                  // refunds go here
    receiver: Address;
    a0: Int as coins;
    a1: Int as coins;
    minShares: Int as coins;
    gas: Int as coins;
    need: Int as uint8;
    epoch: Int as uint32;
    at: Int as uint32;              // when it was accepted (Recover after DEP_TIMEOUT)
}

struct WReq {
    recipient: Address;
    shares: Int as coins;
    budget: Int as coins;
}

struct Worker {
    recipient: Address;
    shares: Int as coins;
    budget: Int as coins;
    stage: Int as uint8;            // 1 collecting, 2 decreasing
    pending: Int as uint8;          // position ops of the stage not finished
    waitUntil: Int as uint32;       // collecting: after this, a Poke may proceed without late fee payouts
    dL0: Int as uint128;
    dL1: Int as uint128;
    since: Int as uint32;           // first op sequence number of this withdrawal
}

struct VaultData {
    phase: Int;
    admin: Address;
    pendingAdmin: Address?;
    keeper: Address?;
    treasury: Address;
    router: Address;
    pool: Address?;
    usdtWallet: Address?;
    rwUsdt: Address?;
    supply: Int;
    idle0: Int;
    idle1: Int;
    exp0: Int;                      // signed: Σ op.r0 (in flight from the DEX)
    exp1: Int;
    owe0: Int;                      // performance fee inside exp
    owe1: Int;
    fee0: Int;
    fee1: Int;
    heldGas: Int;
    pendGram: Int;                  // Gram of pending deposits (amount + gas)
    pendUsdt: Int;                  // USDT of pending deposits
    depositsPaused: Bool;
    strategy: Strategy;
    lastRebalance: Int;
    queueLength: Int;
    workerActive: Bool;
    rebStep: Int;
    opCount: Int;
    depCount: Int;
    epoch: Int;
    due0: Int;                      // owed to withdrawers (user decreases), inside idle / exp
    due1: Int;
    opGas: Int;                     // gas held by ops for forwarding withdrawers' legs
}

struct OracleView {
    ready: Bool;
    spotTick: Int;
    twapTick: Int;
    spotSqrtP: Int;
    spotTs: Int;
}

struct NavView {
    ok: Bool;
    nav: Int;                       // value in token1 units << 64, at the TWAP (or spot) of the last observation
    supply: Int;
    twapTick: Int;
    total0: Int;                    // all Gram (idle + in flight + positions + net uncollected fees)
    total1: Int;
}
