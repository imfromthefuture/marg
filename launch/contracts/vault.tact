import "./messages";

// Creator vault: one per token, LaunchVault(master) (deterministic address). At launch the master
// deploys it with VaultSetup and mints the vault share of the supply into the vault's jetton wallet
// (owner = this vault). That wallet is never tracked for holder rewards (like the Router's wallet),
// so locked tokens do not dilute holders; once claimed to the beneficiary they are tracked normally.
//
// Schedule: nothing before start + lock; then everything at once (vest = 0) or linearly over vest
// seconds. Only the beneficiary (the creator at launch) can claim or hand the vault on. No admin,
// no early withdrawal, no other way out.
//
// The vault does not reference LaunchWallet: the master tells it its wallet address (no code cycle).

const VAULT_MIN_STORAGE: Int = ton("0.03");         // kept for storage (the master funds it with VAULT_DEPLOY_VALUE)
// Minimum ClaimVault value: vault compute + JettonTransfer to its (untracked) wallet, which needs
// > fwd fee + walletHopsFee() (~0.034 at 400 nanoGram/gas) + WALLET_MIN_STORAGE 0.01, and the beneficiary's wallet,
// which checkpoints (tracked) only with >= checkpointValue() (~0.026 at 400) + WALLET_MIN_STORAGE + its compute. The rest comes back.
const VAULT_CLAIM_VALUE: Int = ton("0.15");

contract LaunchVault {
    master: Address;
    ready: Bool;                    // VaultSetup ran
    beneficiary: Address;
    wallet: Address;
    total: Int as coins;
    claimed: Int as coins;
    start: Int as uint32;
    lock: Int as uint32;
    vest: Int as uint32;

    init(master: Address) {
        self.master = master;
        self.ready = false;
        self.beneficiary = master;
        self.wallet = master;
        self.total = 0;
        self.claimed = 0;
        self.start = 0;
        self.lock = 0;
        self.vest = 0;
    }

    receive(msg: VaultSetup) {
        require(sender() == self.master, "Not master");
        require(!self.ready, "Already set up");
        self.ready = true;
        self.beneficiary = msg.beneficiary;
        self.wallet = msg.wallet;
        self.total = msg.total;
        self.start = msg.start;
        self.lock = msg.lock;
        self.vest = msg.vest;
        // The deploy value stays here as the storage reserve.
    }

    receive(msg: ClaimVault) {
        let ctx = context();
        require(self.ready && ctx.sender == self.beneficiary, "Not beneficiary");
        require(ctx.value >= VAULT_CLAIM_VALUE, "Insufficient TON attached");
        let amount = self.unlocked(now()) - self.claimed;
        require(amount > 0, "Nothing to claim");
        self.claimed += amount;
        emit(VaultClaimed { queryId: msg.queryId, beneficiary: self.beneficiary, amount, claimed: self.claimed }.toCell());
        nativeReserve(max(myBalance() - ctx.value, VAULT_MIN_STORAGE), ReserveAtMost);
        message(MessageParameters {
            to: self.wallet,
            value: 0,
            mode: SendRemainingBalance,
            bounce: true,
            body: JettonTransfer {
                queryId: msg.queryId,
                amount,
                destination: self.beneficiary,
                responseDestination: self.beneficiary,
                customPayload: null,
                forwardTonAmount: 0,
                forwardPayload: beginCell().storeBool(false).asSlice(),
            }.toCell(),
        });
    }

    receive(msg: TransferVaultBeneficiary) {
        let ctx = context();
        require(self.ready && ctx.sender == self.beneficiary, "Not beneficiary");
        require(parseStdAddress(msg.newBeneficiary.asSlice()).workchain == 0, "Invalid beneficiary");
        self.beneficiary = msg.newBeneficiary;
        nativeReserve(max(myBalance() - ctx.value, VAULT_MIN_STORAGE), ReserveAtMost);
        message(MessageParameters {
            to: ctx.sender,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: JettonExcesses { queryId: msg.queryId }.toCell(),
        });
    }

    // The wallet refused the transfer (cannot happen with VAULT_CLAIM_VALUE): the amount is claimable again.
    bounced(msg: bounced<JettonTransfer>) {
        self.claimed -= msg.amount;
    }

    // Plain top-ups (storage) are accepted.
    receive() {}

    // -----------------------------------------------------------------------

    fun unlocked(t: Int): Int {
        if (!self.ready) {
            return 0;
        }
        let end = self.start + self.lock;
        if (t < end) {
            return 0;
        }
        if (self.vest == 0 || t >= end + self.vest) {
            return self.total;
        }
        return self.total * (t - end) / self.vest;
    }

    get fun get_vault_data(): VaultData {
        let u = self.unlocked(now());
        return VaultData {
            beneficiary: self.beneficiary,
            total: self.total,
            claimed: self.claimed,
            start: self.start,
            lock: self.lock,
            vest: self.vest,
            unlockedNow: u,
            claimableNow: u - self.claimed,
        };
    }

    get fun get_vault_master(): Address {
        return self.master;
    }

    get fun get_vault_wallet(): Address {
        return self.wallet;
    }

    // Minimum value of a ClaimVault (the rest comes back to the beneficiary).
    get fun get_claim_value(): Int {
        return VAULT_CLAIM_VALUE;
    }
}
