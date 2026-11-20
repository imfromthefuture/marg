// Fee converter v3: regression tests for the 2026-11 review (M-3: sells on taxed launch keys; the
// holder rewards of launch tokens the converter holds). Real dex/v2 Router / Pool and, for the second
// part, the real launchpad (launch/build). Sandbox only.

import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import { sha256_sync } from '@ton/crypto';
import '@ton/test-utils';
import { Dex, GRAM, expectNoFailures, refundCodes, swapEvents, encodeSqrtPrice, CODE } from '../../dex/v2/tests/helpers';
import { FeeConverter } from '../build/FeeConverter_FeeConverter';
import { LaunchFactory } from '../../launch/build/Launch_LaunchFactory';
import { LaunchJetton } from '../../launch/build/Launch_LaunchJetton';
import { LaunchWallet } from '../../launch/build/Launch_LaunchWallet';
import { poolCodeArgs } from '../../launch/tests/poolcode';

jest.setTimeout(900000);

const JET = toNano('50000000');
const SQRT = encodeSqrtPrice(JET, toNano('1300'));
const OP = { TreasuryDeposit: 0x4d460061, ClaimRewards: 0x4d4c0033 };

describe('fee converter v3', () => {
    let d: Dex;
    let conv: SandboxContract<FeeConverter>;
    let tre: SandboxContract<TreasuryContract>;
    let keeper: SandboxContract<TreasuryContract>;
    let mallory: SandboxContract<TreasuryContract>;
    let base: any;

    const approve = (wallet: Address, key: { tickSpacing: bigint; ext: Cell | null }) =>
        conv.send(d.admin.getSender(), { value: toNano('0.05') }, {
            $$type: 'ApproveConvertKey', queryId: 0n, jettonWallet: wallet, tickSpacing: key.tickSpacing, ext: key.ext, approved: true,
        });
    const convert = (wallet: Address, amount: bigint, key: { tickSpacing: bigint; ext: Cell | null }, mc: bigint, value: bigint, minOut = 1n) =>
        conv.send(keeper.getSender(), { value }, {
            $$type: 'ConvertJetton', queryId: 9n, jettonWallet: wallet, amount, tickSpacing: key.tickSpacing, ext: key.ext, minOut, maxCrossings: mc,
        });

    beforeAll(async () => {
        d = await Dex.create();
        tre = await d.chain.treasury('marg-treasury', { balance: toNano('1') });
        keeper = await d.chain.treasury('keeper', { balance: toNano('1000') });
        mallory = await d.chain.treasury('mallory', { balance: toNano('1000') });
        conv = d.chain.openContract(await FeeConverter.fromInit(tre.address, d.router.address, d.admin.address));
        expectNoFailures(await conv.send(d.admin.getSender(), { value: toNano('0.1') }, null));
        expectNoFailures(await conv.send(d.admin.getSender(), { value: toNano('0.05') }, { $$type: 'SetKeeper', queryId: 0n, keeper: keeper.address }));
        expectNoFailures(await d.router.send(d.admin.getSender(), { value: toNano('0.1') }, { $$type: 'SetTreasury', queryId: 0n, treasury: conv.address }));
        base = d.chain.snapshot();
    });
    beforeEach(async () => {
        await d.chain.loadFrom(base);
    });

    it('M-3: a jetton fee from a TAXED launch key is sold at exactly get_convert_value (mc 1, 8, 24); the forward value covers the Router minimum', async () => {
        const LO = { tickSpacing: 200n, taxRecipient: d.alice.address, buyTaxBps: 300n, sellTaxBps: 300n };
        expectNoFailures(await d.launch(d.jB, d.alice, JET, SQRT, conv.address, d.alice.address, LO));
        const key = await d.launchKey(d.tokB, d.alice.address, LO);
        // Jettons in the converter (stands in for LP / protocol fees in the token).
        expectNoFailures(await d.swapNative(d.bob, toNano('300'), d.tokB, { tickSpacing: 200n, ext: key.ext, receiver: conv.address, gas: toNano('1') }));
        const amt = await d.jBal(d.jB, conv.address);
        expect(amt).toBeGreaterThan(0n);
        const wallet = (await d.jWallet(d.jB, conv.address)).address;
        expectNoFailures(await approve(wallet, key));
        // The margin the converter adds on top of base + crossings covers everything the Router can add
        // for a sell (launch key platform payout + tax auto-payout) with room for its 2 forward fees.
        for (const mc of [1n, 8n, 24n]) {
            const routerMin = await d.router.getGetSwapGas(mc, false, 0n, key.ext, true);
            const value = await conv.getGetConvertValue(mc);
            expect(value - toNano('0.12') - routerMin).toBeGreaterThanOrEqual(toNano('0.03'));
        }
        let left = amt;
        const t0 = await d.gram(tre.address);
        for (const mc of [1n, 8n, 24n]) {
            const part = mc === 24n ? left : amt / 3n;
            const res = await convert(wallet, part, key, mc, await conv.getGetConvertValue(mc));
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([]);
            expect(refundCodes(res)).not.toContain(CODE.LOW_GAS);
            expect(swapEvents(res).length).toBe(1);
            expect(swapEvents(res)[0].amountOut).toBeGreaterThan(0n);
            expect(res.transactions).toHaveTransaction({ from: conv.address, to: tre.address, op: OP.TreasuryDeposit, success: true });
            left -= part;
            expect(await d.jBal(d.jB, conv.address)).toBe(left);
        }
        expect(left).toBe(0n);
        expect(await d.gram(tre.address) - t0).toBeGreaterThan(toNano('250'));     // ~300 Gram bought, sold back minus fees and taxes
        expect(await d.jBal(d.jB, tre.address)).toBe(0n);
    });

    it('M-3: value attached above the minimum also reaches the Router (half of the surplus), the rest returns to the treasury', async () => {
        const LO = { tickSpacing: 200n, taxRecipient: d.alice.address, buyTaxBps: 500n, sellTaxBps: 500n, launchFeePips: 100000n, launchDuration: 60n };
        expectNoFailures(await d.launch(d.jB, d.alice, JET, SQRT, conv.address, d.alice.address, LO));
        const key = await d.launchKey(d.tokB, d.alice.address, LO);
        expectNoFailures(await d.swapNative(d.bob, toNano('100'), d.tokB, { tickSpacing: 200n, ext: key.ext, receiver: conv.address, gas: toNano('1') }));
        const amt = await d.jBal(d.jB, conv.address);
        const wallet = (await d.jWallet(d.jB, conv.address)).address;
        expectNoFailures(await approve(wallet, key));
        const min = await conv.getGetConvertValue(24n);
        const res = await convert(wallet, amt, key, 24n, min + toNano('2'));
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        const toRouter = res.transactions.find((tx) => {
            const i = tx.inMessage?.info;
            return i?.type === 'internal' && i.dest.equals(d.router.address);
        })!;
        expect((toRouter.inMessage!.info as any).value.coins).toBe(min - toNano('0.12') + toNano('1'));
        expect(await d.jBal(d.jB, conv.address)).toBe(0n);
        expect(await d.gram(conv.address)).toBeLessThan(toNano('0.11'));          // everything else was forwarded
        // One nanoGram below the minimum is refused before anything is sent.
        const low = await convert(wallet, 1n, key, 24n, min - 1n);
        expect(low.transactions).toHaveTransaction({ to: conv.address, success: false });
        // minOut = 0 is always refused (L-7).
        const zero = await convert(wallet, 1n, key, 24n, min, 0n);
        expect(zero.transactions).toHaveTransaction({ to: conv.address, success: false });
    });

    it('real launch token with holder rewards: the converter claims its rewards as Gram for the treasury and sells the token on the taxed key', async () => {
        const chain = d.chain;
        const content = () => {
            const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
            for (const [k, v] of [['name', 'Rewards'], ['symbol', 'RWD'], ['decimals', '9']]) {
                dict.set(BigInt('0x' + sha256_sync(k).toString('hex')), beginCell().storeUint(0, 8).storeStringTail(v).endCell());
            }
            return beginCell().storeUint(0, 8).storeDict(dict).endCell();
        };
        const tier = { $$type: 'LaunchParams' as const, startMcap: toNano('2600'), tickSpacing: 10n };
        // The factory's treasury (launch fee receiver and feeClaimer of every launch) is the converter.
        const factory = chain.openContract(await LaunchFactory.fromInit(d.admin.address, conv.address, d.router.address, toNano('0.5'),
            { $$type: 'LaunchTiers', low: tier, mid: tier, high: tier }, ...(await poolCodeArgs())));
        expectNoFailures(await factory.send(d.admin.getSender(), { value: toNano('0.5') }, null));
        const t0 = await d.gram(tre.address);
        const created = await factory.send(d.alice.getSender(), { value: await factory.getGetCreateValue(0n) }, {
            $$type: 'CreateToken', queryId: 7n, content: content(), devBuy: 0n, minDevOut: 0n, buyTaxBps: 500n, sellTaxBps: 500n, taxWallet: null,
            rewardsBps: 9999n, walletBps: 0n, buybackBps: 1n, antiSnipePips: 0n, antiSnipeDuration: 0n,
            startMcap: tier.startMcap, tickSpacing: tier.tickSpacing, vaultBps: 0n, vaultLock: 0n, vaultVest: 0n,
        });
        expectNoFailures(created);
        // The launch fee arrives at the converter from the master (a comment) and is forwarded to the treasury.
        expect(await d.gram(tre.address) - t0).toBeGreaterThan(toNano('0.49'));
        const master = chain.openContract(LaunchJetton.fromAddress(await factory.getGetTokenAddress(0n)));
        const key = await master.getGetPoolKey();
        const wallet = chain.openContract(LaunchWallet.fromAddress(await master.getGetWalletAddress(conv.address)));
        // The converter receives tokens (as it does with LP / protocol fees in the token): its wallet is a tracked holder.
        expectNoFailures(await d.swapNative(d.bob, toNano('50'), key.token1, { tickSpacing: key.tickSpacing, ext: key.ext, receiver: conv.address, gas: toNano('1') }));
        const amt = (await wallet.getGetWalletData()).balance;
        expect(amt).toBeGreaterThan(0n);
        expect(await wallet.getGetTracked()).toBe(true);
        expect((await wallet.getGetRewardState()).acked).toBe(amt);
        // More taxed trading: rewards accrue to the converter's wallet.
        expectNoFailures(await d.swapNative(d.carol, toNano('200'), key.token1, { tickSpacing: key.tickSpacing, ext: key.ext, gas: toNano('1') }));
        const rs = await wallet.getGetRewardState();
        const due = await master.getGetPendingRewards(rs.acked, rs.lastAcc, rs.frac, rs.owed);
        expect(due).toBeGreaterThan(toNano('1'));

        // Only the keeper / admin, and only with enough value.
        const claimMsg = { $$type: 'ClaimJettonRewards' as const, queryId: 5n, jettonWallet: wallet.address };
        let res = await conv.send(mallory.getSender(), { value: toNano('0.2') }, claimMsg);
        expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
        res = await conv.send(keeper.getSender(), { value: (await conv.getGetRewardsValue()) - 1n }, claimMsg);
        expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
        for (const bad of [conv.address, d.router.address, tre.address]) {
            res = await conv.send(keeper.getSender(), { value: toNano('0.2') }, { ...claimMsg, jettonWallet: bad });
            expect(res.transactions).toHaveTransaction({ to: conv.address, success: false });
        }
        expect((await master.getGetRewardsData()).claimed).toBe(0n);

        const t1 = await d.gram(tre.address);
        const kb = await d.gram(keeper.address);
        res = await conv.send(keeper.getSender(), { value: await conv.getGetRewardsValue() }, claimMsg);
        expectNoFailures(res);
        expect(res.transactions).toHaveTransaction({ from: conv.address, to: wallet.address, op: OP.ClaimRewards, success: true });
        expect(res.transactions).toHaveTransaction({ from: master.address, to: conv.address, success: true });
        expect(res.transactions).toHaveTransaction({ from: conv.address, to: tre.address, op: OP.TreasuryDeposit, success: true });
        expect((await master.getGetRewardsData()).claimed).toBe(due);
        expect(await d.gram(tre.address) - t1).toBeGreaterThanOrEqual(due);
        expect(kb - (await d.gram(keeper.address))).toBeLessThan(toNano('0.11'));  // the keeper paid only the attached value
        expect((await wallet.getGetRewardState()).inFlight).toBe(0n);
        // The converter's messages went only to its wallet and the treasury.
        for (const tx of res.transactions) {
            const i = tx.inMessage?.info;
            if (i?.type !== 'internal' || !i.src.equals(conv.address)) continue;
            expect(i.dest.equals(wallet.address) || i.dest.equals(tre.address)).toBe(true);
        }

        // And the token itself is sold on its taxed launch key (M-3, with a tracked wallet's checkpoint in the transfer).
        expectNoFailures(await approve(wallet.address, key));
        const t2 = await d.gram(tre.address);
        res = await convert(wallet.address, amt, key, 24n, await conv.getGetConvertValue(24n));
        expectNoFailures(res);
        expect(refundCodes(res)).toEqual([]);
        expect(swapEvents(res).length).toBe(1);
        expect((await wallet.getGetWalletData()).balance).toBe(0n);
        expect((await wallet.getGetRewardState()).acked).toBe(0n);
        expect(await d.gram(tre.address) - t2).toBeGreaterThan(toNano('40'));
        expect(GRAM.equals(key.token0)).toBe(true);
    });
});
