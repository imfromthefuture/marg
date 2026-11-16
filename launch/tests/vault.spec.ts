// Marg direct launch: optional creator vault (LaunchVault). Part of the supply is minted to the vault
// instead of the pool (same start price, shallower pool), locked, then released to the creator in one
// step or linearly. Sandbox only, against the real dex/v2 Router and Pool.

import { Blockchain, SandboxContract, TreasuryContract, SendMessageResult } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import '@ton/test-utils';
import { LaunchFactory, LaunchParams, loadTokenLaunched } from '../build/Launch_LaunchFactory';
import { LaunchJetton } from '../build/Launch_LaunchJetton';
import { LaunchWallet } from '../build/Launch_LaunchWallet';
import { LaunchVault } from '../build/Launch_LaunchVault';
import { Router } from '../../dex/v2/build/Router_Router';
import { Pool } from '../../dex/v2/build/Router_Pool';
import { txOk, events } from '../../dex/v2/tests/helpers';

jest.setTimeout(600000);

const SUPPLY = 10n ** 18n;
const T0 = 1_800_000_000;
const DAY = 86400n;
const PARAMS: LaunchParams = { $$type: 'LaunchParams', startMcap: toNano('2600'), tickSpacing: 10n };
const TIERS = { $$type: 'LaunchTiers' as const, low: PARAMS,
    mid: { $$type: 'LaunchParams' as const, startMcap: toNano('10000'), tickSpacing: 10n },
    high: { $$type: 'LaunchParams' as const, startMcap: toNano('30000'), tickSpacing: 10n } };
const LAUNCH_FEE = toNano('1.5');
const VAULT_GAS = toNano('0.12');
const CLAIM_VALUE = toNano('0.15');

function content(): Cell {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    for (const [k, v] of [['name', 'Vault Test'], ['symbol', 'VLT'], ['decimals', '9']]) {
        dict.set(BigInt('0x' + sha256_sync(k).toString('hex')), beginCell().storeUint(0, 8).storeStringTail(v).endCell());
    }
    return beginCell().storeUint(0, 8).storeDict(dict).endCell();
}

const exitCode = (tx: any) => (tx.description as any).computePhase?.exitCode;
function expectNoFailures(res: SendMessageResult) {
    expect(res.transactions.filter((tx) => !txOk(tx)).map(exitCode)).toEqual([]);
}

describe('Marg direct launch: creator vault', () => {
    let chain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let treasury: SandboxContract<TreasuryContract>;
    let creator: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let carol: SandboxContract<TreasuryContract>;
    let router: SandboxContract<Router>;
    let factory: SandboxContract<LaunchFactory>;
    let base: any;

    type Opts = { devBuy?: bigint; vaultBps?: bigint; vaultLock?: bigint; vaultVest?: bigint; value?: bigint;
                  buyTaxBps?: bigint; rewardsBps?: bigint; walletBps?: bigint };
    async function create(o: Opts = {}) {
        const devBuy = o.devBuy ?? 0n;
        const vaultBps = o.vaultBps ?? 0n;
        const value = o.value ?? await factory.getGetCreateValue2(devBuy, vaultBps > 0n);
        return factory.send(creator.getSender(), { value }, {
            $$type: 'CreateToken', queryId: 7n, content: content(), devBuy, minDevOut: 0n,
            buyTaxBps: o.buyTaxBps ?? 0n, sellTaxBps: 0n, taxWallet: null,
            rewardsBps: o.rewardsBps ?? 0n, walletBps: o.walletBps ?? 0n, buybackBps: 0n,
            antiSnipePips: 0n, antiSnipeDuration: 0n, startMcap: PARAMS.startMcap, tickSpacing: PARAMS.tickSpacing,
            vaultBps, vaultLock: o.vaultLock ?? 0n, vaultVest: o.vaultVest ?? 0n,
        });
    }

    async function opened(index: bigint) {
        const master = chain.openContract(LaunchJetton.fromAddress(await factory.getGetTokenAddress(index)));
        const key = await master.getGetPoolKey();
        const pool = chain.openContract(Pool.fromAddress(await router.getGetPoolAddress(key.token0, key.token1, key.tickSpacing, key.ext)));
        const va = await master.getGetVaultAddress();
        const vault = va ? chain.openContract(LaunchVault.fromAddress(va)) : null;
        return { master, key, pool, vault };
    }

    const walletOf = async (master: SandboxContract<LaunchJetton>, owner: Address) =>
        chain.openContract(LaunchWallet.fromAddress(await master.getGetWalletAddress(owner)));
    const jBal = async (master: SandboxContract<LaunchJetton>, owner: Address) => {
        const w = await walletOf(master, owner);
        if ((await chain.getContract(w.address)).accountState?.type !== 'active') return 0n;
        return (await w.getGetWalletData()).balance;
    };
    const claim = (vault: SandboxContract<LaunchVault>, from = creator, value = CLAIM_VALUE) =>
        vault.send(from.getSender(), { value }, { $$type: 'ClaimVault', queryId: 1n });

    beforeAll(async () => {
        chain = await Blockchain.create();
        chain.now = T0;
        admin = await chain.treasury('admin');
        treasury = await chain.treasury('treasury');
        creator = await chain.treasury('creator', { balance: toNano('100000') });
        bob = await chain.treasury('bob', { balance: toNano('100000') });
        carol = await chain.treasury('carol', { balance: toNano('100000') });
        router = chain.openContract(await Router.fromInit(admin.address, treasury.address));
        await router.send(admin.getSender(), { value: toNano('1') }, null);
        factory = chain.openContract(await LaunchFactory.fromInit(admin.address, treasury.address, router.address, LAUNCH_FEE, TIERS));
        await factory.send(admin.getSender(), { value: toNano('0.5') }, null);
        base = chain.snapshot();
    });
    beforeEach(async () => {
        await chain.loadFrom(base);
        chain.now = T0;
    });

    it('no vault: unchanged behaviour (whole supply in the pool, no vault address, zero vault fields); getters', async () => {
        for (const d of [0n, toNano('5')]) {
            expect(await factory.getGetCreateValue2(d, false)).toBe(await factory.getGetCreateValue(d));
            expect(await factory.getGetCreateValue2(d, true)).toBe((await factory.getGetCreateValue(d)) + VAULT_GAS);
        }
        // vaultBps = 0: lock / vest are ignored (stored 0).
        const res = await create({ vaultLock: 5n, vaultVest: 123n });
        expectNoFailures(res);
        const { master, pool } = await opened(0n);
        const info = await master.getGetLaunchInfo();
        expect([info.vaultBps, info.vaultLock, info.vaultVest]).toEqual([0n, 0n, 0n]);
        expect(await master.getGetVaultAddress()).toBeNull();
        const st = await pool.getGetPoolState();
        expect(st.reserve1 + st.protocolFees1).toBe(SUPPLY);
        expect(await jBal(master, router.address)).toBe(SUPPLY);
        const tl = events(res).filter((e) => e.op === 0x4d4c0021).map((e) => loadTokenLaunched(e.body.clone()))[0];
        expect([tl.vaultBps, tl.vaultLock, tl.vaultVest]).toEqual([0n, 0n, 0n]);
    });

    for (const bps of [3000n, 5000n]) {
        it(`${Number(bps) / 100}% vault: pool holds the rest at the same start price, supply exact, launch at exactly get_create_value2`, async () => {
            expectNoFailures(await create());
            const s0 = (await (await opened(0n)).pool.getGetPoolState()).sqrtPriceX96;
            const value = await factory.getGetCreateValue2(0n, true);
            // One nanoGram less is refused (nothing deployed); the no-vault value is not enough either.
            for (const v of [value - 1n, await factory.getGetCreateValue(0n)]) {
                const r = await create({ vaultBps: bps, vaultLock: 7n * DAY, value: v });
                expect(r.transactions).toHaveTransaction({ to: factory.address, success: false });
                expect((await factory.getGetFactoryData()).nextIndex).toBe(1n);
            }
            const res = await create({ vaultBps: bps, vaultLock: 30n * DAY, vaultVest: 90n * DAY, value });
            expectNoFailures(res);
            const { master, pool, vault } = await opened(1n);
            const vaultAmt = (SUPPLY * bps) / 10000n;
            const st = await pool.getGetPoolState();
            expect(st.initialized).toBe(true);
            expect(st.reserve1 + st.protocolFees1).toBe(SUPPLY - vaultAmt);
            expect(st.sqrtPriceX96).toBe(s0);
            expect(vault).not.toBeNull();
            expect(vault!.address.equals(await master.getGetVaultAddress() as Address)).toBe(true);
            expect(await jBal(master, vault!.address)).toBe(vaultAmt);
            expect(await jBal(master, router.address)).toBe(SUPPLY - vaultAmt);
            expect(await jBal(master, creator.address)).toBe(0n);
            expect((await master.getGetJettonData()).totalSupply).toBe(SUPPLY);
            const vw = await vault!.getGetVaultWallet();
            expect(vw.equals(await master.getGetWalletAddress(vault!.address))).toBe(true);
            const vd = await vault!.getGetVaultData();
            expect([vd.beneficiary.equals(creator.address), vd.total, vd.claimed, vd.start, vd.lock, vd.vest, vd.unlockedNow, vd.claimableNow])
                .toEqual([true, vaultAmt, 0n, BigInt(T0), 30n * DAY, 90n * DAY, 0n, 0n]);
            const info = await master.getGetLaunchInfo();
            expect([info.vaultBps, info.vaultLock, info.vaultVest]).toEqual([bps, 30n * DAY, 90n * DAY]);
            expect((await vault!.getGetVaultMaster()).equals(master.address)).toBe(true);
            // With a dev buy, at exactly get_create_value2(devBuy, true), too.
            const dev = toNano('100');
            const r2 = await create({ vaultBps: bps, vaultLock: 7n * DAY, devBuy: dev, value: await factory.getGetCreateValue2(dev, true) });
            expectNoFailures(r2);
            const t2 = await opened(2n);
            const got = await jBal(t2.master, creator.address);
            expect(got).toBeGreaterThan(0n);
            expect(await jBal(t2.master, t2.vault!.address)).toBe(vaultAmt);
            expect(got + await jBal(t2.master, router.address) + vaultAmt).toBe(SUPPLY);
            // eslint-disable-next-line no-console
            console.log(`vault ${bps} bps: attached ${value}, total tx fees ${res.transactions.reduce((a, tx) => a + tx.totalFees.coins, 0n)}, ` +
                `${res.transactions.length} transactions`);
        });
    }

    it('vest = 0: nothing before the lock ends (refused), everything at the end; no second claim; only the beneficiary', async () => {
        expectNoFailures(await create({ vaultBps: 2000n, vaultLock: 7n * DAY }));
        const { master, vault } = await opened(0n);
        const total = SUPPLY / 5n;
        chain.now = T0 + Number(7n * DAY) - 1;
        expect((await vault!.getGetVaultData()).claimableNow).toBe(0n);
        let res = await claim(vault!);
        expect(res.transactions).toHaveTransaction({ to: vault!.address, success: false });
        expect(await jBal(master, creator.address)).toBe(0n);
        chain.now = T0 + Number(7n * DAY);
        expect((await vault!.getGetVaultData()).claimableNow).toBe(total);
        res = await claim(vault!, bob);
        expect(res.transactions).toHaveTransaction({ to: vault!.address, success: false });
        expect(await jBal(master, bob.address)).toBe(0n);
        // Too little value is refused too.
        res = await claim(vault!, creator, CLAIM_VALUE - 1n);
        expect(res.transactions).toHaveTransaction({ to: vault!.address, success: false });
        const cb = (await chain.getContract(creator.address)).balance;
        res = await claim(vault!);
        expectNoFailures(res);
        expect(await jBal(master, creator.address)).toBe(total);
        expect(await jBal(master, vault!.address)).toBe(0n);
        const vd = await vault!.getGetVaultData();
        expect([vd.claimed, vd.unlockedNow, vd.claimableNow]).toEqual([total, total, 0n]);
        // eslint-disable-next-line no-console
        console.log(`vault claim: creator spent ${cb - (await chain.getContract(creator.address)).balance} of ${CLAIM_VALUE} attached`);
        chain.now = T0 + Number(400n * DAY);
        res = await claim(vault!);
        expect(res.transactions).toHaveTransaction({ to: vault!.address, success: false });
        expect(await jBal(master, creator.address)).toBe(total);
        expect((await master.getGetJettonData()).totalSupply).toBe(SUPPLY);
    });

    it('vest > 0: linear partial claims after the lock, the final claim is exact, never more than unlocked', async () => {
        const lock = 30n * DAY, vest = 100n * DAY;
        expectNoFailures(await create({ vaultBps: 3333n, vaultLock: lock, vaultVest: vest }));
        const { master, vault } = await opened(0n);
        const total = (SUPPLY * 3333n) / 10000n;
        const end = BigInt(T0) + lock;
        let claimed = 0n;
        for (const dt of [0n, 1n, 10n * DAY, 10n * DAY + 7n, 55n * DAY + 12345n, 99n * DAY + 86399n, vest, vest + 1000n]) {
            chain.now = Number(end + dt);
            const unlocked = dt >= vest ? total : (total * dt) / vest;
            const vd = await vault!.getGetVaultData();
            expect([vd.unlockedNow, vd.claimableNow]).toEqual([unlocked, unlocked - claimed]);
            const res = await claim(vault!);
            if (unlocked === claimed) {
                expect(res.transactions).toHaveTransaction({ to: vault!.address, success: false });
            } else {
                expectNoFailures(res);
                claimed = unlocked;
            }
            expect(await jBal(master, creator.address)).toBe(claimed);
            expect(await jBal(master, vault!.address)).toBe(total - claimed);
            // A second claim in the same second gets nothing.
            expect((await claim(vault!)).transactions).toHaveTransaction({ to: vault!.address, success: false });
        }
        expect(claimed).toBe(total);
        expect((await vault!.getGetVaultData()).claimed).toBe(total);
    });

    it('beneficiary transfer: only the beneficiary; the new one claims, the old one cannot', async () => {
        expectNoFailures(await create({ vaultBps: 1000n, vaultLock: 7n * DAY }));
        const { master, vault } = await opened(0n);
        const tr = (from: SandboxContract<TreasuryContract>, to: Address) =>
            vault!.send(from.getSender(), { value: toNano('0.05') }, { $$type: 'TransferVaultBeneficiary', queryId: 0n, newBeneficiary: to });
        expect((await tr(bob, bob.address)).transactions).toHaveTransaction({ to: vault!.address, success: false });
        expectNoFailures(await tr(creator, carol.address));
        expect((await vault!.getGetVaultData()).beneficiary.equals(carol.address)).toBe(true);
        chain.now = T0 + Number(7n * DAY);
        expect((await claim(vault!)).transactions).toHaveTransaction({ to: vault!.address, success: false });
        expectNoFailures(await claim(vault!, carol));
        expect(await jBal(master, carol.address)).toBe(SUPPLY / 10n);
        expect(await jBal(master, creator.address)).toBe(0n);
        // The vault still holds its storage reserve.
        expect((await chain.getContract(vault!.address)).balance).toBeGreaterThanOrEqual(toNano('0.03'));
    });

    it('holder rewards: the vault wallet is not tracked (locked tokens do not dilute); claimed tokens are', async () => {
        expectNoFailures(await create({ vaultBps: 4000n, vaultLock: 7n * DAY, buyTaxBps: 300n, rewardsBps: 10000n }));
        const { master, vault } = await opened(0n);
        const vw = await walletOf(master, vault!.address);
        expect(await vw.getGetTracked()).toBe(false);
        expect(await (await walletOf(master, router.address)).getGetTracked()).toBe(false);
        expect((await master.getGetRewardsData()).totalShares).toBe(0n);
        chain.now = T0 + Number(7n * DAY);
        const res = await claim(vault!);
        expectNoFailures(res);
        const total = (SUPPLY * 4000n) / 10000n;
        expect(await jBal(master, creator.address)).toBe(total);
        const cw = await walletOf(master, creator.address);
        expect(await cw.getGetTracked()).toBe(true);
        expect((await cw.getGetRewardState()).acked).toBe(total);
        expect((await master.getGetRewardsData()).totalShares).toBe(total);
    });

    it('out-of-range vault params are refused (bounced, nothing deployed); the bounds themselves are accepted', async () => {
        for (const o of [
            { vaultBps: 5001n, vaultLock: 7n * DAY }, { vaultBps: 65535n, vaultLock: 30n * DAY },
            { vaultBps: 3000n, vaultLock: 7n * DAY - 1n }, { vaultBps: 3000n, vaultLock: 0n },
            { vaultBps: 3000n, vaultLock: 365n * DAY + 1n }, { vaultBps: 3000n, vaultLock: 7n * DAY, vaultVest: 365n * DAY + 1n },
        ]) {
            const res = await create(o);
            expect(res.transactions).toHaveTransaction({ to: factory.address, success: false });
            expect(res.transactions).toHaveTransaction({ from: factory.address, to: creator.address, inMessageBounced: true });
            expect((await factory.getGetFactoryData()).nextIndex).toBe(0n);
        }
        let i = 0n;
        for (const o of [{ vaultBps: 5000n, vaultLock: 7n * DAY, vaultVest: 365n * DAY }, { vaultBps: 1n, vaultLock: 365n * DAY }]) {
            expectNoFailures(await create(o));
            const { master, vault } = await opened(i++);
            expect(await jBal(master, vault!.address)).toBe((SUPPLY * o.vaultBps) / 10000n);
        }
        // Setup is once and master-only.
        const { vault } = await opened(0n);
        const res = await vault!.send(bob.getSender(), { value: toNano('0.1') }, {
            $$type: 'VaultSetup', queryId: 0n, beneficiary: bob.address, wallet: bob.address, total: 1n, start: 0n, lock: 0n, vest: 0n,
        });
        expect(res.transactions).toHaveTransaction({ to: vault!.address, success: false });
        expect((await vault!.getGetVaultData()).beneficiary.equals(creator.address)).toBe(true);
    });
});
