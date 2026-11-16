import "./messages";
import "./wallet";

const BPS: Int = 10000;
const MASTER_MIN_STORAGE: Int = ton("0.05");
const BUY_GAS: Int = ton("0.1");      // must be attached on top of tonAmount
const SELL_GAS: Int = ton("0.05");
const MINT_VALUE: Int = ton("0.05");  // TON sent with each curve mint
const PTON_GAS: Int = ton("0.01");    // pTON v2 ton_transfer overhead

// STON.fi v2 / pTON v2 op codes
const OP_PROVIDE_LP: Int = 0x37c096df;
const OP_TON_TRANSFER: Int = 0x01f3835d;

// Jetton master with a built-in constant-product bonding curve on virtual reserves.
// Buys mint, sells burn. When realTon reaches graduationTon the curve closes and the
// raised TON plus the remaining supply go into a STON.fi v2 pool; LP goes to lpReceiver.
contract TokenMaster {
    factory: Address;
    index: Int as uint64;

    configured: Bool;
    content: Cell;
    creator: Address;
    treasury: Address;
    params: CurveParams;
    dex: DexConfig;

    totalSupply: Int as coins;
    graduated: Bool;
    tonReserve: Int as coins;
    tokenReserve: Int as coins;
    realTon: Int as coins;
    tokensSold: Int as coins;
    platformFeesAccrued: Int as coins;

    init(factory: Address, index: Int) {
        self.factory = factory;
        self.index = index;
        self.configured = false;
        self.content = emptyCell();
        self.creator = factory;
        self.treasury = factory;
        self.params = CurveParams {
            maxSupply: 0, virtualTon: 0, virtualTokens: 0, graduationTon: 0,
            platformFeeBps: 0, graduationFee: 0,
            lpJettonValue: 0, lpJettonForward: 0, lpTonForward: 0,
        };
        self.dex = DexConfig { router: factory, routerPtonWallet: factory, lpReceiver: factory };
        self.totalSupply = 0;
        self.graduated = false;
        self.tonReserve = 0;
        self.tokenReserve = 0;
        self.realTon = 0;
        self.tokensSold = 0;
        self.platformFeesAccrued = 0;
    }

    receive(msg: Setup) {
        require(sender() == self.factory, "Not factory");
        require(!self.configured, "Already configured");
        self.configured = true;
        self.content = msg.content;
        self.creator = msg.creator;
        self.treasury = msg.treasury;
        self.params = msg.params;
        self.dex = msg.dex;
        self.tonReserve = msg.params.virtualTon;
        self.tokenReserve = msg.params.virtualTokens;

        if (msg.initialBuy > 0) {
            self.buy(msg.creator, 0, msg.initialBuy, 0);
        } else {
            self.refundRemaining(msg.creator, 0);
        }
    }

    receive(msg: Buy) {
        require(context().value >= msg.tonAmount + BUY_GAS, "Insufficient TON attached");
        self.buy(sender(), msg.queryId, msg.tonAmount, msg.minTokensOut);
    }

    receive(msg: SellNotification) {
        require(self.configured, "Not configured");
        require(!self.graduated, "Curve closed");
        let wallet = contractAddress(initOf TokenWallet(myAddress(), msg.seller));
        require(sender() == wallet, "Invalid wallet");
        require(context().value >= SELL_GAS, "Insufficient TON attached");

        let gross = self.tonReserve * msg.amount / (self.tokenReserve + msg.amount);
        require(gross > 0 && gross <= self.realTon, "Invalid sell");
        let platformFee = gross * self.params.platformFeeBps / BPS;
        let out = gross - platformFee;
        require(out >= msg.minTonOut, "Slippage");

        self.tonReserve -= gross;
        self.tokenReserve += msg.amount;
        self.realTon -= gross;
        self.tokensSold -= msg.amount;
        self.totalSupply -= msg.amount;
        self.platformFeesAccrued += platformFee;
        emit(Trade {
            isBuy: false, trader: msg.seller, ton: gross, tokens: msg.amount,
            tonReserve: self.tonReserve, tokenReserve: self.tokenReserve, realTon: self.realTon,
        }.toCell());

        // Reserve what the contract owes; proceeds plus leftover gas go to the seller.
        nativeReserve(self.keepBalance(), ReserveExact);
        message(MessageParameters {
            to: msg.seller,
            value: 0,
            mode: SendRemainingBalance,
            bounce: false,
            body: SellPayout { queryId: msg.queryId, amount: out }.toCell(),
        });
    }

    receive(msg: JettonBurnNotification) {
        let wallet = contractAddress(initOf TokenWallet(myAddress(), msg.sender));
        require(sender() == wallet, "Invalid wallet");
        self.totalSupply -= msg.amount;
        if (msg.responseDestination != null) {
            nativeReserve(self.keepBalance(), ReserveExact);
            message(MessageParameters {
                to: msg.responseDestination!!,
                value: 0,
                mode: SendRemainingBalance | SendIgnoreErrors,
                bounce: false,
                body: JettonExcesses { queryId: msg.queryId }.toCell(),
            });
        }
    }

    receive(msg: ClaimFees) {
        let platform = self.platformFeesAccrued;
        self.platformFeesAccrued = 0;
        if (platform > 0) {
            message(MessageParameters { to: self.treasury, value: platform, mode: SendPayGasSeparately, bounce: false, body: "Platform fees".asComment() });
        }
        self.refundRemaining(sender(), msg.queryId);
    }

    // Platform fee can be lowered by the factory admin, never raised.
    receive(msg: LowerPlatformFee) {
        require(sender() == self.factory, "Not factory");
        require(msg.newFeeBps < self.params.platformFeeBps, "Fee can only go down");
        self.params.platformFeeBps = msg.newFeeBps;
        self.refundRemaining(msg.excessTo, 0);
    }

    // TEP-89 wallet discovery, used by STON.fi and wallets.
    receive(msg: ProvideWalletAddress) {
        require(context().value >= ton("0.0061"), "Insufficient TON attached");
        let ownerCell: Cell? = msg.includeAddress ? beginCell().storeAddress(msg.ownerAddress).endCell() : null;
        let walletAddress = parseStdAddress(msg.ownerAddress.asSlice()).workchain == 0
            ? contractAddress(initOf TokenWallet(myAddress(), msg.ownerAddress))
            : newAddress(0, 0);
        message(MessageParameters {
            to: sender(),
            value: 0,
            mode: SendRemainingValue,
            bounce: false,
            body: TakeWalletAddress { queryId: msg.queryId, walletAddress, ownerAddress: ownerCell }.toCell(),
        });
    }

    // Accept plain TON (e.g. STON.fi excesses).
    receive() {}

    // -----------------------------------------------------------------------

    fun buy(buyer: Address, queryId: Int, tonAmount: Int, minTokensOut: Int) {
        require(self.configured, "Not configured");
        require(!self.graduated, "Curve closed");
        require(tonAmount > 0, "Invalid amount");

        let feeBps = self.params.platformFeeBps;
        let gross = tonAmount;
        let net = gross - gross * feeBps / BPS;
        let remaining = self.params.graduationTon - self.realTon;
        if (net > remaining) {
            // Only take what's needed to hit graduation; the rest is refunded.
            net = remaining;
            gross = (net * BPS + (BPS - feeBps) - 1) / (BPS - feeBps);
        }
        let platformFee = gross - net;

        let out = self.tokenReserve * net / (self.tonReserve + net);
        require(out > 0, "Amount too small");
        require(out >= minTokensOut, "Slippage");
        require(self.tokensSold + out < self.params.maxSupply, "Supply exceeded");

        self.tonReserve += net;
        self.tokenReserve -= out;
        self.realTon += net;
        self.tokensSold += out;
        self.totalSupply += out;
        self.platformFeesAccrued += platformFee;
        emit(Trade {
            isBuy: true, trader: buyer, ton: gross, tokens: out,
            tonReserve: self.tonReserve, tokenReserve: self.tokenReserve, realTon: self.realTon,
        }.toCell());

        // Mint with a fixed value so its gas is covered even if this buy graduates.
        deploy(DeployParameters {
            init: initOf TokenWallet(myAddress(), buyer),
            value: MINT_VALUE,
            mode: SendPayGasSeparately,
            bounce: true,
            body: JettonTransferInternal {
                queryId: queryId,
                amount: out,
                sender: myAddress(),
                responseDestination: buyer,
                forwardTonAmount: 0,
                forwardPayload: beginCell().storeBool(false).asSlice(),
            }.toCell(),
        });

        if (self.realTon >= self.params.graduationTon) {
            self.graduate();
        }
        self.refundRemaining(buyer, queryId);
    }

    fun graduate() {
        self.graduated = true;
        let poolTokens = self.params.maxSupply - self.tokensSold;
        let poolTon = self.realTon - self.params.graduationFee - self.params.lpJettonValue
            - self.params.lpTonForward - PTON_GAS;
        require(poolTon > 0, "Bad graduation params");
        self.realTon = 0;
        self.totalSupply += poolTokens;

        let router = self.dex.router;
        let routerJettonWallet = contractAddress(initOf TokenWallet(myAddress(), router));

        // Jetton leg: mint straight into the router's wallet with a provide_lp payload.
        deploy(DeployParameters {
            init: initOf TokenWallet(myAddress(), router),
            value: self.params.lpJettonValue,
            mode: SendPayGasSeparately,
            bounce: true,
            body: JettonTransferInternal {
                queryId: 0,
                amount: poolTokens,
                sender: myAddress(),
                responseDestination: self.treasury,
                forwardTonAmount: self.params.lpJettonForward,
                forwardPayload: beginCell().storeBool(true)
                    .storeRef(self.provideLpPayload(self.dex.routerPtonWallet)).asSlice(),
            }.toCell(),
        });

        // TON leg: pTON v2 ton_transfer to the router's pTON wallet.
        message(MessageParameters {
            to: self.dex.routerPtonWallet,
            value: poolTon + self.params.lpTonForward + PTON_GAS,
            mode: SendPayGasSeparately,
            bounce: true,
            body: beginCell()
                .storeUint(OP_TON_TRANSFER, 32)
                .storeUint(0, 64)
                .storeCoins(poolTon)
                .storeAddress(self.treasury)
                .storeBool(true)
                .storeRef(self.provideLpPayload(routerJettonWallet))
                .endCell(),
        });

        if (self.params.graduationFee > 0) {
            message(MessageParameters {
                to: self.treasury,
                value: self.params.graduationFee,
                mode: SendPayGasSeparately,
                bounce: false,
                body: "Graduation fee".asComment(),
            });
        }

        emit(Graduated { poolTokens, poolTon }.toCell());
    }

    // STON.fi v2 provide_lp payload. Refunds and excesses go to the treasury.
    fun provideLpPayload(otherTokenWallet: Address): Cell {
        return beginCell()
            .storeUint(OP_PROVIDE_LP, 32)
            .storeAddress(otherTokenWallet)
            .storeAddress(self.treasury)   // refund_address
            .storeAddress(self.treasury)   // excesses_address
            .storeUint(now() + 3600, 64)   // tx_deadline
            .storeRef(beginCell()
                .storeCoins(1)                     // min_lp_out
                .storeAddress(self.dex.lpReceiver) // to_address
                .storeUint(1, 1)                   // both_positive
                .storeCoins(0)                     // fwd_amount
                .storeBool(false)                  // custom_payload
                .endCell())
            .endCell();
    }

    // TON the contract must hold: curve backing, unclaimed fees, storage.
    fun keepBalance(): Int {
        return self.realTon + self.platformFeesAccrued + MASTER_MIN_STORAGE;
    }

    fun refundRemaining(to: Address, queryId: Int) {
        nativeReserve(self.keepBalance(), ReserveExact);
        message(MessageParameters {
            to: to,
            value: 0,
            mode: SendRemainingBalance | SendIgnoreErrors,
            bounce: false,
            body: JettonExcesses { queryId }.toCell(),
        });
    }

    // -----------------------------------------------------------------------

    get fun get_jetton_data(): JettonData {
        return JettonData {
            totalSupply: self.totalSupply,
            mintable: !self.graduated,
            adminAddress: null,
            jettonContent: self.content,
            jettonWalletCode: initOf TokenWallet(myAddress(), myAddress()).code,
        };
    }

    get fun get_wallet_address(owner: Address): Address {
        return contractAddress(initOf TokenWallet(myAddress(), owner));
    }

    get fun curveState(): CurveState {
        return CurveState {
            graduated: self.graduated,
            tonReserve: self.tonReserve,
            tokenReserve: self.tokenReserve,
            realTon: self.realTon,
            tokensSold: self.tokensSold,
            totalSupply: self.totalSupply,
            platformFeeBps: self.params.platformFeeBps,
            graduationTon: self.params.graduationTon,
            platformFeesAccrued: self.platformFeesAccrued,
        };
    }

    // Tokens received for tonAmount (ignores the graduation cap).
    get fun buyQuote(tonAmount: Int): Int {
        let net = tonAmount - tonAmount * self.params.platformFeeBps / BPS;
        return self.tokenReserve * net / (self.tonReserve + net);
    }

    // TON received for selling amount, after fees.
    get fun sellQuote(amount: Int): Int {
        let gross = self.tonReserve * amount / (self.tokenReserve + amount);
        return gross - gross * self.params.platformFeeBps / BPS;
    }

    // The curve this token was launched with (its liquidity tier).
    get fun curveParams(): CurveParams {
        return self.params;
    }

    get fun creator(): Address {
        return self.creator;
    }
}
