import "../messages";

// TESTS ONLY. A hook that records the last notifications it received and, on its owner's
// command, sends any body (HookSetFee, HookCollectFees) to any target. An odd salt makes it throw
// on every notification, to prove a failing hook cannot affect a trade.

message(0x4d4800f2) HookCmd {
    target: Address;
    value: Int as coins;
    bounce: Bool;
    body: Cell;
}

contract TestHook {
    owner: Address;
    salt: Int as uint32;
    swaps: Int as uint32;
    modifies: Int as uint32;
    lastSwap: HookAfterSwap?;
    lastModify: HookAfterModify?;

    init(owner: Address, salt: Int) {
        self.owner = owner;
        self.salt = salt;
        self.swaps = 0;
        self.modifies = 0;
        self.lastSwap = null;
        self.lastModify = null;
    }

    receive(msg: HookAfterSwap) {
        require(self.salt % 2 == 0, "Broken hook");
        self.swaps += 1;
        self.lastSwap = msg;
    }

    receive(msg: HookAfterModify) {
        require(self.salt % 2 == 0, "Broken hook");
        self.modifies += 1;
        self.lastModify = msg;
    }

    receive(msg: HookCmd) {
        require(sender() == self.owner, "Not owner");
        message(MessageParameters {
            to: msg.target,
            value: msg.value,
            mode: SendPayGasSeparately,
            bounce: msg.bounce,
            body: msg.body,
        });
    }

    receive(msg: GramPayout) {}

    receive(msg: JettonExcesses) {}

    receive() {}

    bounced(msg: Slice) {}

    get fun counts(): Int {
        return self.swaps * 1000000 + self.modifies;
    }

    get fun last_swap(): HookAfterSwap? {
        return self.lastSwap;
    }

    get fun last_modify(): HookAfterModify? {
        return self.lastModify;
    }
}
