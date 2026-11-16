import "./messages";
import "./constants";

// Holds one depositor's one-sided deposit into one pool until the other side arrives.
// Pending Gram (side 0 of a native pool) is held natively by this contract; pending jettons
// stay in the Router's wallets and are only recorded here.
contract LpAccount {
    pool: Address;
    user: Address;
    isNative: Bool;
    pending0: Int as coins;
    pending1: Int as coins;

    init(pool: Address, user: Address) {
        self.pool = pool;
        self.user = user;
        self.isNative = false;
        self.pending0 = 0;
        self.pending1 = 0;
    }

    // Pool -> LpAccount. Assets are already in custody: never throw after the sender check.
    receive(msg: LpAccountDeposit) {
        require(sender() == self.pool, "Not pool");
        self.isNative = msg.isNative;

        // A sum above the coins range would throw when storage is committed. Send just this
        // deposit back through the pool instead.
        if (self.pending0 + msg.amount0 > MAX_COINS || self.pending1 + msg.amount1 > MAX_COINS) {
            emit(RefundEvent { queryId: msg.queryId, user: self.user, code: CODE_OVERFLOW }.toCell());
            nativeReserve(self.keep(), ReserveExact);
            message(MessageParameters {
                to: self.pool,
                value: 0,
                mode: SendRemainingBalance,
                bounce: false,
                body: CbRefund { queryId: msg.queryId, user: self.user, amount0: msg.amount0, amount1: msg.amount1 }.toCell(),
            });
            return;
        }

        self.pending0 += msg.amount0;
        self.pending1 += msg.amount1;

        if (self.pending0 > 0 && self.pending1 > 0) {
            // Both sides present: zero first, then hand everything (incl. pending Gram) to the pool.
            let a0 = self.pending0;
            let a1 = self.pending1;
            self.pending0 = 0;
            self.pending1 = 0;
            nativeReserve(LP_ACCOUNT_MIN_STORAGE, ReserveExact);
            message(MessageParameters {
                to: self.pool,
                value: 0,
                mode: SendRemainingBalance,
                bounce: false,
                body: CbAddLiquidity {
                    queryId: msg.queryId,
                    user: self.user,
                    amount0: a0,
                    amount1: a1,
                    minLpOut: msg.minLpOut,
                    lpReceiver: msg.lpReceiver,
                    refundTo: msg.refundTo,
                    allowCreate: msg.allowCreate,
                }.toCell(),
            });
            return;
        }

        // Still one-sided: keep the pending Gram, return the leftover gas.
        nativeReserve(self.keep(), ReserveExact);
        message(MessageParameters {
            to: msg.refundTo,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: JettonExcesses { queryId: msg.queryId }.toCell(),
        });
    }

    // User -> LpAccount: give back whatever is pending. The pool pays it out.
    receive(msg: LpAccountRefund) {
        require(sender() == self.user, "Not owner");
        require(context().value >= LP_ACCOUNT_REFUND_GAS, "Insufficient TON attached");
        let p0 = self.pending0;
        let p1 = self.pending1;
        self.pending0 = 0;
        self.pending1 = 0;
        nativeReserve(LP_ACCOUNT_MIN_STORAGE, ReserveExact);
        message(MessageParameters {
            to: self.pool,
            value: 0,
            mode: SendRemainingBalance,
            bounce: false,
            body: CbRefund { queryId: msg.queryId, user: self.user, amount0: p0, amount1: p1 }.toCell(),
        });
    }

    // Top-ups (storage rent).
    receive() {}

    bounced(msg: Slice) {}

    fun keep(): Int {
        return LP_ACCOUNT_MIN_STORAGE + (self.isNative ? self.pending0 : 0);
    }

    get fun get_lp_account_data(): LpAccountData {
        return LpAccountData {
            pool: self.pool,
            user: self.user,
            pending0: self.pending0,
            pending1: self.pending1,
            isNative: self.isNative,
        };
    }
}
