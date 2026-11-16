// Definitions shared with the launchpad project. Tact only imports from inside a project root, so
// /launch keeps a verbatim copy (launch/contracts/dex_shared.tact); launch/tests asserts the two
// files are byte-identical and serialize identically. Edit both together. No imports on purpose.

// One pool per key: several pools per pair (v4 style). ext == null is a plain pool.
struct PoolKey {
    token0: Address;
    token1: Address;
    tickSpacing: Int as uint16;
    ext: Cell?;
}

// Hook and plugin settings, fixed at pool creation (stored as PoolKey.ext). 1017 bits, one cell.
struct KeyExt {
    hook: Address?;
    hookFlags: Int as uint8;        // bit0 AFTER_SWAP, bit1 AFTER_MODIFY, bit2 FEE_CONTROL
    hookShareBps: Int as uint16;
    hookFeeMin: Int as uint32;
    hookFeeMax: Int as uint32;
    initializer: Address?;          // only this address may set the first price
    launchFeePips: Int as uint32;   // LAUNCH_DECAY plugin
    launchDuration: Int as uint32;
    minLockSecs: Int as uint32;     // MIN_LP_LOCK plugin
    // TAX plugin (Gram pools only, initializer required): buy tax on the Gram input, sell tax on
    // the Gram output, accrued in the pool's taxFees and paid to taxRecipient by CollectTax.
    taxRecipient: Address?;         // null iff buyTaxBps == sellTaxBps == 0
    buyTaxBps: Int as uint16;       // <= TAX_MAX_BPS
    sellTaxBps: Int as uint16;      // <= TAX_MAX_BPS
}

// Direct-launch payload (DESIGN.md §6.11). It rides inside JettonNotification.forwardPayload
// (Either inline/ref) of a transfer whose sender becomes the key's initializer.
// The message is larger than one cell; Tact splits it into a ref chain deterministically.
message(0x4d480004) LaunchPayload {
    sqrtPriceX96: Int as uint160;   // start price (jetton per Gram, Q64.96); the Pool floors its tick to the spacing
    tickSpacing: Int as uint16;
    launchFeePips: Int as uint32;   // LAUNCH_DECAY plugin of the key
    launchDuration: Int as uint32;
    deadline: Int as uint32;
    feeClaimer: Address;            // owner of the locked position (collects its LP fees)
    refundTo: Address;              // refunds and the Gram excess
    taxRecipient: Address?;         // TAX plugin of the key: null iff both taxes are 0
    buyTaxBps: Int as uint16;
    sellTaxBps: Int as uint16;
    devBuy: Int as coins;           // Gram swapped for devReceiver in the SAME Pool transaction (0 = none)
    minDevOut: Int as coins;
    devReceiver: Address;
}
