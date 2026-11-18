import "./messages";
import "./jetton";

// Marg direct launch factory (Clanker / Uniswap-v4-launch style): no bonding curve. CreateToken
// deploys a fixed-supply jetton whose whole supply goes straight into a Marg DEX v2 pool in the
// same message chain: Factory -> Master (mint once) -> Router's wallet -> Router -> Pool. The pool
// starts at startMcap with one jetton-only position locked forever whose LP fees belong to the
// treasury (the platform fee). The optional dev buy runs inside the pool's initialization
// transaction, so nothing can be ordered before it.

const FACTORY_MIN_STORAGE: Int = ton("0.05");
// Value forwarded to the Router with the launch transfer (Router LAUNCH_GAS 0.5 + forward fees).
const ROUTER_LAUNCH_VALUE: Int = ton("0.55");
// Extra Router value when devBuy > 0 (Router DEV_BUY_GAS 0.15 + margin), on top of devBuy itself.
const ROUTER_DEV_VALUE: Int = ton("0.17");
// Factory + master + Router-wallet hops: compute, forward fees (StateInits), master storage.
const HOPS_GAS: Int = ton("0.15");
// Extra value when the launch has a creator vault: VAULT_DEPLOY_VALUE 0.05 + VAULT_WALLET_VALUE 0.03 (both kept
// as storage reserves) + the master's extra compute and the two StateInit forward fees (~0.02) + margin.
const VAULT_GAS: Int = ton("0.12");

// Hard caps (code constants; the DEX enforces its own, identical or wider, caps again).
const TAX_MIN_BPS: Int = 100;                  // a tax is 0 (off) or 1%..5%
const TAX_CAP_BPS: Int = 500;                  // (the DEX allows up to 10%; launches cap at 5%)
const BUYBACK_CAP_BPS: Int = 100;              // max Gram per buyback = 1% of the start market cap
const ANTI_SNIPE_CAP_PIPS: Int = 900000;       // 90% (DEX MAX_LAUNCH_FEE_PIPS must be >= this, else the launch is refunded)
const ANTI_SNIPE_MAX_DURATION: Int = 3600;     // = DEX MAX_LAUNCH_DURATION
const MIN_START_MCAP: Int = ton("100");
const MAX_START_MCAP: Int = ton("100000000");
const VAULT_MAX_BPS: Int = 5000;               // creator vault: at most 50% of the supply
const VAULT_MIN_LOCK: Int = 604800;            // 7 days
const VAULT_MAX_LOCK: Int = 31536000;          // 365 days
const VAULT_MAX_VEST: Int = 31536000;          // 365 days (0 = everything unlocks at the end of the lock)
// Creators kept for the bounced handler: the last FACTORY_PENDING launches (older entries are dropped).
const FACTORY_PENDING: Int = 16;
const Q192: Int = 0x1000000000000000000000000000000000000000000000000;     // 2^192

contract LaunchFactory {
    admin: Address;
    pendingAdmin: Address?;
    treasury: Address;
    router: Address;                // Marg DEX v2 Router (immutable)
    launchFee: Int as coins;        // the admin can only lower it
    tiers: LaunchTiers;             // low / mid / high liquidity
    nextIndex: Int as uint64;
    // v3: the Marg DEX v2 Pool code (hash and depth, immutable). Every master derives its own pool
    // address from it and accepts tax payouts only from that pool (audit L-4).
    poolCodeHash: Int as uint256;
    poolCodeDepth: Int as uint16;
    // v3: index -> creator of the last FACTORY_PENDING launches, for the bounced handler only.
    pending: map<Int as uint64, Address>;

    init(admin: Address, treasury: Address, router: Address, launchFee: Int, tiers: LaunchTiers,
         poolCodeHash: Int, poolCodeDepth: Int) {
        require(isBasechain(admin) && isBasechain(treasury) && isBasechain(router), "Invalid address");
        self.poolCodeHash = poolCodeHash;
        self.poolCodeDepth = poolCodeDepth;
        self.admin = admin;
        self.pendingAdmin = null;
        self.treasury = treasury;
        self.router = router;
        self.launchFee = launchFee;
        self.tiers = tiers;
        self.nextIndex = 0;
    }

    receive(msg: CreateToken) {
        let ctx = context();
        let creator = ctx.sender;
        // Audit L-5: the DEX refuses a non-basechain refund / dev-buy receiver, so such a launch could only
        // fail. Refused here (bounced: the whole value goes back) before anything is deployed.
        require(isBasechain(creator), "Creator not on basechain");
        require(taxOk(msg.buyTaxBps) && taxOk(msg.sellTaxBps), "Tax out of range");
        require(msg.antiSnipePips <= ANTI_SNIPE_CAP_PIPS && msg.antiSnipeDuration <= ANTI_SNIPE_MAX_DURATION &&
            (msg.antiSnipePips > 0) == (msg.antiSnipeDuration > 0), "Invalid anti-snipe fee");
        // The creator signs the tier params it saw: if the admin changed that tier first, no tier matches and
        // the launch is refused (bounced).
        let p = self.tierFor(msg.startMcap, msg.tickSpacing);
        let hasVault = msg.vaultBps > 0;
        let vaultLock = 0;
        let vaultVest = 0;
        if (hasVault) {
            require(msg.vaultBps <= VAULT_MAX_BPS && msg.vaultLock >= VAULT_MIN_LOCK && msg.vaultLock <= VAULT_MAX_LOCK &&
                msg.vaultVest <= VAULT_MAX_VEST, "Invalid vault");
            vaultLock = msg.vaultLock;
            vaultVest = msg.vaultVest;
        }
        require(ctx.value >= self.launchFee + msg.devBuy + self.createGas(msg.devBuy > 0, hasVault), "Insufficient TON attached");
        let taxed = msg.buyTaxBps > 0 || msg.sellTaxBps > 0;
        let rewardsBps = 0;
        let walletBps = 0;
        let buybackBps = 0;
        let taxWallet: Address? = null;
        if (taxed) {
            rewardsBps = msg.rewardsBps;
            walletBps = msg.walletBps;
            buybackBps = msg.buybackBps;
            require(rewardsBps + walletBps + buybackBps == BPS_100, "Split must sum to 100%");
            if (walletBps > 0) {
                taxWallet = msg.taxWallet != null ? msg.taxWallet!! : creator;
                require(isBasechain(taxWallet!!) && taxWallet!! != self.router && taxWallet!! != myAddress(), "Invalid tax wallet");
            }
        }

        let index = self.nextIndex;
        self.nextIndex += 1;
        let init = initOf LaunchJetton(myAddress(), index);
        let master = contractAddress(init);
        // Not the master, and not the token's creator vault: the vault only accepts Gram (plain top-ups)
        // and can never send it out, so the wallet share of the tax would be locked there for good.
        require(taxWallet == null || (taxWallet!! != master && taxWallet!! != contractAddress(initOf LaunchVault(master))),
            "Invalid tax wallet");
        self.pending.set(index, creator);
        if (index >= FACTORY_PENDING) {
            self.pending.set(index - FACTORY_PENDING, null);
        }

        emit(TokenLaunched {
            queryId: msg.queryId, index, master, creator, devBuy: msg.devBuy,
            buyTaxBps: msg.buyTaxBps, sellTaxBps: msg.sellTaxBps, taxWallet, rewardsBps, walletBps, buybackBps,
            antiSnipePips: msg.antiSnipePips, antiSnipeDuration: msg.antiSnipeDuration,
            vaultBps: msg.vaultBps, vaultLock, vaultVest,
        }.toCell());

        // v3: the launch fee travels with the launch and is held by the master until the outcome is known:
        // a launch the DEX refuses returns it to the creator, a successful one pays it to the treasury.
        nativeReserve(max(myBalance() - ctx.value, FACTORY_MIN_STORAGE), ReserveAtMost);
        deploy(DeployParameters {
            init,
            value: 0,
            mode: SendRemainingBalance,
            bounce: true,
            body: LaunchSetup {
                queryId: msg.queryId,
                index,
                content: msg.content,
                info: LaunchInfo {
                    creator,
                    router: self.router,
                    feeClaimer: self.treasury,
                    tickSpacing: p.tickSpacing,
                    launchFeePips: msg.antiSnipePips,
                    launchDuration: msg.antiSnipeDuration,
                    sqrtPriceX96: startSqrtPrice(p.startMcap),
                    // The DEX pays the whole tax to the master, which splits it (see jetton.tact).
                    taxRecipient: taxed ? master : null,
                    buyTaxBps: msg.buyTaxBps,
                    sellTaxBps: msg.sellTaxBps,
                    taxWallet,
                    rewardsBps,
                    walletBps,
                    buybackBps,
                    buybackCap: p.startMcap * BUYBACK_CAP_BPS / BPS_100,
                    createdAt: now(),
                    vaultBps: msg.vaultBps,
                    vaultLock,
                    vaultVest,
                },
                devBuy: msg.devBuy,
                minDevOut: msg.minDevOut,
                routerValue: ROUTER_LAUNCH_VALUE + (msg.devBuy > 0 ? ROUTER_DEV_VALUE + msg.devBuy : 0),
                launchFee: self.launchFee,
                poolCodeHash: self.poolCodeHash,
                poolCodeDepth: self.poolCodeDepth,
            }.toCell(),
        });
    }

    // -----------------------------------------------------------------------
    // Admin (2-step transfer; the launch fee can only go down; params affect new launches only)
    // -----------------------------------------------------------------------

    receive(msg: LowerLaunchFee) {
        self.requireAdmin();
        require(msg.fee < self.launchFee, "Fee can only go down");
        self.launchFee = msg.fee;
        self.refund(msg.queryId);
    }

    receive(msg: SetLaunchParams) {
        self.requireAdmin();
        require(msg.tier <= 2, "Unknown tier");
        let p = msg.params;
        require(p.startMcap >= MIN_START_MCAP && p.startMcap <= MAX_START_MCAP, "Invalid start mcap");
        // DEX fee presets only (a launch on any other spacing would be refunded by the Router).
        require(p.tickSpacing == 1 || p.tickSpacing == 10 || p.tickSpacing == 60 || p.tickSpacing == 200, "Invalid tick spacing");
        if (msg.tier == 0) {
            self.tiers.low = p;
        } else if (msg.tier == 1) {
            self.tiers.mid = p;
        } else {
            self.tiers.high = p;
        }
        self.refund(msg.queryId);
    }

    receive(msg: SetTreasury) {
        self.requireAdmin();
        require(isBasechain(msg.treasury), "Invalid treasury");
        self.treasury = msg.treasury;
        self.refund(msg.queryId);
    }

    receive(msg: TransferAdmin) {
        self.requireAdmin();
        require(isBasechain(msg.newAdmin), "Invalid admin");
        self.pendingAdmin = msg.newAdmin == self.admin ? null : msg.newAdmin;
        self.refund(msg.queryId);
    }

    receive(msg: ClaimAdmin) {
        require(self.pendingAdmin != null && sender() == self.pendingAdmin!!, "Not pending admin");
        self.admin = self.pendingAdmin!!;
        self.pendingAdmin = null;
        self.refund(msg.queryId);
    }

    receive(msg: WithdrawExcess) {
        self.requireAdmin();
        nativeReserve(FACTORY_MIN_STORAGE, ReserveAtMost);
        message(MessageParameters {
            to: self.treasury,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: JettonExcesses { queryId: msg.queryId }.toCell(),
        });
    }

    receive() {}

    // v3: the new master could not run LaunchSetup (it cannot in practice: the factory checks everything
    // and funds it). Nothing was minted; the whole returned value (launch fee and dev buy included) goes
    // back to the creator. If the creator is no longer known (more than FACTORY_PENDING launches
    // ago) the Gram stays here for the admin to return by hand (WithdrawExcess -> treasury).
    bounced(msg: bounced<LaunchSetup>) {
        let ctx = context();
        let creator = self.pending.get(msg.index);
        emit(LaunchBounced { queryId: msg.queryId, index: msg.index, creator, value: ctx.value }.toCell());
        if (creator == null || ctx.sender != contractAddress(initOf LaunchJetton(myAddress(), msg.index))) {
            return;
        }
        self.pending.set(msg.index, null);
        nativeReserve(max(myBalance() - ctx.value, FACTORY_MIN_STORAGE), ReserveAtMost);
        message(MessageParameters {
            to: creator!!,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: JettonExcesses { queryId: msg.queryId }.toCell(),
        });
    }

    // Any other bounce: the value stays here.
    bounced(msg: Slice) {}

    // -----------------------------------------------------------------------

    // The tier whose params the creator signed (throws when none matches).
    fun tierFor(startMcap: Int, tickSpacing: Int): LaunchParams {
        let t = self.tiers;
        if (startMcap == t.low.startMcap && tickSpacing == t.low.tickSpacing) {
            return t.low;
        }
        if (startMcap == t.mid.startMcap && tickSpacing == t.mid.tickSpacing) {
            return t.mid;
        }
        require(startMcap == t.high.startMcap && tickSpacing == t.high.tickSpacing, "Launch params changed");
        return t.high;
    }

    fun createGas(devBuy: Bool, vault: Bool): Int {
        return HOPS_GAS + ROUTER_LAUNCH_VALUE + (devBuy ? ROUTER_DEV_VALUE : 0) + (vault ? VAULT_GAS : 0);
    }

    fun requireAdmin() {
        require(sender() == self.admin, "Not admin");
    }

    fun refund(queryId: Int) {
        nativeReserve(max(myBalance() - context().value, FACTORY_MIN_STORAGE), ReserveAtMost);
        message(MessageParameters {
            to: sender(),
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: JettonExcesses { queryId }.toCell(),
        });
    }

    // -----------------------------------------------------------------------
    // Getters
    // -----------------------------------------------------------------------

    get fun get_factory_data(): FactoryData {
        return FactoryData {
            admin: self.admin,
            pendingAdmin: self.pendingAdmin,
            treasury: self.treasury,
            router: self.router,
            launchFee: self.launchFee,
            tiers: self.tiers,
            nextIndex: self.nextIndex,
        };
    }

    // v3: the DEX Pool code this factory's tokens trust (hash, depth).
    get fun get_pool_code(): PoolCode {
        return PoolCode { hash: self.poolCodeHash, depth: self.poolCodeDepth };
    }

    get fun get_token_address(index: Int): Address {
        return contractAddress(initOf LaunchJetton(myAddress(), index));
    }

    // Value CreateToken must attach (any excess comes back to the creator).
    // Without a creator vault (unchanged); get_create_value2 covers both cases.
    get fun get_create_value(devBuy: Int): Int {
        return self.launchFee + devBuy + self.createGas(devBuy > 0, false);
    }

    get fun get_create_value2(devBuy: Int, hasVault: Bool): Int {
        return self.launchFee + devBuy + self.createGas(devBuy > 0, hasVault);
    }

    // Start price of a new launch on a tier (0 low, 1 mid, 2 high), before the pool floors it to the spacing.
    get fun get_start_sqrt_price(tier: Int): Int {
        let t = self.tiers;
        return startSqrtPrice(tier == 0 ? t.low.startMcap : (tier == 1 ? t.mid.startMcap : t.high.startMcap));
    }
}

fun taxOk(bps: Int): Bool {
    return bps == 0 || (bps >= TAX_MIN_BPS && bps <= TAX_CAP_BPS);
}

// sqrt(jetton per Gram) in Q64.96, floor: price = TOTAL_SUPPLY / startMcap (both 9 decimals).
fun startSqrtPrice(startMcap: Int): Int {
    return isqrtFloor(TOTAL_SUPPLY * Q192 / startMcap);
}

fun isqrtFloor(n: Int): Int {
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
