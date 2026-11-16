import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, fromNano, toNano } from '@ton/core';
import '@ton/test-utils';
import { Factory } from '../build/Factory_Factory';
import { loadTrade, TokenMaster } from '../build/Factory_TokenMaster';
import { TokenWallet } from '../build/Factory_TokenWallet';
import { BURN_ADDRESS, defaultTiers, dexConfig, TIER_RAISE_GRAM } from '../scripts/params';

const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_PROVIDE_LP = 0x37c096df;
const OP_TON_TRANSFER = 0x01f3835d;
const BPS = 10000n;

describe('Launchpad', () => {
    let chain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let treasury: SandboxContract<TreasuryContract>;
    let creator: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let router: SandboxContract<TreasuryContract>;      // stands in for the STON.fi v2 router
    let ptonWallet: SandboxContract<TreasuryContract>;  // stands in for the router's pTON wallet
    let factory: SandboxContract<Factory>;
    const tiers = defaultTiers();
    const params = tiers[1]; // most tests run on the mid tier

    const content = beginCell().storeUint(1, 8).storeStringTail('https://example.com/meta.json').endCell();

    async function launch(initialBuy = 0n, tier = 1n) {
        const index = await factory.getNextIndex();
        const res = await factory.send(
            creator.getSender(),
            { value: toNano('0.5') + initialBuy },
            { $$type: 'CreateToken', queryId: 0n, content, tier, initialBuy },
        );
        const master = chain.openContract(TokenMaster.fromAddress(await factory.getTokenAddress(index)));
        return { res, master };
    }

    async function walletOf(master: SandboxContract<TokenMaster>, owner: Address) {
        return chain.openContract(TokenWallet.fromAddress(await master.getGetWalletAddress(owner)));
    }

    async function balanceOf(master: SandboxContract<TokenMaster>, owner: Address) {
        const w = await walletOf(master, owner);
        const state = await chain.getContract(w.address);
        if (state.accountState?.type !== 'active') return 0n;
        return (await w.getGetWalletData()).balance;
    }

    async function buy(master: SandboxContract<TokenMaster>, who: SandboxContract<TreasuryContract>, tonAmount: bigint, minTokensOut = 0n) {
        return master.send(who.getSender(), { value: tonAmount + toNano('0.2') }, { $$type: 'Buy', queryId: 0n, tonAmount, minTokensOut });
    }

    async function sell(master: SandboxContract<TokenMaster>, who: SandboxContract<TreasuryContract>, amount: bigint, minTonOut = 0n) {
        const w = await walletOf(master, who.address);
        return w.send(who.getSender(), { value: toNano('0.1') }, { $$type: 'Sell', queryId: 0n, amount, minTonOut });
    }

    beforeEach(async () => {
        chain = await Blockchain.create();
        admin = await chain.treasury('admin');
        treasury = await chain.treasury('treasury');
        creator = await chain.treasury('creator', { balance: toNano('100000') });
        alice = await chain.treasury('alice', { balance: toNano('100000') });
        bob = await chain.treasury('bob', { balance: toNano('100000') });
        router = await chain.treasury('router');
        ptonWallet = await chain.treasury('ptonWallet');

        factory = chain.openContract(
            await Factory.fromInit(admin.address, treasury.address, tiers[0], tiers[1], tiers[2], dexConfig(router.address, ptonWallet.address, BURN_ADDRESS), 0n),
        );
        const res = await factory.send(admin.getSender(), { value: toNano('1') }, null);
        expect(res.transactions).toHaveTransaction({ to: factory.address, deploy: true, success: true });
    });

    it('shapes every tier like pump.fun: ~15x climb and the pool opens at the final curve price', async () => {
        tiers.forEach((t, i) => {
            expect(t.graduationTon).toBe(toNano(TIER_RAISE_GRAM[i].toString()));
            const startMcap = Number(fromNano((t.virtualTon * t.maxSupply) / t.virtualTokens));
            const sold = (t.virtualTokens * t.graduationTon) / (t.virtualTon + t.graduationTon);
            const endPrice = Number(t.virtualTon + t.graduationTon) / Number(t.virtualTokens - sold);
            const endMcap = endPrice * Number(fromNano(t.maxSupply));
            expect(endMcap / startMcap).toBeGreaterThan(14);
            expect(endMcap / startMcap).toBeLessThan(16);
            const poolPrice = Number(t.graduationTon) / Number(t.maxSupply - sold);
            expect(Math.abs(poolPrice / endPrice - 1)).toBeLessThan(0.01);
        });
    });

    it('launches on the tier the creator picks and rejects unknown tiers', async () => {
        for (const tier of [0n, 1n, 2n]) {
            const { master } = await launch(0n, tier);
            expect((await master.getCurveState()).graduationTon).toBe(tiers[Number(tier)].graduationTon);
            expect((await master.getCurveParams()).virtualTon).toBe(tiers[Number(tier)].virtualTon);
        }
        const res = await factory.send(creator.getSender(), { value: toNano('0.5') },
            { $$type: 'CreateToken', queryId: 0n, content, tier: 3n, initialBuy: 0n });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });
        expect(await factory.getNextIndex()).toBe(3n);
    });

    it('creates a token through the factory', async () => {
        const { res, master } = await launch();
        expect(res.transactions).toHaveTransaction({ from: factory.address, to: master.address, deploy: true, success: true });
        expect(await factory.getNextIndex()).toBe(1n);
        const data = await master.getGetJettonData();
        expect(data.totalSupply).toBe(0n);
        expect(data.mintable).toBe(true);
        expect(data.jettonContent.equals(content)).toBe(true);
        expect((await master.getCreator()).equals(creator.address)).toBe(true);
    });

    it('rejects a launch without enough gas', async () => {
        const res = await factory.send(creator.getSender(), { value: toNano('0.1') },
            { $$type: 'CreateToken', queryId: 0n, content, tier: 1n, initialBuy: 0n });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });
        expect(await factory.getNextIndex()).toBe(0n);
    });

    it('executes the dev buy in the launch transaction', async () => {
        const { master } = await launch(toNano('100'));
        const bal = await balanceOf(master, creator.address);
        expect(bal).toBeGreaterThan(0n);
        expect((await master.getCurveState()).realTon).toBe(toNano('99')); // 1% platform fee only
    });

    it('buys on the curve, takes fees and refunds the rest', async () => {
        const { master } = await launch();
        const amount = toNano('500');
        const quote = await master.getBuyQuote(amount);
        const before = await alice.getBalance();
        await buy(master, alice, amount);
        expect(await balanceOf(master, alice.address)).toBe(quote);

        const state = await master.getCurveState();
        expect(state.platformFeesAccrued).toBe(toNano('5'));
        expect(state.realTon).toBe(toNano('495'));
        const spent = before - (await alice.getBalance());
        expect(spent).toBeGreaterThan(amount);
        expect(spent).toBeLessThan(amount + toNano('0.1'));

        // ~21% price impact for a $500 buy at a $5k start (500 TON ≈ $815 here, so check the curve maths instead)
        const priceBefore = (params.virtualTon * 10n ** 18n) / params.virtualTokens;
        const priceAfter = (state.tonReserve * 10n ** 18n) / state.tokenReserve;
        expect(priceAfter).toBeGreaterThan(priceBefore);
    });

    it('reverts a buy on slippage and returns the TON', async () => {
        const { master } = await launch();
        const amount = toNano('100');
        const quote = await master.getBuyQuote(amount);
        const before = await alice.getBalance();
        const res = await buy(master, alice, amount, quote + 1n);
        expect(res.transactions).toHaveTransaction({ to: master.address, success: false });
        expect(await balanceOf(master, alice.address)).toBe(0n);
        expect(before - (await alice.getBalance())).toBeLessThan(toNano('0.1'));
    });

    it('sells back to the curve', async () => {
        const { master } = await launch(50n);
        await buy(master, alice, toNano('1000'));
        const tokens = await balanceOf(master, alice.address);
        const half = tokens / 2n;
        const quote = await master.getSellQuote(half);
        const stateBefore = await master.getCurveState();
        const before = await alice.getBalance();

        const res = await sell(master, alice, half);
        expect(res.transactions).toHaveTransaction({ from: master.address, to: alice.address, success: true });
        expect(await balanceOf(master, alice.address)).toBe(tokens - half);

        const received = (await alice.getBalance()) - before;
        expect(received).toBeGreaterThan(quote - toNano('0.1'));
        expect(received).toBeLessThanOrEqual(quote);

        const state = await master.getCurveState();
        expect(state.totalSupply).toBe(stateBefore.totalSupply - half);
        expect(state.platformFeesAccrued).toBeGreaterThan(stateBefore.platformFeesAccrued);
    });

    it('restores tokens when a sell hits slippage', async () => {
        const { master } = await launch();
        await buy(master, alice, toNano('100'));
        const tokens = await balanceOf(master, alice.address);
        const quote = await master.getSellQuote(tokens);
        const res = await sell(master, alice, tokens, quote + 1n);
        expect(res.transactions).toHaveTransaction({ to: master.address, success: false });
        expect(await balanceOf(master, alice.address)).toBe(tokens);
    });

    it('buying then selling everything never pays out more than went in', async () => {
        const { master } = await launch();
        await buy(master, alice, toNano('3000'));
        await buy(master, bob, toNano('2000'));
        await sell(master, alice, await balanceOf(master, alice.address));
        await sell(master, bob, await balanceOf(master, bob.address));
        const state = await master.getCurveState();
        expect(state.tokensSold).toBe(0n);
        expect(state.realTon).toBeGreaterThanOrEqual(0n);
        const masterBalance = (await chain.getContract(master.address)).balance;
        expect(masterBalance).toBeGreaterThanOrEqual(state.realTon + state.platformFeesAccrued);
    });

    it('emits a Trade event for the indexer on every buy and sell', async () => {
        const { master } = await launch();
        const trades = (txs: any[]) => txs.flatMap((tx) => [...tx.outMessages.values()])
            .filter((m: any) => m.info.type === 'external-out')
            .map((m: any) => m.body.beginParse())
            .filter((s: any) => s.preloadUint(32) === 0x6b1a2c21)
            .map((s: any) => loadTrade(s));

        const b = trades((await buy(master, alice, toNano('100'))).transactions);
        expect(b).toHaveLength(1);
        let state = await master.getCurveState();
        expect(b[0].isBuy).toBe(true);
        expect(b[0].trader.equals(alice.address)).toBe(true);
        expect(b[0].ton).toBe(toNano('100'));
        expect(b[0].tokens).toBe(await balanceOf(master, alice.address));
        expect(b[0].tonReserve).toBe(state.tonReserve);
        expect(b[0].realTon).toBe(state.realTon);

        const amount = b[0].tokens / 2n;
        const s = trades((await sell(master, alice, amount)).transactions);
        state = await master.getCurveState();
        expect(s).toHaveLength(1);
        expect(s[0].isBuy).toBe(false);
        expect(s[0].tokens).toBe(amount);
        expect(s[0].tokenReserve).toBe(state.tokenReserve);
    });

    it('transfers between holders like a normal jetton', async () => {
        const { master } = await launch();
        await buy(master, alice, toNano('100'));
        const tokens = await balanceOf(master, alice.address);
        const w = await walletOf(master, alice.address);
        await w.send(alice.getSender(), { value: toNano('0.1') }, {
            $$type: 'JettonTransfer', queryId: 0n, amount: tokens / 4n, destination: bob.address,
            responseDestination: alice.address, customPayload: null, forwardTonAmount: 0n,
            forwardPayload: beginCell().storeBit(false).asSlice(),
        });
        expect(await balanceOf(master, bob.address)).toBe(tokens / 4n);
        expect(await balanceOf(master, alice.address)).toBe(tokens - tokens / 4n);
    });

    it('rejects a fake sell notification', async () => {
        const { master } = await launch();
        await buy(master, alice, toNano('100'));
        const res = await master.send(bob.getSender(), { value: toNano('1') },
            { $$type: 'SellNotification', queryId: 0n, amount: toNano('1000000'), minTonOut: 0n, seller: bob.address });
        expect(res.transactions).toHaveTransaction({ to: master.address, success: false });
    });

    it('pays all accrued fees to the treasury and nothing to the creator', async () => {
        const { master } = await launch();
        await buy(master, alice, toNano('1000'));
        const t0 = await treasury.getBalance();
        const c0 = await creator.getBalance();
        await master.send(bob.getSender(), { value: toNano('0.1') }, { $$type: 'ClaimFees', queryId: 0n });
        expect((await treasury.getBalance()) - t0).toBeGreaterThan(toNano('9.99'));
        expect(await creator.getBalance()).toBe(c0);
        expect((await master.getCurveState()).platformFeesAccrued).toBe(0n);
    });

    it('graduates to STON.fi v2 with the remaining supply and the raised TON', async () => {
        const { master } = await launch();
        await buy(master, alice, toNano('10000'));
        const before = await bob.getBalance();
        // More than needed: only the amount up to 25k TON net is taken.
        const res = await buy(master, bob, toNano('30000'));

        const state = await master.getCurveState();
        expect(state.graduated).toBe(true);
        expect(state.realTon).toBe(0n);

        const routerWallet = await walletOf(master, router.address);
        const poolTokens = params.maxSupply - state.tokensSold;
        expect(state.tokensSold / 10n ** 9n).toBeGreaterThan(793_000_000n);
        expect(state.tokensSold / 10n ** 9n).toBeLessThan(793_200_000n);
        expect((await routerWallet.getGetWalletData()).balance).toBe(poolTokens);
        expect(state.totalSupply).toBe(params.maxSupply);

        // Jetton leg: router gets a transfer_notification whose payload is provide_lp
        // pointing at the router's pTON wallet, LP to the burn address.
        const notif = res.transactions.find((t) => {
            const m = t.inMessage;
            if (!m || m.info.type !== 'internal' || !m.info.dest.equals(router.address)) return false;
            return m.body.beginParse().loadUint(32) === OP_TRANSFER_NOTIFICATION;
        });
        expect(notif).toBeDefined();
        const n = notif!.inMessage!.body.beginParse();
        n.loadUint(32); n.loadUintBig(64);
        expect(n.loadCoins()).toBe(poolTokens);
        expect(n.loadAddress().equals(master.address)).toBe(true);
        expect(n.loadBit()).toBe(true);
        const lp = n.loadRef().beginParse();
        expect(lp.loadUint(32)).toBe(OP_PROVIDE_LP);
        expect(lp.loadAddress().equals(ptonWallet.address)).toBe(true);
        expect(lp.loadAddress().equals(treasury.address)).toBe(true);
        expect(lp.loadAddress().equals(treasury.address)).toBe(true);
        lp.loadUintBig(64);
        const body = lp.loadRef().beginParse();
        expect(body.loadCoins()).toBe(1n);
        expect(body.loadAddress().equals(BURN_ADDRESS)).toBe(true);
        expect(body.loadUint(1)).toBe(1);

        // TON leg: ton_transfer to the router's pTON wallet with provide_lp pointing at the router's jetton wallet.
        const tonLeg = res.transactions.find((t) => {
            const m = t.inMessage;
            return !!m && m.info.type === 'internal' && m.info.dest.equals(ptonWallet.address);
        });
        expect(tonLeg).toBeDefined();
        const tl = tonLeg!.inMessage!.body.beginParse();
        expect(tl.loadUint(32)).toBe(OP_TON_TRANSFER);
        tl.loadUintBig(64);
        const poolTon = tl.loadCoins();
        expect(tl.loadAddress().equals(treasury.address)).toBe(true);
        expect(tl.loadBit()).toBe(true);
        const lp2 = tl.loadRef().beginParse();
        expect(lp2.loadUint(32)).toBe(OP_PROVIDE_LP);
        expect(lp2.loadAddress().equals(routerWallet.address)).toBe(true);
        expect(poolTon).toBe(params.graduationTon - params.lpJettonValue - params.lpTonForward - toNano('0.01'));

        // Pool price ≈ last curve price.
        const curvePrice = Number(state.tonReserve) / Number(state.tokenReserve);
        const poolPrice = Number(poolTon) / Number(poolTokens);
        expect(Math.abs(poolPrice / curvePrice - 1)).toBeLessThan(0.02);

        // Bob only paid what was needed to fill the curve.
        const spent = before - (await bob.getBalance());
        expect(spent).toBeLessThan(toNano('16000'));

        console.log(`graduation: ${fromNano(poolTon)} TON + ${poolTokens / 10n ** 9n} tokens, ` +
            `mcap ${(poolPrice * 1e9).toFixed(0)} TON, bob spent ${fromNano(spent)} TON`);

        // Curve is closed now.
        const late = await buy(master, alice, toNano('10'));
        expect(late.transactions).toHaveTransaction({ to: master.address, success: false });
        const lateSell = await sell(master, alice, 1000n);
        expect(lateSell.transactions).toHaveTransaction({ to: master.address, success: false });
        expect(await balanceOf(master, alice.address)).toBeGreaterThan(0n);
        expect((await master.getGetJettonData()).mintable).toBe(false);
    });

    it('lets only the admin change launch params, for new tokens only', async () => {
        const { master: oldToken } = await launch();
        const newParams = { ...params, platformFeeBps: 150n };
        let res = await factory.send(alice.getSender(), { value: toNano('0.05') }, { $$type: 'UpdateParams', tier: 1n, params: newParams, launchFee: 0n });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });

        res = await factory.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'UpdateParams', tier: 1n, params: { ...params, platformFeeBps: 300n }, launchFee: 0n });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });

        await factory.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'UpdateParams', tier: 1n, params: newParams, launchFee: toNano('1') });
        expect((await factory.getParams(1n)).platformFeeBps).toBe(150n);
        expect((await factory.getParams(0n)).platformFeeBps).toBe(100n);
        expect((await oldToken.getCurveState()).platformFeeBps).toBe(100n);

        const t0 = await treasury.getBalance();
        const { master: newToken } = await (async () => {
            const index = await factory.getNextIndex();
            await factory.send(creator.getSender(), { value: toNano('1.5') },
                { $$type: 'CreateToken', queryId: 0n, content, tier: 1n, initialBuy: 0n });
            return { master: chain.openContract(TokenMaster.fromAddress(await factory.getTokenAddress(index))) };
        })();
        expect((await newToken.getCurveState()).platformFeeBps).toBe(150n);
        expect((await treasury.getBalance()) - t0).toBeGreaterThan(toNano('0.99'));
    });

    it('lets the admin lower the platform fee on a live token, never raise it', async () => {
        const { master } = await launch();
        const lower = (from: SandboxContract<TreasuryContract>, newFeeBps: bigint) =>
            factory.send(from.getSender(), { value: toNano('0.05') }, { $$type: 'AdminLowerPlatformFee', index: 0n, newFeeBps });

        let res = await lower(alice, 0n);
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });
        await lower(admin, 50n);
        expect((await master.getCurveState()).platformFeeBps).toBe(50n);
        res = await lower(admin, 80n);
        expect(res.transactions).toHaveTransaction({ to: master.address, success: false });
        expect((await master.getCurveState()).platformFeeBps).toBe(50n);

        // New fee applies to the next trade: 0.5%.
        await buy(master, alice, toNano('1000'));
        const state = await master.getCurveState();
        expect(state.platformFeesAccrued).toBe(toNano('5'));
        expect(state.realTon).toBe(toNano('995'));

        await lower(admin, 0n);
        expect((await master.getCurveState()).platformFeeBps).toBe(0n);
    });

    it('answers TEP-89 wallet discovery', async () => {
        const { master } = await launch();
        const res = await master.send(alice.getSender(), { value: toNano('0.05') },
            { $$type: 'ProvideWalletAddress', queryId: 7n, ownerAddress: bob.address, includeAddress: false });
        expect(res.transactions).toHaveTransaction({ from: master.address, to: alice.address, success: true });
    });
});

