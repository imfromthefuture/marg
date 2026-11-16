import "./messages";
import "./constants";
import "./lp_wallet";
import "./lp_account";

// One x*y=k pool per sorted token pair, and the LP jetton master of that pool.
// token0/token1 are the Router's jetton wallet addresses, or GRAM for the native coin (always
// token0). A native pool holds its Gram reserve itself; jetton reserves sit in the Router's
// wallets and leave them only when this pool sends PayTo.
//
// Reserves live in storage and never derive from balances, so donations cannot move the price.
// Router -> Pool messages are non-bounceable: after the sender check every asset-path handler
// is total and turns each business failure into an explicit refund. Only the burn path throws,
// because there the bounce restores the LP balance.
contract Pool {
    router: Address;
    token0: Address;
    token1: Address;
    reserve0: Int as coins;
    reserve1: Int as coins;
    totalSupply: Int as coins;      // includes MIN_LIQUIDITY that is never minted
    lpFeeBps: Int as uint16;
    protocolFeeBps: Int as uint16;
    protocolFee0: Int as coins;     // accrued for the treasury, not part of the reserves
    protocolFee1: Int as coins;

    init(router: Address, token0: Address, token1: Address) {
        self.router = router;
        self.token0 = token0;
        self.token1 = token1;
        self.reserve0 = 0;
        self.reserve1 = 0;
        self.totalSupply = 0;
        self.lpFeeBps = DEFAULT_LP_FEE_BPS;
        self.protocolFeeBps = DEFAULT_PROTOCOL_FEE_BPS;
        self.protocolFee0 = 0;
        self.protocolFee1 = 0;
    }

    // -----------------------------------------------------------------------
    // Swap
    // -----------------------------------------------------------------------

    receive(msg: PoolSwap) {
        require(sender() == self.router, "Not router");

        let reserveIn = msg.inIsToken0 ? self.reserve0 : self.reserve1;
        let reserveOut = msg.inIsToken0 ? self.reserve1 : self.reserve0;
        let feeIn = msg.inIsToken0 ? self.protocolFee0 : self.protocolFee1;
        // No referral address means no referral fee.
        let refBps = msg.referral == null ? 0 : msg.refBps;

        let code = 0;
        let q = ExpectedOut { amountOut: 0, protocolFee: 0, refFee: 0 };
        if (now() > msg.deadline) {
            code = CODE_DEADLINE;
        } else if (refBps > MAX_REF_FEE_BPS) {
            code = CODE_BAD_REF_BPS;
        } else if (reserveIn == 0 || reserveOut == 0) {
            code = CODE_EMPTY_POOL;
        } else {
            q = calcSwapOut(msg.amountIn, reserveIn, reserveOut, self.lpFeeBps, self.protocolFeeBps, refBps);
            if (q.amountOut == 0) {
                code = CODE_ZERO_OUT;
            } else if (q.amountOut < msg.minOut) {
                code = CODE_SLIPPAGE;
            } else if (reserveIn + msg.amountIn - q.protocolFee - q.refFee > MAX_COINS ||
                       feeIn + q.protocolFee > MAX_COINS) {
                code = CODE_OVERFLOW;
            }
        }

        if (code != 0) {
            emit(RefundEvent { queryId: msg.queryId, user: msg.fromUser, code }.toCell());
            nativeReserve(self.keep(), ReserveExact);
            self.sendToken(msg.inIsToken0, msg.amountIn, msg.refundTo, msg.refundTo,
                REASON_SWAP_REFUND, msg.queryId, 0, null, true);
            return;
        }

        // Effects before interactions.
        let netIn = msg.amountIn - q.protocolFee - q.refFee;
        if (msg.inIsToken0) {
            self.reserve0 += netIn;
            self.protocolFee0 += q.protocolFee;
            self.reserve1 -= q.amountOut;
        } else {
            self.reserve1 += netIn;
            self.protocolFee1 += q.protocolFee;
            self.reserve0 -= q.amountOut;
        }

        // Events first: an external message after a SendRemainingBalance send could not be paid for.
        emit(SwapEvent {
            fromUser: msg.fromUser,
            inIsToken0: msg.inIsToken0,
            amountIn: msg.amountIn,
            amountOut: q.amountOut,
            protocolFee: q.protocolFee,
            refFee: q.refFee,
            reserve0: self.reserve0,
            reserve1: self.reserve1,
        }.toCell());

        nativeReserve(self.keep(), ReserveExact);
        if (q.refFee > 0) {
            // refFee > 0 implies refBps > 0, which implies referral != null.
            self.sendToken(msg.inIsToken0, q.refFee, msg.referral!!, msg.referral!!,
                REASON_REFERRAL, msg.queryId, 0, null, false);
        }
        self.sendToken(!msg.inIsToken0, q.amountOut, msg.receiver, msg.refundTo,
            REASON_SWAP_OUT, msg.queryId, msg.fwdTon, msg.fwdPayload, true);
    }

    // -----------------------------------------------------------------------
    // Add liquidity
    // -----------------------------------------------------------------------

    receive(msg: PoolProvide) {
        require(sender() == self.router, "Not router");

        let code = 0;
        if (now() > msg.deadline) {
            code = CODE_DEADLINE;
        } else if (self.totalSupply == 0 && !msg.allowCreate) {
            code = CODE_CREATION_PAUSED;
        } else if (msg.requireEmpty && self.totalSupply > 0) {
            code = CODE_POOL_NOT_EMPTY;
        }
        if (code != 0) {
            self.refundDeposit(msg.queryId, msg.user, msg.amount0, msg.amount1, msg.refundTo, code);
            return;
        }

        // Both sides in one message (dual deposit / graduation): no LpAccount needed.
        if (msg.amount0 > 0 && msg.amount1 > 0) {
            self.addLiquidity(msg.queryId, msg.user, msg.amount0, msg.amount1, msg.minLpOut,
                msg.lpReceiver, msg.refundTo, msg.allowCreate, msg.requireEmpty);
            return;
        }

        // One side: park it in LpAccount(pool, user). For a native side 0 the Gram travels with it.
        nativeReserve(self.keep(), ReserveExact);
        deploy(DeployParameters {
            init: initOf LpAccount(myAddress(), msg.user),
            value: 0,
            mode: SendRemainingBalance,
            bounce: false,
            body: LpAccountDeposit {
                queryId: msg.queryId,
                amount0: msg.amount0,
                amount1: msg.amount1,
                minLpOut: msg.minLpOut,
                lpReceiver: msg.lpReceiver,
                refundTo: msg.refundTo,
                allowCreate: msg.allowCreate,
                isNative: self.isNative(),
            }.toCell(),
        });
    }

    receive(msg: CbAddLiquidity) {
        require(sender() == contractAddress(initOf LpAccount(myAddress(), msg.user)), "Not LP account");
        self.addLiquidity(msg.queryId, msg.user, msg.amount0, msg.amount1, msg.minLpOut,
            msg.lpReceiver, msg.refundTo, msg.allowCreate, false);
    }

    receive(msg: CbRefund) {
        require(sender() == contractAddress(initOf LpAccount(myAddress(), msg.user)), "Not LP account");
        nativeReserve(self.keep(), ReserveExact);
        self.payTwo(msg.queryId, msg.amount0, msg.amount1, msg.user, msg.user, REASON_LP_ACCOUNT_REFUND);
    }

    // -----------------------------------------------------------------------
    // Remove liquidity (LP burn). This path may throw: the LpWallet's bounce handler restores
    // the LP balance and the Gram comes back with the bounce.
    // -----------------------------------------------------------------------

    receive(msg: LpBurnNotification) {
        let ctx = context();
        require(ctx.sender == contractAddress(initOf LpWallet(myAddress(), msg.sender)), "Not LP wallet");
        require(ctx.value >= BURN_POOL_GAS, "Insufficient TON attached");
        require(msg.amount > 0, "Invalid amount");
        // MIN_LIQUIDITY is never owned, so this always holds; checked anyway.
        require(msg.amount <= self.totalSupply - MIN_LIQUIDITY, "Invalid amount");

        let min0 = 0;
        let min1 = 0;
        if (msg.customPayload != null) {
            let p = RemoveParams.fromCell(msg.customPayload!!);
            require(now() <= p.deadline, "Deadline");
            min0 = p.min0;
            min1 = p.min1;
        }
        let e = calcBurn(msg.amount, self.reserve0, self.reserve1, self.totalSupply);
        require(e.out0 >= min0 && e.out1 >= min1, "Slippage");
        require(e.out0 + e.out1 > 0, "Invalid amount");

        self.reserve0 -= e.out0;
        self.reserve1 -= e.out1;
        self.totalSupply -= msg.amount;

        emit(LiquidityEvent {
            user: msg.sender,
            isAdd: false,
            amount0: e.out0,
            amount1: e.out1,
            lp: msg.amount,
            reserve0: self.reserve0,
            reserve1: self.reserve1,
            totalSupply: self.totalSupply,
        }.toCell());

        let excessTo = msg.responseDestination != null ? msg.responseDestination!! : msg.sender;
        nativeReserve(self.keep(), ReserveExact);
        self.payTwo(msg.queryId, e.out0, e.out1, msg.sender, excessTo, REASON_BURN_OUT);
    }

    // A mint that bounced (gas misconfigured): the reserves stay, so this is a donation to LPs.
    bounced(msg: bounced<JettonTransferInternal>) {
        self.totalSupply -= msg.amount;
    }

    // -----------------------------------------------------------------------
    // Admin (via Router) and fee collection
    // -----------------------------------------------------------------------

    receive(msg: PoolSetFees) {
        require(sender() == self.router, "Not router");
        // The caps are code constants, re-checked here so the Router cannot exceed them either.
        require(msg.lpFeeBps <= MAX_LP_FEE_BPS && msg.protocolFeeBps <= MAX_PROTOCOL_FEE_BPS, "Fee above cap");
        self.lpFeeBps = msg.lpFeeBps;
        self.protocolFeeBps = msg.protocolFeeBps;
        nativeReserve(self.keep(), ReserveExact);
        message(MessageParameters {
            to: msg.excessTo,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: JettonExcesses { queryId: msg.queryId }.toCell(),
        });
    }

    receive(msg: PoolCollectFees) {
        require(sender() == self.router, "Not router");
        let f0 = self.protocolFee0;
        let f1 = self.protocolFee1;
        self.protocolFee0 = 0;
        self.protocolFee1 = 0;
        nativeReserve(self.keep(), ReserveExact);
        self.payTwo(msg.queryId, f0, f1, msg.treasury, msg.excessTo, REASON_PROTOCOL_FEE);
    }

    // TEP-89 wallet discovery.
    receive(msg: ProvideWalletAddress) {
        require(context().value >= ton("0.0061"), "Insufficient TON attached");
        let ownerCell: Cell? = msg.includeAddress ? beginCell().storeAddress(msg.ownerAddress).endCell() : null;
        let walletAddress = isBasechain(msg.ownerAddress)
            ? contractAddress(initOf LpWallet(myAddress(), msg.ownerAddress))
            : newAddress(0, 0);
        message(MessageParameters {
            to: sender(),
            value: 0,
            mode: SendRemainingValue,
            bounce: false,
            body: TakeWalletAddress { queryId: msg.queryId, walletAddress, ownerAddress: ownerCell }.toCell(),
        });
    }

    // Top-ups only grow the storage buffer; they never change reserves or quotes.
    receive() {}

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    // Total after the caller's authentication: every failure refunds both legs.
    fun addLiquidity(queryId: Int, user: Address, a0: Int, a1: Int, minLpOut: Int,
                     lpReceiver: Address, refundTo: Address, allowCreate: Bool, requireEmpty: Bool) {
        let code = 0;
        let e = ExpectedLp { lp: 0, use0: 0, use1: 0 };
        let newSupply = 0;
        if (self.totalSupply == 0) {
            if (!allowCreate) {
                code = CODE_CREATION_PAUSED;
            } else {
                e = calcAddLiquidity(a0, a1, 0, 0, 0);
                newSupply = e.lp + MIN_LIQUIDITY;
            }
        } else if (requireEmpty) {
            code = CODE_POOL_NOT_EMPTY;
        } else {
            e = calcAddLiquidity(a0, a1, self.reserve0, self.reserve1, self.totalSupply);
            newSupply = self.totalSupply + e.lp;
        }
        if (code == 0) {
            if (e.lp == 0) {
                code = CODE_LP_BELOW_MIN;
            } else if (e.lp < minLpOut) {
                code = CODE_SLIPPAGE;
            } else if (self.reserve0 + e.use0 > MAX_COINS || self.reserve1 + e.use1 > MAX_COINS ||
                       newSupply > MAX_COINS) {
                code = CODE_OVERFLOW;
            }
        }
        if (code != 0) {
            self.refundDeposit(queryId, user, a0, a1, refundTo, code);
            return;
        }

        self.reserve0 += e.use0;
        self.reserve1 += e.use1;
        self.totalSupply = newSupply;

        emit(LiquidityEvent {
            user,
            isAdd: true,
            amount0: e.use0,
            amount1: e.use1,
            lp: e.lp,
            reserve0: self.reserve0,
            reserve1: self.reserve1,
            totalSupply: self.totalSupply,
        }.toCell());

        nativeReserve(self.keep(), ReserveExact);

        // Mint the LP.
        deploy(DeployParameters {
            init: initOf LpWallet(myAddress(), lpReceiver),
            value: LP_MINT_VALUE,
            mode: SendPayGasSeparately,
            bounce: true,
            body: JettonTransferInternal {
                queryId,
                amount: e.lp,
                sender: myAddress(),
                responseDestination: refundTo,
                forwardTonAmount: 0,
                forwardPayload: beginCell().storeBool(false).asSlice(),
            }.toCell(),
        });

        // Refund the unused side(s). Only one side is ever reduced, except by rounding.
        let unused0 = a0 - e.use0;
        let unused1 = a1 - e.use1;
        if (unused0 > 0 && !self.isNative()) {
            self.sendToken(true, unused0, refundTo, refundTo, REASON_LP_EXCESS, queryId, 0, null, false);
        }
        if (unused1 > 0) {
            self.sendToken(false, unused1, refundTo, refundTo, REASON_LP_EXCESS, queryId, 0, null, false);
        }
        if (unused0 > 0 && self.isNative()) {
            // Unused Gram plus the leftover gas.
            self.sendToken(true, unused0, refundTo, refundTo, REASON_LP_EXCESS, queryId, 0, null, true);
        } else {
            message(MessageParameters {
                to: refundTo,
                value: 0,
                mode: SendRemainingBalance | SendIgnoreErrors,
                bounce: false,
                body: JettonExcesses { queryId }.toCell(),
            });
        }
    }

    fun refundDeposit(queryId: Int, user: Address, a0: Int, a1: Int, refundTo: Address, code: Int) {
        emit(RefundEvent { queryId, user, code }.toCell());
        nativeReserve(self.keep(), ReserveExact);
        self.payTwo(queryId, a0, a1, refundTo, refundTo, REASON_PROVIDE_REFUND);
    }

    // Pays up to two legs. Jetton legs go first; the final leg takes the remaining balance (in a
    // native pool that is the Gram leg, which then also carries the leftover gas). When both
    // amounts are 0 the remaining balance goes to excessTo. The caller reserves keep() first.
    fun payTwo(queryId: Int, amount0: Int, amount1: Int, to: Address, excessTo: Address, reason: Int) {
        if (amount0 == 0 && amount1 == 0) {
            message(MessageParameters {
                to: excessTo,
                value: 0,
                mode: SendRemainingBalance | SendIgnoreErrors,
                bounce: false,
                body: JettonExcesses { queryId }.toCell(),
            });
            return;
        }
        if (self.isNative()) {
            if (amount1 > 0) {
                self.sendToken(false, amount1, to, excessTo, reason, queryId, 0, null, amount0 == 0);
            }
            if (amount0 > 0) {
                self.sendToken(true, amount0, to, excessTo, reason, queryId, 0, null, true);
            }
        } else {
            if (amount0 > 0) {
                self.sendToken(true, amount0, to, excessTo, reason, queryId, 0, null, amount1 == 0);
            }
            if (amount1 > 0) {
                self.sendToken(false, amount1, to, excessTo, reason, queryId, 0, null, true);
            }
        }
    }

    // One payout leg. Gram is sent directly; a jetton is a PayTo command to the Router.
    // `last` sends the whole remaining (unreserved) balance; otherwise a fixed value is used.
    fun sendToken(isToken0: Bool, amount: Int, to: Address, excessTo: Address, reason: Int,
                  queryId: Int, fwdTon: Int, fwdPayload: Cell?, last: Bool) {
        let token = isToken0 ? self.token0 : self.token1;
        if (token == GRAM) {
            message(MessageParameters {
                to,
                value: last ? 0 : amount,
                mode: last ? SendRemainingBalance : SendPayGasSeparately,
                bounce: false,
                body: GramPayout { queryId, reason, amount, payload: fwdPayload }.toCell(),
            });
        } else {
            message(MessageParameters {
                to: self.router,
                value: last ? 0 : JETTON_PAYOUT_VALUE + fwdTon,
                mode: last ? SendRemainingBalance : SendPayGasSeparately,
                bounce: false,
                body: PayTo {
                    queryId,
                    token0: self.token0,
                    token1: self.token1,
                    wallet: token,
                    amount,
                    to,
                    excessTo,
                    fwdTon,
                    fwdPayload,
                    reason,
                }.toCell(),
            });
        }
    }

    fun isNative(): Bool {
        return self.token0 == GRAM;
    }

    // Gram the pool must keep: the storage buffer plus, for a native pool, the Gram it owes.
    fun keep(): Int {
        return POOL_MIN_STORAGE + (self.isNative() ? self.reserve0 + self.protocolFee0 : 0);
    }

    // -----------------------------------------------------------------------
    // Getters
    // -----------------------------------------------------------------------

    get fun get_pool_data(): PoolData {
        return PoolData {
            router: self.router,
            token0: self.token0,
            token1: self.token1,
            reserve0: self.reserve0,
            reserve1: self.reserve1,
            totalSupply: self.totalSupply,
            lpFeeBps: self.lpFeeBps,
            protocolFeeBps: self.protocolFeeBps,
            protocolFee0: self.protocolFee0,
            protocolFee1: self.protocolFee1,
            isNative: self.isNative(),
        };
    }

    // 0 for an empty pool, a token not in the pair, or refBps above the cap.
    get fun get_expected_out(tokenIn: Address, amountIn: Int, refBps: Int): ExpectedOut {
        if (refBps < 0 || refBps > MAX_REF_FEE_BPS || (tokenIn != self.token0 && tokenIn != self.token1)) {
            return ExpectedOut { amountOut: 0, protocolFee: 0, refFee: 0 };
        }
        let inIsToken0 = tokenIn == self.token0;
        return calcSwapOut(amountIn,
            inIsToken0 ? self.reserve0 : self.reserve1,
            inIsToken0 ? self.reserve1 : self.reserve0,
            self.lpFeeBps, self.protocolFeeBps, refBps);
    }

    get fun get_expected_lp(amount0: Int, amount1: Int): ExpectedLp {
        return calcAddLiquidity(amount0, amount1, self.reserve0, self.reserve1, self.totalSupply);
    }

    get fun get_expected_burn(lpAmount: Int): ExpectedBurn {
        return calcBurn(lpAmount, self.reserve0, self.reserve1, self.totalSupply);
    }

    get fun get_lp_account_address(user: Address): Address {
        return contractAddress(initOf LpAccount(myAddress(), user));
    }

    get fun get_jetton_data(): JettonData {
        // On-chain TEP-64 metadata: 0x00 prefix + dict sha256(key) -> ^(0x00 + snake string).
        let m: map<Int as uint256, Cell> = emptyMap();
        m.set(sha256("name"), beginCell().storeUint(0, 8).storeSlice("Marg DEX LP".asSlice()).endCell());
        m.set(sha256("symbol"), beginCell().storeUint(0, 8).storeSlice("MARG-LP".asSlice()).endCell());
        m.set(sha256("decimals"), beginCell().storeUint(0, 8).storeSlice("9".asSlice()).endCell());
        return JettonData {
            totalSupply: self.totalSupply,
            mintable: true,
            adminAddress: null,
            jettonContent: beginCell().storeUint(0, 8).storeMaybeRef(m.asCell()).endCell(),
            jettonWalletCode: initOf LpWallet(myAddress(), myAddress()).code,
        };
    }

    get fun get_wallet_address(owner: Address): Address {
        return contractAddress(initOf LpWallet(myAddress(), owner));
    }
}
