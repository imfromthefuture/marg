import "../messages";

// TESTS ONLY. An owner-controlled contract that sends any body to any address: forged
// JettonNotification (it then acts as its own "jetton wallet" token id), PayTo,
// CbMint, PoolBurn, PositionSync, PoolSwap, and so on. Used to test spoofing.

message(0x4d4800f1) FakeSend {
    to: Address;
    value: Int as coins;
    bounce: Bool;
    body: Cell;
}

contract FakeJettonWallet {
    owner: Address;
    salt: Int as uint32;

    init(owner: Address, salt: Int) {
        self.owner = owner;
        self.salt = salt;
    }

    receive(msg: FakeSend) {
        require(sender() == self.owner, "Not owner");
        message(MessageParameters {
            to: msg.to,
            value: msg.value,
            mode: SendPayGasSeparately,
            bounce: msg.bounce,
            body: msg.body,
        });
    }

    // An odd salt makes this behave like a broken jetton wallet that rejects every transfer the
    // Router sends it (to test the Router's bounced<JettonTransfer> path).
    receive(msg: JettonTransfer) {
        require(self.salt % 2 == 0, "Broken wallet");
    }

    // Accept anything else (bounces, top-ups, excesses).
    receive(msg: Slice) {}

    receive() {}

    bounced(msg: Slice) {}
}
