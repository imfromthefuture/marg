import "./messages";

const MIN_TONS_FOR_STORAGE: Int = ton("0.01");
const WALLET_GAS: Int = ton("0.015");

// Standard TEP-74 jetton wallet, plus a Sell op that hands tokens back to the
// bonding curve. No transfer tax: after graduation this is a plain jetton.
contract TokenWallet {
    master: Address;
    owner: Address;
    balance: Int as coins;

    init(master: Address, owner: Address) {
        self.master = master;
        self.owner = owner;
        self.balance = 0;
    }

    receive(msg: JettonTransfer) {
        let ctx = context();
        require(ctx.sender == self.owner, "Not owner");
        require(msg.amount > 0, "Invalid amount");
        require(self.balance >= msg.amount, "Insufficient balance");
        require(parseStdAddress(msg.destination.asSlice()).workchain == 0, "Wrong workchain");
        let fwdCount = msg.forwardTonAmount > 0 ? 2 : 1;
        require(ctx.value > msg.forwardTonAmount + fwdCount * ctx.readForwardFee() + 2 * WALLET_GAS + MIN_TONS_FOR_STORAGE,
            "Insufficient TON attached");

        self.balance -= msg.amount;
        deploy(DeployParameters {
            init: initOf TokenWallet(self.master, msg.destination),
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
        if (ctx.sender != self.master) {
            let peer = contractAddress(initOf TokenWallet(self.master, msg.sender));
            require(ctx.sender == peer, "Invalid sender");
        }
        self.balance += msg.amount;

        // Keep a storage reserve, everything else goes on.
        let before = myBalance() - ctx.value;
        nativeReserve(max(before, MIN_TONS_FOR_STORAGE), ReserveAtMost);

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

    receive(msg: JettonBurn) {
        let ctx = context();
        require(ctx.sender == self.owner, "Not owner");
        require(msg.amount > 0, "Invalid amount");
        require(self.balance >= msg.amount, "Insufficient balance");
        require(ctx.value > ctx.readForwardFee() * 2 + 2 * WALLET_GAS, "Insufficient TON attached");

        self.balance -= msg.amount;
        message(MessageParameters {
            to: self.master,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: JettonBurnNotification {
                queryId: msg.queryId,
                amount: msg.amount,
                sender: self.owner,
                responseDestination: msg.responseDestination,
            }.toCell(),
        });
    }

    receive(msg: Sell) {
        let ctx = context();
        require(ctx.sender == self.owner, "Not owner");
        require(msg.amount > 0, "Invalid amount");
        require(self.balance >= msg.amount, "Insufficient balance");
        require(ctx.value > ctx.readForwardFee() * 2 + 2 * WALLET_GAS, "Insufficient TON attached");

        self.balance -= msg.amount;
        message(MessageParameters {
            to: self.master,
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: SellNotification {
                queryId: msg.queryId,
                amount: msg.amount,
                minTonOut: msg.minTonOut,
                seller: self.owner,
            }.toCell(),
        });
    }

    // A failed transfer, burn or sell returns the tokens.
    bounced(msg: bounced<JettonTransferInternal>) {
        self.balance += msg.amount;
    }

    bounced(msg: bounced<JettonBurnNotification>) {
        self.balance += msg.amount;
    }

    bounced(msg: bounced<SellNotification>) {
        self.balance += msg.amount;
    }

    get fun get_wallet_data(): JettonWalletData {
        return JettonWalletData {
            balance: self.balance,
            owner: self.owner,
            master: self.master,
            code: initOf TokenWallet(self.master, self.owner).code,
        };
    }
}
