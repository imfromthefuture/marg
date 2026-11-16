import "./messages";
import "./constants";

// TEP-74 wallet of a pool's LP jetton. A copy of the launchpad TokenWallet without Sell; the
// burn notification carries customPayload (RemoveParams) to the pool, which may throw on it:
// the bounce restores the balance here.
contract LpWallet {
    pool: Address;      // the jetton master
    owner: Address;
    balance: Int as coins;

    init(pool: Address, owner: Address) {
        self.pool = pool;
        self.owner = owner;
        self.balance = 0;
    }

    receive(msg: JettonTransfer) {
        let ctx = context();
        require(ctx.sender == self.owner, "Not owner");
        require(msg.amount > 0, "Invalid amount");
        require(self.balance >= msg.amount, "Insufficient balance");
        require(isBasechain(msg.destination), "Wrong workchain");
        let fwdCount = msg.forwardTonAmount > 0 ? 2 : 1;
        require(ctx.value > msg.forwardTonAmount + fwdCount * ctx.readForwardFee() + 2 * LP_WALLET_GAS + LP_WALLET_MIN_STORAGE,
            "Insufficient TON attached");

        self.balance -= msg.amount;
        deploy(DeployParameters {
            init: initOf LpWallet(self.pool, msg.destination),
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
        if (ctx.sender != self.pool) {
            let peer = contractAddress(initOf LpWallet(self.pool, msg.sender));
            require(ctx.sender == peer, "Not LP wallet");
        }
        self.balance += msg.amount;

        // Keep a storage reserve, everything else goes on.
        let before = myBalance() - ctx.value;
        nativeReserve(max(before, LP_WALLET_MIN_STORAGE), ReserveAtMost);

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

    // Burning LP = removing liquidity. customPayload is RemoveParams (min amounts, deadline).
    receive(msg: JettonBurn) {
        let ctx = context();
        require(ctx.sender == self.owner, "Not owner");
        require(msg.amount > 0, "Invalid amount");
        require(self.balance >= msg.amount, "Insufficient balance");
        require(ctx.value > ctx.readForwardFee() * 2 + 2 * LP_WALLET_GAS, "Insufficient TON attached");

        self.balance -= msg.amount;
        message(MessageParameters {
            to: self.pool,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: LpBurnNotification {
                queryId: msg.queryId,
                amount: msg.amount,
                sender: self.owner,
                responseDestination: msg.responseDestination,
                customPayload: msg.customPayload,
            }.toCell(),
        });
    }

    // A failed transfer or burn returns the LP.
    bounced(msg: bounced<JettonTransferInternal>) {
        self.balance += msg.amount;
    }

    bounced(msg: bounced<LpBurnNotification>) {
        self.balance += msg.amount;
    }

    get fun get_wallet_data(): JettonWalletData {
        return JettonWalletData {
            balance: self.balance,
            owner: self.owner,
            master: self.pool,
            code: initOf LpWallet(self.pool, self.owner).code,
        };
    }
}
