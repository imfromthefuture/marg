import "./dex_types";
import "./messages";

// MARG fee converter. Every MARG platform fee ends up with the treasury in Gram:
//  - the DEX Router's `treasury` (protocol fees, CollectProtocolFees) and the launch factory's
//    `treasury` (launch fee + feeClaimer of every launch's locked position) point HERE;
//  - Gram that arrives (GramPayout, plain transfers, comments, excesses) is forwarded to the
//    treasury wallet, keeping FC_RESERVE for storage (Flush: anyone, any amount; automatic when a
//    message brings the surplus to FC_AUTO_FORWARD or more);
//  - jettons that arrive (protocol fees in X, LP fees of owned launch positions) sit in the
//    converter's own jetton wallets until the keeper (or admin) sends ConvertJetton: a swap X -> Gram
//    on Marg DEX v2 with receiver = refundTo = this contract. The Router validates the key; a bad key,
//    an empty pool, slippage or a deadline refunds the jettons here. The Gram proceeds are forwarded.
//    The key must be ADMIN-APPROVED for that jetton wallet (ApproveConvertKey): the keeper cannot
//    pick an arbitrary (rigged) pool of X - e.g. a fresh key it initialized at a near-zero X price -
//    and dump the converter's X into it.
//
// Outflows (the whole list):
//  - Gram above FC_RESERVE -> treasury (forward / Flush);
//  - JettonTransfer to `jettonWallet` (ConvertJetton: destination = the fixed Router; RescueJetton:
//    destination = treasury), paid ONLY from the caller's attached value (reserveOwn);
//  - PositionDecrease{liquidityDelta 0, recipient = this} to `position` (CollectPosition), paid only
//    from the caller's attached value (reserveOwn);
//  - ClaimRewards to `jettonWallet` (ClaimJettonRewards, keeper / admin), paid only from the caller's
//    attached value (reserveOwn): holder rewards of launch tokens come back as Gram.
// There is no arbitrary withdraw, no NftTransfer (owned positions can never leave) and no way to
// change the Router. The admin can change the keeper and the treasury, and hand over the admin role
// in two steps.

const GRAM: Address = address("0:0000000000000000000000000000000000000000000000000000000000000000");

const FC_RESERVE: Int = ton("0.05");            // kept for storage rent
const FC_AUTO_FORWARD: Int = ton("0.05");       // auto-forward only when the surplus is at least this
// Marg DEX v2 (dex/v2/contracts/constants.tact): SWAP_BASE_GAS 0.35, CROSS_GAS 0.006, DECREASE_GAS 0.25.
const DEX_SWAP_BASE_GAS: Int = ton("0.35");
const DEX_CROSS_GAS: Int = ton("0.006");
const DEX_DECREASE_GAS: Int = ton("0.25");
const DEX_MAX_CROSSINGS: Int = 24;
// What the Router's swapGas (dex/v2 router.tact, get_swap_gas) can add on top of base + crossings for a
// jetton -> Gram sell: an AFTER_SWAP hook notification (HOOK_NOTIFY_VALUE 0.01), the platform-fee payout
// of a launch key (PAYOUT_MSG_GAS 0.01) and the tax auto-payout of a taxed key (PAYOUT_MSG_GAS 0.01 +
// TAX_PAYOUT_GAS 0.04) = 0.07, plus the 2 forward fees the Router adds (FC_FWD_SLACK covers ~15x today's).
// v3 (audit M-3): the old 0.06 was always 2 forward fees short on a taxed launch key (Router LOW_GAS).
const DEX_SWAP_EXTRAS: Int = ton("0.07");
const FC_FWD_SLACK: Int = ton("0.03");
const FC_SWAP_MARGIN: Int = ton("0.1");         // = DEX_SWAP_EXTRAS + FC_FWD_SLACK
// Converter compute + converter -> wallet -> Router-wallet hops (the excess comes back here).
const FC_WALLET_GAS: Int = ton("0.12");
const FC_COLLECT_VALUE: Int = ton("0.3");       // DECREASE_GAS + our compute and forward fee + slack
const FC_RESCUE_VALUE: Int = ton("0.1");
const FC_REWARDS_VALUE: Int = ton("0.1");       // ClaimJettonRewards: our compute + the wallet's ClaimRewards minimum (~0.042), rest comes back
const FC_SWAP_TTL: Int = 600;                   // swap / decrease deadline, seconds from now

contract FeeConverter {
    treasury: Address;
    router: Address;
    admin: Address;
    pendingAdmin: Address?;
    keeper: Address?;
    // Approved convert routes: convertKeyId(jettonWallet, tickSpacing, ext) -> true. Admin-managed.
    convertKeys: map<Int as uint256, Bool>;

    init(treasury: Address, router: Address, admin: Address) {
        self.treasury = treasury;
        self.router = router;
        self.admin = admin;
        self.pendingAdmin = null;
        self.keeper = null;
    }

    // -----------------------------------------------------------------------
    // Gram in: forward to the treasury
    // -----------------------------------------------------------------------

    receive() {
        self.autoForward(0);
    }

    receive(msg: String) {
        self.autoForward(0);
    }

    receive(msg: GramPayout) {
        self.autoForward(msg.queryId);
    }

    receive(msg: JettonExcesses) {
        self.autoForward(msg.queryId);
    }

    // Jettons arrive with or without a notification (DEX payouts use forwardTonAmount 0); either way
    // they are converted by ConvertJetton. The notification itself is never trusted for anything.
    receive(msg: JettonNotification) {
        self.autoForward(msg.queryId);
    }

    receive(msg: BurnReceipt) {
        self.autoForward(msg.queryId);
    }

    receive(msg: OwnershipAssigned) {
        self.autoForward(msg.queryId);
    }

    receive(msg: Flush) {
        self.sendSurplus(msg.queryId, 1);
    }

    // -----------------------------------------------------------------------
    // Jetton -> Gram
    // -----------------------------------------------------------------------

    receive(msg: ConvertJetton) {
        let ctx = context();
        require(ctx.sender == self.admin || (self.keeper != null && ctx.sender == self.keeper!!), "Not keeper");
        require(msg.amount > 0, "Invalid amount");
        // Audit L-7: the slippage bound is the caller's. On-chain the converter has no price to check it
        // against (a TWAP read is asynchronous and the Router takes minOut in the same message), so the
        // only hard rules are: minOut is mandatory, only the keeper / admin may convert, and only on an
        // admin-approved key. The keeper MUST derive minOut from a quote / the pool TWAP (server/keeper).
        require(msg.minOut > 0, "minOut must be > 0");
        require(msg.maxCrossings >= 1 && msg.maxCrossings <= DEX_MAX_CROSSINGS, "Invalid crossings");
        require(isBasechain(msg.jettonWallet) && msg.jettonWallet != myAddress() && msg.jettonWallet != self.router,
            "Invalid wallet");
        require(self.convertKeys.exists(convertKeyId(msg.jettonWallet, msg.tickSpacing, msg.ext)), "Key not approved");
        let fwd = self.swapForward(msg.maxCrossings);
        require(ctx.value >= fwd + FC_WALLET_GAS, "Insufficient TON attached");
        // Anything attached above the minimum is split between the Router leg and the wallet hops, so a
        // caller can always out-pay either side (higher forward fees, a reward token's checkpoint).
        // Whatever is unused comes back here and is forwarded to the treasury.
        fwd += (ctx.value - fwd - FC_WALLET_GAS) / 2;

        let payload = SwapPayload {
            otherToken: GRAM,
            tickSpacing: msg.tickSpacing,
            ext: msg.ext,
            minOut: msg.minOut,
            sqrtPriceLimitX96: 0,
            maxCrossings: msg.maxCrossings,
            allowPartial: false,
            deadline: now() + FC_SWAP_TTL,
            receiver: myAddress(),
            refundTo: myAddress(),
            referral: null,
            refBps: 0,
            fwdTon: 0,
            fwdPayload: null,
        }.toCell();
        emit(ConvertEvent {
            queryId: msg.queryId, jettonWallet: msg.jettonWallet, amount: msg.amount,
            tickSpacing: msg.tickSpacing, minOut: msg.minOut,
        }.toCell());
        self.reserveOwn();
        message(MessageParameters {
            to: msg.jettonWallet,
            value: 0,
            mode: SendRemainingBalance,
            bounce: true,
            body: JettonTransfer {
                queryId: msg.queryId,
                amount: msg.amount,
                destination: self.router,
                responseDestination: myAddress(),
                customPayload: null,
                forwardTonAmount: fwd,
                forwardPayload: beginCell().storeBool(true).storeRef(payload).asSlice(),
            }.toCell(),
        });
    }

    // -----------------------------------------------------------------------
    // LP fees of owned positions (launch positions are locked forever: only fees can come out)
    // -----------------------------------------------------------------------

    receive(msg: CollectPosition) {
        let ctx = context();
        require(ctx.value >= FC_COLLECT_VALUE, "Insufficient TON attached");
        require(isBasechain(msg.position) && msg.position != myAddress() && msg.position != self.router &&
            msg.position != self.treasury, "Invalid position");
        self.reserveOwn();
        message(MessageParameters {
            to: msg.position,
            value: 0,
            mode: SendRemainingBalance,
            bounce: true,
            body: PositionDecrease {
                queryId: msg.queryId,
                liquidityDelta: 0,
                amount0Min: 0,
                amount1Min: 0,
                deadline: now() + FC_SWAP_TTL,
                recipient: myAddress(),
            }.toCell(),
        });
    }

    // Holder rewards of a Marg launch token (launch/contracts/jetton.tact): the converter's wallet of a
    // rewards token is a tracked holder like any other, and only the wallet's owner can claim. Keeper or
    // admin: send ClaimRewards to the converter's wallet; the master pays the rewards here as plain Gram
    // (a comment message), which is forwarded to the treasury like every other Gram. Paid only from the
    // caller's attached value; the body is fixed, so nothing else can be triggered with it.
    receive(msg: ClaimJettonRewards) {
        let ctx = context();
        require(ctx.sender == self.admin || (self.keeper != null && ctx.sender == self.keeper!!), "Not keeper");
        require(ctx.value >= FC_REWARDS_VALUE, "Insufficient TON attached");
        require(isBasechain(msg.jettonWallet) && msg.jettonWallet != myAddress() && msg.jettonWallet != self.router &&
            msg.jettonWallet != self.treasury, "Invalid wallet");
        self.reserveOwn();
        message(MessageParameters {
            to: msg.jettonWallet,
            value: 0,
            mode: SendRemainingBalance,
            bounce: true,
            body: LaunchClaimRewards { queryId: msg.queryId }.toCell(),
        });
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    // Emergency: a jetton without a usable Gram pool goes to the treasury as is.
    receive(msg: RescueJetton) {
        self.requireAdmin();
        require(context().value >= FC_RESCUE_VALUE, "Insufficient TON attached");
        require(msg.amount > 0, "Invalid amount");
        require(isBasechain(msg.jettonWallet) && msg.jettonWallet != myAddress() && msg.jettonWallet != self.router,
            "Invalid wallet");
        self.reserveOwn();
        message(MessageParameters {
            to: msg.jettonWallet,
            value: 0,
            mode: SendRemainingBalance,
            bounce: true,
            body: JettonTransfer {
                queryId: msg.queryId,
                amount: msg.amount,
                destination: self.treasury,
                responseDestination: myAddress(),
                customPayload: null,
                forwardTonAmount: 0,
                forwardPayload: beginCell().storeBool(false).asSlice(),
            }.toCell(),
        });
    }

    // Allow (approved = true) or revoke (false) the pool key (GRAM, X, tickSpacing, ext) as a convert
    // route for the converter's wallet `jettonWallet` of X.
    receive(msg: ApproveConvertKey) {
        self.requireAdmin();
        require(isBasechain(msg.jettonWallet) && msg.jettonWallet != myAddress() && msg.jettonWallet != self.router,
            "Invalid wallet");
        let id = convertKeyId(msg.jettonWallet, msg.tickSpacing, msg.ext);
        if (msg.approved) {
            self.convertKeys.set(id, true);
        } else {
            self.convertKeys.set(id, null);
        }
        self.autoForward(msg.queryId);
    }

    receive(msg: SetKeeper) {
        self.requireAdmin();
        if (msg.keeper != null) {
            require(isBasechain(msg.keeper!!), "Invalid keeper");
        }
        self.keeper = msg.keeper;
        self.autoForward(msg.queryId);
    }

    receive(msg: SetFeeTreasury) {
        self.requireAdmin();
        require(isBasechain(msg.treasury) && msg.treasury != myAddress() && msg.treasury != self.router,
            "Invalid treasury");
        self.treasury = msg.treasury;
        self.autoForward(msg.queryId);
    }

    receive(msg: TransferConverterAdmin) {
        self.requireAdmin();
        require(isBasechain(msg.newAdmin), "Invalid admin");
        self.pendingAdmin = msg.newAdmin == self.admin ? null : msg.newAdmin;
        self.autoForward(msg.queryId);
    }

    receive(msg: ClaimConverterAdmin) {
        require(self.pendingAdmin != null && sender() == self.pendingAdmin!!, "Not pending admin");
        self.admin = self.pendingAdmin!!;
        self.pendingAdmin = null;
        self.autoForward(msg.queryId);
    }

    // Bounces (a refused PositionDecrease, a JettonTransfer to a wallet that is not ours / short of
    // balance): the value stays here and is forwarded with the next flush. Nothing else to undo.
    bounced(msg: Slice) {}

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    // Admin ops keep the attached value (it is forwarded to the treasury like any other Gram): nothing
    // is ever sent back to the sender.
    fun requireAdmin() {
        require(sender() == self.admin, "Not admin");
    }

    // The outgoing message may carry only the caller's value (minus our gas): reserve what the
    // converter held before this message, at least FC_RESERVE.
    fun reserveOwn() {
        nativeReserve(max(myBalance() - context().value, FC_RESERVE), ReserveAtMost);
    }

    fun swapForward(maxCrossings: Int): Int {
        return DEX_SWAP_BASE_GAS + maxCrossings * DEX_CROSS_GAS + FC_SWAP_MARGIN;
    }

    fun autoForward(queryId: Int) {
        self.sendSurplus(queryId, FC_AUTO_FORWARD);
    }

    // Everything above FC_RESERVE goes to the treasury when the surplus is at least `minSurplus`.
    // Non-bounceable and SendIgnoreErrors: a forward can never fail the transaction (the Gram then
    // simply stays for the next flush).
    fun sendSurplus(queryId: Int, minSurplus: Int) {
        if (myBalance() - FC_RESERVE < minSurplus) {
            return;
        }
        nativeReserve(FC_RESERVE, ReserveAtMost);
        message(MessageParameters {
            to: self.treasury,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: TreasuryDeposit { queryId }.toCell(),
        });
    }

    // -----------------------------------------------------------------------
    // Getters
    // -----------------------------------------------------------------------

    get fun get_converter_data(): ConverterData {
        return ConverterData {
            treasury: self.treasury,
            router: self.router,
            admin: self.admin,
            pendingAdmin: self.pendingAdmin,
            keeper: self.keeper,
            balance: myBalance(),
            reserve: FC_RESERVE,
        };
    }

    // Minimum value to attach to ConvertJetton for a given maxCrossings.
    get fun get_convert_value(maxCrossings: Int): Int {
        return self.swapForward(maxCrossings) + FC_WALLET_GAS;
    }

    get fun get_convert_key_approved(jettonWallet: Address, tickSpacing: Int, ext: Cell?): Bool {
        return self.convertKeys.exists(convertKeyId(jettonWallet, tickSpacing, ext));
    }

    get fun get_collect_value(): Int {
        return FC_COLLECT_VALUE;
    }

    get fun get_rewards_value(): Int {
        return FC_REWARDS_VALUE;
    }
}

// Identity of a convert route. The converter's own jetton wallet fixes the token X (a wallet belongs to
// exactly one master, and the Router resolves X from the wallet the transfer arrives through), and
// otherToken is always GRAM, so (jettonWallet, tickSpacing, ext) determines the pool key
// {token0 = GRAM, token1 = X, tickSpacing, ext} exactly. ext is stored as a ref, so its full content
// (hook, lock settings, ...) is bound by the cell hash: approving one ext never approves another.
fun convertKeyId(jettonWallet: Address, tickSpacing: Int, ext: Cell?): Int {
    return beginCell()
        .storeAddress(jettonWallet)
        .storeUint(tickSpacing, 16)
        .storeMaybeRef(ext)
        .endCell()
        .hash();
}

// True only for a plain addr_std in workchain 0 (copied from dex/v2/contracts/constants.tact).
fun isBasechain(a: Address): Bool {
    let s = a.asSlice();
    return s.bits() == 267 && s.refs() == 0 && s.preloadUint(11) == 1024;
}
