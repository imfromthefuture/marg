import "./messages";
import "./dex_shared";
import "./vault";

// Fixed-supply launch jetton (TEP-74 / TEP-89, TEP-64 content cell). One master per launch,
// deployed by the LaunchFactory. Exactly one mint: LaunchSetup mints the whole 1B supply straight
// into the DEX Router's wallet with a LaunchPayload, so the Router sees `sender = this master`
// (the pool key's initializer). After that minting is closed forever and there is no admin.
//
// Tax tokens: the DEX key's taxRecipient is this master. Every tax payout (GramPayout reason TAX)
// is split here by the immutable rewardsBps / walletBps / buybackBps of the launch:
//   - holder rewards: a dividend-per-share accumulator over the balances that the wallets report
//     (RewardCheckpoint on every balance change); holders claim through their own wallet;
//   - the tax wallet: paid in the same transaction;
//   - buyback and burn: a Gram bucket; a capped, rate-limited swap on the token's own pool whose
//     jettons come back to this master's wallet and are burned (totalSupply goes down).
// Nobody (no admin, not the creator) can redirect any of it.

const TOTAL_SUPPLY: Int = 1000000000000000000;      // 1,000,000,000 tokens, 9 decimals
const MASTER_MIN_STORAGE: Int = ton("0.05");
const LAUNCH_DEADLINE: Int = 600;                   // seconds the launch transfer may take to reach the pool
const WALLET_MIN_STORAGE: Int = ton("0.01");
const WALLET_GAS: Int = ton("0.015");
const BPS_100: Int = 10000;

// --- creator vault ---
const VAULT_DEPLOY_VALUE: Int = ton("0.05");        // the vault's storage reserve (kept there)
const VAULT_WALLET_VALUE: Int = ton("0.03");        // the vault's jetton wallet: compute + storage reserve (kept there)

// --- holder rewards ---
const REWARD_SCALE: Int = 1000000000000000000;      // 1e18: acc is nanoGram per share * 1e18
const CHECKPOINT_VALUE: Int = ton("0.03");          // wallet -> master -> wallet: 38.9k gas + 2 fwd = 0.017 at 400 nanoGram/gas, x1.75
const CLAIM_VALUE: Int = ton("0.04");               // minimum ClaimRewards value: 53k gas + ack + fwd = 0.027 at 400/gas, x1.5 (the rest comes back)
const ACK_VALUE: Int = ton("0.006");                // claim ack to the wallet: 5.9k gas = 0.0024 at 400/gas (+fwd), x2

// --- tax split and buyback ---
const TAX_IN_GAS: Int = ton("0.04");                // kept from a tax payout's value: split + auto-buyback 58k gas = 0.023 at 400/gas, x1.5 + fwd
const RETURN_FEE: Int = ton("0.018");               // kept from each Gram return (excess, burn receipt): <= 30k gas = 0.012 at 400/gas, x1.5
// Gram attached to the buyback swap on top of the amount (most returns). It must cover the Router's
// SwapNative minimum for BUYBACK_CROSSINGS with allowPartial on this (launch, maybe taxed) key
// (dex/v2 router.tact swapGas / get_swap_gas):
//   SWAP_BASE_GAS 0.35 + 24 * CROSS_GAS 0.006 + JETTON_PAYOUT_VALUE 0.07
//   + PAYOUT_MSG_GAS 0.01 (platform fee payout, launch key) + PAYOUT_MSG_GAS 0.01 + TAX_PAYOUT_GAS 0.04 (tax auto-payout)
//   + fwdTon BURN_FWD 0.08 = 0.704,
// plus 2 forward fees (~0.01): 0.85 leaves ~0.146 (~0.136 after forward fees). launch/tests check it against the Router.
const BUYBACK_GAS: Int = ton("0.85");
const BURN_FWD: Int = ton("0.08");                  // forward_ton of the bought jettons: pays the master (32k gas) and the burn
const BUYBACK_MIN: Int = ton("1");                  // smallest buyback (or the cap, if lower)
const BUYBACK_INTERVAL: Int = 300;                  // seconds between buybacks
// = DEX MAX_CROSSINGS_CAP, with allowPartial: dust LP positions above the price cannot block the
// buyback (it swaps what 24 crossings allow and the rest comes back to the bucket as a partial refund).
const BUYBACK_CROSSINGS: Int = 24;
const HARVEST_VALUE: Int = ton("0.21");             // Router CollectTax needs COLLECT_GAS = 0.2 (the leftover comes back)
const HARVEST_INTERVAL: Int = 3600;                 // seconds between bucket-paid harvests (bounds the drain when no tax comes)
const HARVEST_CALLER_INTERVAL: Int = 60;            // seconds between caller-paid harvests (the caller attaches HARVEST_VALUE + KEEPER_FEE)
const KEEPER_FEE: Int = ton("0.03");                // taken from the bucket per Harvest / Buyback call: <= 47k gas = 0.019 at 400/gas, x1.5
const BB_TAG: Int = 0x4d4cbbbb;                     // high 32 bits of the queryId of the master's own DEX requests
const DEX_REASON_SWAP_REFUND: Int = 2;
const DEX_REASON_PARTIAL_REFUND: Int = 10;
const DEX_REASON_TAX: Int = 14;

struct RewardsAcc {
    totalShares: Int as coins;
    acc: Int as uint256;
    rem: Int as uint64;             // scaled remainder of the last accrual (< totalShares at that time)
    accrued: Int as coins;
    claimed: Int as coins;
    carry: Int as coins;
}

struct BuybackAcc {
    bal: Int as coins;
    spent: Int as coins;
    burned: Int as coins;
    count: Int as uint32;
    last: Int as uint32;
    harvestLast: Int as uint32;
    inTotal: Int as coins;          // Gram that entered the bucket from the tax split
}

struct TaxAcc {
    taxIn: Int as coins;
    walletPaid: Int as coins;
}

contract LaunchJetton {
    factory: Address;
    index: Int as uint64;
    launched: Bool;                 // LaunchSetup ran: the supply is minted, minting is closed
    content: Cell;
    totalSupply: Int as coins;
    info: LaunchInfo;
    rw: RewardsAcc;
    bb: BuybackAcc;
    tax: TaxAcc;

    init(factory: Address, index: Int) {
        self.factory = factory;
        self.index = index;
        self.launched = false;
        self.content = emptyCell();
        self.totalSupply = 0;
        self.info = LaunchInfo {
            creator: factory, router: factory, feeClaimer: factory, tickSpacing: 0, launchFeePips: 0,
            launchDuration: 0, sqrtPriceX96: 0, taxRecipient: null, buyTaxBps: 0, sellTaxBps: 0,
            taxWallet: null, rewardsBps: 0, walletBps: 0, buybackBps: 0, buybackCap: 0, createdAt: 0,
            vaultBps: 0, vaultLock: 0, vaultVest: 0,
        };
        self.rw = RewardsAcc { totalShares: 0, acc: 0, rem: 0, accrued: 0, claimed: 0, carry: 0 };
        self.bb = BuybackAcc { bal: 0, spent: 0, burned: 0, count: 0, last: 0, harvestLast: 0, inTotal: 0 };
        self.tax = TaxAcc { taxIn: 0, walletPaid: 0 };
    }

    // The one and only mint. It goes to the Router's wallet with the launch payload; the Router
    // creates the canonical pool (initializer = this master) and the pool runs the dev buy in the
    // same transaction as its initialization.
    receive(msg: LaunchSetup) {
        require(sender() == self.factory, "Not factory");
        require(!self.launched, "Already launched");
        self.launched = true;
        self.content = msg.content;
        self.info = msg.info;
        self.totalSupply = TOTAL_SUPPLY;
        let i = msg.info;
        let payload = LaunchPayload {
            sqrtPriceX96: i.sqrtPriceX96,
            tickSpacing: i.tickSpacing,
            launchFeePips: i.launchFeePips,
            launchDuration: i.launchDuration,
            deadline: now() + LAUNCH_DEADLINE,
            feeClaimer: i.feeClaimer,
            // Refunds come back here: a failed launch leaves the supply in this master's own
            // wallet (no code can move it: effectively burned) and the Gram is forwarded to the
            // creator by the fallback receivers below.
            refundTo: myAddress(),
            taxRecipient: i.taxRecipient,
            buyTaxBps: i.buyTaxBps,
            sellTaxBps: i.sellTaxBps,
            devBuy: msg.devBuy,
            minDevOut: msg.minDevOut,
            devReceiver: i.creator,
        };
        // Creator vault: its share goes to the vault's own (untracked) wallet; the pool gets the rest at the
        // same start price (only its depth shrinks). 1e18 is a multiple of 10000: the two parts sum exactly.
        let vaultAmount = TOTAL_SUPPLY * i.vaultBps / BPS_100;
        if (vaultAmount > 0) {
            let vault = self.vaultAddress();
            let vaultWallet = initOf LaunchWallet(myAddress(), vault, self.rewardsRouter(), self.untrackedVault());
            deploy(DeployParameters {
                init: initOf LaunchVault(myAddress()),
                value: VAULT_DEPLOY_VALUE,
                mode: SendPayGasSeparately,
                bounce: true,
                body: VaultSetup {
                    queryId: msg.queryId,
                    beneficiary: i.creator,
                    wallet: contractAddress(vaultWallet),
                    total: vaultAmount,
                    start: now(),
                    lock: i.vaultLock,
                    vest: i.vaultVest,
                }.toCell(),
            });
            deploy(DeployParameters {
                init: vaultWallet,
                value: VAULT_WALLET_VALUE,
                mode: SendPayGasSeparately,
                bounce: true,
                body: JettonTransferInternal {
                    queryId: msg.queryId,
                    amount: vaultAmount,
                    sender: myAddress(),
                    responseDestination: null,
                    forwardTonAmount: 0,
                    forwardPayload: beginCell().storeBool(false).asSlice(),
                }.toCell(),
            });
        }
        nativeReserve(MASTER_MIN_STORAGE, ReserveAtMost);
        deploy(DeployParameters {
            init: initOf LaunchWallet(myAddress(), i.router, self.rewardsRouter(), self.untrackedVault()),
            value: 0,
            mode: SendRemainingBalance,
            bounce: true,
            body: JettonTransferInternal {
                queryId: msg.queryId,
                amount: TOTAL_SUPPLY - vaultAmount,
                sender: myAddress(),
                responseDestination: i.creator,
                forwardTonAmount: msg.routerValue,
                forwardPayload: beginCell().storeBool(true).storeRef(payload.toCell()).asSlice(),
            }.toCell(),
        });
    }

    receive(msg: JettonBurnNotification) {
        require(sender() == self.walletOf(msg.sender), "Invalid wallet");
        self.totalSupply -= msg.amount;
        if (msg.sender == myAddress()) {
            // Buyback burn (this master's own wallet). Its leftover gas goes back to the bucket.
            self.bb.burned += msg.amount;
            emit(BurnEvent { amount: msg.amount, totalSupply: self.totalSupply }.toCell());
            self.credit(context().value);
            return;
        }
        if (msg.responseDestination != null) {
            nativeReserve(MASTER_MIN_STORAGE + self.held(), ReserveAtMost);
            message(MessageParameters {
                to: msg.responseDestination!!,
                value: 0,
                mode: SendRemainingBalance | SendIgnoreErrors,
                bounce: false,
                body: JettonExcesses { queryId: msg.queryId }.toCell(),
            });
        }
    }

    // TEP-89 wallet discovery.
    receive(msg: ProvideWalletAddress) {
        require(context().value >= ton("0.0061"), "Insufficient TON attached");
        let ownerCell: Cell? = msg.includeAddress ? beginCell().storeAddress(msg.ownerAddress).endCell() : null;
        let walletAddress = parseStdAddress(msg.ownerAddress.asSlice()).workchain == 0
            ? self.walletOf(msg.ownerAddress)
            : newAddress(0, 0);
        message(MessageParameters {
            to: sender(),
            value: 0,
            mode: SendRemainingValue,
            bounce: false,
            body: TakeWalletAddress { queryId: msg.queryId, walletAddress, ownerAddress: ownerCell }.toCell(),
        });
    }

    // The launch mint bounced (it cannot in practice): no supply exists, minting stays closed.
    bounced(msg: bounced<JettonTransferInternal>) {
        self.totalSupply -= msg.amount;
        self.forwardToCreator();
    }

    // A bounced DEX request of the buyback (SwapNative, CollectTax) or a bounced burn: the Gram
    // goes back to the bucket (a bounced swap is also no longer "spent").
    bounced(msg: Slice) {
        if (!self.buybackOn()) {
            self.forwardToCreator();
            return;
        }
        if (msg.bits() >= 32 + 64 + 4) {
            let op = msg.loadUint(32);
            msg.loadUint(64);
            if (op == 0x4d480011) {
                let amt = msg.loadCoins();
                self.bb.spent -= min(amt, self.bb.spent);
            }
        }
        self.credit(context().value);
    }

    // -----------------------------------------------------------------------
    // Tax payouts and Gram returns
    // -----------------------------------------------------------------------

    receive(msg: GramPayout) {
        let ctx = context();
        if (msg.reason == DEX_REASON_TAX && self.taxed()) {
            self.taxIn(ctx.value, msg.amount);
            return;
        }
        if (self.ownQuery(msg.queryId)) {
            // A refunded buyback (slippage, deadline, ...): its Gram returns to the bucket.
            if (msg.reason == DEX_REASON_SWAP_REFUND || msg.reason == DEX_REASON_PARTIAL_REFUND) {
                self.bb.spent -= min(msg.amount, self.bb.spent);
            }
            self.credit(ctx.value);
            return;
        }
        self.forwardToCreator();
    }

    // Excess of the master's own DEX requests (buyback swap chain, harvest with no tax) returns to
    // the bucket. Any other excess (the launch chain) goes to the creator, as before.
    receive(msg: JettonExcesses) {
        if (self.ownQuery(msg.queryId)) {
            self.credit(context().value);
            return;
        }
        self.forwardToCreator();
    }

    // Jettons arriving in this master's own wallet with a notification (the buyback output, or
    // anyone sending tokens here with forward_ton): burned at once when buyback is on.
    receive(msg: JettonNotification) {
        if (!self.buybackOn() || sender() != self.walletOf(myAddress())) {
            self.forwardToCreator();
            return;
        }
        message(MessageParameters {
            to: sender(),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: JettonBurn { queryId: msg.queryId, amount: msg.amount, responseDestination: null, customPayload: null }.toCell(),
        });
    }

    // Anyone (a keeper bot): ask the Router to pay the pool's tax here (the DEX already pays a tax of
    // >= TAX_MIN_PAYOUT 0.1 Gram inside the swaps, so this collects what is left below it). Paid from the buyback bucket
    // at most once per HARVEST_INTERVAL (the caller's whole value is refunded); otherwise (any split,
    // buyback off included) paid by the caller, who attaches >= HARVEST_VALUE + KEEPER_FEE (the rest
    // is refunded), at most once per HARVEST_CALLER_INTERVAL. The payout runs the split and, when
    // due, the buyback. The Router's leftover follows the master's own-query path (see JettonExcesses).
    receive(msg: Harvest) {
        require(self.taxed(), "Not taxed");
        let t = now();
        let queryId = (BB_TAG << 32) + (t % 0x100000000);
        if (self.buybackOn() && t >= self.bb.harvestLast + HARVEST_INTERVAL && self.bb.bal >= HARVEST_VALUE + KEEPER_FEE) {
            self.bb.bal -= HARVEST_VALUE + KEEPER_FEE;
            self.bb.harvestLast = t;
            self.collectTax(queryId);
            self.refundCaller(msg.queryId);
            return;
        }
        let v = context().value;
        require(t >= self.bb.harvestLast + HARVEST_CALLER_INTERVAL, "Not due");
        require(v >= HARVEST_VALUE + KEEPER_FEE, "Insufficient TON attached");
        self.bb.harvestLast = t;
        self.collectTax(queryId);
        let back = v - HARVEST_VALUE - KEEPER_FEE;
        if (back > RETURN_FEE) {
            message(MessageParameters {
                to: sender(),
                value: back,
                mode: SendPayGasSeparately | SendIgnoreErrors,
                bounce: false,
                body: JettonExcesses { queryId: msg.queryId }.toCell(),
            });
        }
    }

    // Anyone: run the buyback now if it is due (the same guards as the automatic run).
    receive(msg: Buyback) {
        require(self.buybackOn() && self.bb.bal >= KEEPER_FEE, "Not due");
        self.bb.bal -= KEEPER_FEE;
        require(self.tryBuyback(), "Not due");
        self.refundCaller(msg.queryId);
    }

    // -----------------------------------------------------------------------
    // Holder rewards
    // -----------------------------------------------------------------------

    receive(msg: RewardCheckpoint) {
        require(self.rewardsOn() && sender() == self.walletOf(msg.owner), "Invalid wallet");
        self.applyDelta(msg.delta);
        message(MessageParameters {
            to: sender(),
            value: 0,
            mode: SendRemainingValue,
            bounce: false,
            body: RewardAck { queryId: msg.queryId, acc: self.rw.acc, delta: msg.delta, claim: false, frac: 0 }.toCell(),
        });
    }

    receive(msg: RewardClaim) {
        require(self.rewardsOn() && sender() == self.walletOf(msg.owner), "Invalid wallet");
        let x = msg.acked * (self.rw.acc - msg.lastAcc) + msg.frac;
        let pay = msg.owed + x / REWARD_SCALE;
        require(self.rw.claimed + pay <= self.rw.accrued, "Rewards insolvent");
        self.rw.claimed += pay;
        self.applyDelta(msg.delta);
        // The wallet gets a small ack; the owner gets the rewards plus the rest of the claim's value.
        message(MessageParameters {
            to: sender(),
            value: ACK_VALUE,
            mode: SendPayGasSeparately,
            bounce: false,
            body: RewardAck { queryId: msg.queryId, acc: self.rw.acc, delta: msg.delta, claim: true, frac: x % REWARD_SCALE }.toCell(),
        });
        nativeReserve(myBalance() - context().value - pay, ReserveAtMost);
        message(MessageParameters {
            to: msg.owner,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: "Marg holder rewards".asComment(),
        });
    }

    // Plain Gram and anything else: forwarded to the creator, keeping storage and the buckets.
    receive() {
        self.forwardToCreator();
    }

    receive(msg: Slice) {
        self.forwardToCreator();
    }

    // -----------------------------------------------------------------------

    fun taxed(): Bool {
        return self.launched && self.info.taxRecipient != null;
    }

    fun rewardsOn(): Bool {
        return self.launched && self.info.rewardsBps > 0;
    }

    fun buybackOn(): Bool {
        return self.launched && self.info.buybackBps > 0;
    }

    // Wallets track rewards only when rewardsBps > 0 (null: plain TEP-74 wallets, no checkpoints).
    fun rewardsRouter(): Address? {
        return self.info.rewardsBps > 0 ? self.info.router : null;
    }

    // The vault, when this token has one and tracks rewards: its wallet must not be tracked (null otherwise).
    fun untrackedVault(): Address? {
        return self.info.rewardsBps > 0 && self.info.vaultBps > 0 ? self.vaultAddress() : null;
    }

    fun vaultAddress(): Address {
        return contractAddress(initOf LaunchVault(myAddress()));
    }

    fun walletOf(owner: Address): Address {
        return contractAddress(initOf LaunchWallet(myAddress(), owner, self.rewardsRouter(), self.untrackedVault()));
    }

    fun ownQuery(queryId: Int): Bool {
        return self.buybackOn() && (queryId >> 32) == BB_TAG;
    }

    // Gram that belongs to holders (unclaimed rewards) and to the buyback bucket.
    fun held(): Int {
        return self.rw.accrued + self.rw.carry - self.rw.claimed + self.bb.bal;
    }

    fun credit(value: Int) {
        if (value > RETURN_FEE) {
            self.bb.bal += value - RETURN_FEE;
        }
    }

    // One tax payout. x = the tax (never more than the value that came with it, minus the split's
    // own fees). Rounding dust goes to the buyback share, else to the wallet share, else rewards.
    // Gram above the buckets (the caller's gas leftover, earlier skims) also goes to the buyback
    // bucket, else with the wallet payment, else to rewards. Then the buyback runs if it is due.
    fun taxIn(value: Int, amount: Int) {
        let i = self.info;
        let x = max(min(amount, value - TAX_IN_GAS), 0);
        let r = x * i.rewardsBps / BPS_100;
        let w = x * i.walletBps / BPS_100;
        let b = x - r - w;
        if (i.buybackBps == 0) {
            if (i.walletBps > 0) {
                w += b;
            } else {
                r += b;
            }
            b = 0;
        }
        self.tax.taxIn += x;
        self.tax.walletPaid += w;
        self.bb.bal += b;
        self.bb.inTotal += b;
        self.accrue(r);

        let extra = max(myBalance() - self.held() - w - MASTER_MIN_STORAGE - TAX_IN_GAS, 0);
        emit(TaxSplitEvent { amount: x, rewards: r, wallet: w, buyback: b, extra }.toCell());
        if (extra > 0) {
            if (i.buybackBps > 0) {
                self.bb.bal += extra;
            } else if (i.walletBps > 0) {
                w += extra;
            } else {
                self.accrue(extra);
            }
        }
        if (w > 0) {
            message(MessageParameters {
                to: i.taxWallet!!,
                value: w,
                mode: SendPayGasSeparately,
                bounce: false,
                body: "Marg tax".asComment(),
            });
        }
        self.tryBuyback();
    }

    fun accrue(r: Int) {
        if (r <= 0) {
            return;
        }
        let amt = r + self.rw.carry;
        if (self.rw.totalShares == 0) {
            self.rw.carry = amt;
            return;
        }
        self.rw.carry = 0;
        let num = amt * REWARD_SCALE + self.rw.rem;
        self.rw.acc += num / self.rw.totalShares;
        self.rw.rem = num % self.rw.totalShares;
        self.rw.accrued += amt;
    }

    fun applyDelta(delta: Int) {
        let t = self.rw.totalShares + delta;
        require(t >= 0, "Negative shares");
        self.rw.totalShares = t;
    }

    // Gram the next buyback would swap (0 = not enough in the bucket).
    fun nextBuyback(): Int {
        let cap = self.info.buybackCap;
        let amt = min(self.bb.bal - BUYBACK_GAS, cap);
        return amt > 0 && amt >= min(BUYBACK_MIN, cap) ? amt : 0;
    }

    fun buybackDue(): Bool {
        return self.buybackOn() && !self.antiSnipeActive() &&
            (self.bb.count == 0 || now() >= self.bb.last + BUYBACK_INTERVAL) && self.nextBuyback() > 0;
    }

    // While the pool's LAUNCH_DECAY fee (up to 90%) is in force a buyback would mostly pay that fee:
    // no buyback runs before createdAt + launchDuration (the bucket keeps filling meanwhile).
    fun antiSnipeActive(): Bool {
        return self.info.launchFeePips > 0 && now() < self.info.createdAt + self.info.launchDuration;
    }

    // Price guard hook. Today: 0 (the guards are the cap of 1% of the start market cap, which is
    // a lower bound of the market cap, and the interval). When the DEX PoolObserve read is live,
    // this becomes a TWAP-based minimum (see README "Buyback and burn").
    fun buybackMinOut(amount: Int): Int {
        return 0;
    }

    fun tryBuyback(): Bool {
        if (!self.buybackDue()) {
            return false;
        }
        let amt = self.nextBuyback();
        self.bb.bal -= amt + BUYBACK_GAS;
        self.bb.spent += amt;
        self.bb.count += 1;
        self.bb.last = now();
        let key = self.poolKey();
        let queryId = (BB_TAG << 32) + self.bb.count;
        message(MessageParameters {
            to: self.info.router,
            value: amt + BUYBACK_GAS,
            mode: SendDefaultMode,
            bounce: true,
            body: SwapNative {
                queryId,
                amount: amt,
                otherToken: key.token1,
                tickSpacing: key.tickSpacing,
                ext: key.ext,
                minOut: self.buybackMinOut(amt),
                sqrtPriceLimitX96: 0,
                maxCrossings: BUYBACK_CROSSINGS,
                allowPartial: true,
                deadline: now() + LAUNCH_DEADLINE,
                receiver: myAddress(),
                refundTo: myAddress(),
                referral: null,
                refBps: 0,
                fwdTon: BURN_FWD,
                fwdPayload: null,
            }.toCell(),
        });
        emit(BuybackEvent { queryId, amount: amt }.toCell());
        return true;
    }

    fun collectTax(queryId: Int) {
        message(MessageParameters {
            to: self.info.router,
            value: HARVEST_VALUE,
            mode: SendDefaultMode,
            bounce: true,
            body: CollectTax { queryId, key: self.poolKey() }.toCell(),
        });
    }

    // Returns the caller's whole value; the fees come from the KEEPER_FEE the bucket paid.
    fun refundCaller(queryId: Int) {
        let v = context().value;
        if (v > 0) {
            message(MessageParameters {
                to: sender(),
                value: v,
                mode: SendPayGasSeparately | SendIgnoreErrors,
                bounce: false,
                body: JettonExcesses { queryId }.toCell(),
            });
        }
    }

    fun forwardToCreator() {
        if (!self.launched) {
            return;
        }
        nativeReserve(MASTER_MIN_STORAGE + self.held(), ReserveAtMost);
        message(MessageParameters {
            to: self.info.creator,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: JettonExcesses { queryId: 0 }.toCell(),
        });
    }

    fun poolKey(): PoolKey {
        let i = self.info;
        return PoolKey {
            token0: newAddress(0, 0),
            token1: self.walletOf(i.router),
            tickSpacing: i.tickSpacing,
            ext: KeyExt {
                hook: null, hookFlags: 0, hookShareBps: 0, hookFeeMin: 0, hookFeeMax: 0,
                initializer: myAddress(), launchFeePips: i.launchFeePips, launchDuration: i.launchDuration, minLockSecs: 0,
                taxRecipient: i.taxRecipient, buyTaxBps: i.buyTaxBps, sellTaxBps: i.sellTaxBps,
            }.toCell(),
        };
    }

    // -----------------------------------------------------------------------

    get fun get_jetton_data(): JettonData {
        return JettonData {
            totalSupply: self.totalSupply,
            mintable: false,
            adminAddress: null,
            jettonContent: self.content,
            jettonWalletCode: initOf LaunchWallet(myAddress(), myAddress(), null, null).code,
        };
    }

    get fun get_wallet_address(owner: Address): Address {
        return self.walletOf(owner);
    }

    get fun get_launch_info(): LaunchInfo {
        return self.info;
    }

    // The creator vault (LaunchVault(master)), or null when this token has none.
    get fun get_vault_address(): Address? {
        if (!self.launched || self.info.vaultBps == 0) {
            return null;
        }
        return self.vaultAddress();
    }

    get fun get_index(): Int {
        return self.index;
    }

    get fun get_launched(): Bool {
        return self.launched;
    }

    // The Router's wallet of this jetton = the token id on the DEX.
    get fun get_router_wallet(): Address {
        return self.walletOf(self.info.router);
    }

    // The canonical DEX v2 pool key. Pool address: Router.get_pool_address(GRAM, token1, tickSpacing, ext).
    get fun get_pool_key(): PoolKey {
        return self.poolKey();
    }

    get fun get_rewards_data(): RewardsData {
        return RewardsData {
            scale: REWARD_SCALE,
            acc: self.rw.acc,
            totalShares: self.rw.totalShares,
            accrued: self.rw.accrued,
            claimed: self.rw.claimed,
            carry: self.rw.carry,
        };
    }

    // Pending rewards of a wallet from its get_reward_state() (one call each; no message needed).
    get fun get_pending_rewards(acked: Int, lastAcc: Int, frac: Int, owed: Int): Int {
        return owed + (acked * (self.rw.acc - lastAcc) + frac) / REWARD_SCALE;
    }

    // Minimum value of a caller-paid Harvest (the rest is refunded).
    get fun get_harvest_value(): Int {
        return HARVEST_VALUE + KEEPER_FEE;
    }

    get fun get_buyback_status(): BuybackStatus {
        let next = self.bb.count == 0 ? 0 : self.bb.last + BUYBACK_INTERVAL;
        let nextHarvest = self.bb.harvestLast + HARVEST_INTERVAL;
        return BuybackStatus {
            balance: self.bb.bal,
            nextAllowedAt: next,
            nextAmount: self.buybackOn() ? self.nextBuyback() : 0,
            wouldRun: self.buybackDue() && self.bb.bal - KEEPER_FEE - BUYBACK_GAS >= min(BUYBACK_MIN, self.info.buybackCap),
            harvestDue: self.buybackOn() && now() >= nextHarvest && self.bb.bal >= HARVEST_VALUE + KEEPER_FEE,
            nextHarvestAt: nextHarvest,
            nextCallerHarvestAt: self.bb.harvestLast + HARVEST_CALLER_INTERVAL,
            cap: self.info.buybackCap,
            spent: self.bb.spent,
            burned: self.bb.burned,
            count: self.bb.count,
        };
    }

    get fun get_tax_data(): TaxData {
        return TaxData {
            taxIn: self.tax.taxIn,
            rewardsBps: self.info.rewardsBps,
            walletBps: self.info.walletBps,
            buybackBps: self.info.buybackBps,
            taxWallet: self.info.taxWallet,
            walletPaid: self.tax.walletPaid,
            rewardsAccrued: self.rw.accrued + self.rw.carry,
            buybackIn: self.bb.inTotal,
        };
    }
}

// Standard TEP-74 wallet (v1 TokenWallet without the curve's Sell op). No transfer tax: a tax
// token's tax lives in its DEX pool key, never in transfers.
//
// Holder rewards (rr != null, i.e. rewardsBps > 0): every balance change of a tracked wallet sends
// RewardCheckpoint{delta} to the master, which answers RewardAck{acc}. The wallet keeps the
// owner's reward state (RewardState). The Router's wallet, the master's own wallet and the creator
// vault's wallet are not tracked (rs == null): they never checkpoint and never earn. With rr == null no wallet is
// tracked and the code path is the plain TEP-74 one.
contract LaunchWallet {
    master: Address;
    owner: Address;
    rr: Address?;                   // the DEX Router when the token has holder rewards, else null
    vault: Address?;                // the creator vault when rr != null and the token has one, else null
    balance: Int as coins;
    rs: RewardState?;               // non-null iff this wallet is tracked

    init(master: Address, owner: Address, rr: Address?, vault: Address?) {
        self.master = master;
        self.owner = owner;
        self.rr = rr;
        self.vault = vault;
        self.balance = 0;
        self.rs = null;
        if (rr != null && owner != rr!! && owner != master && (vault == null || owner != vault!!)) {
            self.rs = RewardState { synced: 0, acked: 0, lastAcc: 0, frac: 0, owed: 0, inFlight: 0 };
        }
    }

    receive(msg: JettonTransfer) {
        let ctx = context();
        require(ctx.sender == self.owner, "Not owner");
        require(msg.amount > 0, "Invalid amount");
        require(self.balance >= msg.amount, "Insufficient balance");
        require(parseStdAddress(msg.destination.asSlice()).workchain == 0, "Wrong workchain");
        let fwdCount = msg.forwardTonAmount > 0 ? 2 : 1;
        let fwdFee = ctx.readForwardFee();
        // A tracked sender pays its own checkpoint and the receiver's (when the receiver is tracked).
        // Untracked senders (the Router's wallet) keep the plain TEP-74 requirement.
        let cp = 0;
        if (self.rs != null) {
            cp = CHECKPOINT_VALUE + fwdFee;
            if (self.tracks(msg.destination)) {
                cp += CHECKPOINT_VALUE + fwdFee;
            }
        }
        require(ctx.value > msg.forwardTonAmount + fwdCount * fwdFee + 2 * WALLET_GAS + WALLET_MIN_STORAGE + cp,
            "Insufficient TON attached");

        self.balance -= msg.amount;
        let body = JettonTransferInternal {
            queryId: msg.queryId,
            amount: msg.amount,
            sender: self.owner,
            responseDestination: msg.responseDestination,
            forwardTonAmount: msg.forwardTonAmount,
            forwardPayload: msg.forwardPayload,
        }.toCell();
        let init = initOf LaunchWallet(self.master, msg.destination, self.rr, self.vault);
        if (self.rs == null) {
            deploy(DeployParameters { init, value: 0, mode: SendRemainingValue, bounce: true, body });
            return;
        }
        // Checkpoint first (same transaction as the balance change), then the transfer carries
        // the rest of the value; Gram above the storage buffer (earlier ack leftovers) goes along.
        self.checkpoint(msg.queryId, CHECKPOINT_VALUE, SendDefaultMode);
        nativeReserve(min(myBalance() - ctx.value, WALLET_MIN_STORAGE), ReserveAtMost);
        deploy(DeployParameters { init, value: 0, mode: SendRemainingBalance, bounce: true, body });
    }

    receive(msg: JettonTransferInternal) {
        let ctx = context();
        if (ctx.sender != self.master) {
            let peer = contractAddress(initOf LaunchWallet(self.master, msg.sender, self.rr, self.vault));
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
        // Best effort: when the incoming value cannot pay the checkpoint, the wallet stays
        // under-reported (it earns on less than it holds) until its next checkpoint or SyncRewards.
        if (self.rs != null &&
            ctx.value >= msg.forwardTonAmount + CHECKPOINT_VALUE + WALLET_MIN_STORAGE + WALLET_GAS) {
            self.checkpoint(msg.queryId, CHECKPOINT_VALUE, SendDefaultMode);
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
        let fwdFee = ctx.readForwardFee();
        let cp = self.rs != null ? CHECKPOINT_VALUE + fwdFee : 0;
        require(ctx.value > fwdFee * 2 + 2 * WALLET_GAS + cp, "Insufficient TON attached");

        self.balance -= msg.amount;
        let body = JettonBurnNotification {
            queryId: msg.queryId,
            amount: msg.amount,
            sender: self.owner,
            responseDestination: msg.responseDestination,
        }.toCell();
        if (self.rs == null) {
            message(MessageParameters { to: self.master, value: 0, mode: SendRemainingValue, bounce: true, body });
            return;
        }
        self.checkpoint(msg.queryId, CHECKPOINT_VALUE, SendDefaultMode);
        nativeReserve(min(myBalance() - ctx.value, WALLET_MIN_STORAGE), ReserveAtMost);
        message(MessageParameters { to: self.master, value: 0, mode: SendRemainingBalance, bounce: true, body });
    }

    // Owner: claim all rewards to the owner address. One claim at a time, and only while no
    // checkpoint is in flight (the master then sees exactly the state this wallet sends).
    receive(msg: ClaimRewards) {
        let ctx = context();
        require(ctx.sender == self.owner, "Not owner");
        require(self.rs != null, "No rewards");
        let rs = self.rs!!;
        require(rs.inFlight == 0, "Checkpoint in flight");
        require(ctx.value >= CLAIM_VALUE, "Insufficient TON attached");
        let delta = self.balance - rs.synced;
        rs.synced = self.balance;
        rs.inFlight = 1;
        self.rs = rs;
        message(MessageParameters {
            to: self.master,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: RewardClaim {
                queryId: msg.queryId, delta, owner: self.owner, acked: rs.acked, lastAcc: rs.lastAcc, frac: rs.frac, owed: rs.owed,
            }.toCell(),
        });
    }

    // Owner: report the current balance (after an under-reported receive) and refresh `owed`.
    receive(msg: SyncRewards) {
        let ctx = context();
        require(ctx.sender == self.owner, "Not owner");
        require(self.rs != null, "No rewards");
        require(ctx.value >= CHECKPOINT_VALUE, "Insufficient TON attached");
        self.checkpoint(msg.queryId, 0, SendRemainingValue);
    }

    receive(msg: RewardAck) {
        require(sender() == self.master && self.rs != null, "Not master");
        let rs = self.rs!!;
        if (msg.claim) {
            rs.owed = 0;
            rs.frac = msg.frac;
        } else {
            let x = rs.acked * (msg.acc - rs.lastAcc) + rs.frac;
            rs.owed += x / REWARD_SCALE;
            rs.frac = x % REWARD_SCALE;
        }
        rs.acked = max(rs.acked + msg.delta, 0);
        rs.lastAcc = msg.acc;
        rs.inFlight = max(rs.inFlight - 1, 0);
        self.rs = rs;
    }

    bounced(msg: bounced<JettonTransferInternal>) {
        self.balance += msg.amount;
    }

    bounced(msg: bounced<JettonBurnNotification>) {
        self.balance += msg.amount;
    }

    // The master did not apply the change: report it again with the next checkpoint.
    bounced(msg: bounced<RewardCheckpoint>) {
        self.unsend(msg.delta);
    }

    bounced(msg: bounced<RewardClaim>) {
        self.unsend(msg.delta);
    }

    fun unsend(delta: Int) {
        if (self.rs != null) {
            let rs = self.rs!!;
            rs.synced -= delta;
            rs.inFlight = max(rs.inFlight - 1, 0);
            self.rs = rs;
        }
    }

    fun tracks(owner: Address): Bool {
        return self.rr != null && owner != self.rr!! && owner != self.master && (self.vault == null || owner != self.vault!!);
    }

    fun checkpoint(queryId: Int, value: Int, mode: Int) {
        let rs = self.rs!!;
        let delta = self.balance - rs.synced;
        rs.synced = self.balance;
        rs.inFlight += 1;
        self.rs = rs;
        message(MessageParameters {
            to: self.master,
            value,
            mode,
            bounce: true,
            body: RewardCheckpoint { queryId, delta, owner: self.owner }.toCell(),
        });
    }

    get fun get_wallet_data(): JettonWalletData {
        return JettonWalletData {
            balance: self.balance,
            owner: self.owner,
            master: self.master,
            code: initOf LaunchWallet(self.master, self.owner, self.rr, self.vault).code,
        };
    }

    // Zeros for an untracked wallet. Pending = master.get_pending_rewards(acked, lastAcc, frac, owed),
    // or get_pending_rewards(master.get_rewards_data().acc) here.
    get fun get_reward_state(): RewardState {
        if (self.rs == null) {
            return RewardState { synced: 0, acked: 0, lastAcc: 0, frac: 0, owed: 0, inFlight: 0 };
        }
        return self.rs!!;
    }

    get fun get_pending_rewards(acc: Int): Int {
        if (self.rs == null) {
            return 0;
        }
        let rs = self.rs!!;
        return rs.owed + (rs.acked * (acc - rs.lastAcc) + rs.frac) / REWARD_SCALE;
    }

    get fun get_tracked(): Bool {
        return self.rs != null;
    }
}
