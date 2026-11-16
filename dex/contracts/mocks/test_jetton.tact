import "../messages";

// TESTS ONLY. A plain TEP-74 jetton whose owner can mint to anyone, optionally with a forward
// payload. Minting straight into the Router's wallet with a ProvideBothPayload simulates the
// launchpad's graduation.

const TJ_MIN_STORAGE: Int = ton("0.01");
const TJ_WALLET_GAS: Int = ton("0.015");

message(0x4d4700e1) TestMint {
    queryId: Int as uint64;
    to: Address;
    amount: Int as coins;
    responseDestination: Address?;
    forwardTonAmount: Int as coins;
    forwardPayload: Cell?;
}

contract TestJettonMaster {
    owner: Address;
    salt: Int as uint32;    // lets one owner deploy several distinct jettons
    totalSupply: Int as coins;

    init(owner: Address, salt: Int) {
        self.owner = owner;
        self.salt = salt;
        self.totalSupply = 0;
    }

    receive(msg: TestMint) {
        require(sender() == self.owner, "Not owner");
        self.totalSupply += msg.amount;
        deploy(DeployParameters {
            init: initOf TestJettonWallet(myAddress(), msg.to),
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

    receive(msg: ProvideWalletAddress) {
        require(context().value >= ton("0.0061"), "Insufficient TON attached");
        let ownerCell: Cell? = msg.includeAddress ? beginCell().storeAddress(msg.ownerAddress).endCell() : null;
        message(MessageParameters {
            to: sender(),
            value: 0,
            mode: SendRemainingValue,
            bounce: false,
            body: TakeWalletAddress {
                queryId: msg.queryId,
                walletAddress: contractAddress(initOf TestJettonWallet(myAddress(), msg.ownerAddress)),
                ownerAddress: ownerCell,
            }.toCell(),
        });
    }

    receive() {}

    bounced(msg: bounced<JettonTransferInternal>) {
        self.totalSupply -= msg.amount;
    }

    get fun get_jetton_data(): JettonData {
        return JettonData {
            totalSupply: self.totalSupply,
            mintable: true,
            adminAddress: self.owner,
            jettonContent: emptyCell(),
            jettonWalletCode: initOf TestJettonWallet(myAddress(), myAddress()).code,
        };
    }

    get fun get_wallet_address(owner: Address): Address {
        return contractAddress(initOf TestJettonWallet(myAddress(), owner));
    }
}

// The launchpad TokenWallet without Sell and without burn.
contract TestJettonWallet {
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
        let fwdCount = msg.forwardTonAmount > 0 ? 2 : 1;
        require(ctx.value > msg.forwardTonAmount + fwdCount * ctx.readForwardFee() + 2 * TJ_WALLET_GAS + TJ_MIN_STORAGE,
            "Insufficient TON attached");

        self.balance -= msg.amount;
        deploy(DeployParameters {
            init: initOf TestJettonWallet(self.master, msg.destination),
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
            let peer = contractAddress(initOf TestJettonWallet(self.master, msg.sender));
            require(ctx.sender == peer, "Invalid sender");
        }
        self.balance += msg.amount;

        let before = myBalance() - ctx.value;
        nativeReserve(max(before, TJ_MIN_STORAGE), ReserveAtMost);

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

    bounced(msg: bounced<JettonTransferInternal>) {
        self.balance += msg.amount;
    }

    get fun get_wallet_data(): JettonWalletData {
        return JettonWalletData {
            balance: self.balance,
            owner: self.owner,
            master: self.master,
            code: initOf TestJettonWallet(self.master, self.owner).code,
        };
    }
}
