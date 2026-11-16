import "./messages";
import "./constants";
import "./pool";

// Marg DEX Router: the single entry point. It owns the DEX's jetton wallets, parses swap and
// deposit payloads, deploys each pool on first use, and moves jettons only when an
// authenticated pool commands it (PayTo).
//
// A token is identified by the Router's own jetton wallet address for it (the sender of the
// JettonNotification), Gram by the zero address. A forged notification therefore only ever
// reaches pools keyed by the forger's own address.
//
// The Router keeps no user Gram between transactions: every asset handler forwards the whole
// incoming value, which is why admin may sweep its balance.
contract Router {
    admin: Address;
    pendingAdmin: Address?;
    treasury: Address;
    creationPaused: Bool;

    init(admin: Address, treasury: Address) {
        self.admin = admin;
        self.pendingAdmin = null;
        self.treasury = treasury;
        self.creationPaused = false;
    }

    // -----------------------------------------------------------------------
    // Jetton entry. The notification is non-bounceable, so this receiver must never throw:
    // every failure sends the jettons back.
    // -----------------------------------------------------------------------

    receive(msg: JettonNotification) {
        let ctx = context();
        let tokenIn = ctx.sender;

        // Below this nothing can pay for a refund transfer; the jettons stay unaccounted.
        if (ctx.value < ROUTER_REFUND_MIN) {
            emit(RefundEvent { queryId: msg.queryId, user: msg.sender, code: CODE_LOW_GAS }.toCell());
            return;
        }
        // A 0-amount notification (allowed by the standard wallet) has nothing to send back, and a
        // 0-amount refund transfer would be rejected by stricter wallets and bounce. Return the gas.
        if (msg.amount == 0) {
            emit(RefundEvent { queryId: msg.queryId, user: msg.sender, code: CODE_BAD_PAYLOAD }.toCell());
            nativeReserve(max(myBalance() - ctx.value, ROUTER_MIN_STORAGE), ReserveAtMost);
            message(MessageParameters {
                to: msg.sender,
                value: 0,
                mode: SendRemainingBalance | SendIgnoreErrors,
                bounce: false,
                body: JettonExcesses { queryId: msg.queryId }.toCell(),
            });
            return;
        }
        // Jettons "from the Router" can only be a payout our own wallet sent back to us (or a forgery).
        // There is no user to key an LpAccount by or to refund to: such a sender would be one shared
        // account that anyone could complete and nobody could refund. The entry checks below make
        // every Router-addressed payout impossible, so this is defence in depth; the jettons stay.
        if (msg.sender == myAddress()) {
            emit(RefundEvent { queryId: msg.queryId, user: msg.sender, code: CODE_BAD_RECIPIENT }.toCell());
            return;
        }
        if (!isBasechain(tokenIn)) {
            self.refundJetton(tokenIn, msg.queryId, msg.amount, msg.sender, CODE_BAD_TOKEN);
            return;
        }

        // Parse into locals only: no state writes and no sends inside try.
        let p = msg.forwardPayload;
        let op = 0;
        try {
            if (p.loadBit()) {
                p = p.loadRef().beginParse();
            }
            op = p.preloadUint(32);
        } catch (e) {
            op = 0;
        }

        if (op == OP_SWAP_PAYLOAD) {
            let sp: SwapPayload? = null;
            try {
                sp = SwapPayload.fromSlice(p);
            } catch (e) {
                sp = null;
            }
            if (sp == null) {
                self.refundJetton(tokenIn, msg.queryId, msg.amount, msg.sender, CODE_BAD_PAYLOAD);
                return;
            }
            self.swapJetton(tokenIn, msg.queryId, msg.amount, msg.sender, sp!!);
            return;
        }
        if (op == OP_PROVIDE_LP_PAYLOAD) {
            let pp: ProvideLpPayload? = null;
            try {
                pp = ProvideLpPayload.fromSlice(p);
            } catch (e) {
                pp = null;
            }
            if (pp == null) {
                self.refundJetton(tokenIn, msg.queryId, msg.amount, msg.sender, CODE_BAD_PAYLOAD);
                return;
            }
            self.provideJetton(tokenIn, msg.queryId, msg.amount, msg.sender, pp!!);
            return;
        }
        if (op == OP_PROVIDE_BOTH_PAYLOAD) {
            let bp: ProvideBothPayload? = null;
            try {
                bp = ProvideBothPayload.fromSlice(p);
            } catch (e) {
                bp = null;
            }
            if (bp == null) {
                self.refundJetton(tokenIn, msg.queryId, msg.amount, msg.sender, CODE_BAD_PAYLOAD);
                return;
            }
            self.provideBoth(tokenIn, msg.queryId, msg.amount, msg.sender, bp!!);
            return;
        }
        self.refundJetton(tokenIn, msg.queryId, msg.amount, msg.sender, CODE_BAD_PAYLOAD);
    }

    // -----------------------------------------------------------------------
    // Native entries. These come bounceable from a wallet, so a throw returns the Gram.
    // -----------------------------------------------------------------------

    receive(msg: SwapNative) {
        let ctx = context();
        require(msg.amount > 0, "Invalid amount");
        require(msg.askToken != GRAM && isBasechain(msg.askToken), "Invalid token");
        require(now() <= msg.deadline, "Deadline");
        require(msg.refBps <= MAX_REF_FEE_BPS, "Fee above cap");
        require(!self.isMe(msg.receiver) && !self.isMe(msg.refundTo) && !self.isMe(msg.referral), "Invalid recipient");
        let pFee = payloadFee(msg.fwdPayload);
        require(pFee >= 0, "Payload too large");
        require(ctx.value >= msg.amount + SWAP_GAS + msg.fwdTon + pFee + 2 * ctx.readForwardFee(), "Insufficient TON attached");

        let from = ctx.sender;
        self.sendToPool(GRAM, msg.askToken, PoolSwap {
            queryId: msg.queryId,
            fromUser: from,
            inIsToken0: true,               // GRAM always sorts first
            amountIn: msg.amount,
            minOut: msg.minOut,
            deadline: msg.deadline,
            receiver: msg.receiver != null ? msg.receiver!! : from,
            refundTo: msg.refundTo != null ? msg.refundTo!! : from,
            referral: msg.referral,
            refBps: msg.referral == null ? 0 : msg.refBps,
            fwdTon: msg.fwdTon,
            fwdPayload: msg.fwdPayload,
        }.toCell());
    }

    receive(msg: ProvideLpNative) {
        let ctx = context();
        require(msg.amount > 0, "Invalid amount");
        require(msg.otherToken != GRAM && isBasechain(msg.otherToken), "Invalid token");
        require(now() <= msg.deadline, "Deadline");
        require(!self.isMe(msg.lpReceiver) && !self.isMe(msg.refundTo), "Invalid recipient");
        require(ctx.value >= msg.amount + PROVIDE_GAS + 2 * ctx.readForwardFee(), "Insufficient TON attached");

        let from = ctx.sender;
        self.sendToPool(GRAM, msg.otherToken, PoolProvide {
            queryId: msg.queryId,
            user: from,
            amount0: msg.amount,
            amount1: 0,
            minLpOut: msg.minLpOut,
            deadline: msg.deadline,
            lpReceiver: msg.lpReceiver != null ? msg.lpReceiver!! : from,
            refundTo: msg.refundTo != null ? msg.refundTo!! : from,
            allowCreate: !self.creationPaused,
            requireEmpty: false,
        }.toCell());
    }

    // -----------------------------------------------------------------------
    // Pool -> Router: pay out jettons. Authenticated by recomputing the pool address.
    // A forger only gets a bounce; after the checks this path is total.
    // -----------------------------------------------------------------------

    receive(msg: PayTo) {
        let pool = contractAddress(initOf Pool(myAddress(), msg.token0, msg.token1));
        require(sender() == pool, "Not pool");
        require(msg.wallet != GRAM && (msg.wallet == msg.token0 || msg.wallet == msg.token1), "Invalid token");

        // The pool has already debited its reserve, so this transfer must not bounce: a bounced
        // JettonTransfer only tells us the amount, and the jettons would be stranded. If the value
        // cannot pay for fwdTon and the payload on the wallet hops, deliver the jettons without
        // them; the unspent value still reaches excessTo. The entry checks budget for the payload,
        // so this only triggers if fees changed in flight.
        let fwdTon = msg.fwdTon;
        let fwdPayload = msg.fwdPayload;
        if (fwdTon > 0 || fwdPayload != null) {
            let walletFee = transferFee(fwdPayload);
            if (walletFee < 0 || context().value < fwdTon + 3 * walletFee + PAYOUT_WALLET_MIN) {
                fwdTon = 0;
                fwdPayload = null;
                emit(RefundEvent { queryId: msg.queryId, user: msg.to, code: CODE_FWD_DROPPED }.toCell());
            }
        }

        message(MessageParameters {
            to: msg.wallet,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: JettonTransfer {
                queryId: msg.queryId,
                amount: msg.amount,
                destination: msg.to,
                responseDestination: msg.excessTo,
                customPayload: null,
                forwardTonAmount: fwdTon,
                forwardPayload: eitherPayload(fwdPayload),
            }.toCell(),
        });
    }

    // -----------------------------------------------------------------------
    // Fee collection (anyone; fees always go to the treasury)
    // -----------------------------------------------------------------------

    receive(msg: CollectProtocolFees) {
        require(context().value >= COLLECT_GAS, "Insufficient TON attached");
        let pool = self.poolAddress(msg.tokenA, msg.tokenB);
        message(MessageParameters {
            to: pool,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: PoolCollectFees { queryId: msg.queryId, treasury: self.treasury, excessTo: sender() }.toCell(),
        });
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    receive(msg: SetPoolFees) {
        self.requireAdmin();
        require(msg.lpFeeBps <= MAX_LP_FEE_BPS && msg.protocolFeeBps <= MAX_PROTOCOL_FEE_BPS, "Fee above cap");
        let pool = self.poolAddress(msg.tokenA, msg.tokenB);
        // No StateInit: a missing pool bounces the gas back here.
        message(MessageParameters {
            to: pool,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: PoolSetFees {
                queryId: msg.queryId,
                lpFeeBps: msg.lpFeeBps,
                protocolFeeBps: msg.protocolFeeBps,
                excessTo: sender(),
            }.toCell(),
        });
    }

    receive(msg: SetCreationPaused) {
        self.requireAdmin();
        self.creationPaused = msg.paused;
        self.refundRemaining(msg.queryId);
    }

    receive(msg: SetTreasury) {
        self.requireAdmin();
        // Fees paid to the Router would land in its own wallets, unaccounted.
        require(msg.treasury != myAddress(), "Invalid recipient");
        self.treasury = msg.treasury;
        self.refundRemaining(msg.queryId);
    }

    // Step 1 of 2. TransferAdmin(self) cancels a pending transfer.
    receive(msg: TransferAdmin) {
        self.requireAdmin();
        self.pendingAdmin = msg.newAdmin == self.admin ? null : msg.newAdmin;
        self.refundRemaining(msg.queryId);
    }

    receive(msg: ClaimAdmin) {
        require(self.pendingAdmin != null && sender() == self.pendingAdmin!!, "Not pending admin");
        self.admin = self.pendingAdmin!!;
        self.pendingAdmin = null;
        self.refundRemaining(msg.queryId);
    }

    // Safe because the Router never holds user Gram at rest.
    receive(msg: WithdrawRouterExcess) {
        self.requireAdmin();
        nativeReserve(ROUTER_MIN_STORAGE, ReserveAtMost);
        message(MessageParameters {
            to: self.treasury,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: JettonExcesses { queryId: msg.queryId }.toCell(),
        });
    }

    // Top-ups, and excesses from our own jetton wallets.
    receive() {}

    receive(msg: JettonExcesses) {}

    // A JettonTransfer to one of our wallets bounced: only a broken or malicious jetton does this,
    // and it only affects pools of that token. Keep the Gram, never throw, but leave a trace for
    // indexers (user = the wallet that rejected it).
    bounced(msg: bounced<JettonTransfer>) {
        emit(RefundEvent { queryId: msg.queryId, user: sender(), code: CODE_TRANSFER_BOUNCED }.toCell());
    }

    // A bounced admin/collect message to a missing pool: keep the Gram, never throw.
    bounced(msg: Slice) {}

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    fun swapJetton(tokenIn: Address, queryId: Int, amount: Int, from: Address, sp: SwapPayload) {
        let ctx = context();
        let refundTo = sp.refundTo != null ? sp.refundTo!! : from;
        let refBps = sp.referral == null ? 0 : sp.refBps;
        let code = 0;
        if (self.isMe(sp.receiver) || self.isMe(sp.refundTo) || self.isMe(sp.referral)) {
            // A payout to the Router would come back as a notification from the Router itself.
            code = CODE_BAD_RECIPIENT;
            refundTo = from;
        } else if (!isBasechain(sp.askToken)) {
            code = CODE_BAD_TOKEN;
        } else if (sp.askToken == tokenIn) {
            code = CODE_SAME_TOKEN;
        } else if (now() > sp.deadline) {
            code = CODE_DEADLINE;
        } else if (refBps > MAX_REF_FEE_BPS) {
            code = CODE_BAD_REF_BPS;
        } else {
            let pFee = payloadFee(sp.fwdPayload);
            if (pFee < 0) {
                code = CODE_BAD_PAYLOAD;
            } else {
                // A referral in a jetton is paid with its own fixed-value PayTo. The output's payload
                // pays a forward fee on every hop it still has to travel.
                let required = SWAP_GAS + sp.fwdTon + pFee + (refBps > 0 ? JETTON_PAYOUT_VALUE : 0) +
                    2 * ctx.readForwardFee();
                if (ctx.value < required) {
                    code = CODE_LOW_GAS;
                }
            }
        }
        if (code != 0) {
            self.refundJetton(tokenIn, queryId, amount, refundTo, code);
            return;
        }

        let inIsToken0 = sortKey(tokenIn) < sortKey(sp.askToken);
        self.sendToPool(tokenIn, sp.askToken, PoolSwap {
            queryId,
            fromUser: from,
            inIsToken0,
            amountIn: amount,
            minOut: sp.minOut,
            deadline: sp.deadline,
            receiver: sp.receiver != null ? sp.receiver!! : from,
            refundTo,
            referral: sp.referral,
            refBps,
            fwdTon: sp.fwdTon,
            fwdPayload: sp.fwdPayload,
        }.toCell());
    }

    fun provideJetton(tokenIn: Address, queryId: Int, amount: Int, from: Address, pp: ProvideLpPayload) {
        let ctx = context();
        let refundTo = pp.refundTo != null ? pp.refundTo!! : from;
        let code = 0;
        if (self.isMe(pp.lpReceiver) || self.isMe(pp.refundTo)) {
            code = CODE_BAD_RECIPIENT;
            refundTo = from;
        } else if (!isBasechain(pp.otherToken)) {
            code = CODE_BAD_TOKEN;
        } else if (pp.otherToken == tokenIn) {
            code = CODE_SAME_TOKEN;
        } else if (now() > pp.deadline) {
            code = CODE_DEADLINE;
        } else if (ctx.value < PROVIDE_GAS + 2 * ctx.readForwardFee()) {
            code = CODE_LOW_GAS;
        }
        if (code != 0) {
            self.refundJetton(tokenIn, queryId, amount, refundTo, code);
            return;
        }

        let inIsToken0 = sortKey(tokenIn) < sortKey(pp.otherToken);
        self.sendToPool(tokenIn, pp.otherToken, PoolProvide {
            queryId,
            user: from,
            amount0: inIsToken0 ? amount : 0,
            amount1: inIsToken0 ? 0 : amount,
            minLpOut: pp.minLpOut,
            deadline: pp.deadline,
            lpReceiver: pp.lpReceiver != null ? pp.lpReceiver!! : from,
            refundTo,
            allowCreate: !self.creationPaused,
            requireEmpty: false,
        }.toCell());
    }

    // Dual deposit / graduation: the Gram leg arrived as the notification's value.
    fun provideBoth(tokenIn: Address, queryId: Int, amount: Int, from: Address, bp: ProvideBothPayload) {
        let ctx = context();
        let code = 0;
        let refundTo = bp.refundTo;
        if (bp.lpReceiver == myAddress() || bp.refundTo == myAddress()) {
            code = CODE_BAD_RECIPIENT;
            refundTo = from;
        } else if (bp.gramAmount == 0) {
            code = CODE_BAD_PAYLOAD;
        } else if (now() > bp.deadline) {
            code = CODE_DEADLINE;
        } else if (ctx.value < bp.gramAmount + PROVIDE_BOTH_GAS + 2 * ctx.readForwardFee()) {
            code = CODE_LOW_GAS;
        }
        if (code != 0) {
            // The Gram that did arrive goes back with the refund as excess.
            self.refundJetton(tokenIn, queryId, amount, refundTo, code);
            return;
        }

        self.sendToPool(GRAM, tokenIn, PoolProvide {
            queryId,
            user: from,
            amount0: bp.gramAmount,
            amount1: amount,
            minLpOut: bp.minLpOut,
            deadline: bp.deadline,
            lpReceiver: bp.lpReceiver,
            refundTo: bp.refundTo,
            allowCreate: !self.creationPaused,
            requireEmpty: bp.requireEmpty,
        }.toCell());
    }

    // Deploy-or-call the pool of (a, b), non-bounceable, forwarding everything we received.
    fun sendToPool(a: Address, b: Address, body: Cell) {
        let ctx = context();
        let init = self.sortedPool(a, b);
        nativeReserve(max(myBalance() - ctx.value, ROUTER_MIN_STORAGE), ReserveAtMost);
        deploy(DeployParameters {
            init,
            value: 0,
            mode: SendRemainingBalance,
            bounce: false,
            body,
        });
    }

    // Send jettons back through our wallet `wallet` (= the token id), with the remaining gas.
    fun refundJetton(wallet: Address, queryId: Int, amount: Int, to: Address, code: Int) {
        let ctx = context();
        emit(RefundEvent { queryId, user: to, code }.toCell());
        nativeReserve(max(myBalance() - ctx.value, ROUTER_MIN_STORAGE), ReserveAtMost);
        message(MessageParameters {
            to: wallet,
            value: 0,
            mode: SendRemainingBalance,
            bounce: true,
            body: JettonTransfer {
                queryId,
                amount,
                destination: to,
                responseDestination: to,
                customPayload: null,
                forwardTonAmount: 0,
                forwardPayload: beginCell().storeBool(false).asSlice(),
            }.toCell(),
        });
    }

    fun isMe(a: Address?): Bool {
        return a != null && a!! == myAddress();
    }

    fun requireAdmin() {
        require(sender() == self.admin, "Not admin");
        require(context().value >= ADMIN_GAS, "Insufficient TON attached");
    }

    fun refundRemaining(queryId: Int) {
        message(MessageParameters {
            to: sender(),
            value: 0,
            mode: SendRemainingValue | SendIgnoreErrors,
            bounce: false,
            body: JettonExcesses { queryId }.toCell(),
        });
    }

    fun sortedPool(a: Address, b: Address): StateInit {
        return sortKey(a) < sortKey(b) ? initOf Pool(myAddress(), a, b) : initOf Pool(myAddress(), b, a);
    }

    fun poolAddress(a: Address, b: Address): Address {
        return contractAddress(self.sortedPool(a, b));
    }

    // -----------------------------------------------------------------------
    // Getters
    // -----------------------------------------------------------------------

    // Arguments are Router-wallet token ids or GRAM, in any order.
    get fun get_pool_address(tokenA: Address, tokenB: Address): Address {
        return self.poolAddress(tokenA, tokenB);
    }

    get fun get_router_data(): RouterData {
        return RouterData {
            admin: self.admin,
            pendingAdmin: self.pendingAdmin,
            treasury: self.treasury,
            creationPaused: self.creationPaused,
        };
    }

    // Extra forward value a swap must attach for `fwdPayload` (added to SWAP_GAS + fwdTon);
    // -1 if the payload is above MAX_PAYLOAD_CELLS and would be refused.
    get fun get_payload_fee(fwdPayload: Cell?): Int {
        return payloadFee(fwdPayload);
    }

    get fun get_gram_token(): Address {
        return GRAM;
    }

    get fun get_lp_account_address(tokenA: Address, tokenB: Address, user: Address): Address {
        return contractAddress(initOf LpAccount(self.poolAddress(tokenA, tokenB), user));
    }
}
