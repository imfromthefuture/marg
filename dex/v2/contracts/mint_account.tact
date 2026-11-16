import "./messages";
import "./constants";

// Holds one user's first leg of a jetton/jetton in-range mint until the second leg arrives
// (copy of v1 LpAccount). Tokens stay in the Router's wallets; these are bookkeeping only.
// Both legs must carry identical MintParams (else both are refunded, review issue 2); allowInit is the AND of the stored first leg and the
// leg that completes the pair, so a leg parked before SetCreationPaused cannot initialize a pool
// during the pause (review finding 4).
contract MintAccount {
    pool: Address;
    user: Address;
    pending0: Int as coins;
    pending1: Int as coins;
    params: MintParams?;
    allowInit: Bool;
    preset: FeePreset;

    init(pool: Address, user: Address) {
        self.pool = pool;
        self.user = user;
        self.pending0 = 0;
        self.pending1 = 0;
        self.params = null;
        self.allowInit = false;
        self.preset = FeePreset {
            baseFeePips: 0, varFeeControl: 0, filterPeriod: 0, decayPeriod: 0, reductionBps: 0, maxVolAcc: 0,
        };
    }

    // Pool -> MintAccount. Never throws after the sender check.
    receive(msg: MintAccountDeposit) {
        require(sender() == self.pool, "Not pool");

        if (self.pending0 + msg.amount0 > MAX_COINS || self.pending1 + msg.amount1 > MAX_COINS) {
            emit(RefundEvent { queryId: msg.queryId, user: self.user, code: CODE_OVERFLOW }.toCell());
            nativeReserve(MINT_ACCOUNT_MIN_STORAGE, ReserveAtMost);
            message(MessageParameters {
                to: self.pool,
                value: 0,
                mode: SendRemainingBalance,
                bounce: false,
                body: CbMintRefund { queryId: msg.queryId, user: self.user, amount0: msg.amount0, amount1: msg.amount1 }.toCell(),
            });
            return;
        }

        // Review issue 2: a leg only pairs with a parked leg carrying the SAME params (owner,
        // refundTo, ticks, prices, minLiquidity, deadline, price bounds). Otherwise a forged first leg
        // (JettonNotification.sender = victim, via an admin-mintable jetton) would make the victim's
        // real leg mint with the attacker's params. On mismatch nothing pairs: each leg is refunded
        // to its own refundTo and the account is cleared.
        if (self.params != null && self.params!!.toCell().hash() != msg.params.toCell().hash()) {
            let s0 = self.pending0;
            let s1 = self.pending1;
            let storedTo = self.params!!.refundTo;
            self.pending0 = 0;
            self.pending1 = 0;
            self.params = null;
            nativeReserve(MINT_ACCOUNT_MIN_STORAGE, ReserveAtMost);
            message(MessageParameters {
                to: self.pool,
                value: 0,
                mode: SendRemainingBalance,
                bounce: false,
                body: CbMintReject {
                    queryId: msg.queryId, user: self.user,
                    amount0: msg.amount0, amount1: msg.amount1, refundTo: msg.params.refundTo,
                    stored0: s0, stored1: s1, storedTo,
                }.toCell(),
            });
            return;
        }

        if (self.params == null) {
            self.params = msg.params;
            self.allowInit = msg.allowInit;
            self.preset = msg.preset;
        }
        self.pending0 += msg.amount0;
        self.pending1 += msg.amount1;

        if (self.pending0 > 0 && self.pending1 > 0) {
            let a0 = self.pending0;
            let a1 = self.pending1;
            let p = self.params!!;
            self.pending0 = 0;
            self.pending1 = 0;
            self.params = null;
            nativeReserve(MINT_ACCOUNT_MIN_STORAGE, ReserveAtMost);
            message(MessageParameters {
                to: self.pool,
                value: 0,
                mode: SendRemainingBalance,
                bounce: false,
                body: CbMint {
                    queryId: msg.queryId,
                    user: self.user,
                    amount0: a0,
                    amount1: a1,
                    params: p,
                    allowInit: self.allowInit && msg.allowInit,
                    preset: self.preset,
                }.toCell(),
            });
            return;
        }

        nativeReserve(MINT_ACCOUNT_MIN_STORAGE, ReserveAtMost);
        message(MessageParameters {
            to: msg.params.refundTo,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: JettonExcesses { queryId: msg.queryId }.toCell(),
        });
    }

    receive(msg: MintAccountRefund) {
        require(sender() == self.user, "Not owner");
        require(context().value >= MINT_ACCOUNT_REFUND_GAS, "Insufficient TON attached");
        let p0 = self.pending0;
        let p1 = self.pending1;
        self.pending0 = 0;
        self.pending1 = 0;
        self.params = null;
        nativeReserve(MINT_ACCOUNT_MIN_STORAGE, ReserveAtMost);
        message(MessageParameters {
            to: self.pool,
            value: 0,
            mode: SendRemainingBalance,
            bounce: false,
            body: CbMintRefund { queryId: msg.queryId, user: self.user, amount0: p0, amount1: p1 }.toCell(),
        });
    }

    receive() {}

    bounced(msg: Slice) {}

    get fun get_mint_account_data(): MintAccountData {
        return MintAccountData {
            pool: self.pool,
            user: self.user,
            pending0: self.pending0,
            pending1: self.pending1,
            params: self.params,
        };
    }
}
