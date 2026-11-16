// The vault runs on the CANONICAL plain Gram/USDT pool: several vaults share one key, each with its
// own NFTs and books, and plain swappers pay the plain-pool price (no hook notification, no 0.01
// Gram hook fee) and never touch a vault.

import { Address, toNano } from '@ton/core';
import { VaultFx, GRAM_1, USDT, PHASE, SPACING, GRAM, P0, expectNoFailures } from './fixture';
import { extCell, failedAt, findMin } from '../../dex/v2/tests/helpers';
import { TestHook } from '../../dex/v2/build/TestHook_TestHook';

const touches = (res: any, a: Address) => res.transactions.filter((tx: any) => tx.inMessage?.info.dest instanceof Address && tx.inMessage.info.dest.equals(a)).length;

describe('several vaults on one key', () => {
    it('two vaults share the canonical pool: independent positions, deposits, withdrawals, rebalances and fees', async () => {
        const a = await VaultFx.create();
        const b = await VaultFx.create({ dex: a.d, salt: 1n, seed0: 300n * GRAM_1, seed1: 900n * USDT });
        expect(a.vault.address.equals(b.vault.address)).toBe(false);
        expect(a.pool.address.equals(b.pool.address)).toBe(true);
        expect((await b.data()).phase).toBe(PHASE.IDLE);
        // B opened on the pool A initialized, at its price (no re-initialization)
        expect((await a.poolState()).sqrtPriceX96).toBe(P0);
        const pa = await a.positions();
        const pb = await b.positions();
        expect(pa.length).toBe(1);
        expect(pb.length).toBe(1);
        expect(pa[0].index).not.toBe(pb[0].index);
        await a.expectPositionsMatchNfts();
        await b.expectPositionsMatchNfts();

        // fees accrue to both; each vault's withdrawal collects only its own position
        for (let i = 0; i < 4; i++) {
            expectNoFailures(await a.swapGram(a.carol, 20n * GRAM_1));
            expectNoFailures(await a.swapUsdt(a.carol, 60n * USDT));
        }
        await a.wait(3700);
        expectNoFailures(await a.depositUsdt(a.alice, 300n * USDT, 100n * GRAM_1));
        expectNoFailures(await b.depositUsdt(b.bob, 150n * USDT, 50n * GRAM_1));
        expect(await a.shares(a.bob.address)).toBe(0n);
        expect(await b.shares(b.alice.address)).toBe(0n);
        const sb = await b.snap();
        const wb = await b.withdraw(b.bob, await b.shares(b.bob.address));
        expectNoFailures(wb);
        expect(touches(wb, a.vault.address)).toBe(0);
        expect((await b.data()).fee0 - sb.v.fee0).toBe((sb.fees[0].f0 * 1000n) / 10000n);
        // a rebalance of A leaves B untouched
        await a.moveTo((await a.poolState()).tick - 700n);
        await a.warm(4000);
        const before = await b.positions();
        const ra = await a.rebalance();
        expectNoFailures(ra);
        expect(touches(ra, b.vault.address)).toBe(0);
        expect(await b.positions()).toEqual(before);
        expect((await a.data()).lastRebalance).toBe(BigInt(a.now));
        for (const f of [a, b]) {
            await f.expectPositionsMatchNfts();
            await f.expectSolvent();
        }
        // and B can rebalance on the same key afterwards
        await b.wait(120);
        const rb = await b.rebalance();
        expectNoFailures(rb);
        expect((await b.data()).lastRebalance).toBe(BigInt(b.now));
        await b.expectPositionsMatchNfts();
        await a.expectPositionsMatchNfts();
    });

    it('a plain swapper on the canonical pool pays no hook fee and never touches a vault', async () => {
        const f = await VaultFx.create();
        const r = await f.swapGram(f.alice, 5n * GRAM_1);
        expectNoFailures(r);
        expect(touches(r, f.vault.address)).toBe(0);
        // Router minimum for the same swap on the canonical key vs a hook key with AFTER_SWAP
        const hook = f.chain.openContract(await TestHook.fromInit(f.carol.address, 0n));
        await hook.send(f.carol.getSender(), { value: toNano('1') }, null);
        const hookExt = extCell({ hook: hook.address, hookFlags: 1n });
        const minFor = (ext: any) => findMin(f.chain, toNano('0.3'), toNano('1'), async (gas) => {
            const res = await f.d.swapNative(f.bob, GRAM_1, f.d.tokA, { tickSpacing: SPACING, ext, gas });
            return failedAt(res, f.d.router.address).length === 0;
        });
        const plain = await minFor(null);
        const hooked = await minFor(hookExt);
        expect(hooked - plain).toBeGreaterThanOrEqual(toNano('0.01'));
        // and a swap at the plain minimum executes on the canonical pool without any notification
        const res = await f.d.swapNative(f.bob, GRAM_1, f.d.tokA, { tickSpacing: SPACING, ext: null, gas: plain });
        expectNoFailures(res);
        expect(res.transactions.some((tx: any) => tx.inMessage?.info.dest instanceof Address && tx.inMessage.info.dest.equals(f.pool.address))).toBe(true);
        expect(touches(res, f.vault.address)).toBe(0);
        expect(GRAM).toBeDefined();
    });
});
