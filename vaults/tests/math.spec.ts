// The vault's copied v3 math must equal dex/v2's (MathHarness, the code the Pool runs), and the
// copied DEX types must serialize exactly like the dex/v2 build. Addresses the vault derives on-chain
// (pool, positions, share wallets) must equal the DEX's / Tact's own derivation.

import { Blockchain } from '@ton/sandbox';
import { Address, beginCell, Builder, Cell, toNano } from '@ton/core';
import { MathHarness } from '../../dex/v2/build/MathHarness_MathHarness';
import * as Dx from '../../dex/v2/build/Router_Router';
import { VaultMathHarness } from '../build/VaultMath_VaultMathHarness';
import * as Vx from '../build/Vault_Vault';
import { VaultFx, VaultWallet, GRAM, SPACING, GRAM_1, USDT } from './fixture';
import { rng } from '../../dex/v2/tests/helpers';

const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;

describe('copied math == dex/v2 math', () => {
    it('matches on 300 random vectors per function (and the edges)', async () => {
        const chain = await Blockchain.create();
        const deployer = await chain.treasury('d');
        const dex = chain.openContract(await MathHarness.fromInit());
        const mine = chain.openContract(await VaultMathHarness.fromInit());
        await dex.send(deployer.getSender(), { value: toNano('1') }, null);
        await mine.send(deployer.getSender(), { value: toNano('1') }, null);
        const r = rng(7);
        const ticks = [-887272n, 887272n, 0n, -1n, 1n];
        for (let i = 0; i < 300; i++) ticks.push(BigInt(r.int(-887272, 887272)));
        for (const t of ticks) {
            expect(await mine.getSqrtAt(t)).toBe(await dex.getSqrtAt(t));
        }
        const sqrts = [MIN_SQRT, MAX_SQRT - 1n, 2n ** 96n];
        for (let i = 0; i < 300; i++) sqrts.push(r.big(MIN_SQRT, MAX_SQRT - 1n));
        for (const s of sqrts) {
            expect(await mine.getTickAt(s)).toBe(await dex.getTickAt(s));
        }
        const MAXU = 2n ** 256n - 1n;
        for (const [a, b] of [[0n, 0n], [0n, 1n], [5n, 3n], [3n, 5n], [MAXU, 0n], [0n, MAXU], [MAXU, MAXU]] as [bigint, bigint][]) {
            expect(await mine.getSubMod(a, b)).toBe(await dex.getSubMod(a, b));
        }
        for (let i = 0; i < 300; i++) {
            const a = r.big(MIN_SQRT, 2n ** 120n);
            const b = a + r.big(1n, 2n ** 110n);
            const liq = r.big(1n, 2n ** 100n);
            const up = r.next() < 0.5;
            expect(await mine.getAmount0Delta(a, b, liq, up)).toBe(await dex.getAmount0Delta(a, b, liq, up));
            expect(await mine.getAmount1Delta(a, b, liq, up)).toBe(await dex.getAmount1Delta(a, b, liq, up));
            const sA = await dex.getSqrtAt(BigInt(r.int(-100000, 0)));
            const sB = await dex.getSqrtAt(BigInt(r.int(1, 100000)));
            const sP = r.big(sA / 2n, sB * 2n);
            const x = r.big(0n, 2n ** 100n);
            const y = r.big(0n, 2n ** 100n);
            expect(await mine.getLiqForAmounts(sP, sA, sB, x, y)).toBe(await dex.getLiqForAmounts(sP, sA, sB, x, y));
            const tL = BigInt(r.int(-200000, 0));
            const tU = tL + BigInt(r.int(1, 200000));
            const tick = BigInt(r.int(-250000, 250000));
            const sq = await dex.getSqrtAt(tick);
            const L = r.big(0n, 2n ** 110n);
            const pm = await mine.getAmountsForLiq(tick, sq, tL, tU, L, up);
            const pd = await dex.getAmountsForLiq(tick, sq, tL, tU, L, up);
            expect([pm.a, pm.b]).toEqual([pd.a, pd.b]);
        }
    }, 120000);
});

describe('copied types and derived addresses', () => {
    const a1 = new Address(0, Buffer.alloc(32, 7));
    const a2 = new Address(0, Buffer.alloc(32, 9));
    const cell = (f: (b: Builder) => void) => { const b = beginCell(); f(b); return b.endCell(); };

    it('every copied struct/message serializes like the dex/v2 build', () => {
        const ext = {
            hook: a1, hookFlags: 3n, hookShareBps: 0n, hookFeeMin: 0n, hookFeeMax: 0n, initializer: a1,
            launchFeePips: 0n, launchDuration: 0n, minLockSecs: 0n, taxRecipient: null, buyTaxBps: 0n, sellTaxBps: 0n,
        };
        const extCell = cell(Vx.storeKeyExt({ $$type: 'KeyExt', ...ext }));
        expect(extCell.equals(cell(Dx.storeKeyExt({ $$type: 'KeyExt', ...ext })))).toBe(true);
        const key = { token0: GRAM, token1: a2, tickSpacing: 60n, ext: extCell };
        expect(cell(Vx.storePoolKey({ $$type: 'PoolKey', ...key })).equals(cell(Dx.storePoolKey({ $$type: 'PoolKey', ...key })))).toBe(true);
        const po = { queryId: 3n, tickLower: -120n, tickUpper: 600n, payload: cell((b) => b.storeUint(7, 8)) };
        expect(cell(Vx.storePoolObserve({ $$type: 'PoolObserve', ...po })).equals(cell(Dx.storePoolObserve({ $$type: 'PoolObserve', ...po })))).toBe(true);
        const ob = {
            queryId: 3n, initialized: true, sqrtPriceX96: 2n ** 96n, tick: -5n, liquidity: 9n, tickCumulative: -123456789n, time: 77n,
            tickLower: -120n, tickUpper: 600n, rangeOk: true, feeGrowthInside0X128: 2n ** 255n + 1n, feeGrowthInside1X128: 5n, payload: null,
        };
        expect(cell(Vx.storePoolObservation({ $$type: 'PoolObservation', ...ob })).equals(cell(Dx.storePoolObservation({ $$type: 'PoolObservation', ...ob })))).toBe(true);
        const pd = { queryId: 3n, liquidityDelta: 2n ** 100n, amount0Min: 1n, amount1Min: 2n, deadline: 5n, recipient: a2 };
        expect(cell(Vx.storePositionDecreaseNotify({ $$type: 'PositionDecreaseNotify', ...pd })).equals(cell(Dx.storePositionDecreaseNotify({ $$type: 'PositionDecreaseNotify', ...pd })))).toBe(true);
        const br = {
            queryId: 3n, index: 4n, ok: true, code: 0n, liquidityDelta: 7n, liquidity: 9n, amount0: 1n, amount1: 2n, fees0: 3n, fees1: 4n,
            fgInside0: 2n ** 200n, fgInside1: 1n,
        };
        expect(cell(Vx.storeBurnReceipt({ $$type: 'BurnReceipt', ...br })).equals(cell(Dx.storeBurnReceipt({ $$type: 'BurnReceipt', ...br })))).toBe(true);
        const mp = {
            otherToken: GRAM, tickSpacing: 60n, ext: null, tickLower: -120n, tickUpper: 600n, gramAmount: 5n,
            sqrtPriceInitX96: 2n ** 96n, minLiquidity: 77n, owner: a1, refundTo: a2, deadline: 123n, sqrtPriceMinX96: 1n, sqrtPriceMaxX96: 2n,
        };
        expect(cell(Vx.storeMintNotifyPayload({ $$type: 'MintNotifyPayload', ...mp })).equals(cell(Dx.storeMintNotifyPayload({ $$type: 'MintNotifyPayload', ...mp })))).toBe(true);
        const { gramAmount, ...mnRest } = { ...mp, queryId: 9n, amount: 1000n };
        expect(cell(Vx.storeMintNativeNotify({ $$type: 'MintNativeNotify', ...mnRest })).equals(cell(Dx.storeMintNativeNotify({ $$type: 'MintNativeNotify', ...mnRest })))).toBe(true);
        const mr = {
            queryId: 3n, ok: true, code: 0n, owner: a1, index: 4n, tickLower: -60n, tickUpper: 60n, liquidity: 9n, amount0: 1n, amount1: 2n,
            refund0: 3n, refund1: 4n, fgInside0: 5n, fgInside1: 6n,
        };
        expect(cell(Vx.storeMintReceipt({ $$type: 'MintReceipt', ...mr })).equals(cell(Dx.storeMintReceipt({ $$type: 'MintReceipt', ...mr })))).toBe(true);
        const gp = { queryId: 1n, reason: 11n, amount: 5n, payload: null };
        expect(cell(Vx.storeGramPayout({ $$type: 'GramPayout', ...gp })).equals(cell(Dx.storeGramPayout({ $$type: 'GramPayout', ...gp })))).toBe(true);
        const jt = { queryId: 1n, amount: 5n, destination: a1, responseDestination: a2, customPayload: null, forwardTonAmount: 3n, forwardPayload: beginCell().storeBit(0).endCell().beginParse() };
        expect(cell(Vx.storeJettonTransfer({ $$type: 'JettonTransfer', ...jt })).equals(cell(Dx.storeJettonTransfer({ $$type: 'JettonTransfer', ...jt })))).toBe(true);
    });

    it('pool, position and share-wallet addresses derived on-chain match the DEX and Tact', async () => {
        const f = await VaultFx.create({ seed0: 100n * GRAM_1, seed1: 300n * USDT });
        const key = await f.vault.getGetPoolKey();
        const v = await f.data();
        expect(v.pool!.equals(await f.d.router.getGetPoolAddress(GRAM, f.d.tokA, SPACING, key.ext))).toBe(true);
        expect(v.usdtWallet!.equals(await f.usdt.getGetWalletAddress(f.vault.address))).toBe(true);
        expect(v.rwUsdt!.equals(f.d.tokA)).toBe(true);
        expect(key.token1.equals(f.d.tokA)).toBe(true);
        for (const i of [0n, 1n, 7n, 123456n]) {
            expect((await f.vault.getGetPositionAddress(i)).equals(await f.pool.getGetPositionAddress(i))).toBe(true);
        }
        const w = await VaultWallet.fromInit(f.vault.address, f.alice.address);
        expect((await f.vault.getGetWalletAddress(f.alice.address)).equals(w.address)).toBe(true);
        expect((await f.vault.getGetJettonData()).jettonWalletCode.equals(w.init!.code)).toBe(true);
        // the canonical plain key: no ext at all
        expect(key.ext).toBeNull();
        expect(await f.d.router.getGetExtValid(key.ext)).toBe(0n);
    });

    it('setup refuses wrong DEX code, a second setup, and non-admins', async () => {
        const f = await VaultFx.create({ open: false });
        const again = await f.vault.send(f.admin.getSender(), { value: toNano('0.3') }, {
            $$type: 'VaultSetup', queryId: 2n, poolCode: f.poolCode, positionCode: f.positionCode, content: Cell.EMPTY,
        });
        expect(again.transactions).toHaveTransaction({ to: f.vault.address, success: false });
        const g = await VaultFx.create({ open: false, salt: 0n }).catch(() => null);
        expect(g).not.toBeNull();
        // a fresh vault given the wrong pool code
        const { Vault } = await import('../build/Vault_Vault');
        const v2 = f.chain.openContract(await Vault.fromInit(f.admin.address, f.d.router.address, f.usdt.address,
            BigInt('0x' + f.poolCode.hash().toString('hex')), BigInt('0x' + f.positionCode.hash().toString('hex')), SPACING, 99n));
        await v2.send(f.admin.getSender(), { value: toNano('1') }, null);
        const bad = await v2.send(f.admin.getSender(), { value: toNano('0.3') }, {
            $$type: 'VaultSetup', queryId: 1n, poolCode: f.positionCode, positionCode: f.positionCode, content: Cell.EMPTY,
        });
        expect(bad.transactions).toHaveTransaction({ to: v2.address, success: false });
        const notAdmin = await v2.send(f.alice.getSender(), { value: toNano('0.3') }, {
            $$type: 'VaultSetup', queryId: 1n, poolCode: f.poolCode, positionCode: f.positionCode, content: Cell.EMPTY,
        });
        expect(notAdmin.transactions).toHaveTransaction({ to: v2.address, success: false });
        expect((await v2.getGetVaultData()).pool).toBeNull();
    });
});
