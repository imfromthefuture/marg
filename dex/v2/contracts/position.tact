import "./messages";
import "./constants";

// One concentrated-liquidity position (TEP-62 NFT item; the Pool is the collection).
// The Position is the authoritative record of its own liquidity and fee checkpoint: it only
// changes them on an authenticated PositionSync{ok}. One operation in flight at a time (busy);
// the Pool always answers with exactly one PositionSync, or the PoolBurn bounces (a throw, or any
// failed send: every PoolBurn send carries SendBounceIfActionFail). Payout addresses are checked
// here and in the Pool, and the Pool's reply budget is protected from rent debt (DESIGN §15.7).
contract Position {
    pool: Address;
    index: Int as uint64;
    initialized: Bool;
    owner: Address;
    tickLower: Int as int24;
    tickUpper: Int as int24;
    liquidity: Int as uint128;
    fgLast0: Int as uint256;
    fgLast1: Int as uint256;
    lockedUntil: Int as uint32;     // 0 = unlocked; 0xFFFFFFFF = locked forever
    busy: Bool;
    pendingQuery: Int as uint64;

    init(pool: Address, index: Int) {
        self.pool = pool;
        self.index = index;
        self.initialized = false;
        self.owner = pool;
        self.tickLower = 0;
        self.tickUpper = 0;
        self.liquidity = 0;
        self.fgLast0 = 0;
        self.fgLast1 = 0;
        self.lockedUntil = 0;
        self.busy = false;
        self.pendingQuery = 0;
    }

    receive(msg: PositionInit) {
        require(sender() == self.pool && !self.initialized, "Not pool");
        self.initialized = true;
        self.owner = msg.owner;
        self.tickLower = msg.tickLower;
        self.tickUpper = msg.tickUpper;
        self.liquidity = msg.liquidity;
        self.fgLast0 = msg.fgInside0;
        self.fgLast1 = msg.fgInside1;
        self.lockedUntil = msg.lockedUntil;
    }

    // Decrease liquidity (delta > 0) or collect fees only (delta == 0, allowed even when locked).
    receive(msg: PositionDecrease) {
        self.startBurn(msg.queryId, msg.liquidityDelta, msg.amount0Min, msg.amount1Min, msg.deadline, msg.recipient,
            DECREASE_GAS, false);
    }

    // Same, and the result is reported to the owner as a BurnReceipt (§6.14).
    receive(msg: PositionDecreaseNotify) {
        self.startBurn(msg.queryId, msg.liquidityDelta, msg.amount0Min, msg.amount1Min, msg.deadline, msg.recipient,
            DECREASE_NOTIFY_GAS, true);
    }

    receive(msg: PositionSync) {
        require(sender() == self.pool && self.busy && msg.queryId == self.pendingQuery, "Unexpected sync");
        if (msg.ok) {
            self.liquidity = msg.liquidity;
            self.fgLast0 = msg.fgInside0;
            self.fgLast1 = msg.fgInside1;
        }
        self.busy = false;
        self.returnExcess(msg.queryId);
    }

    // The Pool's answer to a PoolBurnNotify: same state rule as PositionSync, then the receipt goes
    // to the owner with the remaining value (instead of JettonExcesses).
    receive(msg: PositionSyncNotify) {
        require(sender() == self.pool && self.busy && msg.queryId == self.pendingQuery, "Unexpected sync");
        if (msg.ok) {
            self.liquidity = msg.liquidity;
            self.fgLast0 = msg.fgInside0;
            self.fgLast1 = msg.fgInside1;
        }
        self.busy = false;
        self.sendReceipt(BurnReceipt {
            queryId: msg.queryId, index: self.index, ok: msg.ok, code: msg.code,
            liquidityDelta: msg.ok ? msg.liquidityDelta : 0, liquidity: self.liquidity,
            amount0: msg.amount0, amount1: msg.amount1, fees0: msg.fees0, fees1: msg.fees1,
            fgInside0: self.fgLast0, fgInside1: self.fgLast1,
        });
    }

    // The Pool threw (it never changed anything): unlock from our own state.
    bounced(msg: bounced<PoolBurn>) {
        self.busy = false;
        self.returnExcess(self.pendingQuery);
    }

    bounced(msg: bounced<PoolBurnNotify>) {
        self.busy = false;
        self.sendReceipt(BurnReceipt {
            queryId: self.pendingQuery, index: self.index, ok: false, code: CODE_BURN_BOUNCED,
            liquidityDelta: 0, liquidity: self.liquidity, amount0: 0, amount1: 0, fees0: 0, fees1: 0,
            fgInside0: self.fgLast0, fgInside1: self.fgLast1,
        });
    }

    // TEP-62 transfer. Refused while an operation is in flight.
    receive(msg: NftTransfer) {
        let ctx = context();
        require(ctx.sender == self.owner, "Not owner");
        require(self.initialized && !self.busy, "Busy");
        require(isBasechain(msg.newOwner), "Invalid owner");
        let prev = self.owner;
        self.owner = msg.newOwner;
        nativeReserve(POSITION_MIN_STORAGE, ReserveAtMost);
        if (msg.forwardAmount > 0) {
            message(MessageParameters {
                to: msg.newOwner,
                value: msg.forwardAmount,
                mode: SendPayGasSeparately,
                bounce: false,
                body: OwnershipAssigned { queryId: msg.queryId, prevOwner: prev, forwardPayload: msg.forwardPayload }.toCell(),
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

    receive(msg: GetStaticData) {
        message(MessageParameters {
            to: sender(),
            value: 0,
            mode: SendRemainingValue,
            bounce: false,
            body: ReportStaticData { queryId: msg.queryId, index: self.index, collection: self.pool }.toCell(),
        });
    }

    receive() {}

    bounced(msg: Slice) {}

    fun startBurn(queryId: Int, liquidityDelta: Int, amount0Min: Int, amount1Min: Int, deadline: Int,
                  recipient: Address?, minValue: Int, notify: Bool) {
        let ctx = context();
        require(ctx.sender == self.owner, "Not owner");
        require(self.initialized && !self.busy, "Busy");
        require(ctx.value >= minValue, "Insufficient TON attached");
        require(liquidityDelta <= self.liquidity, "Invalid amount");
        // A non-std recipient would fail the Pool's action phase (no bounce: busy forever).
        require(isBasechainOpt(recipient), "Invalid recipient");
        // LOCKED_FOREVER (graduation) never opens, not even at now() == 2^32 - 1.
        require(liquidityDelta == 0 || (self.lockedUntil != LOCKED_FOREVER && now() >= self.lockedUntil), "Locked");
        self.busy = true;
        self.pendingQuery = queryId;
        nativeReserve(POSITION_MIN_STORAGE, ReserveAtMost);
        let to = recipient != null ? recipient!! : self.owner;
        let body = notify ? PoolBurnNotify {
            queryId, index: self.index, owner: self.owner, recipient: to,
            tickLower: self.tickLower, tickUpper: self.tickUpper, liquidity: self.liquidity, liquidityDelta,
            fgLast0: self.fgLast0, fgLast1: self.fgLast1, amount0Min, amount1Min, deadline,
        }.toCell() : PoolBurn {
            queryId, index: self.index, owner: self.owner, recipient: to,
            tickLower: self.tickLower, tickUpper: self.tickUpper, liquidity: self.liquidity, liquidityDelta,
            fgLast0: self.fgLast0, fgLast1: self.fgLast1, amount0Min, amount1Min, deadline,
        }.toCell();
        message(MessageParameters {
            to: self.pool,
            value: 0,
            mode: SendRemainingBalance,
            bounce: true,
            body,
        });
    }

    // The receipt is the owner's only result signal: it must never be starved by the storage
    // reserve (a long-idle Position may have spent its buffer on rent), so it keeps RECEIPT_FLOOR.
    fun sendReceipt(r: BurnReceipt) {
        nativeReserve(max(0, min(POSITION_MIN_STORAGE, myBalance() - RECEIPT_FLOOR)), ReserveAtMost);
        message(MessageParameters {
            to: self.owner,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: r.toCell(),
        });
    }

    fun returnExcess(queryId: Int) {
        nativeReserve(POSITION_MIN_STORAGE, ReserveAtMost);
        message(MessageParameters {
            to: self.owner,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: JettonExcesses { queryId }.toCell(),
        });
    }

    get fun get_position_data(): PositionData {
        return PositionData {
            pool: self.pool,
            index: self.index,
            initialized: self.initialized,
            owner: self.owner,
            tickLower: self.tickLower,
            tickUpper: self.tickUpper,
            liquidity: self.liquidity,
            fgLast0: self.fgLast0,
            fgLast1: self.fgLast1,
            lockedUntil: self.lockedUntil,
            busy: self.busy,
        };
    }

    get fun get_nft_data(): NftData {
        return NftData {
            initialized: self.initialized,
            index: self.index,
            collection: self.pool,
            owner: self.initialized ? self.owner : null,
            content: beginCell().storeInt(self.tickLower, 24).storeInt(self.tickUpper, 24).endCell(),
        };
    }
}
