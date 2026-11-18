// Deploy helper for contracts whose StateInit is larger than an external message may be (64 KB):
// the owner uploads the code tree in subtrees (Put), rebuilds the upper cells from them (Join), and
// the helper deploys StateInit{code, data} with an internal message (Launch). The deployed address is
// the hash of that StateInit, so the result is exactly the contract that was built and tested.
// Close returns the rest of the balance and destroys the helper.

message(0x41534d01) Put {
    slot: Int as uint8;
    cell: Cell;
}

message(0x41534d02) Join {
    slot: Int as uint8;
    bits: Cell;             // the cell's data bits (no refs)
    n: Int as uint8;        // number of refs, 0..4, taken from slots r0..r3 in order
    r0: Int as uint8;
    r1: Int as uint8;
    r2: Int as uint8;
    r3: Int as uint8;
}

message(0x41534d03) Launch {
    codeSlot: Int as uint8;
    data: Cell;
    value: Int as coins;
}

message(0x41534d04) Close {}

contract Assembler {
    owner: Address;
    nonce: Int as uint32;
    slots: map<Int as uint8, Cell>;

    init(owner: Address, nonce: Int) {
        self.owner = owner;
        self.nonce = nonce;
        self.slots = emptyMap();
    }

    receive() {}

    receive(msg: Put) {
        require(sender() == self.owner, "Not owner");
        self.slots.set(msg.slot, msg.cell);
    }

    receive(msg: Join) {
        require(sender() == self.owner, "Not owner");
        require(msg.n <= 4, "Too many refs");
        let b = beginCell().storeSlice(msg.bits.beginParse());
        if (msg.n > 0) { b = b.storeRef(self.slots.get(msg.r0)!!); }
        if (msg.n > 1) { b = b.storeRef(self.slots.get(msg.r1)!!); }
        if (msg.n > 2) { b = b.storeRef(self.slots.get(msg.r2)!!); }
        if (msg.n > 3) { b = b.storeRef(self.slots.get(msg.r3)!!); }
        self.slots.set(msg.slot, b.endCell());
    }

    receive(msg: Launch) {
        require(sender() == self.owner, "Not owner");
        deploy(DeployParameters {
            init: StateInit { code: self.slots.get(msg.codeSlot)!!, data: msg.data },
            value: msg.value,
            mode: SendPayGasSeparately,
            bounce: false,
        });
    }

    receive(msg: Close) {
        require(sender() == self.owner, "Not owner");
        message(MessageParameters {
            to: self.owner,
            value: 0,
            mode: SendRemainingBalance | SendDestroyIfZero,
            bounce: false,
            body: null,
        });
    }

    get fun get_slot_hash(slot: Int): Int {
        let c = self.slots.get(slot);
        return c == null ? 0 : c!!.hash();
    }
}
