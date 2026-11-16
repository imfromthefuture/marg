import { VaultFx, GRAM_1, USDT, PHASE, P0, SPACING, GRAM, expectNoFailures } from './fixture';

describe('vault smoke', () => {
    it('setup, open on the canonical plain pool, observation, deposit, withdraw, rebalance', async () => {
        const f = await VaultFx.create();
        const v = await f.data();
        expect(v.phase).toBe(PHASE.IDLE);
        // the canonical plain key: ext = null (no hook, no initializer)
        expect(v.pool!.equals(await f.d.router.getGetPoolAddress(f.d.tokA, GRAM, SPACING, null))).toBe(true);
        expect((await f.vault.getGetPoolKey()).ext).toBeNull();
        const ps = await f.poolState();
        expect(ps.initialized).toBe(true);
        expect(ps.sqrtPriceX96).toBe(P0);
        // 1000 Gram + 3000 USDT at 3 USDT/Gram = 6000 USDT of value = 6000 shares (minus the dead shares)
        expect(v.supply).toBe(5_999_999_999_999n);
        expect(await f.shares(f.admin.address)).toBe(5_999_999_999_999n - 1_000_000n);
        expect((await f.positions()).length).toBe(1);
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();

        // swaps by others never touch the vault (no hook)
        const s1 = await f.swapGram(f.alice, 5n * GRAM_1);
        expectNoFailures(s1);
        expect(s1.transactions.filter((tx) => tx.inMessage?.info.dest?.toString() === f.vault.address.toString()).length).toBe(0);

        await f.wait(4000);
        expectNoFailures(await f.depositUsdt(f.bob, 300n * USDT, 100n * GRAM_1));
        expect(await f.shares(f.bob.address)).toBeGreaterThan(599n * 10n ** 9n);
        expect((await f.vault.getGetOracle()).spotTick).toBe((await f.poolState()).tick);
        expectNoFailures(await f.withdraw(f.bob, (await f.shares(f.bob.address)) / 2n));
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();

        // push the price past the threshold, let the TWAP follow, rebalance
        await f.moveTo((await f.poolState()).tick - 700n);
        await f.warm(4000);
        expectNoFailures(await f.rebalance());
        const after = await f.data();
        expect(after.phase).toBe(PHASE.IDLE);
        expect(after.lastRebalance).toBe(BigInt(f.now));
        expect(after.opCount).toBe(0n);
        await f.expectPositionsMatchNfts();
        await f.expectSolvent();
    });
});
