import "./messages";
import "./constants";
import "./pool";

// Marg DEX v2 Router: the single entry point and the custodian of all jettons (one Router wallet
// per jetton = the token id). It parses payloads, validates keys, gas and recipients, deploys
// each Pool(router, key) on first use (non-bounceable + StateInit), and moves jettons only when an
// authenticated Pool commands it (PayTo). It keeps no per-pool state.
contract Router {
    admin: Address;
    pendingAdmin: Address?;
    treasury: Address;
    creationPaused: Bool;
    presets: map<Int as uint16, FeePreset>;     // tickSpacing -> preset, ADD-ONLY
    platformBps: Int as uint16;                 // PLATFORM FEE of launch keys, admin-set in [0, PLATFORM_FEE_CAP_BPS]

    init(admin: Address, treasury: Address) {
        // v3 (audit M-2): a treasury outside basechain fails every platform payout.
        require(isBasechain(treasury), "Invalid recipient");
        self.admin = admin;
        self.pendingAdmin = null;
        self.treasury = treasury;
        self.creationPaused = false;
        self.platformBps = PLATFORM_FEE_CAP_BPS;
        self.presets = emptyMap();
        self.presets.set(1, FeePreset { baseFeePips: 100, varFeeControl: 400000, filterPeriod: 10, decayPeriod: 120, reductionBps: 5000, maxVolAcc: 350000 });
        self.presets.set(10, FeePreset { baseFeePips: 500, varFeeControl: 40000, filterPeriod: 30, decayPeriod: 600, reductionBps: 5000, maxVolAcc: 350000 });
        self.presets.set(60, FeePreset { baseFeePips: 3000, varFeeControl: 4500, filterPeriod: 30, decayPeriod: 600, reductionBps: 5000, maxVolAcc: 350000 });
        self.presets.set(200, FeePreset { baseFeePips: 10000, varFeeControl: 600, filterPeriod: 30, decayPeriod: 600, reductionBps: 5000, maxVolAcc: 350000 });
    }

    // -----------------------------------------------------------------------
    // Jetton entry (non-bounceable notification: never throw, every failure refunds)
    // -----------------------------------------------------------------------

    receive(msg: JettonNotification) {
        let ctx = context();
        let tokenIn = ctx.sender;

        if (ctx.value < ROUTER_REFUND_MIN) {
            emit(RefundEvent { queryId: msg.queryId, user: msg.sender, code: CODE_LOW_GAS }.toCell());
            return;
        }
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
        if (msg.sender == myAddress() || !isBasechain(msg.sender)) {
            emit(RefundEvent { queryId: msg.queryId, user: msg.sender, code: CODE_BAD_RECIPIENT }.toCell());
            return;
        }
        if (!isBasechain(tokenIn)) {
            self.refundJetton(tokenIn, msg.queryId, msg.amount, msg.sender, CODE_BAD_TOKEN, 0);
            return;
        }

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
                self.refundJetton(tokenIn, msg.queryId, msg.amount, msg.sender, CODE_BAD_PAYLOAD, 0);
                return;
            }
            self.swapJetton(tokenIn, msg.queryId, msg.amount, msg.sender, sp!!);
            return;
        }
        if (op == OP_MINT_PAYLOAD) {
            let mp: MintPayload? = null;
            try {
                mp = MintPayload.fromSlice(p);
            } catch (e) {
                mp = null;
            }
            if (mp == null) {
                self.refundJetton(tokenIn, msg.queryId, msg.amount, msg.sender, CODE_BAD_PAYLOAD, 0);
                return;
            }
            self.mintJetton(tokenIn, msg.queryId, msg.amount, msg.sender, mp!!, false);
            return;
        }
        if (op == OP_MINT_NOTIFY_PAYLOAD) {
            let np: MintNotifyPayload? = null;
            try {
                np = MintNotifyPayload.fromSlice(p);
            } catch (e) {
                np = null;
            }
            if (np == null) {
                self.refundJetton(tokenIn, msg.queryId, msg.amount, msg.sender, CODE_BAD_PAYLOAD, NOTIFY_FWD_TON);
                return;
            }
            let n = np!!;
            self.mintJetton(tokenIn, msg.queryId, msg.amount, msg.sender, MintPayload {
                otherToken: n.otherToken, tickSpacing: n.tickSpacing, ext: n.ext, tickLower: n.tickLower,
                tickUpper: n.tickUpper, gramAmount: n.gramAmount, viaAccount: false, sqrtPriceInitX96: n.sqrtPriceInitX96,
                minLiquidity: n.minLiquidity, owner: n.owner, refundTo: n.refundTo, deadline: n.deadline,
                sqrtPriceMinX96: n.sqrtPriceMinX96, sqrtPriceMaxX96: n.sqrtPriceMaxX96,
            }, true);
            return;
        }
        if (op == OP_GRADUATE_PAYLOAD) {
            let gp: GraduatePayload? = null;
            try {
                gp = GraduatePayload.fromSlice(p);
            } catch (e) {
                gp = null;
            }
            if (gp == null) {
                self.refundJetton(tokenIn, msg.queryId, msg.amount, msg.sender, CODE_BAD_PAYLOAD, 0);
                return;
            }
            self.graduate(tokenIn, msg.queryId, msg.amount, msg.sender, gp!!);
            return;
        }
        if (op == OP_LAUNCH_PAYLOAD) {
            let lp: LaunchPayload? = null;
            try {
                lp = LaunchPayload.fromSlice(p);
            } catch (e) {
                lp = null;
            }
            if (lp == null) {
                self.refundJetton(tokenIn, msg.queryId, msg.amount, msg.sender, CODE_BAD_PAYLOAD, 0);
                return;
            }
            self.launch(tokenIn, msg.queryId, msg.amount, msg.sender, lp!!);
            return;
        }
        self.refundJetton(tokenIn, msg.queryId, msg.amount, msg.sender, CODE_BAD_PAYLOAD, 0);
    }

    // -----------------------------------------------------------------------
    // Native entries (bounceable from a wallet: a throw returns the Gram)
    // -----------------------------------------------------------------------

    receive(msg: SwapNative) {
        let ctx = context();
        require(msg.amount > 0, "Invalid amount");
        require(msg.otherToken != GRAM && isBasechain(msg.otherToken), "Invalid token");
        require(now() <= msg.deadline, "Deadline");
        require(msg.refBps <= MAX_REF_FEE_BPS, "Fee above cap");
        require(isBasechainOpt(msg.receiver) && isBasechainOpt(msg.refundTo) && isBasechainOpt(msg.referral), "Invalid recipient");
        require(msg.maxCrossings >= 1 && msg.maxCrossings <= MAX_CROSSINGS_CAP, "Invalid crossings");
        require(!self.isMe(msg.receiver) && !self.isMe(msg.refundTo) && !self.isMe(msg.referral), "Invalid recipient");
        require(self.presets.get(msg.tickSpacing) != null, "Invalid tick spacing");
        let flags = self.extFlags(msg.ext);
        require(flags >= 0, "Invalid key");
        let pFee = payloadFee(msg.fwdPayload);
        require(pFee >= 0, "Payload too large");
        let refBps = msg.referral == null ? 0 : msg.refBps;
        require(ctx.value >= msg.amount + self.swapGas(msg.maxCrossings, msg.allowPartial, refBps, flags, true) +
            msg.fwdTon + pFee + 2 * ctx.readForwardFee(), "Insufficient TON attached");

        let from = ctx.sender;
        let key = PoolKey { token0: GRAM, token1: msg.otherToken, tickSpacing: msg.tickSpacing, ext: msg.ext };
        self.sendToPool(key, PoolSwap {
            queryId: msg.queryId,
            fromUser: from,
            zeroForOne: true,
            amountIn: msg.amount,
            minOut: msg.minOut,
            sqrtPriceLimitX96: msg.sqrtPriceLimitX96,
            maxCrossings: msg.maxCrossings,
            allowPartial: msg.allowPartial,
            deadline: msg.deadline,
            receiver: msg.receiver != null ? msg.receiver!! : from,
            refundTo: msg.refundTo != null ? msg.refundTo!! : from,
            referral: msg.referral,
            refBps,
            fwdTon: msg.fwdTon,
            fwdPayload: msg.fwdPayload,
            platformBps: self.platformBps,
            platformTo: self.treasury,
        }.toCell());
    }

    receive(msg: MintNative) {
        self.mintNative(msg, false);
    }

    // Notifying mint (§6.14): same checks, MINT_NOTIFY_GAS more; the payer gets a MintReceipt.
    receive(msg: MintNativeNotify) {
        self.mintNative(MintNative {
            queryId: msg.queryId, amount: msg.amount, otherToken: msg.otherToken, tickSpacing: msg.tickSpacing,
            ext: msg.ext, tickLower: msg.tickLower, tickUpper: msg.tickUpper, sqrtPriceInitX96: msg.sqrtPriceInitX96,
            minLiquidity: msg.minLiquidity, owner: msg.owner, refundTo: msg.refundTo, deadline: msg.deadline,
            sqrtPriceMinX96: msg.sqrtPriceMinX96, sqrtPriceMaxX96: msg.sqrtPriceMaxX96,
        }, true);
    }

    fun mintNative(msg: MintNative, notify: Bool) {
        let ctx = context();
        require(msg.amount > 0, "Invalid amount");
        require(msg.otherToken != GRAM && isBasechain(msg.otherToken), "Invalid token");
        require(now() <= msg.deadline, "Deadline");
        require(!self.isMe(msg.owner) && !self.isMe(msg.refundTo), "Invalid recipient");
        require(isBasechainOpt(msg.owner) && isBasechainOpt(msg.refundTo), "Invalid recipient");
        let preset = self.presets.get(msg.tickSpacing);
        require(preset != null, "Invalid tick spacing");
        let flags = self.extFlags(msg.ext);
        require(flags >= 0, "Invalid key");
        require(ctx.value >= msg.amount + MINT_GAS + self.hookValue(flags, HOOK_AFTER_MODIFY) +
            (notify ? MINT_NOTIFY_GAS : 0) + 2 * ctx.readForwardFee(), "Insufficient TON attached");

        let from = ctx.sender;
        let key = PoolKey { token0: GRAM, token1: msg.otherToken, tickSpacing: msg.tickSpacing, ext: msg.ext };
        let params = MintParams {
            tickLower: msg.tickLower,
            tickUpper: msg.tickUpper,
            sqrtPriceInitX96: msg.sqrtPriceInitX96,
            minLiquidity: msg.minLiquidity,
            owner: msg.owner != null ? msg.owner!! : from,
            refundTo: msg.refundTo != null ? msg.refundTo!! : from,
            deadline: msg.deadline,
            sqrtPriceMinX96: msg.sqrtPriceMinX96,
            sqrtPriceMaxX96: msg.sqrtPriceMaxX96,
        };
        if (notify) {
            self.sendToPool(key, PoolMintNotify {
                queryId: msg.queryId, fromUser: from, amount0: msg.amount, amount1: 0, params,
                allowInit: !self.creationPaused, preset: preset!!,
            }.toCell());
            return;
        }
        self.sendToPool(key, PoolMint {
            queryId: msg.queryId,
            fromUser: from,
            amount0: msg.amount,
            amount1: 0,
            params,
            viaAccount: false,
            allowInit: !self.creationPaused,
            preset: preset!!,
        }.toCell());
    }

    // -----------------------------------------------------------------------
    // Pool -> Router: pay out jettons. Authenticated by recomputing the pool address from the key.
    // -----------------------------------------------------------------------

    receive(msg: PayTo) {
        let pool = contractAddress(initOf Pool(myAddress(), msg.key));
        require(sender() == pool, "Not pool");
        require(msg.wallet != GRAM && (msg.wallet == msg.key.token0 || msg.wallet == msg.key.token1), "Invalid token");

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
    // Fee collection (anyone; protocol fees always go to the treasury)
    // -----------------------------------------------------------------------

    // TAX plugin: anyone may trigger; the tax always goes to the key's taxRecipient.
    receive(msg: CollectTax) {
        require(context().value >= COLLECT_GAS, "Insufficient TON attached");
        self.toPool(msg.key, PoolCollectTax { queryId: msg.queryId, excessTo: sender() }.toCell());
    }

    // PLATFORM FEE: anyone may flush a pool's carried platform fees; they always go to the treasury.
    receive(msg: CollectPlatformFees) {
        require(context().value >= COLLECT_GAS, "Insufficient TON attached");
        self.toPool(msg.key, PoolCollectPlatform { queryId: msg.queryId, treasury: self.treasury, excessTo: sender() }.toCell());
    }

    // v3: anyone may send a pool's unaccounted surplus Gram to the treasury (see PoolSweepSurplus).
    receive(msg: SweepPoolSurplus) {
        require(context().value >= COLLECT_GAS, "Insufficient TON attached");
        self.toPool(msg.key, PoolSweepSurplus { queryId: msg.queryId, treasury: self.treasury, excessTo: sender() }.toCell());
    }

    receive(msg: CollectProtocolFees) {
        require(context().value >= COLLECT_GAS, "Insufficient TON attached");
        self.toPool(msg.key, PoolCollectProtocol { queryId: msg.queryId, treasury: self.treasury, excessTo: sender() }.toCell());
    }

    // -----------------------------------------------------------------------
    // Admin (strictly capped: no access to funds, no pausing swaps or withdrawals, no upgrades)
    // -----------------------------------------------------------------------

    receive(msg: SetProtocolShare) {
        self.requireAdmin();
        require(msg.shareBps <= MAX_PROTOCOL_SHARE_BPS, "Fee above cap");
        message(MessageParameters {
            to: contractAddress(initOf Pool(myAddress(), msg.key)),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: PoolSetProtocolShare { queryId: msg.queryId, shareBps: msg.shareBps, excessTo: sender() }.toCell(),
        });
    }

    receive(msg: AddFeePreset) {
        self.requireAdmin();
        let s = msg.tickSpacing;
        require(s >= 1 && s <= MAX_TICK_SPACING, "Invalid tick spacing");
        require(self.presets.get(s) == null, "Preset exists");
        let p = msg.preset;
        require(p.baseFeePips <= MAX_BASE_FEE_PIPS, "Fee above cap");
        require(p.reductionBps <= BPS && p.filterPeriod <= p.decayPeriod, "Invalid preset");
        self.presets.set(s, p);
        self.refundRemaining(msg.queryId);
    }

    // Any rate in [0, PLATFORM_FEE_CAP_BPS] (lower or raise again), never above the code cap.
    receive(msg: SetPlatformFee) {
        self.requireAdmin();
        require(msg.bps <= PLATFORM_FEE_CAP_BPS, "Fee above cap");
        self.platformBps = msg.bps;
        self.refundRemaining(msg.queryId);
    }

    receive(msg: SetCreationPaused) {
        self.requireAdmin();
        self.creationPaused = msg.paused;
        self.refundRemaining(msg.queryId);
    }

    receive(msg: SetTreasury) {
        self.requireAdmin();
        // v3 (audit M-2): basechain only. A workchain-1, anycast or addr_var treasury would fail
        // the platform payout inside every launch-key swap.
        require(msg.treasury != myAddress() && isBasechain(msg.treasury), "Invalid recipient");
        self.treasury = msg.treasury;
        self.refundRemaining(msg.queryId);
    }

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

    receive() {}

    receive(msg: JettonExcesses) {}

    bounced(msg: bounced<JettonTransfer>) {
        emit(RefundEvent { queryId: msg.queryId, user: sender(), code: CODE_TRANSFER_BOUNCED }.toCell());
    }

    bounced(msg: Slice) {}

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    fun swapJetton(tokenIn: Address, queryId: Int, amount: Int, from: Address, sp: SwapPayload) {
        let ctx = context();
        let refundTo = sp.refundTo != null ? sp.refundTo!! : from;
        let refBps = sp.referral == null ? 0 : sp.refBps;
        let code = 0;
        let flags = 0;
        if (self.isMe(sp.receiver) || self.isMe(sp.refundTo) || self.isMe(sp.referral) ||
            !isBasechainOpt(sp.receiver) || !isBasechainOpt(sp.refundTo) || !isBasechainOpt(sp.referral)) {
            code = CODE_BAD_RECIPIENT;
            refundTo = from;
        } else if (!isBasechain(sp.otherToken)) {
            code = CODE_BAD_TOKEN;
        } else if (sp.otherToken == tokenIn) {
            code = CODE_SAME_TOKEN;
        } else if (now() > sp.deadline) {
            code = CODE_DEADLINE;
        } else if (refBps > MAX_REF_FEE_BPS) {
            code = CODE_BAD_REF_BPS;
        } else if (sp.maxCrossings < 1 || sp.maxCrossings > MAX_CROSSINGS_CAP) {
            code = CODE_BAD_CROSSINGS;
        } else if (self.presets.get(sp.tickSpacing) == null) {
            code = CODE_BAD_TICK_SPACING;
        } else {
            flags = self.extFlags(sp.ext);
            if (flags < 0 || ((flags & TAXED_FLAG) != 0 && sp.otherToken != GRAM)) {
                code = CODE_BAD_KEY;
            } else {
                let pFee = payloadFee(sp.fwdPayload);
                if (pFee < 0) {
                    code = CODE_BAD_PAYLOAD;
                } else if (ctx.value < self.swapGas(sp.maxCrossings, sp.allowPartial, refBps, flags, sp.otherToken == GRAM) +
                           sp.fwdTon + pFee + 2 * ctx.readForwardFee()) {
                    code = CODE_LOW_GAS;
                }
            }
        }
        if (code != 0) {
            self.refundJetton(tokenIn, queryId, amount, refundTo, code, 0);
            return;
        }

        let key = self.makeKey(tokenIn, sp.otherToken, sp.tickSpacing, sp.ext);
        self.sendToPool(key, PoolSwap {
            queryId,
            fromUser: from,
            zeroForOne: tokenIn == key.token0,
            amountIn: amount,
            minOut: sp.minOut,
            sqrtPriceLimitX96: sp.sqrtPriceLimitX96,
            maxCrossings: sp.maxCrossings,
            allowPartial: sp.allowPartial,
            deadline: sp.deadline,
            receiver: sp.receiver != null ? sp.receiver!! : from,
            refundTo,
            referral: sp.referral,
            refBps,
            fwdTon: sp.fwdTon,
            fwdPayload: sp.fwdPayload,
            platformBps: self.platformBps,
            platformTo: self.treasury,
        }.toCell());
    }

    // Mint entries (a) jetton only, (b) dual Gram + jetton, (d) jetton/jetton via MintAccount.
    // notify (MintNotifyPayload): PoolMintNotify instead of PoolMint; a refusal here refunds the
    // jetton with NOTIFY_FWD_TON so the payer's wallet notifies it.
    fun mintJetton(tokenIn: Address, queryId: Int, amount: Int, from: Address, mp: MintPayload, notify: Bool) {
        let ctx = context();
        let refundTo = mp.refundTo != null ? mp.refundTo!! : from;
        let code = 0;
        let flags = 0;
        if (self.isMe(mp.owner) || self.isMe(mp.refundTo) || !isBasechainOpt(mp.owner) || !isBasechainOpt(mp.refundTo)) {
            code = CODE_BAD_RECIPIENT;
            refundTo = from;
        } else if (!isBasechain(mp.otherToken)) {
            code = CODE_BAD_TOKEN;
        } else if (mp.otherToken == tokenIn) {
            code = CODE_SAME_TOKEN;
        } else if (now() > mp.deadline) {
            code = CODE_DEADLINE;
        } else if (mp.gramAmount > 0 && (mp.otherToken != GRAM || mp.viaAccount)) {
            code = CODE_BAD_PAYLOAD;
        } else if (mp.viaAccount && mp.otherToken == GRAM) {
            code = CODE_BAD_PAYLOAD;
        } else if (self.presets.get(mp.tickSpacing) == null) {
            code = CODE_BAD_TICK_SPACING;
        } else {
            flags = self.extFlags(mp.ext);
            if (flags < 0 || ((flags & TAXED_FLAG) != 0 && mp.otherToken != GRAM)) {
                code = CODE_BAD_KEY;
            } else if (ctx.value < mp.gramAmount + MINT_GAS + self.hookValue(flags, HOOK_AFTER_MODIFY) +
                       (notify ? MINT_NOTIFY_GAS : 0) + 2 * ctx.readForwardFee()) {
                code = CODE_LOW_GAS;
            }
        }
        if (code != 0) {
            self.refundJetton(tokenIn, queryId, amount, refundTo, code, notify ? NOTIFY_FWD_TON : 0);
            return;
        }

        let key = self.makeKey(tokenIn, mp.otherToken, mp.tickSpacing, mp.ext);
        let inIs0 = tokenIn == key.token0;
        let params = MintParams {
            tickLower: mp.tickLower,
            tickUpper: mp.tickUpper,
            sqrtPriceInitX96: mp.sqrtPriceInitX96,
            minLiquidity: mp.minLiquidity,
            owner: mp.owner != null ? mp.owner!! : from,
            refundTo,
            deadline: mp.deadline,
            sqrtPriceMinX96: mp.sqrtPriceMinX96,
            sqrtPriceMaxX96: mp.sqrtPriceMaxX96,
        };
        if (notify) {
            self.sendToPool(key, PoolMintNotify {
                queryId,
                fromUser: from,
                amount0: inIs0 ? amount : mp.gramAmount,
                amount1: inIs0 ? mp.gramAmount : amount,
                params,
                allowInit: !self.creationPaused,
                preset: self.presets.get(mp.tickSpacing)!!,
            }.toCell());
            return;
        }
        self.sendToPool(key, PoolMint {
            queryId,
            fromUser: from,
            amount0: inIs0 ? amount : mp.gramAmount,
            amount1: inIs0 ? mp.gramAmount : amount,
            params,
            viaAccount: mp.viaAccount,
            allowInit: !self.creationPaused,
            preset: self.presets.get(mp.tickSpacing)!!,
        }.toCell());
    }

    // Launchpad graduation: one jetton transfer whose forward value carries the Gram leg.
    // The key's initializer is the transferring owner (the launch master), so only it can
    // initialize this pool: launch pools cannot be squatted.
    fun graduate(tokenIn: Address, queryId: Int, amount: Int, from: Address, gp: GraduatePayload) {
        let ctx = context();
        let code = 0;
        let refundTo = gp.refundTo;
        let ext = KeyExt {
            hook: null, hookFlags: 0, hookShareBps: 0, hookFeeMin: 0, hookFeeMax: 0,
            initializer: from, launchFeePips: gp.launchFeePips, launchDuration: gp.launchDuration, minLockSecs: 0,
            taxRecipient: null, buyTaxBps: 0, sellTaxBps: 0,
        }.toCell();
        if (gp.feeClaimer == myAddress() || gp.refundTo == myAddress() ||
            !isBasechain(gp.feeClaimer) || !isBasechain(gp.refundTo)) {
            code = CODE_BAD_RECIPIENT;
            refundTo = from;
        } else if (gp.gramAmount == 0) {
            code = CODE_BAD_PAYLOAD;
        } else if (now() > gp.deadline) {
            code = CODE_DEADLINE;
        } else if (self.presets.get(gp.tickSpacing) == null) {
            code = CODE_BAD_TICK_SPACING;
        } else if (self.extFlags(ext) < 0) {
            code = CODE_BAD_KEY;
        } else if (ctx.value < gp.gramAmount + GRADUATE_GAS + 2 * ctx.readForwardFee()) {
            code = CODE_LOW_GAS;
        }
        if (code != 0) {
            self.refundJetton(tokenIn, queryId, amount, refundTo, code, 0);
            return;
        }
        let key = PoolKey { token0: GRAM, token1: tokenIn, tickSpacing: gp.tickSpacing, ext };
        self.sendToPool(key, PoolGraduate {
            queryId,
            fromUser: from,
            amount0: gp.gramAmount,
            amount1: amount,
            feeClaimer: gp.feeClaimer,
            refundTo: gp.refundTo,
            deadline: gp.deadline,
            // Review issue 3: launch keys (initializer = the transferring launch master) bypass
            // SetCreationPaused, else the refund strands the supply in the launch master.
            allowInit: true,
            preset: self.presets.get(gp.tickSpacing)!!,
        }.toCell());
    }

    // Direct launch (§6.11): one jetton transfer from the launch master (the transfer's sender is
    // the key's initializer). No Gram leg: the whole deposit becomes a jetton-only position that
    // starts at lp.sqrtPriceX96, locked forever for feeClaimer. forwardTonAmount carries the gas
    // and, optionally, the dev buy, which the Pool executes in the same transaction.
    fun launch(tokenIn: Address, queryId: Int, amount: Int, from: Address, lp: LaunchPayload) {
        let ctx = context();
        let code = 0;
        let refundTo = lp.refundTo;
        let ext = self.launchExt(from, lp.launchFeePips, lp.launchDuration, lp.taxRecipient, lp.buyTaxBps, lp.sellTaxBps);
        if (self.isMe(lp.feeClaimer) || self.isMe(lp.refundTo) || self.isMe(lp.devReceiver) ||
            !isBasechain(lp.feeClaimer) || !isBasechain(lp.refundTo) || !isBasechain(lp.devReceiver)) {
            code = CODE_BAD_RECIPIENT;
            refundTo = from;
        } else if (now() > lp.deadline) {
            code = CODE_DEADLINE;
        } else if (self.presets.get(lp.tickSpacing) == null) {
            code = CODE_BAD_TICK_SPACING;
        } else if (self.extFlags(ext) < 0) {
            code = CODE_BAD_KEY;
        } else if (lp.sqrtPriceX96 < MIN_SQRT_RATIO || lp.sqrtPriceX96 >= MAX_SQRT_RATIO) {
            code = CODE_PRICE_OUT_OF_RANGE;
        } else if (ctx.value < lp.devBuy + LAUNCH_GAS + (lp.devBuy > 0 ? DEV_BUY_GAS : 0) + 2 * ctx.readForwardFee()) {
            code = CODE_LOW_GAS;
        }
        if (code != 0) {
            self.refundJetton(tokenIn, queryId, amount, refundTo, code, 0);
            return;
        }
        let key = PoolKey { token0: GRAM, token1: tokenIn, tickSpacing: lp.tickSpacing, ext };
        self.sendToPool(key, PoolLaunch {
            queryId,
            fromUser: from,
            amount1: amount,
            sqrtPriceX96: lp.sqrtPriceX96,
            feeClaimer: lp.feeClaimer,
            refundTo: lp.refundTo,
            deadline: lp.deadline,
            devBuy: lp.devBuy,
            minDevOut: lp.minDevOut,
            devReceiver: lp.devReceiver,
            // Review issue 3: a launch key bypasses SetCreationPaused (see graduate()).
            allowInit: true,
            preset: self.presets.get(lp.tickSpacing)!!,
            platformBps: self.platformBps,
            platformTo: self.treasury,
        }.toCell());
    }

    fun launchExt(initializer: Address, launchFeePips: Int, launchDuration: Int, taxRecipient: Address?,
                  buyTaxBps: Int, sellTaxBps: Int): Cell {
        return KeyExt {
            hook: null, hookFlags: 0, hookShareBps: 0, hookFeeMin: 0, hookFeeMax: 0,
            initializer, launchFeePips, launchDuration, minLockSecs: 0,
            taxRecipient, buyTaxBps, sellTaxBps,
        }.toCell();
    }

    // Value a swap must attach besides fwdTon / payload / forward fees. It covers the worst case
    // for the user's own bounds, because the Router -> Pool hop is non-bounceable.
    // A charged key (platformGas) adds one direct platform-fee payout, a taxed key one tax
    // auto-payout (+ the recipient's TAX_PAYOUT_GAS). Unused value comes back with the output.
    // gramPool: the pair is Gram/jetton (the PLATFORM FEE is only ever taken in Gram).
    fun swapGas(maxCrossings: Int, allowPartial: Bool, refBps: Int, flags: Int, gramPool: Bool): Int {
        return SWAP_BASE_GAS + maxCrossings * CROSS_GAS +
            (allowPartial ? JETTON_PAYOUT_VALUE : 0) +
            (refBps > 0 ? JETTON_PAYOUT_VALUE : 0) +
            self.hookValue(flags, HOOK_AFTER_SWAP) +
            self.platformGas(flags, gramPool) +
            ((flags & TAXED_FLAG) != 0 ? PAYOUT_MSG_GAS + TAX_PAYOUT_GAS : 0);
    }

    // Mirrors Pool.platformCharged() (same PLATFORM_FEE_ALL_GRAM_POOLS switch).
    fun platformGas(flags: Int, gramPool: Bool): Int {
        return gramPool && (PLATFORM_FEE_ALL_GRAM_POOLS || (flags & LAUNCH_FLAG) != 0) ? PAYOUT_MSG_GAS : 0;
    }

    fun hookValue(flags: Int, bit: Int): Int {
        return (flags & bit) != 0 ? HOOK_NOTIFY_VALUE : 0;
    }

    // hookFlags of a valid ext (0 for null), or -1 when the ext is invalid or not canonical.
    fun extFlags(ext: Cell?): Int {
        if (ext == null) {
            return 0;
        }
        let flags = -1;
        try {
            let e = KeyExt.fromCell(ext!!);
            let ok = e.toCell().hash() == ext!!.hash();
            let f = e.hookFlags;
            if (e.hook != null) {
                ok = ok && isBasechain(e.hook!!) && e.hook!! != myAddress();
            }
            ok = ok && (f & HOOK_FLAGS_MASK) == f;
            ok = ok && !((f != 0 || e.hookShareBps > 0) && e.hook == null);
            ok = ok && e.hookShareBps <= MAX_HOOK_SHARE_BPS;
            if ((f & HOOK_FEE_CONTROL) != 0) {
                ok = ok && e.hookFeeMin <= e.hookFeeMax && e.hookFeeMax <= MAX_BASE_FEE_PIPS;
            } else {
                ok = ok && e.hookFeeMin == 0 && e.hookFeeMax == 0;
            }
            if (e.initializer != null) {
                ok = ok && isBasechain(e.initializer!!);
            }
            ok = ok && e.launchFeePips <= MAX_LAUNCH_FEE_PIPS;
            ok = ok && (e.launchDuration > 0) == (e.launchFeePips > 0);
            ok = ok && e.launchDuration <= MAX_LAUNCH_DURATION;
            ok = ok && e.minLockSecs <= MAX_MIN_LOCK;
            // TAX: caps, recipient iff taxed, initializer required. The Gram-pair rule is checked
            // by the entries (native entries always are; jetton entries need otherToken == GRAM).
            ok = ok && taxValid(e, true);
            if (e.taxRecipient != null) {
                ok = ok && isBasechain(e.taxRecipient!!) && e.taxRecipient!! != myAddress();
            }
            if (ok) {
                flags = f | (e.buyTaxBps > 0 || e.sellTaxBps > 0 ? TAXED_FLAG : 0) |
                    (e.initializer != null ? LAUNCH_FLAG : 0);
            }
        } catch (e) {
            flags = -1;
        }
        return flags;
    }

    fun makeKey(a: Address, b: Address, tickSpacing: Int, ext: Cell?): PoolKey {
        if (sortKey(a) < sortKey(b)) {
            return PoolKey { token0: a, token1: b, tickSpacing, ext };
        }
        return PoolKey { token0: b, token1: a, tickSpacing, ext };
    }

    // v3 (audit L-3): collect / sweep ops go out non-bounceable with the pool's StateInit, so a
    // key whose pool was never deployed (a typo, a wrong ext) still reaches a Pool, which returns
    // the caller's value as excess instead of the bounce being kept here.
    fun toPool(key: PoolKey, body: Cell) {
        require(self.extFlags(key.ext) >= 0, "Invalid key");
        deploy(DeployParameters {
            init: initOf Pool(myAddress(), key),
            value: 0,
            mode: SendRemainingValue,
            bounce: false,
            body,
        });
    }

    fun sendToPool(key: PoolKey, body: Cell) {
        let ctx = context();
        nativeReserve(max(myBalance() - ctx.value, ROUTER_MIN_STORAGE), ReserveAtMost);
        deploy(DeployParameters {
            init: initOf Pool(myAddress(), key),
            value: 0,
            mode: SendRemainingBalance,
            bounce: false,
            body,
        });
    }

    fun refundJetton(wallet: Address, queryId: Int, amount: Int, to: Address, code: Int, fwdTon: Int) {
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
                forwardTonAmount: fwdTon,
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

    // -----------------------------------------------------------------------
    // Getters
    // -----------------------------------------------------------------------

    get fun get_router_data(): RouterData {
        return RouterData {
            admin: self.admin,
            pendingAdmin: self.pendingAdmin,
            treasury: self.treasury,
            creationPaused: self.creationPaused,
        };
    }

    get fun get_preset(tickSpacing: Int): FeePreset? {
        return self.presets.get(tickSpacing);
    }

    get fun get_pool_address(tokenA: Address, tokenB: Address, tickSpacing: Int, ext: Cell?): Address {
        return contractAddress(initOf Pool(myAddress(), self.makeKey(tokenA, tokenB, tickSpacing, ext)));
    }

    get fun get_graduation_pool_address(jettonWalletOfRouter: Address, tickSpacing: Int, initializer: Address,
                                        launchFeePips: Int, launchDuration: Int): Address {
        let ext = KeyExt {
            hook: null, hookFlags: 0, hookShareBps: 0, hookFeeMin: 0, hookFeeMax: 0,
            initializer, launchFeePips, launchDuration, minLockSecs: 0,
            taxRecipient: null, buyTaxBps: 0, sellTaxBps: 0,
        }.toCell();
        return contractAddress(initOf Pool(myAddress(), PoolKey { token0: GRAM, token1: jettonWalletOfRouter, tickSpacing, ext }));
    }

    // Canonical key of a direct launch (initializer = the launch master).
    get fun get_launch_key(jettonWalletOfRouter: Address, tickSpacing: Int, initializer: Address, launchFeePips: Int,
                           launchDuration: Int, taxRecipient: Address?, buyTaxBps: Int, sellTaxBps: Int): PoolKey {
        return PoolKey {
            token0: GRAM, token1: jettonWalletOfRouter, tickSpacing,
            ext: self.launchExt(initializer, launchFeePips, launchDuration, taxRecipient, buyTaxBps, sellTaxBps),
        };
    }

    get fun get_launch_pool_address(jettonWalletOfRouter: Address, tickSpacing: Int, initializer: Address, launchFeePips: Int,
                                    launchDuration: Int, taxRecipient: Address?, buyTaxBps: Int, sellTaxBps: Int): Address {
        let ext = self.launchExt(initializer, launchFeePips, launchDuration, taxRecipient, buyTaxBps, sellTaxBps);
        return contractAddress(initOf Pool(myAddress(), PoolKey { token0: GRAM, token1: jettonWalletOfRouter, tickSpacing, ext }));
    }

    get fun get_mint_account_address(pool: Address, user: Address): Address {
        return contractAddress(initOf MintAccount(pool, user));
    }

    get fun get_payload_fee(fwdPayload: Cell?): Int {
        return payloadFee(fwdPayload);
    }

    get fun get_gram_token(): Address {
        return GRAM;
    }

    // Hook flags | TAXED_FLAG (256) | LAUNCH_FLAG (512), or -1 when the ext is invalid.
    get fun get_ext_valid(ext: Cell?): Int {
        return self.extFlags(ext);
    }

    get fun get_platform_fee(): Int {
        return self.platformBps;
    }

    // The minimum value a swap must attach besides amount, fwdTon, get_payload_fee and 2 forward
    // fees (the Router's own check); -1 for an invalid ext.
    // gramPool: one side is Gram (every SwapNative; a jetton swap with otherToken = GRAM).
    get fun get_swap_gas(maxCrossings: Int, allowPartial: Bool, refBps: Int, ext: Cell?, gramPool: Bool): Int {
        let flags = self.extFlags(ext);
        if (flags < 0) {
            return -1;
        }
        return self.swapGas(maxCrossings, allowPartial, refBps, flags, gramPool);
    }
}
