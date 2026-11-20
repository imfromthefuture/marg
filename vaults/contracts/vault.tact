import "./messages";
import "./vault_math";

// Marg liquidity vault (DESIGN.md). A TEP-74 share master that owns up to a few Position NFTs on the
// CANONICAL plain Gram/USDT pool of Marg DEX v2 (no hook; many vaults may share the key). It learns
// everything through the DEX's additive §6.14 messages:
//  - price, TWAP accumulator and fee growth from PoolObserve -> PoolObservation (only the real pool
//    can answer, and it answers only the vault's own requests);
//  - its mint results from MintReceipt (sent to the payer only) and its decrease / collect results
//    from BurnReceipt (sent by its own Position NFT once it is free);
//  - every USDT the DEX pays it as a notified transfer (forward_ton_amount > 0), every Gram as
//    GramPayout. No balance probe: idle1 only grows on a notification from the vault's own wallet.
//
// Accounting rules (DESIGN §3, §6):
//  - idle0/idle1 only grow on value that really arrived. exp0/exp1 (signed) are what the DEX still
//    owes the vault per its receipts, owe0/owe1 the performance fee inside exp.
//  - Positions change only on authenticated receipts (the Position's own liquidity is copied).
//  - The admin can never move funds or block withdrawals.

const GRAM: Address = address("0:0000000000000000000000000000000000000000000000000000000000000000");
const BPS: Int = 10000;
const MAX_COINS: Int = 1329227995784915872903807060280344575;     // 2^120 - 1
const PERF_FEE_CAP_BPS: Int = 2000;
const DEFAULT_PERF_FEE_BPS: Int = 1000;
const DEAD_SHARES: Int = 1000000;
const SHARES_PER_UNIT: Int = 1000;              // 1 share (1e9 units) = 1e6 token1 units at opening
const MIN_OPEN_VALUE: Int = 10000000;           // token1 units (10 USDT)
const MAX_QUEUE: Int = 64;
const MAX_SLOTS: Int = 3;                       // live positions a deposit observes (normally 1-2); DEPOSIT_GAS covers 3
const MIN_REBALANCE_INTERVAL: Int = 60;
const REBALANCE_TIMEOUT: Int = 1800;
const PAYOUT_WAIT: Int = 600;                   // a withdrawal waits this long for its collected fees
const MAX_OBS_AGE: Int = 120;                   // a price decision needs an observation this fresh
const OP_DEADLINE: Int = 86400;                 // deadlines on DEX ops: never the binding constraint
const MIN_MINT_LIQUIDITY: Int = 10000;          // skip mints below this (DEX minimum is 1000)
const MIN_WITHDRAW_SHARES: Int = 100000000;     // 0.1 share (~0.1 USDT at opening), or supply/10^6 if smaller: no dust burns into the queue (audit L-2)
const MAX_UDEC_TRIES: Int = 3;                  // a user decrease the DEX refuses this often takes the terminal path (audit H-1)
const DEP_TIMEOUT: Int = 600;                   // a deposit whose observation is not back after this is refundable (audit M-1)
const RECOVERY_DELAY: Int = 90000;              // OP_DEADLINE + 1 h: no DEX op of the vault can still execute (audit M-1)
const RECOVER_MAX: Int = 4;                     // items resolved per Recover
const MINT_BAND_DIV: Int = 4;                   // rebalance mints: price band spot ± maxDeviation/4 (audit L-3)
const STALE_FG: Int = 0x8000000000000000000000000000000000000000000000000000000000000000;   // 2^255

// strategy hard caps (admin can only move inside them)
const MAX_WIDTH: Int = 50000;
const MIN_COOLDOWN: Int = 3600;
const MAX_COOLDOWN: Int = 2592000;
const MIN_TWAP_WINDOW: Int = 300;
const MAX_TWAP_WINDOW: Int = 86400;
const MAX_DEVIATION_CAP: Int = 500;

// gas (>= 1.5x measured at 400 nanoGram/gas; see tests/gas.spec.ts)
const VAULT_MIN_STORAGE: Int = ton("0.5");
const DEPOSIT_GAS: Int = ton("0.35");
const SHARE_MINT_VALUE: Int = ton("0.05");
const OBS_VALUE: Int = ton("0.04");             // one PoolObserve (DEX minimum 0.03)
const POS_OP_VALUE: Int = ton("0.32");          // one PositionDecreaseNotify (DEX minimum 0.3)
const MINT_FWD: Int = ton("0.72");              // forwardTonAmount of a jetton mint (+ Gram leg); DEX needs 0.65
const MINT_WALLET_VALUE: Int = ton("0.1");      // our wallet + Router's wallet on top of the forward
const MINT_NATIVE_GAS: Int = ton("0.72");       // MintNativeNotify value on top of the Gram amount
const JETTON_OUT_VALUE: Int = ton("0.08");
const FWD_EST: Int = ton("0.005");              // forward fee + compute share per send
const HANDLER_EST: Int = ton("0.03");           // compute of a handler not charged exactly
const WITHDRAW_GAS: Int = ton("1.8");           // 2 positions x (collect + decrease + forwarding) + idle payouts + compute
const USER_PAY_GAS: Int = ton("0.16");          // held per user decrease: forwarding its legs (USDT transfer 0.08 + compute
                                                // of the forwarding tx, 100k gas = 0.04 at 400 nG/gas, x1.5 + fees); the
                                                // unused part reaches the withdrawer as the USDT transfer's excess
const REBALANCE_GAS: Int = ton("3.5");
const OPEN_GAS: Int = ton("1.5");
const SETUP_QUERY_VALUE: Int = ton("0.05");
const POKE_GAS: Int = ton("0.1");
const COLLECT_FEES_GAS: Int = ton("0.15");
const RECOVER_GAS: Int = ton("0.5");
const REFUND_MIN: Int = ton("0.06");
const DUST_GRAM: Int = ton("0.001");

// phases
const PHASE_SETUP: Int = 0;
const PHASE_OPENING: Int = 1;
const PHASE_IDLE: Int = 2;
const PHASE_REB: Int = 3;

// rebalance / opening steps
const STEP_OBSERVE: Int = 1;
const STEP_CLOSE: Int = 2;
const STEP_SETTLE1: Int = 3;
const STEP_MINT: Int = 4;
const STEP_SETTLE2: Int = 5;

// queryId kinds (top 8 bits of our queryIds)
const K_MINT: Int = 1;
const K_CLOSE: Int = 2;
const K_COLLECT: Int = 3;
const K_UDEC: Int = 4;
const K_SYNC: Int = 5;                          // re-sync collect after a lost receipt (Recover)
const K_OBS: Int = 6;
const K_PAYOUT: Int = 17;
const K_FEE: Int = 18;
const K_REFUND: Int = 19;
const NO_SLOT: Int = 255;

// op contexts (whose budget pays)
const C_NONE: Int = 0;
const C_REB: Int = 1;
const C_WORKER: Int = 2;
const C_DEP: Int = 3;

// worker stages
const W_COLLECT: Int = 1;
const W_DECREASE: Int = 2;

// payload opcodes
const OP_OPEN: Int = 0x56410002;
const OP_DEPOSIT: Int = 0x56410003;

// payout reasons
const PAYOUT_WITHDRAW: Int = 1;
const PAYOUT_FEE: Int = 2;
const PAYOUT_GAS: Int = 3;
const PAYOUT_REFUND: Int = 4;

// refusal codes (RebalanceEvent stage 5 / DepositRefusedEvent)
const R_NOT_READY: Int = 1;
const R_DEVIATION: Int = 2;
const R_NOT_NEEDED: Int = 3;
const R_STALE: Int = 4;
const R_NO_POOL: Int = 5;
const D_CLOSED: Int = 1;
const D_ORACLE: Int = 2;
const D_MIN_SHARES: Int = 3;
const D_CHANGED: Int = 4;
const D_BAD: Int = 5;
const D_TIMEOUT: Int = 6;

fun isBasechain(a: Address): Bool {
    let s = a.asSlice();
    return s.bits() == 267 && s.refs() == 0 && s.preloadUint(11) == 1024;
}

fun eitherPayload(payload: Cell?): Slice {
    if (payload == null) {
        return beginCell().storeBool(false).asSlice();
    }
    return beginCell().storeBool(true).storeRef(payload!!).asSlice();
}

// Floor of the tick to the spacing grid.
fun floorS(t: Int, s: Int): Int {
    let q = t / s;          // TVM division floors
    return q * s;
}

// token1 per token0, scaled by 2^64.
fun priceQ64(sqrtP: Int): Int {
    return mulDiv(sqrtP, sqrtP, 1 << 128);
}

// Value in token1 units, scaled by 2^64.
fun valueOf(x0: Int, x1: Int, pQ64: Int): Int {
    return x0 * pQ64 + (x1 << 64);
}

// Fees accrued by `liq` between the checkpoint and an observation. A checkpoint newer than the
// observation would wrap mod 2^256: such a reading is stale and counts as 0.
fun feesSince(liq: Int, fgNow: Int, fgLast: Int): Int {
    let d = subMod(fgNow, fgLast);
    if (d >= STALE_FG) {
        return 0;
    }
    return min(mulShr(liq, d, 128), MAX_COINS);
}

fun defaultStrategy(spacing: Int): Strategy {
    let w = max(spacing, (1200 / spacing) * spacing);
    return Strategy {
        baseHalfWidth: w,
        limitWidth: w,
        threshold: max(spacing, min(w, (600 / spacing) * spacing)),
        cooldown: 86400,
        twapWindow: 1800,
        maxDeviation: 100,
        perfFeeBps: DEFAULT_PERF_FEE_BPS,
    };
}

fun strategyValid(st: Strategy, spacing: Int): Bool {
    return st.baseHalfWidth >= spacing && st.baseHalfWidth <= MAX_WIDTH && st.baseHalfWidth % spacing == 0 &&
        st.limitWidth >= spacing && st.limitWidth <= MAX_WIDTH && st.limitWidth % spacing == 0 &&
        st.threshold >= spacing && st.threshold <= st.baseHalfWidth &&
        st.cooldown >= MIN_COOLDOWN && st.cooldown <= MAX_COOLDOWN &&
        st.twapWindow >= MIN_TWAP_WINDOW && st.twapWindow <= MAX_TWAP_WINDOW &&
        st.maxDeviation >= 1 && st.maxDeviation <= MAX_DEVIATION_CAP &&
        st.perfFeeBps <= PERF_FEE_CAP_BPS;
}

struct Cfg {
    walletCode: Cell;
    admin: Address;
    router: Address;
    usdtMaster: Address;
    poolCodeHash: Int as uint256;
    positionCodeHash: Int as uint256;
    salt: Int as uint32;
    pendingAdmin: Address?;
    keeper: Address?;
    treasury: Address;
    poolCode: Cell?;
    positionCode: Cell?;
    content: Cell;
}

struct Cold {
    cfgCell: Cell;                  // Cfg, parsed only when needed
    gasCtx: Int as uint8;           // budget charged for this transaction's compute (0 = none)
    gasRef: Int as uint32;          // C_DEP: the deposit (round) charged
    spacing: Int as uint16;
    depositsPaused: Bool;
    strategy: Strategy;
    phase: Int as uint8;
    pool: Address?;
    usdtWallet: Address?;
    rwUsdt: Address?;
    supply: Int as coins;
    idle0: Int as coins;
    idle1: Int as coins;
    exp0: Int as int128;
    exp1: Int as int128;
    owe0: Int as coins;
    owe1: Int as coins;
    fee0: Int as coins;
    fee1: Int as coins;
    pendG: Int as coins;
    pendU: Int as coins;
    positions: map<Int as uint8, Pos>;
    fgs: map<Int as uint8, Fg>;
    ops: map<Int as uint64, Op>;
    seq: Int as uint32;
    rnd: Int as uint32;
    spotRound: Int as uint32;
    epoch: Int as uint32;
    orc: Oracle;
    reb: Reb?;
    deps: map<Int as uint32, Dep>;
    openSqrt: Int as uint160;
    openReceiver: Address?;
    queue: map<Int as uint32, WReq>;
    qHead: Int as uint32;
    qTail: Int as uint32;
    queueGas: Int as coins;
    worker: Worker?;
    wdl: map<Int as uint8, Int as uint128>;     // worker: slot -> liquidity still to decrease for the user
    lastRebalance: Int as uint32;
    baseCenter: Int as int24;
    due0: Int as coins;             // owed to withdrawers by their user decreases (inside idle / exp)
    due1: Int as coins;
    opGas: Int as coins;            // Σ op.g (held)
    wtry: map<Int as uint8, Int as uint8>;      // worker: slot -> refused user decreases
}

// ---------------------------------------------------------------------------
// Setup and admin
// ---------------------------------------------------------------------------

extends mutates fun rVaultSetup(self: Cold, msg: VaultSetup) {
    let ctx = context();
    let cfg = self.cfgGet();
    require(ctx.sender == cfg.admin, "Not admin");
    require(self.phase == PHASE_SETUP && self.pool == null && cfg.poolCode == null, "Already set up");
    require(ctx.value >= 3 * SETUP_QUERY_VALUE, "Insufficient TON attached");
    require(msg.poolCode.hash() == cfg.poolCodeHash, "Bad pool code");
    require(msg.positionCode.hash() == cfg.positionCodeHash, "Bad position code");
    require(strategyValid(self.strategy, self.spacing), "Bad spacing");
    cfg.poolCode = msg.poolCode;
    cfg.positionCode = msg.positionCode;
    cfg.content = msg.content;
    self.cfgCell = cfg.toCell();
    message(MessageParameters {
        to: cfg.usdtMaster, value: SETUP_QUERY_VALUE, mode: SendPayGasSeparately, bounce: true,
        body: ProvideWalletAddress { queryId: 1, ownerAddress: myAddress(), includeAddress: false }.toCell(),
    });
    message(MessageParameters {
        to: cfg.usdtMaster, value: SETUP_QUERY_VALUE, mode: SendPayGasSeparately, bounce: true,
        body: ProvideWalletAddress { queryId: 2, ownerAddress: cfg.router, includeAddress: false }.toCell(),
    });
}

extends mutates fun rTakeWalletAddress(self: Cold, msg: TakeWalletAddress) {
    let cfg = self.cfgGet();
    require(sender() == cfg.usdtMaster && self.phase == PHASE_SETUP && self.pool == null, "Unexpected");
    require(isBasechain(msg.walletAddress), "Bad wallet");
    if (msg.queryId == 1) {
        self.usdtWallet = msg.walletAddress;
    } else if (msg.queryId == 2) {
        self.rwUsdt = msg.walletAddress;
    }
    if (self.usdtWallet != null && self.rwUsdt != null && cfg.poolCode != null) {
        // The canonical plain key: no hook, no initializer (Tact 1.6 init layout: 0b0 . router . key).
        let key = self.poolKey();
        self.pool = contractAddress(StateInit {
            code: cfg.poolCode!!,
            data: beginCell().storeUint(0, 1).storeAddress(cfg.router)
                .storeAddress(key.token0).storeAddress(key.token1).storeUint(key.tickSpacing, 16)
                .storeMaybeRef(key.ext).endCell(),
        });
        cfg.poolCode = null;
        self.cfgCell = cfg.toCell();
    }
}

extends mutates fun rSetPerfFee(self: Cold, msg: SetPerfFee) {
    self.requireAdmin();
    require(msg.bps <= PERF_FEE_CAP_BPS, "Fee above cap");
    let s = self.strategy;
    s.perfFeeBps = msg.bps;
    self.strategy = s;
    self.adminDone(msg.queryId);
}

extends mutates fun rSetKeeper(self: Cold, msg: SetKeeper) {
    self.requireAdmin();
    require(msg.keeper == null || isBasechain(msg.keeper!!), "Invalid keeper");
    let cfg = self.cfgGet();
    cfg.keeper = msg.keeper;
    self.cfgCell = cfg.toCell();
    self.adminDone(msg.queryId);
}

extends mutates fun rSetTreasury(self: Cold, msg: SetTreasury) {
    self.requireAdmin();
    require(isBasechain(msg.treasury) && msg.treasury != myAddress(), "Invalid treasury");
    let cfg = self.cfgGet();
    cfg.treasury = msg.treasury;
    self.cfgCell = cfg.toCell();
    self.adminDone(msg.queryId);
}

extends mutates fun rSetDepositsPaused(self: Cold, msg: SetDepositsPaused) {
    self.requireAdmin();
    self.depositsPaused = msg.paused;
    self.adminDone(msg.queryId);
}

extends mutates fun rSetStrategy(self: Cold, msg: SetStrategy) {
    self.requireAdmin();
    require(strategyValid(msg.strategy, self.spacing), "Outside caps");
    self.strategy = msg.strategy;
    self.adminDone(msg.queryId);
}

extends mutates fun rVaultTransferAdmin(self: Cold, msg: VaultTransferAdmin) {
    self.requireAdmin();
    let cfg = self.cfgGet();
    cfg.pendingAdmin = msg.newAdmin == cfg.admin ? null : msg.newAdmin;
    self.cfgCell = cfg.toCell();
    self.adminDone(msg.queryId);
}

extends mutates fun rVaultClaimAdmin(self: Cold, msg: VaultClaimAdmin) {
    let cfg = self.cfgGet();
    require(cfg.pendingAdmin != null && sender() == cfg.pendingAdmin!!, "Not pending admin");
    cfg.admin = cfg.pendingAdmin!!;
    cfg.pendingAdmin = null;
    self.cfgCell = cfg.toCell();
    self.adminDone(msg.queryId);
}

extends mutates fun rProvideWalletAddress(self: Cold, msg: ProvideWalletAddress) {
    require(context().value >= ton("0.0061"), "Insufficient TON attached");
    let ownerCell: Cell? = msg.includeAddress ? beginCell().storeAddress(msg.ownerAddress).endCell() : null;
    let walletAddress = parseStdAddress(msg.ownerAddress.asSlice()).workchain == 0
        ? self.walletAddress(msg.ownerAddress)
        : newAddress(0, 0);
    message(MessageParameters {
        to: sender(), value: 0, mode: SendRemainingValue, bounce: false,
        body: TakeWalletAddress { queryId: msg.queryId, walletAddress, ownerAddress: ownerCell }.toCell(),
    });
}

extends mutates fun rCollectFees(self: Cold, msg: CollectFees) {
    let ctx = context();
    require(ctx.value >= COLLECT_FEES_GAS, "Insufficient TON attached");
    let spent = 0;
    let treasury = self.cfgGet().treasury;
    if (self.fee0 > 0) {
        let f = self.fee0;
        self.fee0 = 0;
        self.sendGram(treasury, f, PAYOUT_FEE, msg.queryId);
    }
    if (self.fee1 > 0) {
        let f = self.fee1;
        self.fee1 = 0;
        self.sendUsdt(self.nextQ(K_FEE), f, treasury, JETTON_OUT_VALUE, 0, null, treasury);
        spent = JETTON_OUT_VALUE;
    }
    self.refundGas(ctx.sender, ctx.value - spent - HANDLER_EST, msg.queryId);
}

// ---------------------------------------------------------------------------
// Opening (admin seed; the pool may or may not be initialized)
// ---------------------------------------------------------------------------

extends mutates fun openVault(self: Cold, msg: JettonNotification, p: OpenPayload) {
    let ctx = context();
    let ok = msg.sender == self.cfgGet().admin && self.phase == PHASE_SETUP && self.pool != null && self.reb == null &&
        ctx.value >= p.gramAmount + OPEN_GAS &&
        p.sqrtPriceInitX96 >= MIN_SQRT_RATIO && p.sqrtPriceInitX96 < MAX_SQRT_RATIO &&
        (p.receiver == null || isBasechain(p.receiver!!));
    if (ok) {
        try {
            let v = valueOf(self.idle0 + p.gramAmount, self.idle1 + msg.amount, priceQ64(p.sqrtPriceInitX96));
            ok = v >= (MIN_OPEN_VALUE << 64);
        } catch (e) {
            ok = false;
        }
    }
    if (!ok) {
        self.refundJetton(msg.queryId, msg.amount, msg.sender, ctx.value);
        return;
    }
    self.idle0 += p.gramAmount;
    self.idle1 += msg.amount;
    self.phase = PHASE_OPENING;
    self.openSqrt = p.sqrtPriceInitX96;
    self.openReceiver = p.receiver != null ? p.receiver!! : msg.sender;
    self.reb = Reb { step: STEP_OBSERVE, startedAt: now(), budget: ctx.value - p.gramAmount, payer: msg.sender,
                     round: 0, need: 0, twap: 0, since: self.seq + 1, spot: 0 };
    self.gasCtx = C_REB;
    self.rebObserve(false);
}

// The opening observation is in: mint the seed's base range at the pool price (or initialize the
// canonical pool at the admin's price if nobody has).
extends mutates fun openObserved(self: Cold) {
    let st = self.strategy;
    let s = self.spacing;
    let expected = tickAt(self.openSqrt);
    let sP = self.openSqrt;
    let sInit = 0;
    if (self.spotRound == self.reb!!.round && now() - self.orc.spotTs <= MAX_OBS_AGE) {
        if (abs(self.orc.spotTick - expected) > st.maxDeviation) {
            self.refuseReb(R_DEVIATION);
            return;
        }
        sP = self.orc.spotSqrtP;
    } else {
        sInit = self.openSqrt;      // not initialized (or not deployed): the seed mint initializes it
    }
    self.openSqrt = sP;
    let t0 = tickAt(sP);
    let tL = max(minUsable(s), floorS(t0 - st.baseHalfWidth, s));
    let tU = min(maxUsable(s), floorS(t0 + st.baseHalfWidth, s) + s);
    let liq = liquidityForAmounts(sP, sqrtAt(tL), sqrtAt(tU), self.idle0, self.idle1);
    let am = amountsForLiquidity(t0, sP, tL, tU, liq, true);
    let b0 = min(am.a, self.idle0);
    let b1 = min(am.b, self.idle1);
    let sMin = sqrtAt(max(MIN_TICK, expected - st.maxDeviation));
    let sMax = sqrtAt(min(MAX_TICK, expected + st.maxDeviation));
    let r = self.reb!!;
    r.step = STEP_MINT;
    self.reb = r;
    self.sendMint(0, tL, tU, b0, b1, liq * 99 / 100, sInit, sMin, sMax, C_REB);
    self.pump();
}

// Seed shares at the opening price: 1 share = 1 USDT of value (DEAD_SHARES are owned by nobody).
extends mutates fun completeOpen(self: Cold, m: MintReceipt) {
    let sP = self.openSqrt;
    self.openSqrt = 0;
    self.baseCenter = tickAt(sP);
    self.lastRebalance = now();
    let v = valueOf(self.idle0 + self.exp0 - self.owe0 + m.amount0, self.idle1 + self.exp1 - self.owe1 + m.amount1, priceQ64(sP));
    let total = (v * SHARES_PER_UNIT) >> 64;
    self.supply += DEAD_SHARES;
    let mine = total - DEAD_SHARES;
    if (mine > 0) {
        self.spend(C_REB, SHARE_MINT_VALUE);
        let to = self.openReceiver!!;
        self.mintShares(to, mine, SHARE_MINT_VALUE, to);
    }
}

// ---------------------------------------------------------------------------
// Observations (DESIGN §8)
// ---------------------------------------------------------------------------

// Start an observation round: one PoolObserve per live position (its fee growth inside), or one
// price-only request. Returns the round; `self.rnd` is it, the reply count is roundNeed(withSlots).
extends mutates fun startRound(self: Cold, withSlots: Bool): Int {
    self.rnd += 1;
    let r = self.rnd;
    let n = 0;
    if (withSlots) {
        foreach (slot, p in self.positions) {
            if (p.L > 0) {
                self.sendObserve(r, slot, p.tL, p.tU);
                n += 1;
            }
        }
    }
    if (n == 0) {
        self.sendObserve(r, NO_SLOT, 0, 0);
    }
    return r;
}

extends mutates fun roundNeed(self: Cold, withSlots: Bool): Int {
    let n = 0;
    if (withSlots) {
        n = self.liveCount();
    }
    return max(1, n);
}

extends mutates fun sendObserve(self: Cold, round: Int, slot: Int, tL: Int, tU: Int) {
    message(MessageParameters {
        to: self.pool!!, value: OBS_VALUE, mode: SendPayGasSeparately, bounce: true,
        body: PoolObserve { queryId: (K_OBS << 56) | (round << 8) | slot, tickLower: tL, tickUpper: tU, payload: null }.toCell(),
    });
}

// Pool -> vault (authenticated by the caller). Only the vault's own requests are ever answered to it.
extends mutates fun rPoolObservation(self: Cold, msg: PoolObservation) {
    let q = msg.queryId;
    if ((q >> 56) != K_OBS) {
        return;
    }
    let round = (q >> 8) & 0xFFFFFFFF;
    let slot = q & 0xFF;
    if (msg.initialized && msg.time >= self.orc.spotTs) {
        let o = self.orc;
        o.spotTick = msg.tick;
        o.spotSqrtP = msg.sqrtPriceX96;
        o.spotTs = msg.time;
        o.spotCum = msg.tickCumulative;
        // TWAP anchors: the pool's own accumulator, at most one per half window.
        if (o.t2 == 0 || msg.time - o.t2 >= self.strategy.twapWindow / 2) {
            o.c0 = o.c1;
            o.t0 = o.t1;
            o.c1 = o.c2;
            o.t1 = o.t2;
            o.c2 = msg.tickCumulative;
            o.t2 = msg.time;
        }
        self.orc = o;
        self.spotRound = round;
    }
    if (slot != NO_SLOT) {
        let po = self.positions.get(slot);
        let fo = self.fgs.get(slot);
        if (po != null && fo != null && msg.rangeOk && po!!.tL == msg.tickLower && po!!.tU == msg.tickUpper) {
            let p = po!!;
            let f = fo!!;
            p.uf0 = feesSince(p.L, msg.feeGrowthInside0X128, f.fg0);
            p.uf1 = feesSince(p.L, msg.feeGrowthInside1X128, f.fg1);
            p.oRound = round;
            self.positions.set(slot, p);
        }
    }
    self.roundReply(round);
}

// A PoolObserve bounced (pool not deployed, or refused): the round gets its reply, without data.
extends mutates fun bPoolObserve(self: Cold, queryId: Int) {
    if ((queryId >> 56) != K_OBS) {
        return;
    }
    self.roundReply((queryId >> 8) & 0xFFFFFFFF);
}

extends mutates fun roundReply(self: Cold, round: Int) {
    let dop = self.deps.get(round);
    if (dop != null) {
        let d = dop!!;
        self.gasCtx = C_DEP;
        self.gasRef = round;
        d.need = max(0, d.need - 1);
        if (d.need > 0) {
            self.deps.set(round, d);
            return;
        }
        self.finishDeposit(round, d);
        return;
    }
    if (self.reb != null && self.reb!!.round == round && round != 0) {
        let r = self.reb!!;
        self.gasCtx = C_REB;
        r.need = max(0, r.need - 1);
        if (r.need > 0) {
            self.reb = r;
            return;
        }
        r.round = 0;
        self.reb = r;
        if (self.phase == PHASE_OPENING) {
            self.openObserved();
        } else {
            self.rebObserved();
        }
    }
}

// TWAP from the pool's accumulator: the newest anchor at least `twapWindow` older than the last
// observation. Spot = that observation.
extends mutates fun oracleView(self: Cold): OracleView {
    let o = self.orc;
    let w = self.strategy.twapWindow;
    let t = o.spotTs;
    let ready = false;
    let twap = o.spotTick;
    if (t > 0) {
        if (o.t2 > 0 && t - o.t2 >= w && t > o.t2) {
            twap = (o.spotCum - o.c2) / (t - o.t2);
            ready = true;
        } else if (o.t1 > 0 && t - o.t1 >= w && t > o.t1) {
            twap = (o.spotCum - o.c1) / (t - o.t1);
            ready = true;
        } else if (o.t0 > 0 && t - o.t0 >= w && t > o.t0) {
            twap = (o.spotCum - o.c0) / (t - o.t0);
            ready = true;
        }
    }
    return OracleView { ready, spotTick: o.spotTick, twapTick: twap, spotSqrtP: o.spotSqrtP, spotTs: t };
}

// ---------------------------------------------------------------------------
// Deposits (DESIGN §4): accepted into `deps`, priced when their own observation round is in
// ---------------------------------------------------------------------------

extends mutates fun canDeposit(self: Cold): Bool {
    return self.phase == PHASE_IDLE && !self.depositsPaused && self.supply > 0 && self.worker == null &&
        !self.anyBusy() && self.liveCount() <= MAX_SLOTS && self.pool != null;
}

extends mutates fun rDepositNative(self: Cold, msg: DepositNative) {
    let ctx = context();
    require(msg.amount > 0, "Invalid amount");
    require(ctx.value >= msg.amount + DEPOSIT_GAS, "Insufficient TON attached");
    let receiver = msg.receiver != null ? msg.receiver!! : ctx.sender;
    require(isBasechain(receiver), "Invalid receiver");
    require(self.canDeposit(), "Deposits closed");
    self.queueDeposit(ctx.sender, receiver, msg.amount, 0, msg.minShares, ctx.value - msg.amount);
}

extends mutates fun depositJetton(self: Cold, msg: JettonNotification, p: DepositPayload) {
    let ctx = context();
    let receiver = p.receiver != null ? p.receiver!! : msg.sender;
    if (!isBasechain(receiver) || ctx.value < p.gramAmount + DEPOSIT_GAS || !self.canDeposit()) {
        emit(DepositRefusedEvent { from: msg.sender, amount0: p.gramAmount, amount1: msg.amount, code: D_CLOSED }.toCell());
        self.refundJetton(msg.queryId, msg.amount, msg.sender, ctx.value);
        return;
    }
    self.queueDeposit(msg.sender, receiver, p.gramAmount, msg.amount, p.minShares, ctx.value - p.gramAmount);
}

extends mutates fun queueDeposit(self: Cold, from: Address, receiver: Address, a0: Int, a1: Int, minShares: Int, value: Int) {
    let need = self.roundNeed(true);
    let round = self.startRound(true);
    let gas = max(0, value - need * (OBS_VALUE + FWD_EST) - HANDLER_EST);
    self.deps.set(round, Dep { from, receiver, a0, a1, minShares, gas, need, epoch: self.epoch, at: now() });
    self.pendG += a0 + gas;
    self.pendU += a1;
}

extends mutates fun finishDeposit(self: Cold, round: Int, d: Dep) {
    self.deps.set(round, null);
    self.pendG -= min(self.pendG, d.a0 + d.gas);
    self.pendU -= min(self.pendU, d.a1);
    self.gasCtx = 0;
    // This transaction's compute is paid from the deposit's remaining gas.
    let left = max(0, d.gas - getComputeFee(gasConsumed() + 60000, false) - FWD_EST);
    let code = 0;
    let shares = 0;
    let twap = 0;
    if (self.phase != PHASE_IDLE || self.depositsPaused || self.supply == 0 || self.worker != null) {
        code = D_CLOSED;
    } else if (self.epoch != d.epoch) {
        code = D_CHANGED;
    } else if (self.spotRound != round || now() - self.orc.spotTs > MAX_OBS_AGE) {
        code = D_ORACLE;
    } else {
        foreach (slot, p in self.positions) {
            if (p.L > 0 && p.oRound != round) {
                code = D_CHANGED;
            }
        }
    }
    if (code == 0) {
        let ov = self.oracleView();
        twap = ov.twapTick;
        if (!ov.ready || abs(ov.spotTick - ov.twapTick) > self.strategy.maxDeviation) {
            code = D_ORACLE;
        } else {
            shares = self.quoteShares(d.a0, d.a1, ov);
            if (shares <= 0) {
                code = D_ORACLE;
            } else if (shares < d.minShares) {
                code = D_MIN_SHARES;
            } else if (left < SHARE_MINT_VALUE) {
                code = D_BAD;           // cannot pay the share wallet (unreachable with DEPOSIT_GAS)
            }
        }
    }
    if (code != 0) {
        self.depositRefund(d, left, code);
        return;
    }
    self.idle0 += d.a0;
    self.idle1 += d.a1;
    self.mintShares(d.receiver, shares, left, d.from);
    emit(DepositEvent { receiver: d.receiver, amount0: d.a0, amount1: d.a1, shares, twapTick: twap }.toCell());
}

// Both legs of a refused (or timed-out) deposit back to its sender; `left` is its remaining gas.
extends mutates fun depositRefund(self: Cold, d: Dep, left0: Int, code: Int) {
    let left = left0;
    emit(DepositRefusedEvent { from: d.from, amount0: d.a0, amount1: d.a1, code }.toCell());
    if (d.a1 > 0 && left >= JETTON_OUT_VALUE + FWD_EST) {
        self.sendUsdt(self.nextQ(K_REFUND), d.a1, d.from, JETTON_OUT_VALUE, 0, null, d.from);
        left -= JETTON_OUT_VALUE + FWD_EST;
    } else if (d.a1 > 0) {
        self.idle1 += d.a1;     // unreachable (DEPOSIT_GAS covers the refund): holders keep it
    }
    message(MessageParameters {
        to: d.from, value: d.a0 + left, mode: SendPayGasSeparately | SendIgnoreErrors, bounce: false,
        body: VaultPayout { queryId: 0, reason: PAYOUT_REFUND, amount: d.a0 }.toCell(),
    });
}

// Shares for a deposit: the smaller of the TWAP quote and the spot quote (a manipulated spot cannot
// raise it, and neither can a TWAP that lags a real move).
extends mutates fun quoteShares(self: Cold, a0: Int, a1: Int, ov: OracleView): Int {
    let shares = 0;
    try {
        let sT = sqrtAt(ov.twapTick);
        let navT = self.navAt(ov.twapTick, sT);
        let navS = self.navAt(ov.spotTick, ov.spotSqrtP);
        let vT = valueOf(a0, a1, priceQ64(sT));
        let vS = valueOf(a0, a1, priceQ64(ov.spotSqrtP));
        if (navT > 0 && navS > 0) {
            shares = min(mulDiv(vT, self.supply, navT), mulDiv(vS, self.supply, navS));
        }
    } catch (e) {
        shares = 0;
    }
    return shares;
}

// Value of everything the holders own, in token1 units << 64, at (tick, sqrtP): idle, what the DEX
// still owes (net of the performance fee), every position's principal and its uncollected fees at
// the last observation (net of the performance fee).
extends mutates fun navAt(self: Cold, tick: Int, sqrtP: Int): Int {
    let p = priceQ64(sqrtP);
    let bps = self.strategy.perfFeeBps;
    let v = valueOf(self.idle0 + self.exp0 - self.owe0 - self.due0, self.idle1 + self.exp1 - self.owe1 - self.due1, p);
    foreach (slot, pos in self.positions) {
        let l = pos.L - pos.reserved;
        if (l > 0) {
            let am = amountsForLiquidity(tick, sqrtP, pos.tL, pos.tU, l, false);
            v += valueOf(am.a, am.b, p);
        }
        v += valueOf(pos.uf0 - pos.uf0 * bps / BPS, pos.uf1 - pos.uf1 * bps / BPS, p);
    }
    return v;
}

extends mutates fun mintShares(self: Cold, to: Address, amount: Int, value: Int, response: Address) {
    self.supply += amount;
    deploy(DeployParameters {
        init: self.walletInit(to),
        value: max(value, 0),
        mode: SendPayGasSeparately,
        bounce: true,
        body: JettonTransferInternal {
            queryId: 0, amount, sender: myAddress(), responseDestination: response,
            forwardTonAmount: 0, forwardPayload: beginCell().storeBool(false).asSlice(),
        }.toCell(),
    });
}

extends mutates fun refundJetton(self: Cold, queryId: Int, amount: Int, to: Address, value: Int) {
    if (value < REFUND_MIN || !isBasechain(to)) {
        return;         // too little gas to refund: the USDT stays in the wallet, unaccounted (DESIGN §4.1)
    }
    self.sendUsdt(self.nextQ(K_REFUND), amount, to, value - HANDLER_EST, 0, null, to);
}

// ---------------------------------------------------------------------------
// Withdrawals (DESIGN §5): queue -> collect (fees to the vault) -> pay idle share + decrease to the user
// ---------------------------------------------------------------------------

extends mutates fun rJettonBurnNotification(self: Cold, msg: JettonBurnNotification) {
    let ctx = context();
    require(ctx.sender == self.walletAddress(msg.sender), "Invalid wallet");
    require(self.phase == PHASE_IDLE || self.phase == PHASE_REB, "Not open");
    require(msg.amount >= max(1, min(MIN_WITHDRAW_SHARES, self.supply / 1000000)) && msg.amount <= self.supply - DEAD_SHARES,
        "Invalid amount");
    let recipient = msg.responseDestination != null ? msg.responseDestination!! : msg.sender;
    require(self.validRecipient(recipient), "Invalid recipient");
    require(self.qTail - self.qHead < MAX_QUEUE, "Queue full");
    require(ctx.value >= WITHDRAW_GAS, "Insufficient TON attached");
    let budget = ctx.value - HANDLER_EST;
    self.queue.set(self.qTail, WReq { recipient, shares: msg.amount, budget });
    self.qTail += 1;
    self.queueGas += budget;
    self.workerKick();
}

// A withdrawal recipient (audit H-1): a basechain address that is none of the contracts the vault
// talks to (a payout there would be stranded or refused).
extends mutates fun validRecipient(self: Cold, a: Address): Bool {
    if (!isBasechain(a) || a == myAddress()) {
        return false;
    }
    let cfg = self.cfgGet();
    if (a == cfg.router || a == cfg.usdtMaster) {
        return false;
    }
    if (self.pool != null && a == self.pool!!) {
        return false;
    }
    if (self.usdtWallet != null && a == self.usdtWallet!!) {
        return false;
    }
    if (self.rwUsdt != null && a == self.rwUsdt!!) {
        return false;
    }
    return true;
}

extends mutates fun workerKick(self: Cold) {
    repeat (8) {
        if (self.worker != null) {
            self.workerPump();
        }
        if (self.worker != null || !self.workerStart()) {
            return;
        }
    }
}

extends mutates fun workerStart(self: Cold): Bool {
    if (self.phase != PHASE_IDLE || self.worker != null || self.qHead >= self.qTail || self.anyBusy()) {
        return false;
    }
    let r = self.queue.get(self.qHead)!!;
    self.queue.set(self.qHead, null);
    self.qHead += 1;
    self.queueGas -= min(self.queueGas, r.budget);
    self.worker = Worker { recipient: r.recipient, shares: r.shares, budget: r.budget, stage: W_COLLECT, pending: 0,
                           waitUntil: now() + PAYOUT_WAIT, dL0: 0, dL1: 0, since: self.seq + 1 };
    self.wdl = emptyMap();
    self.wtry = emptyMap();
    self.gasCtx = C_WORKER;
    self.epoch += 1;
    // Collect every position's fees to the vault first: the withdrawer's share then includes them.
    let n = 0;
    let ps = self.positions;
    foreach (slot, p in ps) {
        if (p.L > 0 && self.sendPosOp(K_COLLECT, C_WORKER, slot, 0, null, 0)) {
            n += 1;
        }
    }
    let w = self.worker!!;
    w.pending = n;
    self.worker = w;
    return true;
}

extends mutates fun workerPump(self: Cold) {
    if (self.worker == null) {
        return;
    }
    let w = self.worker!!;
    if (w.stage == W_COLLECT) {
        if (w.pending > 0) {
            return;
        }
        // Wait until the collected fees have landed (or the wait is over: a Poke proceeds then).
        if (now() < w.waitUntil && self.inFlight(C_WORKER, w.since)) {
            return;
        }
        self.workerPay();
        w = self.worker!!;
    }
    if (w.stage == W_DECREASE) {
        // (Re)send the user's decrease on every slot that still owes it and is free. A decrease the
        // DEX refused MAX_UDEC_TRIES times takes the terminal path (never an endless retry).
        let m = self.wdl;
        foreach (slot, dL in m) {
            let p = self.positions.get(slot);
            let tries = self.wtry.get(slot);
            if (p == null || (tries != null && tries!! >= MAX_UDEC_TRIES)) {
                if (p == null || p!!.busy == 0) {
                    self.udecGiveUp(slot, dL);
                }
            } else if (p!!.busy == 0) {
                self.sendPosOp(K_UDEC, C_WORKER, slot, dL, w.recipient, 0);
            }
        }
        if (self.wdl.isEmpty()) {
            w = self.worker!!;
            self.worker = null;
            let refund = min(w.budget, self.freeBalance());
            self.refundGas(w.recipient, refund, 0);
        }
    }
}

// Pro-rata, in kind, price-free: shares/supply of idle (paid now) and of every position's liquidity
// (decreased to the vault, then forwarded to the user with his pro-rata share of the fees).
extends mutates fun workerPay(self: Cold) {
    let w = self.worker!!;
    let S = self.supply;
    let s = w.shares;
    let g = mulDiv(self.idle0, s, S);
    let u = mulDiv(self.idle1, s, S);
    if (g < DUST_GRAM) {
        g = 0;              // dust stays with the holders (it could not pay the recipient's compute)
    }
    self.idle0 -= g;
    self.idle1 -= u;
    self.supply -= s;
    self.epoch += 1;
    let ps = self.positions;
    foreach (slot, p in ps) {
        if (p.L > p.reserved) {
            let dL = mulDiv(p.L, s, S);
            if (dL > 0) {
                p.reserved += dL;
                self.positions.set(slot, p);
                self.wdl.set(slot, dL);
                if (slot == 0) {
                    w.dL0 = dL;
                } else if (slot == 1) {
                    w.dL1 = dL;
                }
            }
        }
    }
    if (g > 0) {
        w.budget -= min(w.budget, FWD_EST);
        self.sendGram(w.recipient, g, PAYOUT_WITHDRAW, 0);
    }
    if (u > 0) {
        w.budget -= min(w.budget, JETTON_OUT_VALUE + FWD_EST);
        self.sendUsdt(self.nextQ(K_PAYOUT), u, w.recipient, JETTON_OUT_VALUE, 0, null, w.recipient);
    }
    w.stage = W_DECREASE;
    self.worker = w;
    emit(WithdrawEvent { recipient: w.recipient, shares: s, amount0: g, amount1: u, dL0: w.dL0, dL1: w.dL1 }.toCell());
}

// Terminal path of a user decrease (audit H-1): the DEX refused it MAX_UDEC_TRIES times. Its
// liquidity goes back to the holders and the withdrawer gets new shares worth it, priced like a
// deposit (the worse of TWAP and spot of the last observation, so the holders never pay more).
extends mutates fun udecGiveUp(self: Cold, slot: Int, dL: Int) {
    let w = self.worker!!;
    self.wdl.set(slot, null);
    self.wtry.set(slot, null);
    let po = self.positions.get(slot);
    if (po == null) {
        return;
    }
    let p = po!!;
    p.reserved = max(0, p.reserved - dL);
    self.positions.set(slot, p);
    self.epoch += 1;
    let x = 0;
    try {
        let ov = self.oracleView();
        let t = ov.ready ? ov.twapTick : ov.spotTick;
        let sT = sqrtAt(t);
        let aT = amountsForLiquidity(t, sT, p.tL, p.tU, dL, false);
        let aS = amountsForLiquidity(ov.spotTick, ov.spotSqrtP, p.tL, p.tU, dL, false);
        let vT = valueOf(aT.a, aT.b, priceQ64(sT));
        let vS = valueOf(aS.a, aS.b, priceQ64(ov.spotSqrtP));
        let nT = self.navAt(t, sT) - vT;
        let nS = self.navAt(ov.spotTick, ov.spotSqrtP) - vS;
        if (nT > 0 && nS > 0) {
            x = min(mulDiv(vT, self.supply, nT), mulDiv(vS, self.supply, nS));
        }
    } catch (e) {
        x = 0;
    }
    if (x <= 0) {
        x = mulDiv(w.shares, dL, max(1, p.L));     // no usable price: the liquidity share of this slot
    }
    self.spend(C_WORKER, SHARE_MINT_VALUE);
    self.mintShares(w.recipient, x, SHARE_MINT_VALUE, w.recipient);
    emit(WithdrawFailedEvent { recipient: w.recipient, slot, dL, shares: x }.toCell());
}

extends mutates fun workerOpDone(self: Cold, kind: Int, slot: Int, ok: Bool) {
    if (self.worker == null) {
        return;
    }
    let w = self.worker!!;
    if (kind == K_COLLECT && w.stage == W_COLLECT) {
        w.pending = max(0, w.pending - 1);
        self.worker = w;
    } else if (kind == K_UDEC && self.wdl.get(slot) != null) {
        if (ok) {
            self.wdl.set(slot, null);
            self.wtry.set(slot, null);
        } else {
            let t = self.wtry.get(slot);
            self.wtry.set(slot, (t == null ? 0 : t!!) + 1);
        }
    }
}

// ---------------------------------------------------------------------------
// Rebalance (DESIGN §7)
// ---------------------------------------------------------------------------

extends mutates fun rRebalance(self: Cold, msg: Rebalance) {
    let ctx = context();
    // audit L-2: the keeper or the admin, never anyone (a null keeper means admin only).
    let cfg = self.cfgGet();
    require(ctx.sender == cfg.admin || (cfg.keeper != null && ctx.sender == cfg.keeper!!), "Not keeper");
    require(self.phase == PHASE_IDLE && self.worker == null && !self.anyBusy() && !self.anyUnresolved(), "Busy");
    require(ctx.value >= REBALANCE_GAS, "Insufficient TON attached");
    require(now() >= self.lastRebalance + MIN_REBALANCE_INTERVAL, "Too soon");
    self.phase = PHASE_REB;
    self.epoch += 1;
    self.reb = Reb { step: STEP_OBSERVE, startedAt: now(), budget: ctx.value, payer: ctx.sender, round: 0, need: 0, twap: 0,
                     since: self.seq + 1, spot: 0 };
    self.gasCtx = C_REB;
    emit(RebalanceEvent { stage: 1, code: 0, twapTick: 0, spotTick: self.orc.spotTick }.toCell());
    self.rebObserve(false);
}

extends mutates fun rebObserve(self: Cold, withSlots: Bool) {
    let need = self.roundNeed(withSlots);
    self.spend(C_REB, need * OBS_VALUE);
    let round = self.startRound(withSlots);
    let r = self.reb!!;
    r.round = round;
    r.need = need;
    r.step = STEP_OBSERVE;
    self.reb = r;
}

// The rebalance's own fresh observation is in: guards, then close everything.
extends mutates fun rebObserved(self: Cold) {
    let ov = self.oracleView();
    let st = self.strategy;
    let code = 0;
    if (ov.spotTs == 0) {
        code = R_NO_POOL;
    } else if (now() - ov.spotTs > MAX_OBS_AGE) {
        code = R_STALE;
    } else if (!ov.ready) {
        code = R_NOT_READY;
    } else if (abs(ov.spotTick - ov.twapTick) > st.maxDeviation) {
        code = R_DEVIATION;
    } else {
        let base = self.positions.get(0);
        let outOfRange = base == null || ov.spotTick < base!!.tL || ov.spotTick >= base!!.tU;
        let past = abs(ov.spotTick - self.baseCenter) >= st.threshold;
        let cool = now() >= self.lastRebalance + st.cooldown;
        if (!(outOfRange || past || cool)) {
            code = R_NOT_NEEDED;
        }
    }
    if (code != 0) {
        self.refuseReb(code);
        return;
    }
    let r = self.reb!!;
    r.twap = ov.twapTick;
    r.spot = ov.spotTick;
    r.step = STEP_CLOSE;
    self.reb = r;
    let ps = self.positions;
    foreach (slot, p in ps) {
        if (p.L > 0) {
            self.sendPosOp(K_CLOSE, C_REB, slot, p.L, null, 0);
        }
    }
    self.pump();
}

extends mutates fun refuseReb(self: Cold, code: Int) {
    emit(RebalanceEvent { stage: 5, code, twapTick: self.oracleView().twapTick, spotTick: self.orc.spotTick }.toCell());
    if (self.phase == PHASE_OPENING) {
        self.openSqrt = 0;
    }
    self.endReb();
}

extends mutates fun pump(self: Cold) {
    if (self.reb == null) {
        return;
    }
    let r = self.reb!!;
    if (r.step == STEP_CLOSE && !self.unresolved(C_REB, r.since)) {
        r.step = STEP_SETTLE1;
        self.reb = r;
    }
    if (r.step == STEP_SETTLE1) {
        if (self.inFlight(C_REB, r.since)) {
            return;
        }
        r.step = STEP_MINT;
        self.reb = r;
        if (self.phase == PHASE_REB) {
            self.doMints(r.twap, r.spot);
            emit(RebalanceEvent { stage: 2, code: 0, twapTick: r.twap, spotTick: self.orc.spotTick }.toCell());
        }
    }
    if (r.step == STEP_MINT && !self.unresolved(C_REB, r.since)) {
        r.step = STEP_SETTLE2;
        self.reb = r;
    }
    if (r.step == STEP_SETTLE2) {
        if (self.inFlight(C_REB, r.since)) {
            return;
        }
        if (self.phase == PHASE_REB) {
            self.lastRebalance = now();
        }
        emit(RebalanceEvent { stage: 3, code: 0, twapTick: r.twap, spotTick: self.orc.spotTick }.toCell());
        self.endReb();
    }
}

extends mutates fun endReb(self: Cold) {
    let r = self.reb!!;
    self.reb = null;
    if (self.phase == PHASE_OPENING) {
        self.phase = self.supply > 0 ? PHASE_IDLE : PHASE_SETUP;
        self.openSqrt = 0;
    } else {
        self.phase = PHASE_IDLE;
    }
    let refund = min(r.budget, self.freeBalance());
    self.refundGas(r.payer, refund, 0);
    self.workerKick();
}

extends mutates fun rAbortRebalance(self: Cold, msg: AbortRebalance) {
    require(self.reb != null && (self.phase == PHASE_REB || self.phase == PHASE_OPENING), "No rebalance");
    require(now() >= self.reb!!.startedAt + REBALANCE_TIMEOUT, "Too early");
    emit(RebalanceEvent { stage: 4, code: 0, twapTick: 0, spotTick: self.orc.spotTick }.toCell());
    self.endReb();
}

// New ranges around the TWAP tick t: base = the largest balanced pair, limit = the leftover token,
// single-sided, just beyond the deviation band. Both carry a DEX price band (enforced by the Pool
// when the mint executes): spot ± maxDeviation/MINT_BAND_DIV around the rebalance's own observed
// spot, inside TWAP ± maxDeviation. Between the closes and the mints the vault's liquidity is out
// of the pool, so the price can be moved cheaply; the band bounds how far (audit L-3). A mint
// outside it is refused by the DEX (refunded to idle), never executed at a moved price.
extends mutates fun doMints(self: Cold, t: Int, spot: Int) {
    let s = self.spacing;
    let st = self.strategy;
    let dev = st.maxDeviation;
    let minU = minUsable(s);
    let maxU = maxUsable(s);
    let tol = max(1, dev / MINT_BAND_DIV);
    let sMin = sqrtAt(max(max(MIN_TICK, t - dev), spot - tol));
    let sMax = sqrtAt(min(min(MAX_TICK, t + dev), spot + tol));
    let sT = sqrtAt(t);
    let x0 = self.idle0;
    let x1 = self.idle1;

    // base
    let tL = max(minU, floorS(t - st.baseHalfWidth, s));
    let tU = min(maxU, floorS(t + st.baseHalfWidth, s) + s);
    let sA = sqrtAt(tL);
    let sB = sqrtAt(tU);
    let b0 = 0;
    let b1 = 0;
    if (x0 > 0 && x1 > 0 && self.positions.get(0) == null) {
        let liq = liquidityForAmounts(sT, sA, sB, x0, x1);
        if (liq >= MIN_MINT_LIQUIDITY) {
            let am = amountsForLiquidity(t, sT, tL, tU, liq, true);
            b0 = min(am.a, x0);
            b1 = min(am.b, x1);
            let lLo = liquidityForAmounts(sMin, sA, sB, b0, b1);
            let lHi = liquidityForAmounts(sMax, sA, sB, b0, b1);
            let minL = min(lLo, lHi) * 99 / 100;
            if (!self.sendMint(0, tL, tU, b0, b1, minL, 0, sMin, sMax, C_REB)) {
                b0 = 0;
                b1 = 0;
            }
        }
    }
    self.baseCenter = t;

    // limit: the leftover token, single-sided, beyond the deviation band
    if (self.positions.get(1) != null) {
        return;                 // a position the vault could not close is still in the limit slot
    }
    let l0 = x0 - b0;
    let l1 = x1 - b1;
    let p = priceQ64(sT);
    if (l0 > 0 && l0 * p >= (l1 << 64)) {
        let lL = floorS(t + dev, s) + s;
        let lU = min(maxU, lL + st.limitWidth);
        if (lL < lU) {
            let liq = liqForAmount0(sqrtAt(lL), sqrtAt(lU), l0);
            if (liq >= MIN_MINT_LIQUIDITY) {
                self.sendMint(1, lL, lU, l0, 0, liq * 99 / 100, 0, sMin, sMax, C_REB);
            }
        }
    } else if (l1 > 0) {
        let lU = floorS(t - dev, s);
        let lL = max(minU, lU - st.limitWidth);
        if (lL < lU) {
            let liq = liqForAmount1(sqrtAt(lL), sqrtAt(lU), l1);
            if (liq >= MIN_MINT_LIQUIDITY) {
                self.sendMint(1, lL, lU, 0, l1, liq * 99 / 100, 0, sMin, sMax, C_REB);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// DEX ops and their results
// ---------------------------------------------------------------------------

extends mutates fun sendMint(self: Cold, slot: Int, tL: Int, tU: Int, a0: Int, a1: Int, minL: Int, sqrtInit: Int,
                             sMin: Int, sMax: Int, ctxId: Int): Bool {
    let q = self.nextQ(K_MINT);
    let cfg = self.cfgGet();
    if (a1 > 0) {
        if (!self.spend(ctxId, MINT_FWD + MINT_WALLET_VALUE)) {
            return false;
        }
        self.idle0 -= a0;
        self.idle1 -= a1;
        self.sendUsdt(q, a1, cfg.router, a0 + MINT_FWD + MINT_WALLET_VALUE, a0 + MINT_FWD, MintNotifyPayload {
            otherToken: GRAM, tickSpacing: self.spacing, ext: null, tickLower: tL, tickUpper: tU,
            gramAmount: a0, sqrtPriceInitX96: sqrtInit, minLiquidity: minL,
            owner: myAddress(), refundTo: myAddress(), deadline: now() + OP_DEADLINE,
            sqrtPriceMinX96: sMin, sqrtPriceMaxX96: sMax,
        }.toCell(), myAddress());
    } else {
        if (a0 <= 0 || !self.spend(ctxId, MINT_NATIVE_GAS)) {
            return false;
        }
        self.idle0 -= a0;
        message(MessageParameters {
            to: cfg.router, value: a0 + MINT_NATIVE_GAS, mode: SendPayGasSeparately, bounce: true,
            body: MintNativeNotify {
                queryId: q, amount: a0, otherToken: self.rwUsdt!!, tickSpacing: self.spacing, ext: null,
                tickLower: tL, tickUpper: tU, sqrtPriceInitX96: sqrtInit, minLiquidity: minL,
                owner: myAddress(), refundTo: myAddress(), deadline: now() + OP_DEADLINE,
                sqrtPriceMinX96: sMin, sqrtPriceMaxX96: sMax,
            }.toCell(),
        });
    }
    // Until its receipt, the mint's legs are owed back by the DEX (as a position or a refund).
    self.exp0 += a0;
    self.exp1 += a1;
    self.epoch += 1;
    self.ops.set(q, Op {
        kind: K_MINT, ctx: ctxId, slot, index: 0, done: false, ok: false, dL: minL, a0, a1, r0: a0, r1: a1,
        f0: 0, f1: 0, tL, tU, user: null, retries: 0, at: now(), g: 0, u0: 0, u1: 0, ref: 0,
    });
    return true;
}

// Pool -> vault (authenticated by the caller). Sent only for mints the vault itself paid for.
extends mutates fun rMintReceipt(self: Cold, m: MintReceipt) {
    let q = m.queryId;
    let opt = self.ops.get(q);
    if (opt == null || opt!!.kind != K_MINT || opt!!.done) {
        return;
    }
    let o = opt!!;
    self.gasCtx = o.ctx;
    o.done = true;
    o.ok = m.ok;
    self.epoch += 1;
    if (m.ok) {
        o.r0 -= m.amount0;
        o.r1 -= m.amount1;
        self.exp0 -= m.amount0;
        self.exp1 -= m.amount1;
        let slot = o.slot;
        if (self.positions.get(slot) != null) {
            slot = self.freeSlot();     // never overwrite a live position (only after an abort)
            o.slot = slot;
        }
        self.positions.set(slot, Pos {
            index: m.index, tL: m.tickLower, tU: m.tickUpper, L: m.liquidity, reserved: 0, busy: 0,
            uf0: 0, uf1: 0, oRound: 0, addr: self.posAddress(m.index),
        });
        self.fgs.set(slot, Fg { fg0: m.fgInside0, fg1: m.fgInside1 });
        if (self.openSqrt > 0 && self.phase == PHASE_OPENING) {
            self.completeOpen(m);
        }
    }
    self.ops.set(q, o);
    self.maybeRemove(q);
    self.afterOp();
}

// A PositionDecreaseNotify on one of our NFTs. The DEX always pays the VAULT (recipient = vault):
// a user decrease is forwarded to the withdrawer by the vault (audit H-1, H-2), so the Pool can
// never refuse it for its recipient and never pays a withdrawer the position's other fees.
extends mutates fun sendPosOp(self: Cold, kind: Int, ctxId: Int, slot: Int, dL: Int, user: Address?, ref: Int): Bool {
    let po = self.positions.get(slot);
    if (po == null || po!!.busy != 0) {
        return false;
    }
    let g = kind == K_UDEC ? USER_PAY_GAS : 0;
    if (!self.spend(ctxId, POS_OP_VALUE + g)) {
        return false;
    }
    let p = po!!;
    let q = self.nextQ(kind);
    message(MessageParameters {
        to: p.addr, value: POS_OP_VALUE, mode: SendPayGasSeparately, bounce: true,
        body: PositionDecreaseNotify {
            queryId: q, liquidityDelta: dL, amount0Min: 0, amount1Min: 0,
            deadline: now() + OP_DEADLINE, recipient: myAddress(),
        }.toCell(),
    });
    p.busy = q;
    self.positions.set(slot, p);
    self.epoch += 1;
    self.opGas += g;
    self.ops.set(q, Op {
        kind, ctx: ctxId, slot, index: p.index, done: false, ok: false, dL, a0: 0, a1: 0, r0: 0, r1: 0,
        f0: 0, f1: 0, tL: p.tL, tU: p.tU, user, retries: 0, at: now(), g, u0: 0, u1: 0, ref,
    });
    return true;
}

// Position -> vault: exactly one per PositionDecreaseNotify the Position accepted, once it is free.
// Authenticated against the op's Position (cached NFT address) before gas is accepted; false = ignored.
extends mutates fun rBurnReceiptIn(self: Cold, m: BurnReceipt): Bool {
    let q = m.queryId;
    let opt = self.ops.get(q);
    if (opt == null) {
        return false;
    }
    let o = opt!!;
    if (o.done || o.index != m.index || o.kind < K_CLOSE || o.kind > K_SYNC) {
        return false;
    }
    let slot0 = self.slotOf(o.index);
    let expected = slot0 != NO_SLOT ? self.positions.get(slot0)!!.addr : self.posAddress(o.index);
    if (sender() != expected) {
        return false;
    }
    acceptMessage();
    self.credit(o.ctx, context().value);
    self.gasCtx = o.ctx;
    self.epoch += 1;
    self.freePos(o.index, q);
    o.done = true;
    o.ok = m.ok;
    let staleQ = 0;
    let staleRan = false;
    if (m.ok) {
        let slot = self.slotOf(o.index);
        if (slot != NO_SLOT) {
            let p = self.positions.get(slot)!!;
            if (o.kind == K_UDEC) {
                p.reserved = max(0, p.reserved - m.liquidityDelta);
            }
            if (o.kind == K_SYNC) {
                // Re-sync after a lost receipt: nothing else touched this NFT since the lost op, so its
                // liquidity tells whether that op ran (Recover, audit M-1).
                let so = self.ops.get(o.ref);
                if (so != null && !so!!.done) {
                    staleQ = o.ref;
                    staleRan = so!!.dL > 0 && p.L - m.liquidity == so!!.dL;
                    if (staleRan && so!!.kind == K_UDEC) {
                        p.reserved = max(0, p.reserved - so!!.dL);
                    }
                }
            }
            p.L = m.liquidity;          // the Position's own record
            p.uf0 = 0;                  // the fee checkpoint moved: the last reading is void
            p.uf1 = 0;
            p.oRound = 0;
            if (p.L == 0 && p.reserved == 0) {
                self.positions.set(slot, null);
                self.fgs.set(slot, null);
            } else {
                self.positions.set(slot, p);
                self.fgs.set(slot, Fg { fg0: m.fgInside0, fg1: m.fgInside1 });
            }
        }
    }
    self.ops.set(q, o);
    if (m.ok) {
        let bps = self.strategy.perfFeeBps;
        let perf0 = m.fees0 * bps / BPS;
        let perf1 = m.fees1 * bps / BPS;
        self.expectOp(q, m.amount0 + m.fees0, perf0, m.amount1 + m.fees1, perf1);
        if (o.kind == K_UDEC) {
            // The withdrawer's principal, plus his liquidity's share of the fees this decrease
            // collected (net of the performance fee); the rest of the fees stays with the holders.
            let lb = m.liquidity + m.liquidityDelta;
            let u0 = m.amount0;
            let u1 = m.amount1;
            if (lb > 0) {
                u0 += mulDiv(m.fees0 - perf0, m.liquidityDelta, lb);
                u1 += mulDiv(m.fees1 - perf1, m.liquidityDelta, lb);
            }
            self.oweUser(q, u0, u1);
        }
    }
    self.maybeRemove(q);
    if (staleQ != 0) {
        self.resolveStale(staleQ, staleRan);
    }
    self.opDone(o.ctx, o.kind, o.slot, o.ok);
    return true;
}

// A position op whose receipt was lost, resolved by its re-sync: if it ran, what arrived for it is
// its result (for a user decrease: all of it is forwarded to the withdrawer); if not, it failed.
extends mutates fun resolveStale(self: Cold, q: Int, ran: Bool) {
    let s = self.ops.get(q)!!;
    s.done = true;
    s.ok = ran;
    self.ops.set(q, s);
    emit(RecoverEvent { kind: 3, queryId: q }.toCell());
    if (ran) {
        let a0 = max(0, -s.r0);
        let a1 = max(0, -s.r1);
        self.expectOp(q, a0, 0, a1, 0);
        if (s.kind == K_UDEC) {
            self.oweUser(q, a0, a1);
        }
    }
    self.maybeRemove(q);
    self.opDone(s.ctx, s.kind, s.slot, ran);
}

extends mutates fun oweUser(self: Cold, q: Int, u0: Int, u1: Int) {
    let o = self.ops.get(q)!!;
    o.u0 += u0;
    o.u1 += u1;
    self.due0 += u0;
    self.due1 += u1;
    self.ops.set(q, o);
}

// The Position refused the op (bounced: not owner / busy / not deployed yet): nothing happened.
extends mutates fun bPositionDecreaseNotify(self: Cold, q: Int) {
    let opt = self.ops.get(q);
    if (opt == null || opt!!.done) {
        return;
    }
    let o = opt!!;
    self.credit(o.ctx, context().value);
    self.freePos(o.index, q);
    o.done = true;
    o.ok = false;
    self.ops.set(q, o);
    self.maybeRemove(q);
    self.opDone(o.ctx, o.kind, o.slot, o.ok);
}

extends mutates fun opDone(self: Cold, ctxId: Int, kind: Int, slot: Int, ok: Bool) {
    if (ctxId == C_WORKER) {
        self.workerOpDone(kind, slot, ok);
    }
    self.afterOp();
}

// After any op result: push the rebalance and the withdrawal worker (a position freed by a late op
// of an aborted rebalance lets the queue start, audit L-1).
extends mutates fun afterOp(self: Cold) {
    self.pump();
    self.workerKick();
}

// A receipt says `gross` (perf fee `perf` inside) is on its way, per token. Part of it may already
// have arrived (r < 0): the fee on that part is taken from idle now.
extends mutates fun expectOp(self: Cold, q: Int, gross0: Int, perf0: Int, gross1: Int, perf1: Int) {
    let o = self.ops.get(q)!!;
    let early0 = min(max(0, -o.r0), gross0);
    o.r0 += gross0;
    self.exp0 += gross0;
    let t0 = min(min(early0, perf0), self.idle0);
    self.idle0 -= t0;
    self.fee0 += t0;
    o.f0 += perf0 - t0;
    self.owe0 += perf0 - t0;
    let early1 = min(max(0, -o.r1), gross1);
    o.r1 += gross1;
    self.exp1 += gross1;
    let t1 = min(min(early1, perf1), self.idle1);
    self.idle1 -= t1;
    self.fee1 += t1;
    o.f1 += perf1 - t1;
    self.owe1 += perf1 - t1;
    self.ops.set(q, o);
}

// Value that really arrived from the DEX for queryId q: the op's performance fee first, the rest
// to the holders. Without an op (a swap output sent to the vault, a late payout) it is surplus.
extends mutates fun arrived0(self: Cold, q: Int, amount: Int) {
    let opt = self.ops.get(q);
    if (opt == null) {
        self.idle0 += amount;
        return;
    }
    let o = opt!!;
    o.r0 -= amount;
    self.exp0 -= amount;
    let t = min(amount, o.f0);
    o.f0 -= t;
    self.owe0 -= min(self.owe0, t);
    self.fee0 += t;
    self.idle0 += amount - t;
    self.ops.set(q, o);
    self.maybeRemove(q);
    self.opDone(o.ctx, o.kind, o.slot, o.ok);
}

extends mutates fun arrived1(self: Cold, q: Int, amount: Int) {
    let opt = self.ops.get(q);
    if (opt == null) {
        self.idle1 += amount;
        return;
    }
    let o = opt!!;
    o.r1 -= amount;
    self.exp1 -= amount;
    let t = min(amount, o.f1);
    o.f1 -= t;
    self.owe1 -= min(self.owe1, t);
    self.fee1 += t;
    self.idle1 += amount - t;
    self.ops.set(q, o);
    self.maybeRemove(q);
    self.opDone(o.ctx, o.kind, o.slot, o.ok);
}

// An op is forgotten once its result is in and everything it announced has arrived. More than
// announced (r < 0: someone sent extra with our queryId) is surplus for the holders. A user
// decrease forwards each leg to the withdrawer as soon as that leg has arrived.
extends mutates fun maybeRemove(self: Cold, q: Int) {
    let opt = self.ops.get(q);
    if (opt == null) {
        return;
    }
    let o = opt!!;
    if (!o.done) {
        return;
    }
    if (o.r0 <= 0 && o.u0 > 0) {
        let a = min(o.u0, self.idle0);
        self.idle0 -= a;
        self.due0 -= min(self.due0, o.u0);
        o.u0 = 0;
        let c = min(o.g, FWD_EST);
        o.g -= c;
        self.opGas -= min(self.opGas, c);
        if (a > 0) {
            self.sendGram(o.user!!, a, PAYOUT_WITHDRAW, q);
        }
    }
    if (o.r1 <= 0 && o.u1 > 0) {
        let a = min(o.u1, self.idle1);
        self.idle1 -= a;
        self.due1 -= min(self.due1, o.u1);
        o.u1 = 0;
        // This transaction's compute (and the Gram leg's fee if still to come) stays; the rest of the
        // held gas rides with the transfer and its excess goes to the withdrawer.
        let keep = FWD_EST + getComputeFee(gasConsumed() + 40000, false) + (o.u0 > 0 ? FWD_EST : 0);
        let v = max(JETTON_OUT_VALUE, o.g - keep);
        let c = min(o.g, v + FWD_EST);
        o.g -= c;
        self.opGas -= min(self.opGas, c);
        if (a > 0) {
            self.sendUsdt(self.nextQ(K_PAYOUT), a, o.user!!, v, 0, null, o.user!!);
        }
    }
    if (o.r0 > 0 || o.r1 > 0) {
        self.ops.set(q, o);
        return;
    }
    self.dropOp(q, o);
}

// Remove an op (its expectations written off: exp, owe and due), releasing its held gas to its
// budget (or the free buffer).
extends mutates fun dropOp(self: Cold, q: Int, o: Op) {
    self.exp0 -= o.r0;
    self.exp1 -= o.r1;
    self.owe0 -= min(self.owe0, o.f0);
    self.owe1 -= min(self.owe1, o.f1);
    self.due0 -= min(self.due0, o.u0);
    self.due1 -= min(self.due1, o.u1);
    self.opGas -= min(self.opGas, o.g);
    if (o.g > 0) {
        let gc = self.gasCtx;
        self.credit(o.ctx, o.g);
        self.gasCtx = gc;
    }
    self.ops.set(q, null);
}

extends mutates fun rGramPayout(self: Cold, msg: GramPayout) {
    let ctx = context();
    let amount = min(msg.amount, ctx.value);
    let opt = self.ops.get(msg.queryId);
    if (opt != null) {
        self.credit(opt!!.ctx, ctx.value - amount);
    }
    self.arrived0(msg.queryId, amount);
}

extends mutates fun rJettonNotification(self: Cold, msg: JettonNotification) {
    let ctx = context();
    let router = self.cfgGet().router;
    if (msg.sender == router) {
        // A DEX payout or refund (notified because the vault only uses notifying ops). Real USDT
        // has arrived in our wallet: accepted on the hot path, so it can never be lost to an
        // out-of-gas handler (forcing this path costs a DEX swap plus the USDT itself).
        let opt = self.ops.get(msg.queryId);
        if (opt != null) {
            self.credit(opt!!.ctx, ctx.value);
        }
        self.arrived1(msg.queryId, msg.amount);
        return;
    }
    if (msg.sender == myAddress()) {
        return;
    }
    let pl = msg.forwardPayload;
    let op = 0;
    try {
        if (pl.loadBit()) {
            pl = pl.loadRef().beginParse();
        }
        op = pl.preloadUint(32);
    } catch (e) {
        op = 0;
    }
    if (op == OP_DEPOSIT) {
        let dp: DepositPayload? = null;
        try {
            dp = DepositPayload.fromSlice(pl);
        } catch (e) {
            dp = null;
        }
        if (dp != null) {
            self.depositJetton(msg, dp!!);
            return;
        }
    } else if (op == OP_OPEN) {
        let o: OpenPayload? = null;
        try {
            o = OpenPayload.fromSlice(pl);
        } catch (e) {
            o = null;
        }
        if (o != null) {
            self.openVault(msg, o!!);
            return;
        }
    }
    self.refundJetton(msg.queryId, msg.amount, msg.sender, ctx.value);
}

extends mutates fun rJettonExcesses(self: Cold, msg: JettonExcesses) {
    // Leftover gas of a DEX payout / refund or of our own transfers: back to the op's budget. Never
    // accepted (anyone can make a wallet send us an excess): it runs on its own value, and if that
    // is too little the value simply stays in the free buffer.
    let opt = self.ops.get(msg.queryId);
    if (opt != null) {
        let o = opt!!;
        let v = context().value;
        if (o.kind == K_MINT && !o.ok && o.r0 > 0 && v >= o.r0 + MINT_FWD / 2) {
            // A Router-level refusal of our notifying jetton mint (deadline, gas, ...): the USDT is
            // refunded notified, the Gram leg comes back inside our wallet's excess. Only a value this
            // large can be it (a normal excess is < MINT_WALLET_VALUE); it is real value either way.
            self.credit(o.ctx, v - o.r0);
            self.arrived0(msg.queryId, o.r0);
        } else {
            self.credit(o.ctx, v);
        }
    }
}

extends mutates fun bJettonTransfer(self: Cold, queryId: Int, amount: Int) {
    let ctx = context();
    let q = queryId;
    let kind = q >> 56;
    if (kind == K_MINT) {
        let opt = self.ops.get(q);
        if (opt != null && !opt!!.ok) {
            // Our wallet refused the mint transfer: both legs are back (the Gram rides in the value).
            // Also for a mint Recover already marked failed: what is still expected is what came back.
            self.mintLegsBack(q, opt!!, ctx.value, true);
        }
        return;
    }
    if (kind == K_FEE) {
        self.fee1 += amount;
        return;
    }
    // A payout / refund our wallet refused (cannot happen while idle1 + fee1 + pendU <= balance).
    self.idle1 += amount;
}

extends mutates fun bMintNativeNotify(self: Cold, queryId: Int) {
    let opt = self.ops.get(queryId);
    if (opt == null || opt!!.ok) {
        return;
    }
    self.mintLegsBack(queryId, opt!!, context().value, false);
}

// A mint that definitely failed before reaching the Pool (bounced): the legs still expected are
// back, the op is removed.
extends mutates fun mintLegsBack(self: Cold, q: Int, o: Op, value: Int, usdt: Bool) {
    let a0 = min(max(0, o.r0), value);
    let a1 = usdt ? max(0, o.r1) : 0;
    self.idle0 += a0;
    self.idle1 += a1;
    o.r0 -= a0;
    o.r1 -= a1;
    self.exp0 -= a0;
    self.exp1 -= a1;
    self.credit(o.ctx, value - a0);
    o.done = true;
    self.dropOp(q, o);
    self.afterOp();
}

extends mutates fun bJettonTransferInternal(self: Cold, amount: Int) {
    self.supply -= min(self.supply, amount);
}

// Anyone, paid: a fresh observation (TWAP anchors) and a push of whatever waits on time.
extends mutates fun rPoke(self: Cold, msg: Poke) {
    let ctx = context();
    require(ctx.value >= POKE_GAS, "Insufficient TON attached");
    let value = ctx.value - HANDLER_EST;
    if (self.pool != null && self.phase >= PHASE_IDLE) {
        self.startRound(false);
        value -= OBS_VALUE + FWD_EST;
    }
    if (self.worker != null) {
        let w = self.worker!!;
        w.budget += max(0, value);
        self.worker = w;
        self.gasCtx = C_WORKER;
    } else if (self.reb != null) {
        let r = self.reb!!;
        r.budget += max(0, value);
        self.reb = r;
        self.gasCtx = C_REB;
    }
    self.workerKick();
    self.pump();
}

// Anyone, paid (audit M-1): resolve what a lost DEX reply left pending, after a delay at which
// nothing the vault sent can still execute. Each item ends in a consistent state:
//  - a deposit whose observation never came back (DEP_TIMEOUT): both legs refunded;
//  - a mint without receipt (RECOVERY_DELAY > its DEX deadline): written off (a late refund is
//    surplus for the holders);
//  - a position op without receipt (RECOVERY_DELAY): the NFT is re-read with a fresh collect
//    (K_SYNC); its receipt tells whether the lost op ran (rBurnReceiptIn / resolveStale);
//  - a finished op whose payout never arrived (RECOVERY_DELAY): written off (exp, owe, due).
extends mutates fun rRecover(self: Cold, msg: Recover) {
    let ctx = context();
    require(ctx.value >= RECOVER_GAS, "Insufficient TON attached");
    let n = 0;
    let spent = 0;
    let dm = self.deps;
    foreach (round, d in dm) {
        if (n < RECOVER_MAX && now() >= d.at + DEP_TIMEOUT) {
            self.deps.set(round, null);
            self.pendG -= min(self.pendG, d.a0 + d.gas);
            self.pendU -= min(self.pendU, d.a1);
            self.depositRefund(d, max(0, d.gas - FWD_EST), D_TIMEOUT);
            emit(RecoverEvent { kind: 1, queryId: round }.toCell());
            n += 1;
        }
    }
    let om = self.ops;
    foreach (q, o0 in om) {
        let oo = self.ops.get(q);         // an earlier item may have resolved it already
        if (n < RECOVER_MAX && oo != null && now() >= oo!!.at + RECOVERY_DELAY) {
            let o = oo!!;
            if (o.done) {
                // its result is in but (part of) its payout never arrived
                self.dropOp(q, o);
                emit(RecoverEvent { kind: 4, queryId: q }.toCell());
                n += 1;
            } else if (o.kind == K_MINT) {
                // Past its DEX deadline it can no longer execute: it failed. The record stays so a late
                // refund is still matched; whatever never arrives is written off RECOVERY_DELAY later.
                o.done = true;
                o.ok = false;
                o.at = now();
                self.ops.set(q, o);
                emit(RecoverEvent { kind: 2, queryId: q }.toCell());
                self.maybeRemove(q);
                self.opDone(o.ctx, o.kind, o.slot, false);
                n += 1;
            } else if (o.kind == K_SYNC) {
                // a re-sync that itself got no answer: drop it; the lost op can be re-synced again
                self.freePos(o.index, q);
                self.dropOp(q, o);
                emit(RecoverEvent { kind: 5, queryId: q }.toCell());
                n += 1;
            } else {
                let slot = self.slotOf(o.index);
                if (slot == NO_SLOT) {
                    o.done = true;
                    o.ok = false;
                    self.ops.set(q, o);
                    self.maybeRemove(q);
                    self.opDone(o.ctx, o.kind, o.slot, false);
                    n += 1;
                } else {
                    let p = self.positions.get(slot)!!;
                    if (p.busy == q || p.busy == 0) {
                        p.busy = 0;
                        self.positions.set(slot, p);
                        if (self.sendPosOp(K_SYNC, C_NONE, slot, 0, null, q)) {
                            spent += POS_OP_VALUE + FWD_EST;
                            n += 1;
                        } else {
                            p.busy = q;
                            self.positions.set(slot, p);
                        }
                    }
                }
            }
        }
    }
    require(n > 0, "Nothing to recover");
    self.epoch += 1;
    self.gasCtx = 0;
    self.refundGas(ctx.sender, min(ctx.value - spent - HANDLER_EST, self.freeBalance()), msg.queryId);
    self.afterOp();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

extends mutates fun liveCount(self: Cold): Int {
    let n = 0;
    foreach (slot, p in self.positions) {
        if (p.L > 0) {
            n += 1;
        }
    }
    return n;
}

extends mutates fun anyBusy(self: Cold): Bool {
    foreach (slot, p in self.positions) {
        if (p.busy != 0) {
            return true;
        }
    }
    return false;
}

// Any op without its result (a late mint result must never land on top of a newer position).
extends mutates fun anyUnresolved(self: Cold): Bool {
    foreach (q, o in self.ops) {
        if (!o.done) {
            return true;
        }
    }
    return false;
}

// Ops of this context (sent since sequence number `since`) still waiting for their result.
extends mutates fun unresolved(self: Cold, ctxId: Int, since: Int): Bool {
    foreach (q, o in self.ops) {
        if (o.ctx == ctxId && (q & 0xFFFFFFFF) >= since && !o.done) {
            return true;
        }
    }
    return false;
}

// ... or for their result or announced value to arrive (ops leave the map once settled). Ops of an
// earlier, aborted rebalance or of an earlier withdrawal never hold up a new one.
extends mutates fun inFlight(self: Cold, ctxId: Int, since: Int): Bool {
    foreach (q, o in self.ops) {
        if (o.ctx == ctxId && (q & 0xFFFFFFFF) >= since) {
            return true;
        }
    }
    return false;
}

extends mutates fun slotOf(self: Cold, index: Int): Int {
    foreach (slot, p in self.positions) {
        if (p.index == index) {
            return slot;
        }
    }
    return NO_SLOT;
}

extends mutates fun freePos(self: Cold, index: Int, q: Int) {
    let slot = self.slotOf(index);
    if (slot == NO_SLOT) {
        return;
    }
    let p = self.positions.get(slot)!!;
    if (p.busy == q) {
        p.busy = 0;
        self.positions.set(slot, p);
    }
}

extends mutates fun freeSlot(self: Cold): Int {
    let i = 2;
    while (self.positions.get(i) != null && i < 254) {
        i += 1;
    }
    return i;
}

extends mutates fun nextQ(self: Cold, kind: Int): Int {
    self.seq += 1;
    return (kind << 56) | self.seq;
}

extends mutates fun heldGas(self: Cold): Int {
    let h = self.queueGas + self.pendG + self.opGas;
    if (self.reb != null) {
        h += self.reb!!.budget;
    }
    if (self.worker != null) {
        h += self.worker!!.budget;
    }
    return h;
}

extends mutates fun freeBalance(self: Cold): Int {
    return max(0, myBalance() - self.idle0 - self.fee0 - self.heldGas() - VAULT_MIN_STORAGE);
}

extends mutates fun spend(self: Cold, ctxId: Int, value: Int): Bool {
    let cost = value + FWD_EST;
    if (ctxId == C_REB && self.reb != null) {
        let r = self.reb!!;
        if (r.budget < cost) {
            return false;
        }
        r.budget -= cost;
        self.reb = r;
        return true;
    }
    if (ctxId == C_WORKER && self.worker != null) {
        let w = self.worker!!;
        if (w.budget < cost) {
            return false;
        }
        w.budget -= cost;
        self.worker = w;
        return true;
    }
    // The op's budget is gone (e.g. after an abort): maintenance draws from the vault's free gas
    // buffer, never from idle funds or held budgets.
    return self.freeBalance() >= cost;
}

extends mutates fun credit(self: Cold, ctxId: Int, value: Int) {
    if (ctxId == C_REB && self.reb != null) {
        let r = self.reb!!;
        r.budget += max(0, value);
        self.reb = r;
        self.gasCtx = C_REB;
    } else if (ctxId == C_WORKER && self.worker != null) {
        let w = self.worker!!;
        w.budget += max(0, value);
        self.worker = w;
        self.gasCtx = C_WORKER;
    }
}

// Charge this transaction's real compute to the budget that paid for it (called last, before the
// state is stored; the margin covers serialisation and the action phase).
extends mutates fun chargeGas(self: Cold) {
    if (self.gasCtx == 0) {
        return;
    }
    let fee = getComputeFee(gasConsumed() + 20000, false);
    if (self.gasCtx == C_REB && self.reb != null) {
        let r = self.reb!!;
        r.budget = max(0, r.budget - fee);
        self.reb = r;
    } else if (self.gasCtx == C_WORKER && self.worker != null) {
        let w = self.worker!!;
        w.budget = max(0, w.budget - fee);
        self.worker = w;
    } else if (self.gasCtx == C_DEP) {
        let dop = self.deps.get(self.gasRef);
        if (dop != null) {
            let d = dop!!;
            let f = min(fee, d.gas);
            d.gas -= f;
            self.pendG -= min(self.pendG, f);
            self.deps.set(self.gasRef, d);
        }
    }
    self.gasCtx = 0;
}

extends mutates fun sendGram(self: Cold, to: Address, amount: Int, reason: Int, queryId: Int) {
    message(MessageParameters {
        to, value: amount, mode: SendPayGasSeparately, bounce: false,
        body: VaultPayout { queryId, reason, amount }.toCell(),
    });
}

extends mutates fun refundGas(self: Cold, to: Address, amount: Int, queryId: Int) {
    if (amount < ton("0.01")) {
        return;
    }
    message(MessageParameters {
        to, value: amount, mode: SendPayGasSeparately | SendIgnoreErrors, bounce: false,
        body: VaultPayout { queryId, reason: PAYOUT_GAS, amount }.toCell(),
    });
}

extends mutates fun sendUsdt(self: Cold, q: Int, amount: Int, to: Address, value: Int, fwdTon: Int, payload: Cell?, response: Address?) {
    message(MessageParameters {
        to: self.usdtWallet!!, value, mode: SendPayGasSeparately, bounce: true,
        body: JettonTransfer {
            queryId: q, amount, destination: to, responseDestination: response, customPayload: null,
            forwardTonAmount: fwdTon, forwardPayload: eitherPayload(payload),
        }.toCell(),
    });
}

extends mutates fun poolKey(self: Cold): PoolKey {
    return PoolKey { token0: GRAM, token1: self.rwUsdt!!, tickSpacing: self.spacing, ext: null };
}

extends mutates fun posAddress(self: Cold, index: Int): Address {
    return contractAddress(StateInit {
        code: self.cfgGet().positionCode!!,
        data: beginCell().storeUint(0, 1).storeAddress(self.pool!!).storeInt(index, 257).endCell(),
    });
}

extends mutates fun walletAddress(self: Cold, owner: Address): Address {
    return contractAddress(self.walletInit(owner));
}

// VaultWallet StateInit built by hand (Tact 1.6 layout: 0b0 . master . owner); initOf cannot be
// used outside the contract body.
extends mutates fun walletInit(self: Cold, owner: Address): StateInit {
    return StateInit {
        code: self.cfgGet().walletCode,
        data: beginCell().storeUint(0, 1).storeAddress(myAddress()).storeAddress(owner).endCell(),
    };
}

extends mutates fun cfgGet(self: Cold): Cfg {
    return Cfg.fromCell(self.cfgCell);
}

extends mutates fun requireAdmin(self: Cold) {
    require(sender() == self.cfgGet().admin, "Not admin");
}

extends mutates fun adminDone(self: Cold, queryId: Int) {
    message(MessageParameters {
        to: sender(), value: 0, mode: SendRemainingValue | SendIgnoreErrors, bounce: false,
        body: JettonExcesses { queryId }.toCell(),
    });
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

extends mutates fun g_get_vault_data(self: Cold): VaultData {
    let cfg = self.cfgGet();
    let n = 0;
    foreach (q, o in self.ops) {
        n += 1;
    }
    let nd = 0;
    foreach (r, d in self.deps) {
        nd += 1;
    }
    return VaultData {
        phase: self.phase, admin: cfg.admin, pendingAdmin: cfg.pendingAdmin, keeper: cfg.keeper,
        treasury: cfg.treasury, router: cfg.router, pool: self.pool, usdtWallet: self.usdtWallet,
        rwUsdt: self.rwUsdt, supply: self.supply, idle0: self.idle0, idle1: self.idle1, exp0: self.exp0,
        exp1: self.exp1, owe0: self.owe0, owe1: self.owe1, fee0: self.fee0, fee1: self.fee1, heldGas: self.heldGas(),
        pendGram: self.pendG, pendUsdt: self.pendU,
        depositsPaused: self.depositsPaused, strategy: self.strategy, lastRebalance: self.lastRebalance,
        queueLength: self.qTail - self.qHead, workerActive: self.worker != null,
        rebStep: self.reb == null ? 0 : self.reb!!.step, opCount: n, depCount: nd, epoch: self.epoch,
        due0: self.due0, due1: self.due1, opGas: self.opGas,
    };
}

extends mutates fun g_get_nav(self: Cold): NavView {
    let ov = self.oracleView();
    let t = ov.ready ? ov.twapTick : ov.spotTick;
    let sT = sqrtAt(t);
    let bps = self.strategy.perfFeeBps;
    let tot0 = self.idle0 + self.exp0 - self.owe0 - self.due0;
    let tot1 = self.idle1 + self.exp1 - self.owe1 - self.due1;
    foreach (slot, pos in self.positions) {
        let l = pos.L - pos.reserved;
        if (l > 0) {
            let am = amountsForLiquidity(t, sT, pos.tL, pos.tU, l, false);
            tot0 += am.a;
            tot1 += am.b;
        }
        tot0 += pos.uf0 - pos.uf0 * bps / BPS;
        tot1 += pos.uf1 - pos.uf1 * bps / BPS;
    }
    return NavView { ok: ov.ready, nav: self.navAt(t, sT), supply: self.supply, twapTick: t, total0: tot0, total1: tot1 };
}

contract Vault {
    // Hot state: what the pre-accept checks of DEX replies touch.
    pool: Address;                  // = myAddress() until setup
    wallet: Address;                // our USDT wallet; = myAddress() until setup
    router: Address;
    posKeys: map<Int as uint256, Bool>;     // hashes of our Position NFTs' addresses
    cold: Cell;

    init(admin: Address, router: Address, usdtMaster: Address, poolCodeHash: Int, positionCodeHash: Int,
         spacing: Int, salt: Int) {
        self.pool = myAddress();
        self.wallet = myAddress();
        self.router = router;
        self.posKeys = emptyMap();
        self.cold = Cold {
            cfgCell: Cfg {
                walletCode: initOf VaultWallet(myAddress(), myAddress()).code, admin, router, usdtMaster,
                poolCodeHash, positionCodeHash, salt, pendingAdmin: null, keeper: null, treasury: admin,
                poolCode: null, positionCode: null, content: emptyCell(),
            }.toCell(),
            gasCtx: 0,
            gasRef: 0,
            spacing,
            depositsPaused: false,
            strategy: defaultStrategy(spacing),
            phase: PHASE_SETUP,
            pool: null,
            usdtWallet: null,
            rwUsdt: null,
            supply: 0,
            idle0: 0,
            idle1: 0,
            exp0: 0,
            exp1: 0,
            owe0: 0,
            owe1: 0,
            fee0: 0,
            fee1: 0,
            pendG: 0,
            pendU: 0,
            positions: emptyMap(),
            fgs: emptyMap(),
            ops: emptyMap(),
            seq: 0,
            rnd: 0,
            spotRound: 0,
            epoch: 0,
            orc: Oracle { spotTick: 0, spotSqrtP: 0, spotTs: 0, spotCum: 0, c0: 0, t0: 0, c1: 0, t1: 0, c2: 0, t2: 0 },
            reb: null,
            deps: emptyMap(),
            openSqrt: 0,
            openReceiver: null,
            queue: emptyMap(),
            qHead: 0,
            qTail: 0,
            queueGas: 0,
            worker: null,
            wdl: emptyMap(),
            lastRebalance: 0,
            baseCenter: 0,
            due0: 0,
            due1: 0,
            opGas: 0,
            wtry: emptyMap(),
        }.toCell();
    }

    receive(msg: VaultSetup) {
        let c = Cold.fromCell(self.cold);
        c.rVaultSetup(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: TakeWalletAddress) {
        let c = Cold.fromCell(self.cold);
        c.rTakeWalletAddress(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    // DEX -> vault. The pool (or our wallet) is checked on the hot fields before anything is
    // parsed; gas is then accepted, so an op result can never be lost to an out-of-gas handler.
    receive(msg: PoolObservation) {
        require(sender() == self.pool, "Not pool");
        acceptMessage();
        let c = Cold.fromCell(self.cold);
        c.rPoolObservation(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: MintReceipt) {
        require(sender() == self.pool, "Not pool");
        acceptMessage();
        let c = Cold.fromCell(self.cold);
        c.rMintReceipt(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: GramPayout) {
        if (sender() != self.pool) {
            return;         // not from our pool: keep the value, credit nothing
        }
        acceptMessage();
        let c = Cold.fromCell(self.cold);
        c.rGramPayout(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    // Position -> vault. Authenticated against the op's Position (cached NFT address) before gas
    // is accepted.
    // Position -> vault: only our NFTs pass the hot check (then gas is accepted, so a result is
    // never lost); the op and its Position are authenticated again in the cold path.
    receive(msg: BurnReceipt) {
        if (self.posKeys.get(parseStdAddress(sender().asSlice()).address) == null) {
            return;
        }
        acceptMessage();
        let c = Cold.fromCell(self.cold);
        if (c.rBurnReceiptIn(msg)) {
            c.chargeGas();
            self.syncPosKeys(c.positions);
            self.cold = c.toCell();
        }
    }

    receive(msg: JettonNotification) {
        if (sender() != self.wallet || self.wallet == myAddress()) {
            return;         // not our wallet: no USDT arrived, nothing to refund
        }
        // DEX payouts always; deposits (or refundable transfers) when they pay for themselves.
        if (msg.sender == self.router || context().value >= REFUND_MIN) {
            acceptMessage();
        }
        let c = Cold.fromCell(self.cold);
        c.rJettonNotification(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: JettonExcesses) {
        let c = Cold.fromCell(self.cold);
        c.rJettonExcesses(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: DepositNative) {
        let c = Cold.fromCell(self.cold);
        c.rDepositNative(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: JettonBurnNotification) {
        let c = Cold.fromCell(self.cold);
        c.rJettonBurnNotification(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: Rebalance) {
        let c = Cold.fromCell(self.cold);
        c.rRebalance(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: Poke) {
        let c = Cold.fromCell(self.cold);
        c.rPoke(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: Recover) {
        let c = Cold.fromCell(self.cold);
        c.rRecover(msg);
        c.chargeGas();
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: AbortRebalance) {
        let c = Cold.fromCell(self.cold);
        c.rAbortRebalance(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: CollectFees) {
        let c = Cold.fromCell(self.cold);
        c.rCollectFees(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: SetPerfFee) {
        let c = Cold.fromCell(self.cold);
        c.rSetPerfFee(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: SetKeeper) {
        let c = Cold.fromCell(self.cold);
        c.rSetKeeper(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: SetTreasury) {
        let c = Cold.fromCell(self.cold);
        c.rSetTreasury(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: SetDepositsPaused) {
        let c = Cold.fromCell(self.cold);
        c.rSetDepositsPaused(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: SetStrategy) {
        let c = Cold.fromCell(self.cold);
        c.rSetStrategy(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: VaultTransferAdmin) {
        let c = Cold.fromCell(self.cold);
        c.rVaultTransferAdmin(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: VaultClaimAdmin) {
        let c = Cold.fromCell(self.cold);
        c.rVaultClaimAdmin(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive(msg: ProvideWalletAddress) {
        let c = Cold.fromCell(self.cold);
        c.rProvideWalletAddress(msg);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    receive() {}

    fun syncPosKeys(positions: map<Int as uint8, Pos>) {
        let m: map<Int as uint256, Bool> = emptyMap();
        foreach (slot, p in positions) {
            m.set(parseStdAddress(p.addr.asSlice()).address, true);
        }
        self.posKeys = m;
    }

    bounced(msg: bounced<JettonTransfer>) {
        let c = Cold.fromCell(self.cold);
        c.bJettonTransfer(msg.queryId, msg.amount);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    bounced(msg: bounced<MintNativeNotify>) {
        let c = Cold.fromCell(self.cold);
        c.bMintNativeNotify(msg.queryId);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    bounced(msg: bounced<PositionDecreaseNotify>) {
        let c = Cold.fromCell(self.cold);
        c.bPositionDecreaseNotify(msg.queryId);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    bounced(msg: bounced<PoolObserve>) {
        let c = Cold.fromCell(self.cold);
        c.bPoolObserve(msg.queryId);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    bounced(msg: bounced<JettonTransferInternal>) {
        let c = Cold.fromCell(self.cold);
        c.bJettonTransferInternal(msg.amount);
        c.chargeGas();
        if (c.pool != null) {
            self.pool = c.pool!!;
        }
        if (c.usdtWallet != null) {
            self.wallet = c.usdtWallet!!;
        }
        self.syncPosKeys(c.positions);
        self.cold = c.toCell();
    }

    bounced(msg: Slice) {}

    get fun get_vault_data(): VaultData {
        return Cold.fromCell(self.cold).g_get_vault_data();
    }

    get fun get_pool_key(): PoolKey {
        return Cold.fromCell(self.cold).poolKey();
    }

    get fun get_positions(): map<Int as uint8, Pos> {
        return Cold.fromCell(self.cold).positions;
    }

    get fun get_checkpoints(): map<Int as uint8, Fg> {
        return Cold.fromCell(self.cold).fgs;
    }

    get fun get_ops(): map<Int as uint64, Op> {
        return Cold.fromCell(self.cold).ops;
    }

    get fun get_deposits(): map<Int as uint32, Dep> {
        return Cold.fromCell(self.cold).deps;
    }

    get fun get_oracle(): OracleView {
        return Cold.fromCell(self.cold).oracleView();
    }

    get fun get_oracle_state(): Oracle {
        return Cold.fromCell(self.cold).orc;
    }

    get fun get_nav(): NavView {
        return Cold.fromCell(self.cold).g_get_nav();
    }

    // Estimate at the last observation (the real quote uses the deposit's own fresh observation).
    get fun get_preview_deposit(amount0: Int, amount1: Int): Int {
        let c = Cold.fromCell(self.cold);
        let ov = c.oracleView();
        if (!ov.ready || abs(ov.spotTick - ov.twapTick) > c.strategy.maxDeviation || c.supply == 0) {
            return 0;
        }
        return c.quoteShares(amount0, amount1, ov);
    }

    get fun get_position_address(index: Int): Address {
        return Cold.fromCell(self.cold).posAddress(index);
    }

    get fun get_withdraw_gas(): Int {
        return WITHDRAW_GAS;
    }

    get fun get_deposit_gas(): Int {
        return DEPOSIT_GAS;
    }

    get fun get_queue(): map<Int as uint32, WReq> {
        return Cold.fromCell(self.cold).queue;
    }

    get fun get_worker(): Worker? {
        return Cold.fromCell(self.cold).worker;
    }

    get fun get_jetton_data(): JettonData {
        let cfg = Cold.fromCell(self.cold).cfgGet();
        return JettonData {
            totalSupply: Cold.fromCell(self.cold).supply,
            mintable: true,
            adminAddress: null,
            jettonContent: cfg.content,
            jettonWalletCode: cfg.walletCode,
        };
    }

    get fun get_wallet_address(owner: Address): Address {
        return Cold.fromCell(self.cold).walletAddress(owner);
    }
}

// =======================================================================
// Share wallet: the launchpad's LaunchWallet (launch/contracts/jetton.tact), TEP-74 with burn.
// Change: a bounced burn (the vault refused the withdrawal) also returns the Gram to the owner.
// =======================================================================

const WALLET_MIN_STORAGE: Int = ton("0.01");
const WALLET_GAS: Int = ton("0.015");

contract VaultWallet {
    master: Address;
    owner: Address;
    balance: Int as coins;

    init(master: Address, owner: Address) {
        self.master = master;
        self.owner = owner;
        self.balance = 0;
    }

    receive(msg: JettonTransfer) {
        let ctx = context();
        require(ctx.sender == self.owner, "Not owner");
        require(msg.amount > 0, "Invalid amount");
        require(self.balance >= msg.amount, "Insufficient balance");
        require(parseStdAddress(msg.destination.asSlice()).workchain == 0, "Wrong workchain");
        let fwdCount = msg.forwardTonAmount > 0 ? 2 : 1;
        require(ctx.value > msg.forwardTonAmount + fwdCount * ctx.readForwardFee() + 2 * WALLET_GAS + WALLET_MIN_STORAGE,
            "Insufficient TON attached");

        self.balance -= msg.amount;
        deploy(DeployParameters {
            init: initOf VaultWallet(self.master, msg.destination),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: JettonTransferInternal {
                queryId: msg.queryId,
                amount: msg.amount,
                sender: self.owner,
                responseDestination: msg.responseDestination,
                forwardTonAmount: msg.forwardTonAmount,
                forwardPayload: msg.forwardPayload,
            }.toCell(),
        });
    }

    receive(msg: JettonTransferInternal) {
        let ctx = context();
        if (ctx.sender != self.master) {
            let peer = contractAddress(initOf VaultWallet(self.master, msg.sender));
            require(ctx.sender == peer, "Invalid sender");
        }
        self.balance += msg.amount;

        let before = myBalance() - ctx.value;
        nativeReserve(max(before, WALLET_MIN_STORAGE), ReserveAtMost);

        if (msg.forwardTonAmount > 0) {
            message(MessageParameters {
                to: self.owner,
                value: msg.forwardTonAmount,
                mode: SendPayGasSeparately,
                bounce: false,
                body: JettonNotification {
                    queryId: msg.queryId,
                    amount: msg.amount,
                    sender: msg.sender,
                    forwardPayload: msg.forwardPayload,
                }.toCell(),
            });
        }
        if (msg.responseDestination != null) {
            message(MessageParameters {
                to: msg.responseDestination!!,
                value: 0,
                mode: SendRemainingBalance | SendIgnoreErrors,
                bounce: false,
                body: JettonExcesses { queryId: msg.queryId }.toCell(),
            });
        }
    }

    receive(msg: JettonBurn) {
        let ctx = context();
        require(ctx.sender == self.owner, "Not owner");
        require(msg.amount > 0, "Invalid amount");
        require(self.balance >= msg.amount, "Insufficient balance");
        require(ctx.value > ctx.readForwardFee() * 2 + 2 * WALLET_GAS, "Insufficient TON attached");

        self.balance -= msg.amount;
        message(MessageParameters {
            to: self.master,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: JettonBurnNotification {
                queryId: msg.queryId,
                amount: msg.amount,
                sender: self.owner,
                responseDestination: msg.responseDestination,
            }.toCell(),
        });
    }

    bounced(msg: bounced<JettonTransferInternal>) {
        self.balance += msg.amount;
    }

    // The vault refused the withdrawal: restore the shares and return the attached Gram.
    bounced(msg: bounced<JettonBurnNotification>) {
        self.balance += msg.amount;
        nativeReserve(WALLET_MIN_STORAGE, ReserveAtMost);
        message(MessageParameters {
            to: self.owner,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: JettonExcesses { queryId: msg.queryId }.toCell(),
        });
    }

    receive() {}

    get fun get_wallet_data(): JettonWalletData {
        return JettonWalletData {
            balance: self.balance,
            owner: self.owner,
            master: self.master,
            code: initOf VaultWallet(self.master, self.owner).code,
        };
    }
}
