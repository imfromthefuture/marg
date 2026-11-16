// Copies of the Marg DEX v2 (dex/v2/contracts/messages.tact) and TEP-74 / TEP-62 definitions the
// fee converter sends or receives. Tact only imports from inside a project root, so these are
// verbatim copies: same opcodes, same field order, same widths. fees/tests/types.spec.ts checks
// that each one serializes exactly like the dex/v2 build.

message(0x0f8a7ea5) JettonTransfer {
    queryId: Int as uint64;
    amount: Int as coins;
    destination: Address;
    responseDestination: Address?;
    customPayload: Cell?;
    forwardTonAmount: Int as coins;
    forwardPayload: Slice as remaining;
}

message(0x7362d09c) JettonNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    sender: Address;
    forwardPayload: Slice as remaining;
}

message(0xd53276db) JettonExcesses {
    queryId: Int as uint64;
}

message(0x05138d91) OwnershipAssigned {
    queryId: Int as uint64;
    prevOwner: Address;
    forwardPayload: Slice as remaining;
}

message(0x4d480001) SwapPayload {
    otherToken: Address;            // Router wallet of the output token, or GRAM
    tickSpacing: Int as uint16;
    ext: Cell?;
    minOut: Int as coins;
    sqrtPriceLimitX96: Int as uint160;  // 0 = none
    maxCrossings: Int as uint8;     // 1..32
    allowPartial: Bool;
    deadline: Int as uint32;
    receiver: Address?;
    refundTo: Address?;
    referral: Address?;
    refBps: Int as uint16;
    fwdTon: Int as coins;
    fwdPayload: Cell?;
}

message(0x4d480042) PositionDecrease {
    queryId: Int as uint64;
    liquidityDelta: Int as uint128;     // 0 = collect fees only
    amount0Min: Int as coins;
    amount1Min: Int as coins;
    deadline: Int as uint32;
    recipient: Address?;
}

message(0x4d480061) GramPayout {
    queryId: Int as uint64;
    reason: Int as uint8;
    amount: Int as coins;
    payload: Cell?;
}

message(0x4d480083) BurnReceipt {
    queryId: Int as uint64;
    index: Int as uint64;
    ok: Bool;
    code: Int as uint16;
    liquidityDelta: Int as uint128;     // removed (0 when !ok)
    liquidity: Int as uint128;          // the position's liquidity after the op
    amount0: Int as coins;              // principal paid to the recipient
    amount1: Int as coins;
    fees0: Int as coins;                // fees paid to the recipient
    fees1: Int as coins;
    fgInside0: Int as uint256;          // the position's fee checkpoint after the op
    fgInside1: Int as uint256;
}
