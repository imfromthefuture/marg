import "./messages";
import "./master";

const FACTORY_MIN_STORAGE: Int = ton("0.05");
const DEPLOY_GAS: Int = ton("0.2");      // covers master deploy + setup + mint
const MAX_PLATFORM_FEE_BPS: Int = 200;   // hard caps, admin can't exceed them

const TIER_COUNT: Int = 3;              // 0 low, 1 mid, 2 high liquidity

// Launchpad factory. Creators pick a liquidity tier; each tier has its own curve.
// Admin sets the tier curves for new launches only; existing tokens keep theirs.
contract Factory {
    admin: Address;
    treasury: Address;
    tiers: map<Int as uint8, CurveParams>;
    dex: DexConfig;
    launchFee: Int as coins;
    nextIndex: Int as uint64;

    init(admin: Address, treasury: Address, low: CurveParams, mid: CurveParams, high: CurveParams, dex: DexConfig, launchFee: Int) {
        self.admin = admin;
        self.treasury = treasury;
        self.tiers = emptyMap();
        self.tiers.set(0, low);
        self.tiers.set(1, mid);
        self.tiers.set(2, high);
        self.dex = dex;
        self.launchFee = launchFee;
        self.nextIndex = 0;
    }

    receive(msg: CreateToken) {
        let ctx = context();
        require(ctx.value >= DEPLOY_GAS + self.launchFee + msg.initialBuy, "Insufficient TON attached");
        let params = self.tiers.get(msg.tier);
        require(params != null, "Unknown tier");

        let index = self.nextIndex;
        self.nextIndex += 1;
        let init = initOf TokenMaster(myAddress(), index);
        let master = contractAddress(init);

        if (self.launchFee > 0) {
            message(MessageParameters {
                to: self.treasury,
                value: self.launchFee,
                mode: SendPayGasSeparately,
                bounce: false,
                body: "Launch fee".asComment(),
            });
        }
        message(MessageParameters {
            to: sender(),
            value: ton("0.01"),
            mode: SendPayGasSeparately,
            bounce: false,
            body: TokenCreated { queryId: msg.queryId, index, master }.toCell(),
        });

        // Everything else funds the deploy, the dev buy and its refund.
        nativeReserve(myBalance() - ctx.value, ReserveExact);
        deploy(DeployParameters {
            init,
            value: 0,
            mode: SendRemainingBalance,
            bounce: true,
            body: Setup {
                content: msg.content,
                creator: sender(),
                treasury: self.treasury,
                initialBuy: msg.initialBuy,
                params: params!!,
                dex: self.dex,
            }.toCell(),
        });
    }

    receive(msg: UpdateParams) {
        require(sender() == self.admin, "Not admin");
        require(msg.tier < TIER_COUNT, "Unknown tier");
        self.validate(msg.params);
        self.tiers.set(msg.tier, msg.params);
        self.launchFee = msg.launchFee;
        self.refund();
    }

    receive(msg: UpdateDex) {
        require(sender() == self.admin, "Not admin");
        self.dex = msg.dex;
        self.refund();
    }

    receive(msg: SetTreasury) {
        require(sender() == self.admin, "Not admin");
        self.treasury = msg.treasury;
        self.refund();
    }

    receive(msg: TransferAdmin) {
        require(sender() == self.admin, "Not admin");
        self.admin = msg.newAdmin;
        self.refund();
    }

    receive(msg: AdminLowerPlatformFee) {
        require(sender() == self.admin, "Not admin");
        message(MessageParameters {
            to: contractAddress(initOf TokenMaster(myAddress(), msg.index)),
            value: 0,
            mode: SendRemainingValue,
            bounce: true,
            body: LowerPlatformFee { newFeeBps: msg.newFeeBps, excessTo: sender() }.toCell(),
        });
    }

    receive() {}

    fun validate(p: CurveParams) {
        require(p.platformFeeBps <= MAX_PLATFORM_FEE_BPS, "Platform fee too high");
        require(p.virtualTon > 0 && p.virtualTokens > 0 && p.graduationTon > 0, "Invalid curve");
        // Tokens sold when the curve is full must leave supply for the pool.
        let soldAtGraduation = p.virtualTokens * p.graduationTon / (p.virtualTon + p.graduationTon);
        require(soldAtGraduation < p.maxSupply, "Curve sells more than supply");
        require(p.graduationTon > p.graduationFee + p.lpJettonValue + p.lpTonForward + ton("0.01"), "Graduation costs exceed raise");
        require(p.lpJettonValue > p.lpJettonForward, "Jetton leg gas too low");
    }

    fun refund() {
        nativeReserve(max(myBalance() - context().value, FACTORY_MIN_STORAGE), ReserveAtMost);
        message(MessageParameters {
            to: sender(),
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: "OK".asComment(),
        });
    }

    get fun tokenAddress(index: Int): Address {
        return contractAddress(initOf TokenMaster(myAddress(), index));
    }

    get fun params(tier: Int): CurveParams {
        let p = self.tiers.get(tier);
        require(p != null, "Unknown tier");
        return p!!;
    }

    get fun dex(): DexConfig {
        return self.dex;
    }

    get fun nextIndex(): Int {
        return self.nextIndex;
    }

    get fun launchFee(): Int {
        return self.launchFee;
    }

    get fun admin(): Address {
        return self.admin;
    }
}
