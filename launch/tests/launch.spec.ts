// Marg direct launch: LaunchFactory + fixed-supply LaunchJetton on top of Marg DEX v2.
// Sandbox only: deploys the DEX v2 Router and the factory, launches tokens (with and without dev
// buy, with and without tax), trades them, claims the locked position's fees to the treasury,
// exercises the admin powers and every rejection.

import * as fs from 'fs';
import * as path from 'path';
import { Blockchain, SandboxContract, TreasuryContract, SendMessageResult } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import '@ton/test-utils';
import { LaunchFactory, LaunchParams, storeLaunchPayload as storeLaunchPayloadL, loadTokenLaunched } from '../build/Launch_LaunchFactory';
import { LaunchJetton } from '../build/Launch_LaunchJetton';
import { LaunchWallet } from '../build/Launch_LaunchWallet';
import { Router, storeSwapPayload, storeLaunchPayload as storeLaunchPayloadD, loadKeyExt } from '../../dex/v2/build/Router_Router';
import { Pool } from '../../dex/v2/build/Router_Pool';
import { Position } from '../../dex/v2/build/Router_Position';
import {
    txOk, events, swapEvents, initEvents, launchEvents, gramPayouts, refundCodes, opOf, gasAt, OP, REASON, CODES,
} from '../../dex/v2/tests/helpers';

jest.setTimeout(600000);

const GRAM = new Address(0, Buffer.alloc(32));
const SUPPLY = 10n ** 18n;
const Q96 = 2n ** 96n;
const T0 = 1_800_000_000;
const PARAMS: LaunchParams = { $$type: 'LaunchParams', startMcap: toNano('2600'), tickSpacing: 10n };
// Low = PARAMS (what the existing tests launch on); mid and high are deeper pools.
const TIERS = { $$type: 'LaunchTiers' as const, low: PARAMS,
    mid: { $$type: 'LaunchParams' as const, startMcap: toNano('10000'), tickSpacing: 10n },
    high: { $$type: 'LaunchParams' as const, startMcap: toNano('30000'), tickSpacing: 10n } };
const LAUNCH_FEE = toNano('1.5');
const PLATFORM_BPS = 100n;   // Router.platformBps default (1%), paid in Gram to the Router treasury

function content(name: string, symbol: string): Cell {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    for (const [k, v] of [['name', name], ['symbol', symbol], ['decimals', '9'], ['description', 'Marg direct launch test']]) {
        dict.set(BigInt('0x' + sha256_sync(k).toString('hex')), beginCell().storeUint(0, 8).storeStringTail(v).endCell());
    }
    return beginCell().storeUint(0, 8).storeDict(dict).endCell();
}

function expectNoFailures(res: SendMessageResult, allow?: (tx: any) => boolean) {
    const bad = res.transactions.filter((tx) => !txOk(tx) && !(allow && allow(tx)));
    expect(bad.map((tx) => (tx.description as any).computePhase?.exitCode)).toEqual([]);
}

// Market cap of the whole supply at a Q64.96 sqrt price (jetton per Gram), in nanoGram.
const mcapAt = (sqrtP: bigint) => (SUPPLY * Q96 * Q96) / (sqrtP * sqrtP);

describe('Marg direct launch (factory + jetton + DEX v2)', () => {
    let chain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let treasury: SandboxContract<TreasuryContract>;
    let creator: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let carol: SandboxContract<TreasuryContract>;
    let router: SandboxContract<Router>;
    let factory: SandboxContract<LaunchFactory>;
    let base: any;

    async function create(o: { devBuy?: bigint; minDevOut?: bigint; buyTaxBps?: bigint; sellTaxBps?: bigint; taxWallet?: Address | null;
                               rewardsBps?: bigint; walletBps?: bigint; buybackBps?: bigint; antiSnipePips?: bigint; antiSnipeDuration?: bigint;
                               value?: bigint; from?: SandboxContract<TreasuryContract>; name?: string; startMcap?: bigint; tickSpacing?: bigint;
                               vaultBps?: bigint } = {}) {
        const devBuy = o.devBuy ?? 0n;
        const vaultBps = o.vaultBps ?? 0n;
        const p = (await factory.getGetFactoryData()).tiers.low;
        const value = o.value ?? await factory.getGetCreateValue2(devBuy, vaultBps > 0n);
        return factory.send((o.from ?? creator).getSender(), { value }, {
            $$type: 'CreateToken', queryId: 7n, content: content(o.name ?? 'Marg Test', 'MARG'), devBuy, minDevOut: o.minDevOut ?? 0n,
            buyTaxBps: o.buyTaxBps ?? 0n, sellTaxBps: o.sellTaxBps ?? 0n, taxWallet: o.taxWallet ?? null,
            rewardsBps: o.rewardsBps ?? 0n, walletBps: o.walletBps ?? 10000n, buybackBps: o.buybackBps ?? 0n,
            antiSnipePips: o.antiSnipePips ?? 150000n, antiSnipeDuration: o.antiSnipeDuration ?? 300n,
            startMcap: o.startMcap ?? p.startMcap, tickSpacing: o.tickSpacing ?? p.tickSpacing,
            vaultBps, vaultLock: vaultBps > 0n ? 7n * 86400n : 0n, vaultVest: 0n,
        });
    }

    // PLATFORM FEE payouts to the Router treasury in a result: [amount, value].
    const platPays = (res: SendMessageResult) => gramPayouts(res, treasury.address).filter((x) => x.reason === REASON.PLATFORM).map((x) => [x.amount, x.value]);

    async function opened(index: bigint) {
        const master = chain.openContract(LaunchJetton.fromAddress(await factory.getGetTokenAddress(index)));
        const key = await master.getGetPoolKey();
        const pool = chain.openContract(Pool.fromAddress(await router.getGetPoolAddress(key.token0, key.token1, key.tickSpacing, key.ext)));
        return { master, key, pool };
    }

    const jBal = async (master: SandboxContract<LaunchJetton>, owner: Address) => {
        const w = chain.openContract(LaunchWallet.fromAddress(await master.getGetWalletAddress(owner)));
        if ((await chain.getContract(w.address)).accountState?.type !== 'active') return 0n;
        return (await w.getGetWalletData()).balance;
    };

    async function buy(who: SandboxContract<TreasuryContract>, key: any, amount: bigint, minOut = 0n) {
        return router.send(who.getSender(), { value: amount + toNano('0.7') }, {
            $$type: 'SwapNative', queryId: 1n, amount, otherToken: key.token1, tickSpacing: key.tickSpacing, ext: key.ext, minOut,
            sqrtPriceLimitX96: 0n, maxCrossings: 24n, allowPartial: false, deadline: BigInt(chain.now! + 600), receiver: null,
            refundTo: null, referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null,
        });
    }

    async function sell(who: SandboxContract<TreasuryContract>, master: SandboxContract<LaunchJetton>, key: any, amount: bigint) {
        const w = chain.openContract(LaunchWallet.fromAddress(await master.getGetWalletAddress(who.address)));
        const p = beginCell().store(storeSwapPayload({
            $$type: 'SwapPayload', otherToken: GRAM, tickSpacing: key.tickSpacing, ext: key.ext, minOut: 0n, sqrtPriceLimitX96: 0n,
            maxCrossings: 24n, allowPartial: false, deadline: BigInt(chain.now! + 600), receiver: null, refundTo: null, referral: null,
            refBps: 0n, fwdTon: 0n, fwdPayload: null,
        })).endCell();
        return w.send(who.getSender(), { value: toNano('0.8') }, {
            $$type: 'JettonTransfer', queryId: 2n, amount, destination: router.address, responseDestination: who.address,
            customPayload: null, forwardTonAmount: toNano('0.7'), forwardPayload: beginCell().storeBit(1).storeRef(p).endCell().beginParse(),
        });
    }

    beforeAll(async () => {
        chain = await Blockchain.create();
        chain.now = T0;
        admin = await chain.treasury('admin');
        treasury = await chain.treasury('treasury');
        creator = await chain.treasury('creator', { balance: toNano('100000') });
        bob = await chain.treasury('bob', { balance: toNano('100000') });
        carol = await chain.treasury('carol', { balance: toNano('100000') });
        router = chain.openContract(await Router.fromInit(admin.address, treasury.address));
        expect((await router.send(admin.getSender(), { value: toNano('1') }, null)).transactions)
            .toHaveTransaction({ to: router.address, deploy: true, success: true });
        factory = chain.openContract(await LaunchFactory.fromInit(admin.address, treasury.address, router.address, LAUNCH_FEE, TIERS));
        expect((await factory.send(admin.getSender(), { value: toNano('0.5') }, null)).transactions)
            .toHaveTransaction({ to: factory.address, deploy: true, success: true });
        base = chain.snapshot();
    });
    beforeEach(async () => {
        await chain.loadFrom(base);
    });

    it('the launch payload and key structs are ONE definition: the copy is byte-identical and serializes identically', async () => {
        const a = fs.readFileSync(path.join(__dirname, '../contracts/dex_shared.tact'), 'utf8');
        const b = fs.readFileSync(path.join(__dirname, '../../dex/v2/contracts/shared.tact'), 'utf8');
        expect(a).toBe(b);
        const v = {
            $$type: 'LaunchPayload' as const, sqrtPriceX96: 123456789n * Q96, tickSpacing: 200n, launchFeePips: 150000n, launchDuration: 300n,
            deadline: 1n, feeClaimer: treasury.address, refundTo: creator.address, taxRecipient: bob.address, buyTaxBps: 300n,
            sellTaxBps: 500n, devBuy: toNano('12'), minDevOut: 5n, devReceiver: creator.address,
        };
        const c1 = beginCell().store(storeLaunchPayloadL(v)).endCell();
        const c2 = beginCell().store(storeLaunchPayloadD(v)).endCell();
        expect(c1.hash().equals(c2.hash())).toBe(true);
    });

    it('CreateToken: fixed 1B supply, minting closed, no admin; whole supply in the pool at ~2,600 Gram mcap; launch fee to treasury', async () => {
        const tb = (await chain.getContract(treasury.address)).balance;
        const cb = (await chain.getContract(creator.address)).balance;
        const value = await factory.getGetCreateValue(0n);
        expect(value).toBe(LAUNCH_FEE + toNano('0.15') + toNano('0.55'));
        const res = await create();
        expectNoFailures(res);
        const { master, key, pool } = await opened(0n);
        // Event from the factory.
        const tl = events(res).filter((e) => e.op === 0x4d4c0021).map((e) => loadTokenLaunched(e.body.clone()));
        expect([tl.length, tl[0].index, tl[0].master.equals(master.address), tl[0].creator.equals(creator.address)]).toEqual([1, 0n, true, true]);
        // Jetton: TEP-74 data.
        const jd = await master.getGetJettonData();
        expect([jd.totalSupply, jd.mintable, jd.adminAddress]).toEqual([SUPPLY, false, null]);
        expect(jd.jettonContent.hash().equals(content('Marg Test', 'MARG').hash())).toBe(true);
        expect(await master.getGetLaunched()).toBe(true);
        // The Router's wallet holds the supply; nobody else holds any.
        expect(await jBal(master, router.address)).toBe(SUPPLY);
        expect(await jBal(master, creator.address)).toBe(0n);
        expect(key.token1.equals(await master.getGetRouterWallet())).toBe(true);
        // Canonical key: initializer = master, the factory's launch fee plugin, no tax.
        const ext = loadKeyExt(key.ext!.beginParse());
        expect([ext.initializer!.equals(master.address), ext.launchFeePips, ext.launchDuration, ext.taxRecipient, ext.buyTaxBps, ext.sellTaxBps])
            .toEqual([true, 150000n, 300n, null, 0n, 0n]);
        expect((await router.getGetLaunchPoolAddress(key.token1, PARAMS.tickSpacing, master.address, 150000n, 300n, null, 0n, 0n)).equals(pool.address)).toBe(true);
        // Pool: initialized at the floored start price; all jettons in the locked position.
        const st = await pool.getGetPoolState();
        expect(st.initialized).toBe(true);
        expect(st.reserve1 + st.protocolFees1).toBe(SUPPLY);
        expect(st.reserve0).toBe(0n);
        const mcap = mcapAt(st.sqrtPriceX96);
        expect(mcap).toBeGreaterThanOrEqual(toNano('2600') - 1n);
        expect(mcap).toBeLessThan((toNano('2600') * 10201n) / 10000n);   // floor to the spacing: < 1 spacing (1%) above
        const ini = initEvents(res);
        expect([ini.length, ini[0].initializer!.equals(master.address)]).toEqual([1, true]);
        const le = launchEvents(res)[0];
        expect(le.key.ext!.hash().equals(key.ext!.hash())).toBe(true);
        expect(le.feeClaimer.equals(treasury.address)).toBe(true);
        // The position is locked forever and owned by the treasury.
        const pos = chain.openContract(Position.fromAddress(await pool.getGetPositionAddress(0n)));
        const pd = await pos.getGetPositionData();
        expect([pd.owner.equals(treasury.address), pd.lockedUntil, pd.tickUpper]).toEqual([true, 0xFFFFFFFFn, st.tick]);
        // Launch fee reached the treasury; the creator paid fee + gas only (excess came back).
        expect((await chain.getContract(treasury.address)).balance - tb).toBeGreaterThanOrEqual(LAUNCH_FEE - toNano('0.001'));
        const spent = cb - (await chain.getContract(creator.address)).balance;
        expect(spent).toBeGreaterThan(LAUNCH_FEE);
        expect(spent).toBeLessThan(LAUNCH_FEE + toNano('0.45'));
        // Launch info getter (what a web app shows).
        const info = await master.getGetLaunchInfo();
        expect([info.creator.equals(creator.address), info.feeClaimer.equals(treasury.address), info.tickSpacing, info.buyTaxBps, info.sellTaxBps])
            .toEqual([true, true, PARAMS.tickSpacing, 0n, 0n]);
        expect((await factory.getGetFactoryData()).nextIndex).toBe(1n);
        // eslint-disable-next-line no-console
        console.log(`create (no dev buy): attached ${value}, creator spent ${spent} (launch fee ${LAUNCH_FEE}), ` +
            `start mcap ${mcap} nanoGram, ${res.transactions.length} transactions`);
    });

    it('dev buy: executed in the pool initialization transaction, before anyone else can trade', async () => {
        const dev = toNano('100');
        const res = await create({ devBuy: dev });
        expectNoFailures(res);
        const { master, key, pool } = await opened(0n);
        const poolTxs = res.transactions.filter((tx) => tx.inMessage?.info.dest instanceof Address && tx.inMessage.info.dest.equals(pool.address));
        expect(poolTxs.map((tx) => opOf(tx))).toEqual([OP.PoolLaunch]);
        const outOps = [...poolTxs[0].outMessages.values()].filter((m) => m.info.type === 'external-out').map((m) => m.body.beginParse().preloadUint(32));
        expect(outOps).toEqual([OP.InitializeEvent, 0x4d480072, OP.SwapEvent, OP.LaunchEvent]);
        const sw = swapEvents(res)[0];
        expect(sw.fromUser.equals(creator.address)).toBe(true);
        expect(sw.amountIn).toBe(dev);
        expect(await jBal(master, creator.address)).toBe(sw.amountOut);
        // The dev buy pays the 1% platform fee, sent to the Router treasury in the same (pool) transaction.
        expect(sw.platformFee).toBe((dev * PLATFORM_BPS) / 10000n);
        expect(platPays(res)).toEqual([[sw.platformFee, sw.platformFee]]);
        expect(poolTxs[0].outMessages.values().some((m) => m.info.dest instanceof Address && m.info.dest.equals(treasury.address))).toBe(true);
        // ~ dev / price minus the 1% platform fee and the 0.05% (+ variable) LP fee: no 15% anti-snipe fee on the dev buy.
        const startTokens = (dev * SUPPLY) / toNano('2600');
        expect(sw.amountOut).toBeGreaterThan((startTokens * 94n) / 100n);
        expect(sw.amountOut).toBeLessThan(startTokens);
        // The next buyer pays the anti-snipe fee and a higher price.
        const r2 = await buy(bob, key, dev);
        expectNoFailures(r2);
        const b2 = swapEvents(r2)[0];
        expect(b2.amountOut).toBeLessThan((sw.amountOut * 87n) / 100n);
        expect((await pool.getGetPoolState()).initialized).toBe(true);
        // Gas per hop.
        const g = (addr: Address) => gasAt(res, addr);
        // eslint-disable-next-line no-console
        console.log(`create + dev buy 100: factory ${g(factory.address)}, master ${g(master.address)}, router wallet ` +
            `${g(key.token1)}, router ${g(router.address)}, pool ${g(pool.address)}, total tx fees ` +
            `${res.transactions.reduce((a, tx) => a + tx.totalFees.coins, 0n)}`);
    });

    it('get_create_value2 covers a launch with dev buy and the platform fee: taxed / untaxed, vault on / off, at exactly the getter value', async () => {
        const k = fs.readFileSync(path.join(__dirname, '../../dex/v2/contracts/constants.tact'), 'utf8');
        const D = (n: string) => { const m = k.match(new RegExp(`const ${n}: Int = ton\\("([0-9.]+)"\\);`)); expect(m).not.toBeNull(); return toNano(m![1]); };
        const dev = toNano('100');
        const lines: string[] = [];
        for (const taxed of [false, true]) {
            for (const vault of [false, true]) {
                await chain.loadFrom(base);
                const value = await factory.getGetCreateValue2(dev, vault);
                const o = { devBuy: dev, vaultBps: vault ? 2000n : 0n,
                    ...(taxed ? { buyTaxBps: 300n, sellTaxBps: 500n, rewardsBps: 5000n, walletBps: 5000n } : {}) };
                // One nanoGram less is refused by the factory.
                expect((await create({ ...o, value: value - 1n })).transactions).toHaveTransaction({ to: factory.address, success: false });
                const res = await create({ ...o, value });
                expectNoFailures(res);
                expect(refundCodes(res)).toEqual([]);
                const { master, pool } = await opened(0n);
                const sw = swapEvents(res);
                expect(sw.length).toBe(1);
                expect([sw[0].amountIn, sw[0].platformFee, sw[0].tax]).toEqual([dev, toNano('1'), taxed ? toNano('3') : 0n]);
                expect(platPays(res)).toEqual([[toNano('1'), toNano('1')]]);
                expect(gramPayouts(res, master.address).filter((x) => x.reason === REASON.TAX).map((x) => x.amount)).toEqual(taxed ? [toNano('3')] : []);
                expect(await jBal(master, creator.address)).toBe(sw[0].amountOut);
                // Margins: the Pool's dev-buy check (incl. the payout gas) and the Router's launch check (before its 2 forward fees).
                const st = await pool.getGetPoolState();
                const payoutGas = D('PAYOUT_MSG_GAS') + (taxed ? D('PAYOUT_MSG_GAS') + D('TAX_PAYOUT_GAS') : 0n);
                const need = D('MINT_POOL_GAS') + st.tickCount * (D('TICK_RENT_BUFFER') + D('TICK_INIT_FEE')) + D('POSITION_DEPLOY_VALUE') +
                    D('DEV_BUY_POOL_GAS') + D('JETTON_PAYOUT_VALUE') + payoutGas;
                const inVal = (a: Address, op: number) => res.transactions.filter((tx) => tx.inMessage?.info.dest instanceof Address &&
                    tx.inMessage.info.dest.equals(a) && opOf(tx) === op).map((tx) => (tx.inMessage!.info as any).value.coins as bigint);
                const poolIn = inVal(pool.address, OP.PoolLaunch);
                expect(poolIn.length).toBe(1);
                const poolMargin = poolIn[0] - dev - need;
                expect(poolMargin).toBeGreaterThanOrEqual(toNano('0.05'));
                const routerIn = inVal(router.address, 0x7362d09c);   // the launch transfer's notification
                expect(routerIn.length).toBe(1);
                const routerMargin = routerIn[0] - dev - D('LAUNCH_GAS') - D('DEV_BUY_GAS');
                expect(routerMargin).toBeGreaterThanOrEqual(toNano('0.03'));
                lines.push(`taxed ${taxed} vault ${vault}: attached ${value}, pool margin ${poolMargin} (need ${need}), router margin ${routerMargin} (before 2 fwd fees)`);
            }
        }
        // eslint-disable-next-line no-console
        console.log(`create + dev buy 100 at exactly get_create_value2:\n${lines.join('\n')}`);
    });

    it('third-party buys and sells; the treasury claims the locked position fees and the protocol fees', async () => {
        expectNoFailures(await create());
        const { master, key, pool } = await opened(0n);
        chain.now = T0 + 400;   // after the anti-snipe window
        // Buy: exactly 1% of the Gram input goes to the Router treasury, in the same transaction chain (value == amount).
        expect((await router.getGetPlatformFee())).toBe(PLATFORM_BPS);
        let res = await buy(bob, key, toNano('300'));
        expectNoFailures(res);
        let sw = swapEvents(res)[0];
        expect([sw.amountIn, sw.platformFee, sw.tax]).toEqual([toNano('300'), toNano('3'), 0n]);
        expect(platPays(res)).toEqual([[toNano('3'), toNano('3')]]);
        const got = await jBal(master, bob.address);
        expect(got).toBe(sw.amountOut);
        res = await buy(carol, key, toNano('50'));
        expectNoFailures(res);
        expect(platPays(res)).toEqual([[toNano('0.5'), toNano('0.5')]]);
        const t1 = (await pool.getGetPoolState()).tick;
        // Sell: exactly 1% of the Gram output (before the fee); the seller gets the rest.
        res = await sell(bob, master, key, got / 2n);
        expectNoFailures(res);
        sw = swapEvents(res)[0];
        const gross = sw.amountOut + sw.platformFee + sw.tax;
        expect([sw.platformFee, sw.tax]).toEqual([(gross * PLATFORM_BPS) / 10000n, 0n]);
        expect(sw.platformFee).toBeGreaterThan(0n);
        expect(platPays(res)).toEqual([[sw.platformFee, sw.platformFee]]);
        expect(gramPayouts(res, bob.address).filter((x) => x.reason === REASON.SWAP_OUT).map((x) => x.amount)).toEqual([sw.amountOut]);
        expect((await pool.getGetPoolState()).platformFees).toBe(0n);   // nothing carried
        expect((await pool.getGetPoolState()).tick).toBeGreaterThan(t1);
        // Treasury collects LP fees from the locked position (Gram from buys, jettons from sells).
        const pos = chain.openContract(Position.fromAddress(await pool.getGetPositionAddress(0n)));
        const pd = await pos.getGetPositionData();
        const amt = await pool.getGetPositionAmounts(pd.tickLower, pd.tickUpper, pd.liquidity, pd.fgLast0, pd.fgLast1, 0n);
        expect(amt.fees0).toBeGreaterThan((toNano('350') * 5n * 9n) / 100000n);   // >= the 0.05% base fee on 350 Gram, minus the 10% protocol share
        expect(amt.fees1).toBeGreaterThan(0n);
        const dec = (liq: bigint, from = treasury) => pos.send(from.getSender(), { value: toNano('0.3') }, {
            $$type: 'PositionDecrease', queryId: 1n, liquidityDelta: liq, amount0Min: 0n, amount1Min: 0n,
            deadline: BigInt(chain.now! + 60), recipient: null,
        });
        res = await dec(0n);
        expectNoFailures(res);
        expect(gramPayouts(res, treasury.address).filter((x) => x.reason === REASON.POSITION_OUT).map((x) => x.amount)).toEqual([amt.fees0]);
        expect(await jBal(master, treasury.address)).toBe(amt.fees1);
        // The principal is locked forever; others cannot collect.
        res = await dec(1n);
        expect(res.transactions.filter((tx) => !txOk(tx)).length).toBe(1);
        res = await dec(0n, bob);
        expect(res.transactions.filter((tx) => !txOk(tx)).length).toBe(1);
        // Protocol share (10% of every swap fee) also goes to the treasury, triggered by anyone.
        const st = await pool.getGetPoolState();
        res = await router.send(bob.getSender(), { value: toNano('0.3') }, { $$type: 'CollectProtocolFees', queryId: 0n, key: { ...key, $$type: 'PoolKey' } });
        expectNoFailures(res);
        expect(gramPayouts(res, treasury.address).filter((x) => x.reason === REASON.PROTOCOL_FEE).map((x) => x.amount)).toEqual([st.protocolFees0]);
        // The jetton is a normal TEP-74 token: bob can send it to carol.
        const bw = chain.openContract(LaunchWallet.fromAddress(await master.getGetWalletAddress(bob.address)));
        res = await bw.send(bob.getSender(), { value: toNano('0.1') }, {
            $$type: 'JettonTransfer', queryId: 0n, amount: 1000n, destination: carol.address, responseDestination: bob.address,
            customPayload: null, forwardTonAmount: 0n, forwardPayload: beginCell().storeBit(0).endCell().beginParse(),
        });
        expectNoFailures(res);
    });

    it('tax token: the key pays the master, exact buy/sell tax paid in the swap (>= 0.1 Gram), the rest by CollectTax -> the master pays the wallet share (default: the creator)', async () => {
        const res = await create({ buyTaxBps: 300n, sellTaxBps: 500n, devBuy: toNano('10') });
        expectNoFailures(res);
        const { master, key, pool } = await opened(0n);
        const info = await master.getGetLaunchInfo();
        expect([info.buyTaxBps, info.sellTaxBps, info.taxRecipient!.equals(master.address), info.taxWallet!.equals(creator.address)])
            .toEqual([300n, 500n, true, true]);
        const ext = loadKeyExt(key.ext!.beginParse());
        expect([ext.buyTaxBps, ext.sellTaxBps, ext.taxRecipient!.equals(master.address)]).toEqual([300n, 500n, true]);
        const tl = events(res).filter((e) => e.op === 0x4d4c0021).map((e) => loadTokenLaunched(e.body.clone()))[0];
        expect([tl.buyTaxBps, tl.sellTaxBps]).toEqual([300n, 500n]);
        // The dev buy paid 3% buy tax too (>= TAX_MIN_PAYOUT: paid to the master and split in the launch chain).
        const taxPays = (r: SendMessageResult) => gramPayouts(r, master.address).filter((x) => x.reason === REASON.TAX).map((x) => [x.amount, x.value]);
        const toCreator = (r: SendMessageResult) => r.transactions.filter((tx) => tx.inMessage?.info.src instanceof Address &&
            tx.inMessage.info.src.equals(master.address) && (tx.inMessage.info.dest as Address).equals(creator.address) &&
            tx.inMessage.body.beginParse().preloadUint(32) === 0).map((tx) => (tx.inMessage!.info as any).value.coins as bigint);
        expect([swapEvents(res)[0].tax, swapEvents(res)[0].platformFee]).toEqual([toNano('0.3'), toNano('0.1')]);
        expect(taxPays(res)).toEqual([[toNano('0.3'), toNano('0.34')]]);
        expect(platPays(res)).toEqual([[toNano('0.1'), toNano('0.1')]]);
        expect(toCreator(res).length).toBe(1);
        expect(toCreator(res)[0]).toBeGreaterThanOrEqual(toNano('0.3'));
        expect((await pool.getGetPoolState()).taxFees).toBe(0n);
        chain.now = T0 + 400;
        const q = await pool.getGetQuote(true, toNano('100'), 0n, 24n, 0n, false);
        expect([q.tax, q.platformFee]).toEqual([toNano('3'), toNano('1')]);
        // Buy: 3% tax and 1% platform fee on the Gram input; the tax is paid to the master in the swap and the
        // master pays the creator (walletBps = 100%) in the same chain; the platform fee goes to the treasury.
        let r = await buy(bob, key, toNano('100'), q.amountOut);
        expectNoFailures(r);
        expect(swapEvents(r)[0].amountOut).toBe(q.amountOut);
        expect(taxPays(r)).toEqual([[toNano('3'), toNano('3.04')]]);
        expect(platPays(r)).toEqual([[toNano('1'), toNano('1')]]);
        expect(toCreator(r).length).toBe(1);
        expect(toCreator(r)[0]).toBeGreaterThanOrEqual(toNano('3'));
        expect((await pool.getGetPoolState()).taxFees).toBe(0n);
        const bal = await jBal(master, bob.address);
        const qs = await pool.getGetQuote(false, bal, 0n, 24n, 0n, false);
        r = await sell(bob, master, key, bal);
        expectNoFailures(r);
        // Sell: 5% tax and 1% platform fee on the Gram output; the seller gets the rest.
        const sev = swapEvents(r)[0];
        expect([sev.amountOut, sev.tax, sev.platformFee]).toEqual([qs.amountOut, qs.tax, qs.platformFee]);
        const gross = sev.amountOut + sev.tax + sev.platformFee;
        expect([sev.tax, sev.platformFee]).toEqual([(gross * 500n) / 10000n, (gross * PLATFORM_BPS) / 10000n]);
        expect(taxPays(r)).toEqual([[sev.tax, sev.tax + toNano('0.04')]]);
        expect(platPays(r)).toEqual([[sev.platformFee, sev.platformFee]]);
        expect(gramPayouts(r, bob.address).filter((x) => x.reason === REASON.SWAP_OUT).map((x) => x.amount)).toEqual([sev.amountOut]);
        // Below TAX_MIN_PAYOUT (0.1 Gram) the tax stays in the pool until CollectTax (anyone, via the Router).
        r = await buy(carol, key, toNano('2'));
        expectNoFailures(r);
        expect(taxPays(r)).toEqual([]);
        const owed = (await pool.getGetPoolState()).taxFees;
        expect(owed).toBe(toNano('0.06'));
        r = await router.send(carol.getSender(), { value: toNano('0.3') }, { $$type: 'CollectTax', queryId: 0n, key: { ...key, $$type: 'PoolKey' } });
        expectNoFailures(r);
        expect(taxPays(r).map((x) => x[0])).toEqual([owed]);
        expect((await pool.getGetPoolState()).taxFees).toBe(0n);
        // walletBps = 100%: the creator gets the whole tax (plus the CollectTax gas leftover).
        expect(toCreator(r).length).toBe(1);
        expect(toCreator(r)[0]).toBeGreaterThanOrEqual(owed);
        expect((await master.getGetTaxData()).walletPaid).toBe(toNano('0.3') + toNano('3') + sev.tax + owed);
    });

    it('tax recipient can be someone else; 0/0 means a normal token even if a recipient is given', async () => {
        let res = await create({ buyTaxBps: 0n, sellTaxBps: 500n, taxWallet: carol.address });
        expectNoFailures(res);
        let { master } = await opened(0n);
        let info = await master.getGetLaunchInfo();
        expect([info.sellTaxBps, info.taxWallet!.equals(carol.address), info.taxRecipient!.equals(master.address)]).toEqual([500n, true, true]);
        res = await create({ taxWallet: carol.address });
        expectNoFailures(res);
        ({ master } = await opened(1n));
        info = await master.getGetLaunchInfo();
        expect([info.buyTaxBps, info.sellTaxBps, info.taxRecipient, info.taxWallet, info.walletBps]).toEqual([0n, 0n, null, null, 0n]);
    });

    it('rejects: too little value, tax outside 0 or 1%..5%, split not 100%, bad anti-snipe; nothing is deployed and the index does not move', async () => {
        const v = await factory.getGetCreateValue(toNano('5'));
        for (const o of [{ devBuy: toNano('5'), value: v - 1n }, { buyTaxBps: 501n }, { sellTaxBps: 501n }, { buyTaxBps: 99n }, { sellTaxBps: 1n },
                         { buyTaxBps: 300n, walletBps: 9999n }, { buyTaxBps: 300n, walletBps: 5000n, rewardsBps: 5000n, buybackBps: 1n },
                         { buyTaxBps: 300n, walletBps: 0n }, { antiSnipePips: 900001n }, { antiSnipeDuration: 3601n },
                         { antiSnipePips: 0n }, { antiSnipeDuration: 0n },
                         { startMcap: PARAMS.startMcap + 1n }, { startMcap: PARAMS.startMcap - 1n }, { tickSpacing: 60n }]) {
            const res = await create(o);
            expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });
            expect((await factory.getGetFactoryData()).nextIndex).toBe(0n);
            expect((await chain.getContract(await factory.getGetTokenAddress(0n))).accountState?.type).not.toBe('active');
        }
        // The master accepts LaunchSetup only from the factory, and only once.
        expectNoFailures(await create());
        const { master } = await opened(0n);
        const info = await master.getGetLaunchInfo();
        const res = await master.send(bob.getSender(), { value: toNano('2') }, {
            $$type: 'LaunchSetup', queryId: 0n, content: Cell.EMPTY, info, devBuy: 0n, minDevOut: 0n, routerValue: toNano('0.6'),
        });
        expect(res.transactions).toHaveTransaction({ to: master.address, success: false });
        expect((await master.getGetJettonData()).totalSupply).toBe(SUPPLY);
    });

    it('DEX creation paused does not block a launch (launch keys bypass it)', async () => {
        expect((await router.send(admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetCreationPaused', queryId: 0n, paused: true })).transactions)
            .toHaveTransaction({ to: router.address, success: true });
        const res = await create({ devBuy: toNano('50') });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        const { master, pool } = await opened(0n);
        expect((await pool.getGetPoolState()).initialized).toBe(true);
        expect(await jBal(master, creator.address)).toBeGreaterThan(0n);
    });

    it('a failed launch (DEX refuses the key) never hands out the supply: it stays in the master\'s own wallet, Gram goes back', async () => {
        // A factory deployed with a spacing that is not a DEX preset (SetLaunchParams refuses it; init does not check).
        const bad30 = { ...PARAMS, tickSpacing: 30n };
        const f2 = chain.openContract(await LaunchFactory.fromInit(admin.address, treasury.address, router.address, LAUNCH_FEE,
            { ...TIERS, low: bad30 }));
        await f2.send(admin.getSender(), { value: toNano('0.5') }, null);
        const cb = (await chain.getContract(creator.address)).balance;
        const devBuy = toNano('50');
        const res = await f2.send(creator.getSender(), { value: await f2.getGetCreateValue(devBuy) }, {
            $$type: 'CreateToken', queryId: 7n, content: content('Marg Test', 'MARG'), devBuy, minDevOut: 0n,
            buyTaxBps: 0n, sellTaxBps: 0n, taxWallet: null, rewardsBps: 0n, walletBps: 10000n, buybackBps: 0n,
            antiSnipePips: 150000n, antiSnipeDuration: 300n, startMcap: PARAMS.startMcap, tickSpacing: 30n,
            vaultBps: 0n, vaultLock: 0n, vaultVest: 0n,
        });
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([CODES.BAD_TICK_SPACING]);
        const master = chain.openContract(LaunchJetton.fromAddress(await f2.getGetTokenAddress(0n)));
        expect(await jBal(master, creator.address)).toBe(0n);
        expect(await jBal(master, master.address)).toBe(SUPPLY);
        expect(await jBal(master, router.address)).toBe(0n);
        // The dev-buy Gram came back to the creator (through the master).
        const spent = cb - (await chain.getContract(creator.address)).balance;
        expect(spent).toBeLessThan(LAUNCH_FEE + toNano('0.6'));
    });

    it('a CreateToken signed for the old params is refused (and refunded) when the admin changes them first', async () => {
        const send = (body: any) => factory.send(admin.getSender(), { value: toNano('0.1') }, body);
        // Every DEX preset and the 100 Gram floor are accepted.
        for (const ts of [1n, 10n, 60n, 200n]) {
            expect((await send({ $$type: 'SetLaunchParams', queryId: 0n, tier: 0n, params: { startMcap: toNano('100'), tickSpacing: ts } })).transactions)
                .toHaveTransaction({ to: factory.address, success: true });
        }
        expect((await send({ $$type: 'SetLaunchParams', queryId: 0n, tier: 0n, params: PARAMS })).transactions).toHaveTransaction({ to: factory.address, success: true });
        // The creator signs CreateToken with the params it sees (2,600 Gram / 200); the admin's change lands first.
        for (const np of [{ ...PARAMS, startMcap: toNano('100') }, { ...PARAMS, tickSpacing: 60n }]) {
            await chain.loadFrom(base);
            expect((await send({ $$type: 'SetLaunchParams', queryId: 0n, tier: 0n, params: np })).transactions).toHaveTransaction({ to: factory.address, success: true });
            const cb = (await chain.getContract(creator.address)).balance;
            const res = await create({ devBuy: toNano('10'), startMcap: PARAMS.startMcap, tickSpacing: PARAMS.tickSpacing });
            expect(res.transactions).toHaveTransaction({ from: factory.address, to: creator.address, inMessageBounced: true });
            expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });
            expect((await factory.getGetFactoryData()).nextIndex).toBe(0n);
            expect(cb - (await chain.getContract(creator.address)).balance).toBeLessThan(toNano('0.01'));   // value bounced back
            // Re-signed with the new params, it goes through.
            expectNoFailures(await create({ devBuy: toNano('10') }));
            expect((await opened(0n)).key.tickSpacing).toBe(np.tickSpacing);
        }
    });

    it('admin: launch fee only goes down; params apply to new launches only; 2-step admin; treasury change', async () => {
        const send = (from: SandboxContract<TreasuryContract>, body: any) => factory.send(from.getSender(), { value: toNano('0.1') }, body);
        let res = await send(admin, { $$type: 'LowerLaunchFee', queryId: 0n, fee: LAUNCH_FEE + 1n });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });
        res = await send(admin, { $$type: 'LowerLaunchFee', queryId: 0n, fee: LAUNCH_FEE });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });
        res = await send(bob, { $$type: 'LowerLaunchFee', queryId: 0n, fee: 0n });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });
        res = await send(admin, { $$type: 'LowerLaunchFee', queryId: 0n, fee: toNano('0.5') });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: true });
        expect((await factory.getGetFactoryData()).launchFee).toBe(toNano('0.5'));
        expect(await factory.getGetCreateValue(0n)).toBe(toNano('0.5') + toNano('0.7'));
        // First token at 2,600 Gram, then params change: second token at 10,000 Gram, first unchanged.
        expectNoFailures(await create());
        const p1 = (await opened(0n)).pool;
        const s1 = (await p1.getGetPoolState()).sqrtPriceX96;
        for (const bad of [
            { ...PARAMS, startMcap: toNano('0.5') }, { ...PARAMS, startMcap: toNano('100') - 1n }, { ...PARAMS, tickSpacing: 0n },
            { ...PARAMS, tickSpacing: 16385n }, { ...PARAMS, tickSpacing: 30n }, { ...PARAMS, tickSpacing: 100n }, { ...PARAMS, tickSpacing: 2n },
        ]) {
            res = await send(admin, { $$type: 'SetLaunchParams', queryId: 0n, tier: 0n, params: bad });
            expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });
        }
        res = await send(bob, { $$type: 'SetLaunchParams', queryId: 0n, tier: 0n, params: { ...PARAMS, startMcap: toNano('10000') } });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });
        res = await send(admin, { $$type: 'SetLaunchParams', queryId: 0n, tier: 0n, params: { ...PARAMS, startMcap: toNano('10000'), tickSpacing: 60n } });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: true });
        expectNoFailures(await create());
        const t2 = await opened(1n);
        const s2 = (await t2.pool.getGetPoolState()).sqrtPriceX96;
        expect(mcapAt(s2)).toBeGreaterThanOrEqual(toNano('10000') - 1n);
        expect(mcapAt(s2)).toBeLessThan((toNano('10000') * 10061n) / 10000n);
        expect(t2.key.tickSpacing).toBe(60n);
        expect((await p1.getGetPoolState()).sqrtPriceX96).toBe(s1);
        // Treasury change: new launches' fee claimer; old positions keep theirs.
        res = await send(admin, { $$type: 'SetTreasury', queryId: 0n, treasury: carol.address });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: true });
        expectNoFailures(await create());
        expect((await (await opened(2n)).master.getGetLaunchInfo()).feeClaimer.equals(carol.address)).toBe(true);
        expect((await (await opened(0n)).master.getGetLaunchInfo()).feeClaimer.equals(treasury.address)).toBe(true);
        // 2-step admin.
        res = await send(admin, { $$type: 'TransferAdmin', queryId: 0n, newAdmin: bob.address });
        expect((await factory.getGetFactoryData()).pendingAdmin!.equals(bob.address)).toBe(true);
        res = await send(carol, { $$type: 'ClaimAdmin', queryId: 0n });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });
        res = await send(bob, { $$type: 'ClaimAdmin', queryId: 0n });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: true });
        const fd = await factory.getGetFactoryData();
        expect([fd.admin.equals(bob.address), fd.pendingAdmin]).toEqual([true, null]);
        res = await send(admin, { $$type: 'LowerLaunchFee', queryId: 0n, fee: 0n });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });
        res = await send(bob, { $$type: 'LowerLaunchFee', queryId: 0n, fee: 0n });
        expect(res.transactions).toHaveTransaction({ to: factory.address, success: true });
        // Fee 0: no launch-fee message at all.
        res = await create();
        expectNoFailures(res);
        expect(res.transactions).not.toHaveTransaction({ from: factory.address, to: carol.address });
    });

    it('liquidity tiers: low / mid / high each launch at their own start mcap; a deeper tier moves less per buy', async () => {
        const fd = (await factory.getGetFactoryData()).tiers;
        expect([fd.low.startMcap, fd.mid.startMcap, fd.high.startMcap]).toEqual([toNano('2600'), toNano('10000'), toNano('30000')]);
        const moves: number[] = [];
        let i = 0n;
        for (const t of [fd.low, fd.mid, fd.high]) {
            expectNoFailures(await create({ startMcap: t.startMcap, tickSpacing: t.tickSpacing, antiSnipePips: 0n, antiSnipeDuration: 0n }));
            const { master, key, pool } = await opened(i++);
            const st = await pool.getGetPoolState();
            const m0 = mcapAt(st.sqrtPriceX96);
            // Start mcap matches the tier (the pool floors the price to the spacing: within 2%).
            expect(Number(m0) / Number(t.startMcap)).toBeGreaterThan(0.98);
            expect(Number(m0) / Number(t.startMcap)).toBeLessThan(1.02);
            expect((await master.getGetLaunchInfo()).buybackCap).toBe(t.startMcap / 100n);
            expectNoFailures(await buy(bob, key, toNano('50')));
            moves.push(Number(mcapAt((await pool.getGetPoolState()).sqrtPriceX96)) / Number(m0));
        }
        // The same 50 Gram buy lifts low the most, high the least.
        expect(moves[0]).toBeGreaterThan(moves[1]);
        expect(moves[1]).toBeGreaterThan(moves[2]);
        // A pair that matches no tier is refused and nothing is deployed.
        const before = (await factory.getGetFactoryData()).nextIndex;
        expect((await create({ startMcap: toNano('5000'), tickSpacing: 10n })).transactions).toHaveTransaction({ to: factory.address, success: false });
        expect((await factory.getGetFactoryData()).nextIndex).toBe(before);
        // Admin sets one tier at a time; unknown tier index refused; the start price getter follows the tier.
        const send = (b: any) => factory.send(admin.getSender(), { value: toNano('0.1') }, b);
        expect((await send({ $$type: 'SetLaunchParams', queryId: 0n, tier: 3n, params: PARAMS })).transactions).toHaveTransaction({ to: factory.address, success: false });
        expect((await send({ $$type: 'SetLaunchParams', queryId: 0n, tier: 2n, params: { ...PARAMS, startMcap: toNano('50000') } })).transactions)
            .toHaveTransaction({ to: factory.address, success: true });
        const nd = (await factory.getGetFactoryData()).tiers;
        expect([nd.low.startMcap, nd.mid.startMcap, nd.high.startMcap]).toEqual([toNano('2600'), toNano('10000'), toNano('50000')]);
        expect(await factory.getGetStartSqrtPrice(2n)).toBeLessThan(await factory.getGetStartSqrtPrice(0n));
    });

    it('many launches: token address by index, independent pools', async () => {
        for (let i = 0; i < 3; i++) expectNoFailures(await create({ name: `T${i}` }));
        const pools = new Set<string>();
        for (let i = 0n; i < 3n; i++) {
            const { master, pool } = await opened(i);
            expect(await master.getGetIndex()).toBe(i);
            expect((await pool.getGetPoolState()).initialized).toBe(true);
            pools.add(pool.address.toString());
        }
        expect(pools.size).toBe(3);
    });
});
