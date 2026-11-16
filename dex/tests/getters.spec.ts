import { Address, beginCell, Dictionary, toNano } from '@ton/core';
import { SandboxContract } from '@ton/sandbox';
import { createHash } from 'crypto';
import {
    Dex, ERR, expectNoFailures, GRAM, LpAccount, LpWallet, modelAdd, modelBurn, modelSwap, OP, opOf, Pool, rng,
    storeProvideWalletAddress, txsBetween,
} from './helpers';

// Getters (Router, Pool, LpWallet, LpAccount) and TEP-74 / TEP-89 compliance of the LP jetton.

describe('getters', () => {
    let d: Dex;
    let native: SandboxContract<Pool>;
    let jj: SandboxContract<Pool>;

    beforeEach(async () => {
        d = await Dex.create();
        native = await d.seedNative(d.jA, toNano('1000'), toNano('5000000'));
        jj = await d.seedJJ(d.jA, toNano('1000000'), d.jB, toNano('4000000'));
    });

    it('Router: pool address is deterministic and order independent; router data; gram token', async () => {
        for (const [a, b] of [[GRAM, d.tokA], [d.tokA, d.tokB], [d.tokC, d.tokB]]) {
            const p1 = await d.router.getGetPoolAddress(a, b);
            const p2 = await d.router.getGetPoolAddress(b, a);
            expect(p1.equals(p2)).toBe(true);
            const [t0, t1] = BigInt('0x' + a.hash.toString('hex')) < BigInt('0x' + b.hash.toString('hex')) ? [a, b] : [b, a];
            expect((await Pool.fromInit(d.router.address, t0, t1)).address.equals(p1)).toBe(true);
        }
        const pd = await native.getGetPoolData();
        expect(pd.token0.equals(GRAM)).toBe(true);
        expect(pd.isNative).toBe(true);
        expect(pd.router.equals(d.router.address)).toBe(true);
        const rd = await d.router.getGetRouterData();
        expect(rd.admin.equals(d.admin.address)).toBe(true);
        expect(rd.treasury.equals(d.treasury.address)).toBe(true);
        expect(rd.pendingAdmin).toBeNull();
        expect(rd.creationPaused).toBe(false);
        expect((await d.router.getGetGramToken()).equals(GRAM)).toBe(true);
    });

    it('LpAccount address agrees between Router, Pool and fromInit; account data', async () => {
        const viaRouter = await d.router.getGetLpAccountAddress(d.tokA, GRAM, d.bob.address);
        const viaPool = await native.getGetLpAccountAddress(d.bob.address);
        const viaInit = (await LpAccount.fromInit(native.address, d.bob.address)).address;
        expect(viaRouter.equals(viaPool)).toBe(true);
        expect(viaPool.equals(viaInit)).toBe(true);
        expectNoFailures(await d.provideNative(d.bob, toNano('2'), d.tokA));
        const a = await d.chain.openContract(LpAccount.fromAddress(viaPool)).getGetLpAccountData();
        expect(a.pool.equals(native.address)).toBe(true);
        expect(a.user.equals(d.bob.address)).toBe(true);
        expect(a.pending0).toBe(toNano('2'));
        expect(a.isNative).toBe(true);
    });

    it('TEP-74: get_jetton_data (on-chain TEP-64 metadata) and get_wallet_address', async () => {
        const jd = await native.getGetJettonData();
        const pd = await native.getGetPoolData();
        expect(jd.totalSupply).toBe(pd.totalSupply);
        expect(jd.mintable).toBe(true);
        expect(jd.adminAddress).toBeNull();
        const lwInit = (await LpWallet.fromInit(native.address, d.alice.address)).init!;
        expect(jd.jettonWalletCode.equals(lwInit.code)).toBe(true);

        const c = jd.jettonContent.beginParse();
        expect(c.loadUint(8)).toBe(0);
        const dict = c.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        const read = (k: string) => {
            const key = BigInt('0x' + createHash('sha256').update(k).digest('hex'));
            const v = dict.get(key)!.beginParse();
            expect(v.loadUint(8)).toBe(0);
            return v.loadStringTail();
        };
        expect(read('name')).toBe('Marg DEX LP');
        expect(read('symbol')).toBe('MARG-LP');
        expect(read('decimals')).toBe('9');

        const w = await native.getGetWalletAddress(d.alice.address);
        expect(w.equals((await LpWallet.fromInit(native.address, d.alice.address)).address)).toBe(true);
        const wd = await d.chain.openContract(LpWallet.fromAddress(w)).getGetWalletData();
        expect(wd.balance).toBe(pd.totalSupply - 1000n);
        expect(wd.owner.equals(d.alice.address)).toBe(true);
        expect(wd.master.equals(native.address)).toBe(true);
        expect(wd.code.equals(lwInit.code)).toBe(true);
    });

    it('TEP-89: ProvideWalletAddress -> TakeWalletAddress, with and without the owner', async () => {
        for (const include of [true, false]) {
            const body = beginCell().store(storeProvideWalletAddress({
                $$type: 'ProvideWalletAddress', queryId: 77n, ownerAddress: d.carol.address, includeAddress: include,
            })).endCell();
            const res = await d.bob.send({ to: native.address, value: toNano('0.05'), body });
            expectNoFailures(res);
            const reply = txsBetween(res, native.address, d.bob.address).find((t) => opOf(t) === OP.TakeWalletAddress)!;
            const b = reply.inMessage!.body.beginParse();
            b.loadUint(32);
            expect(b.loadUintBig(64)).toBe(77n);
            expect(b.loadAddress().equals(await native.getGetWalletAddress(d.carol.address))).toBe(true);
            const owner = b.loadMaybeRef();
            if (include) expect(owner!.beginParse().loadAddress().equals(d.carol.address)).toBe(true);
            else expect(owner).toBeNull();
        }
        const low = await d.bob.send({
            to: native.address, value: toNano('0.006'),
            body: beginCell().store(storeProvideWalletAddress({ $$type: 'ProvideWalletAddress', queryId: 0n, ownerAddress: d.carol.address, includeAddress: false })).endCell(),
        });
        expect(low.transactions).toHaveTransaction({ to: native.address, success: false, exitCode: ERR.pool['Insufficient TON attached'] });
    });

    it('get_expected_out: 0 for a wrong token, refBps above the cap or below 0, an empty pool; model-exact otherwise', async () => {
        expect((await native.getGetExpectedOut(d.tokB, toNano('1'), 0n)).amountOut).toBe(0n);
        expect((await native.getGetExpectedOut(GRAM, toNano('1'), 11n)).amountOut).toBe(0n);
        expect((await native.getGetExpectedOut(GRAM, toNano('1'), -1n)).amountOut).toBe(0n);
        expect((await native.getGetExpectedOut(GRAM, 0n, 0n)).amountOut).toBe(0n);
        expect((await native.getGetExpectedOut(GRAM, -5n, 0n)).amountOut).toBe(0n);
        expectNoFailures(await d.swapNative(d.bob, toNano('1'), d.tokC));     // deploys an empty (GRAM, C)
        const empty = await d.poolOf(GRAM, d.tokC);
        expect((await empty.getGetExpectedOut(GRAM, toNano('1'), 0n)).amountOut).toBe(0n);

        const r = rng(42);
        for (let i = 0; i < 25; i++) {
            const p = r.pick([native, jj]);
            const pd = await p.getGetPoolData();
            const in0 = r.next() < 0.5;
            const amt = r.big(1n, (in0 ? pd.reserve0 : pd.reserve1) * 3n);
            const ref = BigInt(r.int(0, 10));
            const m = modelSwap(amt, in0 ? pd.reserve0 : pd.reserve1, in0 ? pd.reserve1 : pd.reserve0, pd.lpFeeBps, pd.protocolFeeBps, ref);
            const q = await p.getGetExpectedOut(in0 ? pd.token0 : pd.token1, amt, ref);
            expect(q.amountOut).toBe(m.amountOut);
            expect(q.protocolFee).toBe(m.protocolFee);
            expect(q.refFee).toBe(m.refFee);
        }
    });

    it('get_expected_lp and get_expected_burn are model-exact, 0 out of range', async () => {
        expect((await native.getGetExpectedLp(0n, toNano('1'))).lp).toBe(0n);
        expect((await native.getGetExpectedBurn(0n)).out0).toBe(0n);
        const pd0 = await native.getGetPoolData();
        expect((await native.getGetExpectedBurn(pd0.totalSupply + 1n)).out0).toBe(0n);
        const empty = await d.poolOf(GRAM, d.tokC);
        expectNoFailures(await d.swapNative(d.bob, toNano('1'), d.tokC));
        expect((await empty.getGetExpectedLp(toNano('4'), toNano('9'))).lp).toBe(toNano('6') - 1000n);
        expect((await empty.getGetExpectedLp(1000n, 1000n)).lp).toBe(0n);

        const r = rng(43);
        for (let i = 0; i < 25; i++) {
            const p = r.pick([native, jj]);
            const pd = await p.getGetPoolData();
            const a0 = r.big(1n, pd.reserve0);
            const a1 = r.big(1n, pd.reserve1);
            const m = modelAdd(a0, a1, pd.reserve0, pd.reserve1, pd.totalSupply);
            const q = await p.getGetExpectedLp(a0, a1);
            expect([q.lp, q.use0, q.use1]).toEqual([m.lp, m.use0, m.use1]);
            const lp = r.big(1n, pd.totalSupply - 1000n);
            const mb = modelBurn(lp, pd.reserve0, pd.reserve1, pd.totalSupply);
            const qb = await p.getGetExpectedBurn(lp);
            expect([qb.out0, qb.out1]).toEqual([mb.out0, mb.out1]);
        }
    });
});
void Address;
