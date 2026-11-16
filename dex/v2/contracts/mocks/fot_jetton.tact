import "../messages";
import "./test_jetton";

// TESTS ONLY. A fee-on-transfer jetton: every incoming transfer to a wallet burns feeBps of it
// (the receiver is credited amount - fee). `honest` decides what the wallet notifies its owner:
//   honest = true:  the amount actually credited (amount - fee);
//   honest = false: the gross amount sent (more than the wallet received: a lying wallet).
// Used to show what the Router's "credit the notified amount" rule does with such tokens.

contract FotJettonMaster {
    owner: Address;
    feeBps: Int as uint16;
    honest: Bool;
    totalSupply: Int as coins;

    init(owner: Address, feeBps: Int, honest: Bool) {
        self.owner = owner;
        self.feeBps = feeBps;
        self.honest = honest;
        self.totalSupply = 0;
    }

    receive(msg: TestMint) {
        require(sender() == self.owner, "Not owner");
        self.totalSupply += msg.amount;
        deploy(DeployParameters {
            init: initOf FotJettonWallet(myAddress(), msg.to, self.feeBps, self.honest),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: JettonTransferInternal {
                queryId: msg.queryId,
                amount: msg.amount,
                sender: myAddress(),
                responseDestination: msg.responseDestination,
                forwardTonAmount: msg.forwardTonAmount,
                forwardPayload: msg.forwardPayload == null
                    ? beginCell().storeBool(false).asSlice()
                    : beginCell().storeBool(true).storeRef(msg.forwardPayload!!).asSlice(),
            }.toCell(),
        });
    }

    receive() {}

    get fun get_wallet_address(owner: Address): Address {
        return contractAddress(initOf FotJettonWallet(myAddress(), owner, self.feeBps, self.honest));
    }
}

contract FotJettonWallet {
    master: Address;
    owner: Address;
    feeBps: Int as uint16;
    honest: Bool;
    balance: Int as coins;

    init(master: Address, owner: Address, feeBps: Int, honest: Bool) {
        self.master = master;
        self.owner = owner;
        self.feeBps = feeBps;
        self.honest = honest;
        self.balance = 0;
    }

    receive(msg: JettonTransfer) {
        let ctx = context();
        require(ctx.sender == self.owner, "Not owner");
        require(msg.amount > 0, "Invalid amount");
        require(self.balance >= msg.amount, "Insufficient balance");
        self.balance -= msg.amount;
        deploy(DeployParameters {
            init: initOf FotJettonWallet(self.master, msg.destination, self.feeBps, self.honest),
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
            let peer = contractAddress(initOf FotJettonWallet(self.master, msg.sender, self.feeBps, self.honest));
            require(ctx.sender == peer, "Invalid sender");
        }
        let fee = ctx.sender == self.master ? 0 : msg.amount * self.feeBps / 10000;
        let credited = msg.amount - fee;
        self.balance += credited;

        nativeReserve(max(myBalance() - ctx.value, TJ_MIN_STORAGE), ReserveAtMost);
        if (msg.forwardTonAmount > 0) {
            message(MessageParameters {
                to: self.owner,
                value: msg.forwardTonAmount,
                mode: SendPayGasSeparately,
                bounce: false,
                body: JettonNotification {
                    queryId: msg.queryId,
                    amount: self.honest ? credited : msg.amount,
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

    bounced(msg: bounced<JettonTransferInternal>) {
        self.balance += msg.amount;
    }

    get fun get_wallet_data(): JettonWalletData {
        return JettonWalletData {
            balance: self.balance,
            owner: self.owner,
            master: self.master,
            code: initOf FotJettonWallet(self.master, self.owner, self.feeBps, self.honest).code,
        };
    }
}
