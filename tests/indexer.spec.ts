// Feeds real sandbox transactions, shaped like toncenter v3 results, through the indexer.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, toNano, Transaction } from '@ton/core';
import { Factory } from '../build/Factory_Factory';
import { TokenMaster } from '../build/Factory_TokenMaster';
import { TokenWallet } from '../build/Factory_TokenWallet';
import { BURN_ADDRESS, defaultTiers, dexConfig } from '../scripts/params';

process.env.FACTORY = '0:' + '0'.repeat(64);
process.env.DB_PATH = ':memory:';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const idx = require('../server/indexer/src/index');

const T0 = 1_800_000_000;

function v3(tx: Transaction) {
    return {
        account: tx.inMessage!.info.dest!.toString(),
        now: tx.now, lt: tx.lt.toString(), hash: tx.hash().toString('base64'),
        description: { aborted: tx.description.type === 'generic' ? tx.description.aborted : false },
        out_msgs: [...tx.outMessages.values()].map((m) => ({
            destination: m.info.type === 'external-out' ? null : m.info.dest!.toString(),
            message_content: { body: m.body.toBoc().toString('base64') },
        })),
    };
}

describe('Indexer', () => {
    let chain: Blockchain;
    let alice: SandboxContract<TreasuryContract>;
    let master: SandboxContract<TokenMaster>;
    const tiers = defaultTiers();
    const params = tiers[1];
    const feed = (txs: Transaction[]) => txs.filter((t) => t.inMessage?.info.dest instanceof Address && (t.inMessage.info.dest as Address).equals(master.address)).forEach((t) => idx.handleTx(v3(t)));
    const get = async (path: string, q = '') => (await idx.route(path, new URLSearchParams(q)))[1] as any;

    beforeAll(async () => {
        chain = await Blockchain.create();
        chain.now = T0;
        const admin = await chain.treasury('admin');
        const creator = await chain.treasury('creator', { balance: toNano('1000') });
        alice = await chain.treasury('alice', { balance: toNano('100000') });
        const router = await chain.treasury('router');
        const pton = await chain.treasury('pton');
        const factory = chain.openContract(await Factory.fromInit(admin.address, admin.address, tiers[0], tiers[1], tiers[2], dexConfig(router.address, pton.address, BURN_ADDRESS), 0n));
        await factory.send(admin.getSender(), { value: toNano('1') }, null);
        master = chain.openContract(TokenMaster.fromAddress(await factory.getTokenAddress(0n)));

        idx.setReady();
        idx.db.prepare(`INSERT INTO tokens (address, idx, name, symbol, creator, ton_reserve, token_reserve, real_ton,
            virtual_ton, virtual_tokens, graduation_ton, max_supply) VALUES (?, 0, 'Cat', 'CAT', ?, ?, ?, '0', ?, ?, ?, ?)`).run(
            master.address.toRawString(), creator.address.toRawString(), params.virtualTon.toString(), params.virtualTokens.toString(),
            params.virtualTon.toString(), params.virtualTokens.toString(), params.graduationTon.toString(), params.maxSupply.toString());

        const content = beginCell().storeUint(1, 8).storeStringTail('x').endCell();
        feed((await factory.send(creator.getSender(), { value: toNano('0.5') }, { $$type: 'CreateToken', queryId: 0n, content, tier: 1n, initialBuy: 0n })).transactions);

        chain.now = T0 + 30;
        feed((await master.send(alice.getSender(), { value: toNano('100.2') }, { $$type: 'Buy', queryId: 0n, tonAmount: toNano('100'), minTokensOut: 0n })).transactions);
        chain.now = T0 + 400;
        feed((await master.send(alice.getSender(), { value: toNano('50.2') }, { $$type: 'Buy', queryId: 0n, tonAmount: toNano('50'), minTokensOut: 0n })).transactions);
        chain.now = T0 + 700;
        const wallet = chain.openContract(TokenWallet.fromAddress(await master.getGetWalletAddress(alice.address)));
        const bal = (await wallet.getGetWalletData()).balance;
        feed((await wallet.send(alice.getSender(), { value: toNano('0.1') }, { $$type: 'Sell', queryId: 0n, amount: bal / 4n, minTonOut: 0n })).transactions);
    });

    it('records each trade and tracks the latest curve state', async () => {
        const trades = await get(`/api/idx/token/${master.address.toString()}/trades`);
        expect(trades.map((t: any) => t.isBuy)).toEqual([false, true, true]);
        expect(trades[2].ton).toBe(toNano('100').toString());

        const curve = await master.getCurveState();
        const token = await get(`/api/idx/token/${master.address.toString()}`);
        expect(token.symbol).toBe('CAT');
        expect(token.createdAt).toBe(T0);
        expect(token.realTon).toBe(curve.realTon.toString());
        expect(token.mcap).toBe(((curve.tonReserve * params.maxSupply) / curve.tokenReserve).toString());
        expect(token.tradesTotal).toBe(3);
        expect(token.progress).toBeCloseTo(Number(curve.realTon) / Number(params.graduationTon), 9);
    });

    it('builds candles that open at the previous close', async () => {
        const c = await get(`/api/idx/token/${master.address.toString()}/candles`, 'tf=300');
        expect(c.map((x: any) => x.time)).toEqual([T0, T0 + 300, T0 + 600]); // T0 is a multiple of 300
        for (let i = 1; i < c.length; i++) expect(c[i].open).toBe(c[i - 1].close);
        expect(c[0].open).toBeCloseTo(Number(params.virtualTon) / Number(params.virtualTokens), 15);
        expect(c[2].close).toBeLessThan(c[1].close); // the sell pushed the price down
    });

    it('lists the token and the recent trades feed', async () => {
        const list = await get('/api/idx/tokens');
        expect(list).toHaveLength(1);
        expect(list[0].spark).toHaveLength(24);
        expect((await get('/api/idx/trades')).length).toBe(3);
        expect((await idx.route('/api/idx/token/nope', new URLSearchParams()))[0]).toBe(404);
    });
});
