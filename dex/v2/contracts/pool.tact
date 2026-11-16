import "./messages";
import "./constants";
import "./dict";
import "./math";
import "./fees";
import "./engine";
import "./position";
import "./mint_account";

// Outcome of a simulated swap: the receiver commits `res` only when code == 0; the getter
// returns the same values, so a quote equals execution for the same state and time.
struct Sim {
    code: Int;
    consumed: Int;
    refFee: Int;
    refund: Int;
    tax: Int;           // TAX plugin, in Gram (buy: from the input; sell: from the output)
    plat: Int;          // PLATFORM FEE, in Gram (same sides as the tax)
    out: Int;           // what the receiver gets: res.out minus a sell tax and sell platform fee
    res: SwapRes;
}

// One concentrated-liquidity pool per PoolKey (Uniswap-v3 tick engine + Meteora volatility fee),
// and the TEP-62 collection of its Position NFTs. A native pool holds its Gram itself; jettons
// sit in the Router's wallets and move only on this pool's PayTo.
//
// Router -> Pool messages are non-bounceable, so after authentication every asset path is total:
// all pure math runs inside try on locals, and any failure is an explicit refund with no state
// written.
contract Pool {
    router: Address;
    key: PoolKey;

    initialized: Bool;
    sqrtPriceX96: Int as uint160;
    tick: Int as int24;
    liquidity: Int as uint128;
    feeGrowth0X128: Int as uint256;
    feeGrowth1X128: Int as uint256;
    ticks: map<Int as int24, TickInfo>;
    tickCount: Int as uint16;

    reserve0: Int as coins;         // principal + unclaimed LP fees owed to positions
    reserve1: Int as coins;
    protocolFees0: Int as coins;
    protocolFees1: Int as coins;
    hookFees0: Int as coins;
    hookFees1: Int as coins;

    fs: FeeState;

    nextPositionId: Int as uint64;
    tickCumulative: Int as int64;   // TWAP accumulator: sum of tick * seconds
    obsTs: Int as uint32;
    endowment: Int as coins;        // Σ TICK_INIT_FEE paid: permanent storage endowment (in keep())
    taxFees: Int as coins;          // TAX plugin: Gram owed to key.ext.taxRecipient (in keep())
    platformFees: Int as coins;     // PLATFORM FEE carried below PLATFORM_MIN_PAYOUT (in keep())
    platformBps: Int as uint16;     // last PLATFORM FEE rate seen from the Router (get_quote uses it)

    init(router: Address, key: PoolKey) {
        self.router = router;
        self.key = key;
        self.initialized = false;
        self.sqrtPriceX96 = 0;
        self.tick = 0;
        self.liquidity = 0;
        self.feeGrowth0X128 = 0;
        self.feeGrowth1X128 = 0;
        self.ticks = emptyMap();
        self.tickCount = 0;
        self.reserve0 = 0;
        self.reserve1 = 0;
        self.protocolFees0 = 0;
        self.protocolFees1 = 0;
        self.hookFees0 = 0;
        self.hookFees1 = 0;
        self.fs = emptyFeeState();
        self.nextPositionId = 0;
        self.tickCumulative = 0;
        self.obsTs = 0;
        self.endowment = 0;
        self.taxFees = 0;
        self.platformFees = 0;
        self.platformBps = PLATFORM_FEE_CAP_BPS;
    }

    // -----------------------------------------------------------------------
    // Swap (exact-in)
    // -----------------------------------------------------------------------

    receive(msg: PoolSwap) {
        require(sender() == self.router, "Not router");
        let ext = extOf(self.key.ext);
        let refBps = msg.referral == null ? 0 : msg.refBps;
        let platBps = 0;
        if (self.platformCharged(ext)) {
            platBps = min(msg.platformBps, PLATFORM_FEE_CAP_BPS);
            self.platformBps = platBps;
        }

        if (now() > msg.deadline) {
            self.refundSwap(msg, CODE_DEADLINE);
            return;
        }
        let sim = self.simulate(ext, msg.zeroForOne, msg.amountIn, msg.sqrtPriceLimitX96, msg.maxCrossings,
            refBps, msg.allowPartial, msg.minOut, now(), platBps);
        if (sim.code != 0) {
            self.refundSwap(msg, sim.code);
            return;
        }

        self.commitSwap(sim, msg.zeroForOne, msg.fromUser);
        let res = sim.res;
        let pays = self.takePayouts(ext);

        self.reserveKeep();
        if (sim.refFee > 0) {
            self.sendToken(msg.zeroForOne, sim.refFee, msg.referral!!, msg.referral!!,
                REASON_REFERRAL, msg.queryId, 0, null, false);
        }
        if ((ext.hookFlags & HOOK_AFTER_SWAP) != 0 && ext.hook != null) {
            message(MessageParameters {
                to: ext.hook!!,
                value: HOOK_NOTIFY_VALUE,
                mode: SendPayGasSeparately,
                bounce: false,
                body: HookAfterSwap {
                    queryId: msg.queryId,
                    fromUser: msg.fromUser,
                    zeroForOne: msg.zeroForOne,
                    amountIn: sim.consumed + sim.refFee + (msg.zeroForOne ? sim.tax + sim.plat : 0),
                    amountOut: sim.out,
                    sqrtPriceX96: res.sqrtP,
                    tick: res.tick,
                    liquidity: res.liquidity,
                    feePips: res.lastFee,
                }.toCell(),
            });
        }
        self.sendPayouts(pays, ext, msg.platformTo, msg.queryId);
        if (sim.refund > 0) {
            self.sendToken(msg.zeroForOne, sim.refund, msg.refundTo, msg.refundTo,
                REASON_PARTIAL_REFUND, msg.queryId, 0, null, false);
        }
        self.sendToken(!msg.zeroForOne, sim.out, msg.receiver, msg.refundTo,
            REASON_SWAP_OUT, msg.queryId, msg.fwdTon, msg.fwdPayload, true);
    }

    // -----------------------------------------------------------------------
    // Mint (one new Position per mint)
    // -----------------------------------------------------------------------

    receive(msg: PoolMint) {
        require(sender() == self.router, "Not router");
        if (msg.viaAccount) {
            // Jetton/jetton in-range mint: park the leg in MintAccount(pool, user).
            self.reserveKeep();
            deploy(DeployParameters {
                init: initOf MintAccount(myAddress(), msg.fromUser),
                value: 0,
                mode: SendRemainingBalance,
                bounce: false,
                body: MintAccountDeposit {
                    queryId: msg.queryId,
                    amount0: msg.amount0,
                    amount1: msg.amount1,
                    params: msg.params,
                    allowInit: msg.allowInit,
                    preset: msg.preset,
                }.toCell(),
            });
            return;
        }
        self.doMint(msg.queryId, msg.fromUser, msg.amount0, msg.amount1, msg.params, msg.allowInit, msg.preset, false, false);
    }

    receive(msg: CbMint) {
        require(sender() == contractAddress(initOf MintAccount(myAddress(), msg.user)), "Not mint account");
        self.doMint(msg.queryId, msg.user, msg.amount0, msg.amount1, msg.params, msg.allowInit, msg.preset, false, false);
    }

    receive(msg: CbMintRefund) {
        require(sender() == contractAddress(initOf MintAccount(myAddress(), msg.user)), "Not mint account");
        self.reserveKeep();
        self.payTwo(msg.queryId, msg.amount0, msg.amount1, msg.user, msg.user, REASON_LP_ACCOUNT_REFUND, 0);
    }

    // Mismatched MintAccount legs (review issue 2): the parked leg goes to its own refundTo, the
    // arriving leg (last, takes the remaining value) to its own. Jetton/jetton only.
    receive(msg: CbMintReject) {
        require(sender() == contractAddress(initOf MintAccount(myAddress(), msg.user)), "Not mint account");
        emit(RefundEvent { queryId: msg.queryId, user: msg.user, code: CODE_MINT_MISMATCH }.toCell());
        self.reserveKeep();
        if (msg.stored0 > 0) {
            self.sendToken(true, msg.stored0, msg.storedTo, msg.storedTo, REASON_LP_ACCOUNT_REFUND, msg.queryId, 0, null, false);
        }
        if (msg.stored1 > 0) {
            self.sendToken(false, msg.stored1, msg.storedTo, msg.storedTo, REASON_LP_ACCOUNT_REFUND, msg.queryId, 0, null, false);
        }
        self.payTwo(msg.queryId, msg.amount0, msg.amount1, msg.refundTo, msg.refundTo, REASON_MINT_REFUND, 0);
    }

    // Launchpad graduation: price from the deposit ratio, full-range position locked forever whose
    // fees stay claimable by feeClaimer. Only the key's initializer can do it, and only once.
    receive(msg: PoolGraduate) {
        require(sender() == self.router, "Not router");
        let ext = extOf(self.key.ext);
        let code = 0;
        let sqrtP = sqrtFromAmounts(msg.amount0, msg.amount1);
        if (self.initialized) {
            code = CODE_ALREADY_INITIALIZED;
        } else if (ext.initializer == null || ext.initializer!! != msg.fromUser) {
            code = CODE_NOT_INITIALIZER;
        } else if (sqrtP < MIN_SQRT_RATIO || sqrtP >= MAX_SQRT_RATIO) {
            code = CODE_PRICE_OUT_OF_RANGE;
        }
        if (code != 0) {
            self.refundDeposit(msg.queryId, msg.fromUser, msg.amount0, msg.amount1, msg.refundTo, code);
            return;
        }
        let s = self.key.tickSpacing;
        self.doMint(msg.queryId, msg.fromUser, msg.amount0, msg.amount1, MintParams {
            tickLower: minUsable(s),
            tickUpper: maxUsable(s),
            sqrtPriceInitX96: sqrtP,
            minLiquidity: 0,
            owner: msg.feeClaimer,
            refundTo: msg.refundTo,
            deadline: msg.deadline,
            sqrtPriceMinX96: 0,
            sqrtPriceMaxX96: 0,
        }, msg.allowInit, msg.preset, true, false);
    }

    // Direct launch (§6.11): no curve, no Gram leg. The pool starts at the given price, floored to
    // the spacing (tU), and the whole jetton deposit becomes ONE position [minUsable, tU]: entirely
    // above the price for a Gram buyer (jetton per Gram falls as Gram comes in), so every buy is
    // filled from it. Owner feeClaimer, locked forever, fees claimable. Only the key's initializer
    // (the launch master) can do it, and only once. The optional dev buy runs in this same
    // transaction, right after the commit, so nothing can be ordered before it.
    receive(msg: PoolLaunch) {
        let ctx = context();
        require(ctx.sender == self.router, "Not router");
        let ext = extOf(self.key.ext);
        let s = self.key.tickSpacing;
        let t = now();
        let code = 0;
        let tU = 0;
        if (t > msg.deadline) {
            code = CODE_DEADLINE;
        } else if (self.initialized) {
            code = CODE_ALREADY_INITIALIZED;
        } else if (!msg.allowInit) {
            code = CODE_CREATION_PAUSED;
        } else if (ext.initializer == null || ext.initializer!! != msg.fromUser) {
            code = CODE_NOT_INITIALIZER;
        } else if (!self.isNative() || !taxValid(ext, true)) {
            code = CODE_BAD_KEY;
        } else if (msg.sqrtPriceX96 < MIN_SQRT_RATIO || msg.sqrtPriceX96 >= MAX_SQRT_RATIO) {
            code = CODE_PRICE_OUT_OF_RANGE;
        } else {
            tU = (tickAt(msg.sqrtPriceX96) / s) * s;     // floor (Tact `/` rounds toward -inf)
            if (tU <= minUsable(s) || tU > maxUsable(s)) {
                code = CODE_BAD_TICKS;
            }
        }
        let tL = minUsable(s);
        let sqrtP = 0;
        let m = MintRes {
            code: 0, liq: 0, use0: 0, use1: 0, liquidity: self.liquidity, ticks: self.ticks,
            tickCount: self.tickCount, newTicks: 0, inside0: 0, inside1: 0,
        };
        if (code == 0) {
            let ok = true;
            try {
                sqrtP = sqrtAt(tU);
                m = computeMint(MintIn {
                    sqrtP, tick: tU, liquidity: self.liquidity,
                    fg0: self.feeGrowth0X128, fg1: self.feeGrowth1X128,
                    ticks: self.ticks, tickCount: self.tickCount, spacing: s,
                    tL, tU, a0: 0, a1: msg.amount1, minL: 0,
                });
            } catch (e) {
                ok = false;
            }
            code = ok ? m.code : CODE_MATH_FAILURE;
        }
        if (code == 0) {
            let need = MINT_POOL_GAS + m.newTicks * (TICK_RENT_BUFFER + TICK_INIT_FEE) + POSITION_DEPLOY_VALUE +
                (msg.devBuy > 0 ? DEV_BUY_POOL_GAS + JETTON_PAYOUT_VALUE + self.payoutGas(ext) : 0);
            if (ctx.value - msg.devBuy < need) {
                code = CODE_LOW_GAS;
            } else if (m.use0 != 0) {
                code = CODE_MATH_FAILURE;
            } else if (self.reserve1 + msg.amount1 > MAX_COINS) {
                code = CODE_OVERFLOW;
            }
        }
        if (code != 0) {
            self.refundDeposit(msg.queryId, msg.fromUser, msg.devBuy, msg.amount1, msg.refundTo, code);
            return;
        }

        // Commit the initialization and the locked position.
        let fs = feeStateFromPreset(msg.preset, t);
        fs.idxRef = tU / s;
        self.initialized = true;
        self.sqrtPriceX96 = sqrtP;
        self.tick = tU;
        self.fs = fs;
        self.obsTs = t;
        self.ticks = m.ticks;
        self.tickCount = m.tickCount;
        self.endowment += m.newTicks * TICK_INIT_FEE;
        self.liquidity = m.liquidity;
        self.reserve1 += m.use1;
        self.platformBps = min(msg.platformBps, PLATFORM_FEE_CAP_BPS);
        // Rounding dust of the deposit (< sqrt(price) units) is not worth a payout hop: it is
        // booked as protocol fee, so the Router wallet stays exactly backed.
        self.protocolFees1 += msg.amount1 - m.use1;
        let index = self.nextPositionId;
        self.nextPositionId += 1;
        emit(InitializeEvent { sqrtPriceX96: sqrtP, tick: tU, initializer: ext.initializer, graduation: true }.toCell());
        emit(ModifyEvent {
            owner: msg.feeClaimer, index, tickLower: tL, tickUpper: tU, liquidityDelta: m.liq,
            amount0: 0, amount1: m.use1, fees0: 0, fees1: 0,
        }.toCell());

        // Dev buy: same transaction, so it is the first swap the pool ever sees. The anti-snipe
        // launch fee is waived for it (it cannot be a snipe); base fee, protocol share and the
        // key's buy tax apply as usual.
        let devIn = 0;
        let devOut = 0;
        if (msg.devBuy > 0) {
            let e2 = ext;
            e2.launchFeePips = 0;
            let sim = self.simulate(e2, true, msg.devBuy, 0, 2, 0, false, msg.minDevOut, t, self.platformBps);
            if (sim.code == 0) {
                self.commitSwap(sim, true, msg.devReceiver);
                devIn = msg.devBuy;
                devOut = sim.out;
            } else {
                emit(RefundEvent { queryId: msg.queryId, user: msg.devReceiver, code: sim.code }.toCell());
            }
        }
        emit(LaunchEvent {
            key: self.key, feeClaimer: msg.feeClaimer, tickLower: tL, tickUpper: tU, liquidity: m.liq,
            amount1: m.use1, devIn, devOut,
        }.toCell());

        let pays = self.takePayouts(ext);
        self.reserveKeep();
        deploy(DeployParameters {
            init: initOf Position(myAddress(), index),
            value: POSITION_DEPLOY_VALUE,
            mode: SendPayGasSeparately,
            bounce: false,
            body: PositionInit {
                queryId: msg.queryId,
                owner: msg.feeClaimer,
                tickLower: tL,
                tickUpper: tU,
                liquidity: m.liq,
                fgInside0: m.inside0,
                fgInside1: m.inside1,
                lockedUntil: LOCKED_FOREVER,
            }.toCell(),
        });
        self.sendPayouts(pays, ext, msg.platformTo, msg.queryId);
        if (devOut > 0) {
            // The jetton payout carries the remaining value; its excess returns to refundTo.
            self.sendToken(false, devOut, msg.devReceiver, msg.refundTo, REASON_SWAP_OUT, msg.queryId, 0, null, true);
        } else if (msg.devBuy > 0) {
            self.sendToken(true, msg.devBuy, msg.refundTo, msg.refundTo, REASON_SWAP_REFUND, msg.queryId, 0, null, true);
        } else {
            self.excess(msg.refundTo, msg.queryId);
        }
    }

    // -----------------------------------------------------------------------
    // Decrease / collect (Position -> Pool -> Position). Exactly one PositionSync per PoolBurn.
    // -----------------------------------------------------------------------

    receive(msg: PoolBurn) {
        require(context().sender == contractAddress(initOf Position(myAddress(), msg.index)), "Not position");
        self.burnCore(msg, false);
    }

    // Notifying decrease (§6.14): same checks and math; the Position gets PositionSyncNotify (which
    // it relays to the owner as a BurnReceipt) and the jetton legs carry NOTIFY_FWD_TON.
    receive(msg: PoolBurnNotify) {
        require(context().sender == contractAddress(initOf Position(myAddress(), msg.index)), "Not position");
        self.burnCore(PoolBurn {
            queryId: msg.queryId, index: msg.index, owner: msg.owner, recipient: msg.recipient,
            tickLower: msg.tickLower, tickUpper: msg.tickUpper, liquidity: msg.liquidity,
            liquidityDelta: msg.liquidityDelta, fgLast0: msg.fgLast0, fgLast1: msg.fgLast1,
            amount0Min: msg.amount0Min, amount1Min: msg.amount1Min, deadline: msg.deadline,
        }, true);
    }

    // Read-only snapshot for contracts (§6.14): spot, active liquidity, the TWAP accumulator at now()
    // and the fee growth inside [tickLower, tickUpper]. No state change; the reply takes the
    // remaining value. Below OBSERVE_VALUE the request is refused (a bounceable one bounces).
    receive(msg: PoolObserve) {
        let ctx = context();
        require(ctx.value >= OBSERVE_VALUE, "Insufficient TON attached");
        let o = self.observe(msg.tickLower, msg.tickUpper);
        o.queryId = msg.queryId;
        o.payload = msg.payload;
        message(MessageParameters {
            to: ctx.sender,
            value: 0,
            mode: SendRemainingValue | SendIgnoreErrors,
            bounce: false,
            body: o.toCell(),
        });
    }

    receive(msg: PoolMintNotify) {
        require(sender() == self.router, "Not router");
        self.doMint(msg.queryId, msg.fromUser, msg.amount0, msg.amount1, msg.params, msg.allowInit, msg.preset, false, true);
    }

    fun burnCore(msg: PoolBurn, notify: Bool) {
        let ctx = context();
        let ext = extOf(self.key.ext);
        let hookOn = (ext.hookFlags & HOOK_AFTER_MODIFY) != 0 && ext.hook != null;
        let need = BURN_POOL_GAS + (hookOn ? HOOK_NOTIFY_VALUE : 0) + (notify ? 2 * NOTIFY_FWD_TON : 0);
        // Gram this message really brought: PoolBurn is bounceable, so storage rent (and rent debt,
        // collected from the incoming value in the credit phase) is taken before compute. The
        // success path must still be able to pay every send, or its action phase would fail with
        // no bounce and leave the Position busy forever (review finding 1).
        let spare = myBalance() - self.keep();

        let code = 0;
        let b = BurnRes {
            amount0: 0, amount1: 0, fees0: 0, fees1: 0, inside0: msg.fgLast0, inside1: msg.fgLast1,
            liquidity: self.liquidity, ticks: self.ticks, tickCount: self.tickCount,
        };
        if (ctx.value < need || spare < need) {
            code = CODE_LOW_GAS;
        } else if (now() > msg.deadline) {
            code = CODE_DEADLINE;
        } else if (!isBasechain(msg.recipient) || msg.recipient == self.router) {
            // A payout to the Router would be stranded there (Gram sweepable by the admin via
            // WithdrawRouterExcess, jettons unattributed in its wallet); a non-std address would
            // fail the action phase. Refuse, like every Router entry.
            code = CODE_BAD_RECIPIENT;
        } else if (msg.liquidityDelta > msg.liquidity) {
            code = CODE_MATH_FAILURE;
        } else {
            let ok = true;
            try {
                b = computeBurn(BurnIn {
                    sqrtP: self.sqrtPriceX96, tick: self.tick, liquidity: self.liquidity,
                    fg0: self.feeGrowth0X128, fg1: self.feeGrowth1X128,
                    ticks: self.ticks, tickCount: self.tickCount,
                    tL: msg.tickLower, tU: msg.tickUpper, posLiq: msg.liquidity, delta: msg.liquidityDelta,
                    fgLast0: msg.fgLast0, fgLast1: msg.fgLast1,
                });
            } catch (e) {
                ok = false;
            }
            if (!ok) {
                code = CODE_MATH_FAILURE;
            } else if (b.amount0 + b.fees0 < msg.amount0Min || b.amount1 + b.fees1 < msg.amount1Min) {
                code = CODE_SLIPPAGE;
            } else if (b.amount0 + b.fees0 > self.reserve0 || b.amount1 + b.fees1 > self.reserve1) {
                code = CODE_MATH_FAILURE;
            }
        }
        if (code != 0) {
            emit(RefundEvent { queryId: msg.queryId, user: msg.owner, code }.toCell());
            // §2.2 rule: never take the incoming value to cover a rent deficit on this path, so the
            // single reply can always be paid (the pool's own buffer absorbs the shortfall).
            nativeReserve(max(0, min(self.keep(), myBalance() - ctx.value)), ReserveAtMost);
            message(MessageParameters {
                to: ctx.sender,
                value: 0,
                mode: SendRemainingBalance | SendBounceIfActionFail,
                bounce: false,
                body: notify ? PositionSyncNotify {
                    queryId: msg.queryId, ok: false, code,
                    liquidity: msg.liquidity, fgInside0: msg.fgLast0, fgInside1: msg.fgLast1,
                    liquidityDelta: 0, amount0: 0, amount1: 0, fees0: 0, fees1: 0,
                }.toCell() : PositionSync {
                    queryId: msg.queryId, ok: false, code,
                    liquidity: msg.liquidity, fgInside0: msg.fgLast0, fgInside1: msg.fgLast1,
                }.toCell(),
            });
            return;
        }

        let out0 = b.amount0 + b.fees0;
        let out1 = b.amount1 + b.fees1;
        self.ticks = b.ticks;
        self.tickCount = b.tickCount;
        self.liquidity = b.liquidity;
        self.reserve0 -= out0;
        self.reserve1 -= out1;

        emit(ModifyEvent {
            owner: msg.owner,
            index: msg.index,
            tickLower: msg.tickLower,
            tickUpper: msg.tickUpper,
            liquidityDelta: -msg.liquidityDelta,
            amount0: b.amount0,
            amount1: b.amount1,
            fees0: b.fees0,
            fees1: b.fees1,
        }.toCell());

        // spare >= need, so after reserving keep() the sends below are always funded. The Sync goes
        // first; every send also bounces the PoolBurn if it ever fails (+16), which clears `busy`.
        self.reserveKeep();
        message(MessageParameters {
            to: ctx.sender,
            value: POSITION_SYNC_VALUE,
            mode: SendPayGasSeparately | SendBounceIfActionFail,
            bounce: false,
            body: notify ? PositionSyncNotify {
                queryId: msg.queryId, ok: true, code: 0,
                liquidity: msg.liquidity - msg.liquidityDelta, fgInside0: b.inside0, fgInside1: b.inside1,
                liquidityDelta: msg.liquidityDelta, amount0: b.amount0, amount1: b.amount1, fees0: b.fees0, fees1: b.fees1,
            }.toCell() : PositionSync {
                queryId: msg.queryId, ok: true, code: 0,
                liquidity: msg.liquidity - msg.liquidityDelta, fgInside0: b.inside0, fgInside1: b.inside1,
            }.toCell(),
        });
        if (hookOn) {
            self.notifyModify(ext.hook!!, msg.queryId, msg.owner, msg.index, msg.tickLower, msg.tickUpper,
                -msg.liquidityDelta, b.amount0, b.amount1);
        }
        self.payTwo(msg.queryId, out0, out1, msg.recipient, msg.owner, REASON_POSITION_OUT, notify ? NOTIFY_FWD_TON : 0);
    }

    // -----------------------------------------------------------------------
    // Admin (via Router), protocol and hook fees
    // -----------------------------------------------------------------------

    receive(msg: PoolSetProtocolShare) {
        require(sender() == self.router, "Not router");
        require(msg.shareBps <= MAX_PROTOCOL_SHARE_BPS, "Fee above cap");
        self.fs.protocolShareBps = msg.shareBps;
        self.reserveForCaller(0);
        self.excess(msg.excessTo, msg.queryId);
    }

    receive(msg: PoolCollectProtocol) {
        require(sender() == self.router, "Not router");
        let f0 = self.protocolFees0;
        let f1 = self.protocolFees1;
        self.protocolFees0 = 0;
        self.protocolFees1 = 0;
        self.reserveForCaller(self.isNative() ? f0 : 0);
        self.payTwo(msg.queryId, f0, f1, msg.treasury, msg.excessTo, REASON_PROTOCOL_FEE, 0);
    }

    // TAX plugin: anyone (via the Router) pays the accrued tax to the key's taxRecipient.
    receive(msg: PoolCollectTax) {
        require(sender() == self.router, "Not router");
        let ext = extOf(self.key.ext);
        let f = self.taxFees;
        self.taxFees = 0;
        self.reserveForCaller(f);
        if (ext.taxRecipient == null) {
            self.excess(msg.excessTo, msg.queryId);
            return;
        }
        self.payTwo(msg.queryId, f, 0, ext.taxRecipient!!, msg.excessTo, REASON_TAX, 0);
    }

    // PLATFORM FEE: anyone (via the Router) pays the carried platform fees to the treasury.
    receive(msg: PoolCollectPlatform) {
        require(sender() == self.router, "Not router");
        let f = self.platformFees;
        self.platformFees = 0;
        self.reserveForCaller(f);
        self.payTwo(msg.queryId, f, 0, msg.treasury, msg.excessTo, REASON_PLATFORM, 0);
    }

    // FEE_CONTROL: the hook sets the base fee within the key's visible bounds (next swap on).
    receive(msg: HookSetFee) {
        let ext = extOf(self.key.ext);
        require(ext.hook != null && sender() == ext.hook!!, "Not hook");
        require((ext.hookFlags & HOOK_FEE_CONTROL) != 0, "Not allowed");
        require(self.initialized, "Not initialized");
        require(msg.feePips >= ext.hookFeeMin && msg.feePips <= ext.hookFeeMax && msg.feePips <= MAX_BASE_FEE_PIPS, "Fee above cap");
        self.fs.hookFeeSet = true;
        self.fs.hookFeePips = msg.feePips;
        self.reserveForCaller(0);
        self.excess(sender(), msg.queryId);
    }

    receive(msg: HookCollectFees) {
        let ext = extOf(self.key.ext);
        require(ext.hook != null && sender() == ext.hook!!, "Not hook");
        require(context().value >= COLLECT_GAS, "Insufficient TON attached");
        let f0 = self.hookFees0;
        let f1 = self.hookFees1;
        self.hookFees0 = 0;
        self.hookFees1 = 0;
        self.reserveForCaller(self.isNative() ? f0 : 0);
        self.payTwo(msg.queryId, f0, f1, ext.hook!!, ext.hook!!, REASON_HOOK_FEE, 0);
    }

    // Plain Gram is a donation to the pool's permanent endowment (in keep()), never spare balance
    // that the next payout could sweep to its caller (review issue 1).
    receive() {
        self.endowment += context().value;
    }

    bounced(msg: Slice) {}

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    // Total after the caller's authentication: every failure refunds every leg to refundTo.
    fun doMint(queryId: Int, user: Address, a0: Int, a1: Int, p: MintParams, allowInit: Bool,
               preset: FeePreset, graduation: Bool, notify: Bool) {
        let ctx = context();
        let ext = extOf(self.key.ext);
        let t = now();
        let code = 0;

        let sqrtP = self.sqrtPriceX96;
        let tick = self.tick;
        let fs = self.fs;
        let initNow = false;
        if (t > p.deadline) {
            code = CODE_DEADLINE;
        } else if (!self.initialized) {
            if (p.sqrtPriceInitX96 == 0) {
                code = CODE_NOT_INITIALIZED;
            } else if (!allowInit) {
                code = CODE_CREATION_PAUSED;
            } else if (ext.initializer != null && ext.initializer!! != user) {
                code = CODE_NOT_INITIALIZER;
            } else if (!taxValid(ext, self.isNative())) {
                code = CODE_BAD_KEY;
            } else if (p.sqrtPriceInitX96 < MIN_SQRT_RATIO || p.sqrtPriceInitX96 >= MAX_SQRT_RATIO) {
                code = CODE_PRICE_OUT_OF_RANGE;
            } else {
                sqrtP = p.sqrtPriceInitX96;
                tick = tickAt(sqrtP);
                fs = feeStateFromPreset(preset, t);
                // The volatility reference starts at the initial price (Meteora: the active bin).
                // Left at 0, a pool initialized away from tick 0 (every graduation) would start
                // with va = maxVolAcc and charge the maximum variable fee to its first swaps.
                fs.idxRef = tick / self.key.tickSpacing;
                initNow = true;
            }
        }
        if (code == 0 && ((p.sqrtPriceMinX96 > 0 && sqrtP < p.sqrtPriceMinX96) ||
                          (p.sqrtPriceMaxX96 > 0 && sqrtP > p.sqrtPriceMaxX96))) {
            code = CODE_SLIPPAGE;
        }

        let m = MintRes {
            code: 0, liq: 0, use0: 0, use1: 0, liquidity: self.liquidity, ticks: self.ticks,
            tickCount: self.tickCount, newTicks: 0, inside0: 0, inside1: 0,
        };
        if (code == 0) {
            let ok = true;
            try {
                m = computeMint(MintIn {
                    sqrtP, tick, liquidity: self.liquidity,
                    fg0: self.feeGrowth0X128, fg1: self.feeGrowth1X128,
                    ticks: self.ticks, tickCount: self.tickCount, spacing: self.key.tickSpacing,
                    tL: p.tickLower, tU: p.tickUpper, a0, a1, minL: p.minLiquidity,
                });
            } catch (e) {
                ok = false;
            }
            code = ok ? m.code : CODE_MATH_FAILURE;
        }
        let hookOn = (ext.hookFlags & HOOK_AFTER_MODIFY) != 0 && ext.hook != null;
        if (code == 0) {
            let legs = 0;
            if (a0 - m.use0 > 0 && self.key.token0 != GRAM) {
                legs += 1;
            }
            if (a1 - m.use1 > 0) {
                legs += 1;
            }
            let gasAvail = ctx.value - (self.isNative() ? a0 : 0);
            let need = MINT_POOL_GAS + m.newTicks * (TICK_RENT_BUFFER + TICK_INIT_FEE) + POSITION_DEPLOY_VALUE +
                legs * JETTON_PAYOUT_VALUE + (hookOn ? HOOK_NOTIFY_VALUE : 0) +
                (notify ? RECEIPT_VALUE + legs * NOTIFY_FWD_TON : 0);
            if (gasAvail < need) {
                code = CODE_LOW_GAS;
            } else if (self.reserve0 + m.use0 > MAX_COINS || self.reserve1 + m.use1 > MAX_COINS) {
                code = CODE_OVERFLOW;
            }
        }
        if (code != 0) {
            if (notify) {
                self.mintFailed(queryId, user, a0, a1, p, code);
                return;
            }
            self.refundDeposit(queryId, user, a0, a1, p.refundTo, code);
            return;
        }

        // Commit.
        if (initNow) {
            self.initialized = true;
            self.sqrtPriceX96 = sqrtP;
            self.tick = tick;
            self.fs = fs;
            self.obsTs = t;
            emit(InitializeEvent { sqrtPriceX96: sqrtP, tick, initializer: ext.initializer, graduation }.toCell());
        }
        self.ticks = m.ticks;
        self.tickCount = m.tickCount;
        self.endowment += m.newTicks * TICK_INIT_FEE;
        self.liquidity = m.liquidity;
        self.reserve0 += m.use0;
        self.reserve1 += m.use1;
        let index = self.nextPositionId;
        self.nextPositionId += 1;

        emit(ModifyEvent {
            owner: p.owner,
            index,
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
            liquidityDelta: m.liq,
            amount0: m.use0,
            amount1: m.use1,
            fees0: 0,
            fees1: 0,
        }.toCell());

        let lockedUntil = 0;
        if (graduation) {
            lockedUntil = LOCKED_FOREVER;
        } else {
            if (ext.minLockSecs > 0) {
                lockedUntil = t + ext.minLockSecs;
            }
            // LAUNCH_DECAY: liquidity added inside the launch window stays until the window ends,
            // so a just-in-time range cannot take the decaying launch fee and leave (finding 9).
            let launchEnd = fs.startTs + ext.launchDuration;
            if (ext.launchFeePips > 0 && t < launchEnd) {
                lockedUntil = max(lockedUntil, launchEnd);
            }
        }

        self.reserveKeep();
        deploy(DeployParameters {
            init: initOf Position(myAddress(), index),
            value: POSITION_DEPLOY_VALUE,
            mode: SendPayGasSeparately,
            bounce: false,
            body: PositionInit {
                queryId,
                owner: p.owner,
                tickLower: p.tickLower,
                tickUpper: p.tickUpper,
                liquidity: m.liq,
                fgInside0: m.inside0,
                fgInside1: m.inside1,
                lockedUntil,
            }.toCell(),
        });
        if (hookOn) {
            self.notifyModify(ext.hook!!, queryId, p.owner, index, p.tickLower, p.tickUpper, m.liq, m.use0, m.use1);
        }
        if (notify) {
            message(MessageParameters {
                to: user,
                value: RECEIPT_VALUE,
                mode: SendPayGasSeparately | SendBounceIfActionFail,
                bounce: false,
                body: MintReceipt {
                    queryId, ok: true, code: 0, owner: p.owner, index, tickLower: p.tickLower, tickUpper: p.tickUpper,
                    liquidity: m.liq, amount0: m.use0, amount1: m.use1, refund0: a0 - m.use0, refund1: a1 - m.use1,
                    fgInside0: m.inside0, fgInside1: m.inside1,
                }.toCell(),
            });
        }
        self.payTwo(queryId, a0 - m.use0, a1 - m.use1, p.refundTo, p.refundTo, REASON_MINT_REFUND, notify ? NOTIFY_FWD_TON : 0);
    }

    // A refused notifying mint: the receipt first (same FIFO channel as a Gram refund), then both
    // legs to refundTo, the jetton ones notified. The receipt never blocks the refund.
    fun mintFailed(queryId: Int, user: Address, a0: Int, a1: Int, p: MintParams, code: Int) {
        emit(RefundEvent { queryId, user, code }.toCell());
        self.reserveKeep();
        message(MessageParameters {
            to: user,
            value: RECEIPT_VALUE,
            mode: SendPayGasSeparately | SendIgnoreErrors,
            bounce: false,
            body: MintReceipt {
                queryId, ok: false, code, owner: p.owner, index: 0, tickLower: p.tickLower, tickUpper: p.tickUpper,
                liquidity: 0, amount0: 0, amount1: 0, refund0: a0, refund1: a1, fgInside0: 0, fgInside1: 0,
            }.toCell(),
        });
        self.payTwo(queryId, a0, a1, p.refundTo, p.refundTo, REASON_MINT_REFUND, NOTIFY_FWD_TON);
    }

    // PoolObservation for (tL, tU) at now(); queryId and payload are filled by the caller.
    fun observe(tL: Int, tU: Int): PoolObservation {
        let o = PoolObservation {
            queryId: 0, initialized: self.initialized, sqrtPriceX96: 0, tick: 0, liquidity: 0, tickCumulative: 0,
            time: now(), tickLower: tL, tickUpper: tU, rangeOk: false, feeGrowthInside0X128: 0, feeGrowthInside1X128: 0,
            payload: null,
        };
        if (!self.initialized) {
            return o;
        }
        o.sqrtPriceX96 = self.sqrtPriceX96;
        o.tick = self.tick;
        o.liquidity = self.liquidity;
        o.tickCumulative = self.tickCumulative + self.tick * (now() - self.obsTs);
        // v3 snapshotCumulativesInside requires both ticks initialized; an uninitialized tick's
        // fee-growth-outside is undefined, so the inside value is reported only for a live range.
        if (ticksValid(tL, tU, self.key.tickSpacing) && self.ticks.get(tL) != null && self.ticks.get(tU) != null) {
            let inside = feeGrowthInside(self.ticks, self.tick, tL, tU, self.feeGrowth0X128, self.feeGrowth1X128);
            o.rangeOk = true;
            o.feeGrowthInside0X128 = inside.a;
            o.feeGrowthInside1X128 = inside.b;
        }
        return o;
    }

    // platBps: the PLATFORM FEE rate, already 0 unless platformCharged().
    fun simulate(ext: KeyExt, zfo: Bool, amountIn: Int, limIn: Int, maxCrossings: Int, refBps: Int,
                 allowPartial: Bool, minOut: Int, t: Int, platBps: Int): Sim {
        let sim = Sim { code: 0, consumed: 0, refFee: 0, refund: 0, tax: 0, plat: 0, out: 0, res: self.idleRes() };
        if (!self.initialized) {
            sim.code = CODE_NOT_INITIALIZED;
            return sim;
        }
        if (refBps < 0 || refBps > MAX_REF_FEE_BPS) {
            sim.code = CODE_BAD_REF_BPS;
            return sim;
        }
        if (maxCrossings < 1 || maxCrossings > MAX_CROSSINGS_CAP) {
            sim.code = CODE_BAD_CROSSINGS;
            return sim;
        }
        if (amountIn <= 0) {
            sim.code = CODE_ZERO_OUT;
            return sim;
        }
        if (platBps < 0 || platBps > PLATFORM_FEE_CAP_BPS) {
            sim.code = CODE_BAD_REF_BPS;
            return sim;
        }
        let lim = limIn;
        if (lim == 0) {
            lim = zfo ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1;
        }
        let limOk = zfo ? (lim > MIN_SQRT_RATIO && lim < self.sqrtPriceX96)
                        : (lim > self.sqrtPriceX96 && lim < MAX_SQRT_RATIO);
        if (!limOk) {
            sim.code = CODE_BAD_PRICE_LIMIT;
            return sim;
        }

        // TAX plugin (Gram pools only): a buy pays buyTax on its Gram input before the swap, a sell
        // pays sellTax on its Gram output after it. Both sit outside the LP fee accounting.
        // The PLATFORM FEE (launch keys) is taken the same way, on the same Gram side.
        let buyTax = zfo && self.isNative() ? ext.buyTaxBps : 0;
        let sellTax = !zfo && self.isNative() ? ext.sellTaxBps : 0;
        let buyPlat = zfo && self.isNative() ? platBps : 0;
        let sellPlat = !zfo && self.isNative() ? platBps : 0;
        let r = amountIn * refBps / BPS;
        let x = amountIn * buyTax / BPS;
        let p = amountIn * buyPlat / BPS;
        let s = amountIn - r - x - p;
        let ok = true;
        let res = sim.res;
        try {
            res = computeSwap(SwapIn {
                sqrtP: self.sqrtPriceX96,
                tick: self.tick,
                liquidity: self.liquidity,
                fg0: self.feeGrowth0X128,
                fg1: self.feeGrowth1X128,
                ticks: self.ticks,
                fs: self.fs,
                spacing: self.key.tickSpacing,
                launchFeePips: ext.launchFeePips,
                launchDuration: ext.launchDuration,
                hookShareBps: ext.hookShareBps,
                zeroForOne: zfo,
                budget: s,
                limit: lim,
                maxCrossings,
                t,
            });
        } catch (e) {
            ok = false;
        }
        if (!ok) {
            sim.code = CODE_MATH_FAILURE;
            return sim;
        }

        // Referral, buy tax and buy platform fee are charged on the filled part only (DESIGN.md §5.2).
        let c = s - res.remaining;
        let refFee = r;
        let tax = x;
        let plat = p;
        let refund = 0;
        if (c < s) {
            let k = BPS - refBps - buyTax - buyPlat;
            refFee = min(r, c * refBps / k);
            tax = min(x, c * buyTax / k);
            plat = min(p, c * buyPlat / k);
            refund = amountIn - c - refFee - tax - plat;
        }
        if (sellTax > 0) {
            tax = res.out * sellTax / BPS;
        }
        if (sellPlat > 0) {
            plat = res.out * sellPlat / BPS;
        }
        sim.consumed = c;
        sim.refFee = refFee;
        sim.refund = refund;
        sim.tax = tax;
        sim.plat = plat;
        sim.out = res.out - (zfo ? 0 : tax + plat);
        sim.res = res;

        let resIn = zfo ? self.reserve0 : self.reserve1;
        let resOut = zfo ? self.reserve1 : self.reserve0;
        let protoIn = zfo ? self.protocolFees0 : self.protocolFees1;
        let hookIn = zfo ? self.hookFees0 : self.hookFees1;
        if (res.out == 0) {
            sim.code = res.stop == STOP_NO_LIQUIDITY && c == 0 ? CODE_NO_LIQUIDITY : CODE_ZERO_OUT;
        } else if (res.remaining > 0 && !allowPartial) {
            sim.code = CODE_PARTIAL_NOT_ALLOWED;
        } else if (sim.out < minOut) {
            sim.code = CODE_SLIPPAGE;
        } else if (resIn + c - res.proto - res.hook > MAX_COINS || protoIn + res.proto > MAX_COINS ||
                   hookIn + res.hook > MAX_COINS || self.taxFees + tax > MAX_COINS ||
                   self.platformFees + plat > MAX_COINS) {
            sim.code = CODE_OVERFLOW;
        } else if (res.out > resOut || refund < 0) {
            sim.code = CODE_MATH_FAILURE;
        }
        return sim;
    }

    // Commit a successful simulation (code == 0) and emit its SwapEvent.
    fun commitSwap(sim: Sim, zeroForOne: Bool, fromUser: Address) {
        let res = sim.res;
        let t = now();
        self.tickCumulative += self.tick * (t - self.obsTs);
        self.obsTs = t;
        self.sqrtPriceX96 = res.sqrtP;
        self.tick = res.tick;
        self.liquidity = res.liquidity;
        self.feeGrowth0X128 = res.fg0;
        self.feeGrowth1X128 = res.fg1;
        self.ticks = res.ticks;
        self.fs = res.fs;
        let netIn = sim.consumed - res.proto - res.hook;
        self.taxFees += sim.tax;
        self.platformFees += sim.plat;
        if (zeroForOne) {
            self.reserve0 += netIn;
            self.protocolFees0 += res.proto;
            self.hookFees0 += res.hook;
            self.reserve1 -= res.out;
        } else {
            self.reserve1 += netIn;
            self.protocolFees1 += res.proto;
            self.hookFees1 += res.hook;
            self.reserve0 -= res.out;
        }
        // Event before the sends (an external message after SendRemainingBalance is unpaid).
        emit(SwapEvent {
            fromUser,
            zeroForOne,
            amountIn: sim.consumed + sim.refFee + (zeroForOne ? sim.tax + sim.plat : 0),
            amountOut: sim.out,
            refFee: sim.refFee,
            feeTotal: res.feeTotal,
            protocolFee: res.proto,
            hookFee: res.hook,
            sqrtPriceX96: res.sqrtP,
            tick: res.tick,
            liquidity: res.liquidity,
            crossings: res.crossings,
            steps: res.steps,
            stop: res.stop,
            tax: sim.tax,
            platformFee: sim.plat,
        }.toCell());
    }

    // THE platform-fee scope decision (one place; PLATFORM_FEE_ALL_GRAM_POOLS flips it): Gram pools
    // only (the fee is taken in Gram), and either all of them or launch keys (an initializer) only.
    fun platformCharged(ext: KeyExt): Bool {
        return self.isNative() && (PLATFORM_FEE_ALL_GRAM_POOLS || ext.initializer != null);
    }

    // Value a swap's direct fee payouts may need on top of the fees themselves (see swapGas).
    fun payoutGas(ext: KeyExt): Int {
        return (self.platformCharged(ext) ? PAYOUT_MSG_GAS : 0) +
            (ext.taxRecipient != null ? PAYOUT_MSG_GAS + TAX_PAYOUT_GAS : 0);
    }

    // After a committed swap, before reserveKeep(): take what is due for direct payout out of the
    // carried balances, so keep() no longer protects it. a = platform fee, b = tax.
    fun takePayouts(ext: KeyExt): Pair {
        let pays = Pair { a: 0, b: 0 };
        if (self.platformFees >= PLATFORM_MIN_PAYOUT) {
            pays.a = self.platformFees;
            self.platformFees = 0;
        }
        if (ext.taxRecipient != null && self.taxFees >= TAX_MIN_PAYOUT) {
            pays.b = self.taxFees;
            self.taxFees = 0;
        }
        return pays;
    }

    // Never the last send: each carries exactly its fee (+ TAX_PAYOUT_GAS for the tax), paid from
    // the swap's gas, which the Router sized for it.
    fun sendPayouts(pays: Pair, ext: KeyExt, platformTo: Address, queryId: Int) {
        if (pays.a > 0) {
            self.sendToken(true, pays.a, platformTo, platformTo, REASON_PLATFORM, queryId, 0, null, false);
        }
        if (pays.b > 0) {
            message(MessageParameters {
                to: ext.taxRecipient!!,
                value: pays.b + TAX_PAYOUT_GAS,
                mode: SendPayGasSeparately | SendBounceIfActionFail,
                bounce: false,
                body: GramPayout { queryId, reason: REASON_TAX, amount: pays.b, payload: null }.toCell(),
            });
        }
    }

    fun idleRes(): SwapRes {
        return SwapRes {
            out: 0, remaining: 0, feeTotal: 0, proto: 0, hook: 0,
            sqrtP: self.sqrtPriceX96, tick: self.tick, liquidity: self.liquidity,
            fg0: self.feeGrowth0X128, fg1: self.feeGrowth1X128, ticks: self.ticks, fs: self.fs,
            crossings: 0, steps: 0, stop: STOP_FILLED, lastFee: 0,
        };
    }

    fun refundSwap(msg: PoolSwap, code: Int) {
        emit(RefundEvent { queryId: msg.queryId, user: msg.fromUser, code }.toCell());
        self.reserveKeep();
        self.sendToken(msg.zeroForOne, msg.amountIn, msg.refundTo, msg.refundTo,
            REASON_SWAP_REFUND, msg.queryId, 0, null, true);
    }

    fun refundDeposit(queryId: Int, user: Address, a0: Int, a1: Int, refundTo: Address, code: Int) {
        emit(RefundEvent { queryId, user, code }.toCell());
        self.reserveKeep();
        self.payTwo(queryId, a0, a1, refundTo, refundTo, REASON_MINT_REFUND, 0);
    }

    fun notifyModify(hook: Address, queryId: Int, owner: Address, index: Int, tL: Int, tU: Int,
                     delta: Int, a0: Int, a1: Int) {
        message(MessageParameters {
            to: hook,
            value: HOOK_NOTIFY_VALUE,
            mode: SendPayGasSeparately | SendBounceIfActionFail,
            bounce: false,
            body: HookAfterModify {
                queryId, owner, index, tickLower: tL, tickUpper: tU, liquidityDelta: delta, amount0: a0, amount1: a1,
            }.toCell(),
        });
    }

    fun excess(to: Address, queryId: Int) {
        message(MessageParameters {
            to,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: JettonExcesses { queryId }.toCell(),
        });
    }

    // Up to two payout legs; jetton legs first, the last one takes the remaining balance (copied
    // from v1). When both amounts are 0 the remaining balance goes to excessTo.
    // fwdTon > 0 (notifying ops): every jetton leg carries it, so the recipient's wallet notifies.
    fun payTwo(queryId: Int, amount0: Int, amount1: Int, to: Address, excessTo: Address, reason: Int, fwdTon: Int) {
        if (amount0 == 0 && amount1 == 0) {
            self.excess(excessTo, queryId);
            return;
        }
        if (self.isNative()) {
            if (amount1 > 0) {
                self.sendToken(false, amount1, to, excessTo, reason, queryId, fwdTon, null, amount0 == 0);
            }
            if (amount0 > 0) {
                self.sendToken(true, amount0, to, excessTo, reason, queryId, 0, null, true);
            }
        } else {
            if (amount0 > 0) {
                self.sendToken(true, amount0, to, excessTo, reason, queryId, fwdTon, null, amount1 == 0);
            }
            if (amount1 > 0) {
                self.sendToken(false, amount1, to, excessTo, reason, queryId, fwdTon, null, true);
            }
        }
    }

    fun sendToken(isToken0: Bool, amount: Int, to: Address, excessTo: Address, reason: Int,
                  queryId: Int, fwdTon: Int, fwdPayload: Cell?, last: Bool) {
        let token = isToken0 ? self.key.token0 : self.key.token1;
        if (token == GRAM) {
            message(MessageParameters {
                to,
                value: last ? 0 : amount,
                mode: (last ? SendRemainingBalance : SendPayGasSeparately) | SendBounceIfActionFail,
                bounce: false,
                body: GramPayout { queryId, reason, amount, payload: fwdPayload }.toCell(),
            });
        } else {
            message(MessageParameters {
                to: self.router,
                value: last ? 0 : JETTON_PAYOUT_VALUE + fwdTon,
                mode: (last ? SendRemainingBalance : SendPayGasSeparately) | SendBounceIfActionFail,
                bounce: false,
                body: PayTo {
                    queryId,
                    key: self.key,
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
        return self.key.token0 == GRAM;
    }

    // Gram the pool must keep: storage, per-tick rent buffers, and (native) the Gram it owes.
    fun keep(): Int {
        return POOL_MIN_STORAGE + self.tickCount * TICK_RENT_BUFFER + self.endowment +
            (self.isNative() ? self.reserve0 + self.protocolFees0 + self.hookFees0 + self.taxFees + self.platformFees : 0);
    }

    // ReserveAtMost: under rent debt the balance can be below keep(); never fail the action phase.
    fun reserveKeep() {
        nativeReserve(self.keep(), ReserveAtMost);
    }

    // Collect / admin / hook ops (review issue 1): the caller gets back only its own value plus the
    // Gram this op pays out (outGram), minus gas, never other balance above keep(). Called after
    // the collected fees are zeroed, so keep() no longer counts outGram.
    fun reserveForCaller(outGram: Int) {
        nativeReserve(max(self.keep(), myBalance() - context().value - outGram), ReserveAtMost);
    }

    fun quoteAt(zeroForOne: Bool, amountIn: Int, sqrtPriceLimitX96: Int, maxCrossings: Int, refBps: Int,
                allowPartial: Bool, atTime: Int, platformBps: Int): Quote {
        let ext = extOf(self.key.ext);
        let sim = self.simulate(ext, zeroForOne, amountIn, sqrtPriceLimitX96, maxCrossings,
            refBps, allowPartial, 0, atTime, self.platformCharged(ext) ? platformBps : 0);
        let r = sim.res;
        return Quote {
            amountOut: sim.out,
            consumed: sim.consumed,
            refFee: sim.refFee,
            refund: sim.refund,
            feeTotal: r.feeTotal,
            protocolFee: r.proto,
            hookFee: r.hook,
            sqrtPriceAfter: r.sqrtP,
            tickAfter: r.tick,
            liquidityAfter: r.liquidity,
            crossings: r.crossings,
            steps: r.steps,
            stop: r.stop,
            code: sim.code,
            tax: sim.tax,
            platformFee: sim.plat,
        };
    }

    // -----------------------------------------------------------------------
    // Getters
    // -----------------------------------------------------------------------

    get fun get_pool_state(): PoolState {
        let ext = extOf(self.key.ext);
        let feeNow = 0;
        if (self.initialized) {
            let s = self.key.tickSpacing;
            let f = refreshRefs(self.fs, self.tick, s, now());
            feeNow = stepFeePips(f, volAt(f, self.tick, s), s,
                launchExtra(ext.launchFeePips, ext.launchDuration, f.startTs, now()));
        }
        return PoolState {
            key: self.key,
            initialized: self.initialized,
            sqrtPriceX96: self.sqrtPriceX96,
            tick: self.tick,
            liquidity: self.liquidity,
            feeGrowth0X128: self.feeGrowth0X128,
            feeGrowth1X128: self.feeGrowth1X128,
            reserve0: self.reserve0,
            reserve1: self.reserve1,
            protocolFees0: self.protocolFees0,
            protocolFees1: self.protocolFees1,
            hookFees0: self.hookFees0,
            hookFees1: self.hookFees1,
            tickCount: self.tickCount,
            nextPositionId: self.nextPositionId,
            fs: self.fs,
            feePipsNow: feeNow,
            endowment: self.endowment,
            taxFees: self.taxFees,
            platformFees: self.platformFees,
            platformBps: self.platformBps,
        };
    }

    get fun get_quote(zeroForOne: Bool, amountIn: Int, sqrtPriceLimitX96: Int, maxCrossings: Int,
                      refBps: Int, allowPartial: Bool): Quote {
        return self.quoteAt(zeroForOne, amountIn, sqrtPriceLimitX96, maxCrossings, refBps, allowPartial, now(), self.platformBps);
    }

    get fun get_quote_at(zeroForOne: Bool, amountIn: Int, sqrtPriceLimitX96: Int, maxCrossings: Int,
                         refBps: Int, allowPartial: Bool, atTime: Int): Quote {
        return self.quoteAt(zeroForOne, amountIn, sqrtPriceLimitX96, maxCrossings, refBps, allowPartial, atTime, self.platformBps);
    }

    // Exact quote with the Router's current PLATFORM FEE (Router get_platform_fee): get_quote uses
    // the rate this pool last saw, which lags a SetPlatformFee until the pool's next swap. A rate
    // above PLATFORM_FEE_CAP_BPS quotes code BAD_REF_BPS. Ignored (0) where platformCharged() is false.
    get fun get_quote2(zeroForOne: Bool, amountIn: Int, sqrtPriceLimitX96: Int, maxCrossings: Int,
                       refBps: Int, allowPartial: Bool, platformBps: Int): Quote {
        return self.quoteAt(zeroForOne, amountIn, sqrtPriceLimitX96, maxCrossings, refBps, allowPartial, now(), platformBps);
    }

    get fun get_mint_quote(tickLower: Int, tickUpper: Int, amount0: Int, amount1: Int, sqrtPriceInitX96: Int): MintQuote {
        let sqrtP = self.sqrtPriceX96;
        let tick = self.tick;
        if (!self.initialized) {
            if (sqrtPriceInitX96 < MIN_SQRT_RATIO || sqrtPriceInitX96 >= MAX_SQRT_RATIO) {
                return MintQuote { liquidity: 0, use0: 0, use1: 0, code: CODE_PRICE_OUT_OF_RANGE };
            }
            sqrtP = sqrtPriceInitX96;
            tick = tickAt(sqrtP);
        }
        let ok = true;
        let m = MintRes {
            code: 0, liq: 0, use0: 0, use1: 0, liquidity: 0, ticks: self.ticks,
            tickCount: 0, newTicks: 0, inside0: 0, inside1: 0,
        };
        try {
            m = computeMint(MintIn {
                sqrtP, tick, liquidity: self.liquidity, fg0: self.feeGrowth0X128, fg1: self.feeGrowth1X128,
                ticks: self.ticks, tickCount: self.tickCount, spacing: self.key.tickSpacing,
                tL: tickLower, tU: tickUpper, a0: amount0, a1: amount1, minL: 0,
            });
        } catch (e) {
            ok = false;
        }
        if (!ok) {
            return MintQuote { liquidity: 0, use0: 0, use1: 0, code: CODE_MATH_FAILURE };
        }
        return MintQuote { liquidity: m.liq, use0: m.use0, use1: m.use1, code: m.code };
    }

    get fun get_position_amounts(tickLower: Int, tickUpper: Int, liquidity: Int, fgLast0: Int, fgLast1: Int,
                                 liquidityDelta: Int): PositionAmounts {
        let b = computeBurn(BurnIn {
            sqrtP: self.sqrtPriceX96, tick: self.tick, liquidity: self.liquidity,
            fg0: self.feeGrowth0X128, fg1: self.feeGrowth1X128, ticks: self.ticks, tickCount: self.tickCount,
            tL: tickLower, tU: tickUpper, posLiq: liquidity, delta: liquidityDelta,
            fgLast0, fgLast1,
        });
        return PositionAmounts { amount0: b.amount0, amount1: b.amount1, fees0: b.fees0, fees1: b.fees1 };
    }

    get fun get_tick(t: Int): TickInfo? {
        return self.ticks.get(t);
    }

    // Up to 64 initialized ticks starting at `from` (inclusive), walking up or down.
    get fun get_ticks(from: Int, count: Int, ascending: Bool): map<Int as int24, TickInfo> {
        let out: map<Int as int24, TickInfo> = emptyMap();
        let n = min(count, 64);
        let cur: Int? = ascending ? tickNextGt(from - 1, self.ticks, 24) : tickPrevLe(from, self.ticks, 24);
        while (n > 0 && cur != null) {
            let t = cur!!;
            out.set(t, self.ticks.get(t)!!);
            cur = ascending ? tickNextGt(t, self.ticks, 24) : tickPrevLe(t - 1, self.ticks, 24);
            n -= 1;
        }
        return out;
    }

    get fun get_observe(): Observation {
        if (!self.initialized) {
            return Observation { tickCumulative: 0, time: now() };
        }
        return Observation { tickCumulative: self.tickCumulative + self.tick * (now() - self.obsTs), time: now() };
    }

    // The PoolObservation a PoolObserve{tickLower, tickUpper} would get now (same function).
    get fun get_pool_observation(tickLower: Int, tickUpper: Int): PoolObservation {
        return self.observe(tickLower, tickUpper);
    }

    get fun get_position_address(index: Int): Address {
        return contractAddress(initOf Position(myAddress(), index));
    }

    get fun get_mint_account_address(user: Address): Address {
        return contractAddress(initOf MintAccount(myAddress(), user));
    }

    // TEP-62 collection
    get fun get_collection_data(): CollectionData {
        return CollectionData {
            nextItemIndex: self.nextPositionId,
            content: beginCell().storeUint(1, 8).endCell(),
            owner: null,
        };
    }

    get fun get_nft_address_by_index(index: Int): Address {
        return contractAddress(initOf Position(myAddress(), index));
    }

    get fun get_nft_content(index: Int, individualContent: Cell): Cell {
        return individualContent;
    }
}
