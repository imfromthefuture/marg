// Fee converter messages. Opcodes use the prefix 0x4d46 ("MF"), disjoint from the DEX (0x4d48),
// the launchpad (0x4d4c) and the vaults (0x5641).

// Anyone: forward every Gram above FC_RESERVE to the treasury.
message(0x4d460001) Flush {
    queryId: Int as uint64;
}

// Keeper or admin: swap `amount` of the jetton held in the converter's wallet `jettonWallet` to Gram
// on the Marg DEX v2 key (GRAM, X, tickSpacing, ext), which must be admin-approved for that wallet
// (ApproveConvertKey; else refused). The Router validates the key; anything wrong
// refunds the jettons to the converter. minOut > 0 is mandatory (sandwich bound).
message(0x4d460002) ConvertJetton {
    queryId: Int as uint64;
    jettonWallet: Address;          // the converter's OWN wallet of X (the caller's gas is all that reaches it)
    amount: Int as coins;
    tickSpacing: Int as uint16;
    ext: Cell?;
    minOut: Int as coins;           // > 0, net Gram out (after any sell tax)
    maxCrossings: Int as uint8;     // 1..24; the value to attach grows with it (get_convert_value)
}

// Anyone: collect the LP fees of a Position NFT the converter owns (PositionDecrease, liquidityDelta 0).
message(0x4d460003) CollectPosition {
    queryId: Int as uint64;
    position: Address;
}

// Admin: send `amount` of a jetton from the converter's wallet to the TREASURY as is (for a jetton
// without a usable Gram pool). The treasury is the only possible destination.
message(0x4d460004) RescueJetton {
    queryId: Int as uint64;
    jettonWallet: Address;
    amount: Int as coins;
}

// Admin: approve (approved = true) or revoke (false) the DEX key (GRAM, X, tickSpacing, ext) as a
// ConvertJetton route for the converter's wallet `jettonWallet` of X. ConvertJetton on any other key
// is refused. Stored as hash(jettonWallet . uint16 tickSpacing . Maybe ^ext).
message(0x4d460009) ApproveConvertKey {
    queryId: Int as uint64;
    jettonWallet: Address;
    tickSpacing: Int as uint16;
    ext: Cell?;
    approved: Bool;
}

message(0x4d460005) SetKeeper {
    queryId: Int as uint64;
    keeper: Address?;               // null: only the admin converts
}

message(0x4d460006) SetFeeTreasury {
    queryId: Int as uint64;
    treasury: Address;
}

message(0x4d460007) TransferConverterAdmin {
    queryId: Int as uint64;
    newAdmin: Address;
}

message(0x4d460008) ClaimConverterAdmin {
    queryId: Int as uint64;
}

// Plain-Gram transfer to the treasury carries this body (a treasury contract can ignore it).
message(0x4d460061) TreasuryDeposit {
    queryId: Int as uint64;
}

// External-out log of a ConvertJetton that was sent (the result is the Router's SwapEvent / RefundEvent).
message(0x4d460071) ConvertEvent {
    queryId: Int as uint64;
    jettonWallet: Address;
    amount: Int as coins;
    tickSpacing: Int as uint16;
    minOut: Int as coins;
}

struct ConverterData {
    treasury: Address;
    router: Address;
    admin: Address;
    pendingAdmin: Address?;
    keeper: Address?;
    balance: Int;
    reserve: Int;
}
