import { Blockchain, RemoteBlockchainStorage, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, fromNano, toNano, TupleBuilder } from '@ton/core';
import '@ton/test-utils';
import { Factory } from '../build/Factory_Factory';
import { TokenMaster } from '../build/Factory_TokenMaster';
import { TokenWallet } from '../build/Factory_TokenWallet';
import { BURN_ADDRESS, defaultTiers, dexConfig } from '../scripts/params';
import { fetchLibraries, toncenterClient } from './toncenter';

// Runs graduation against the real STON.fi v2 contracts, lazily loaded from mainnet
// into the sandbox. Nothing is sent on-chain. Needs network: FORK=1 npx jest stonfi-fork
const ROUTER = Address.parse('EQCiypoBWNIEPlarBp04UePyEj5zH0ZDHxuRNqJ1WQx3FCY-'); // v2.2 ConstantProduct, pool creation enabled
const PTON_WALLET = Address.parse('EQCjEo7QNUH5S2tVjYgFFdEh1pherydH9K-nrHx0aScsq7U5');

const describeFork = process.env.FORK ? describe : describe.skip;

describeFork('Graduation on a mainnet fork (real STON.fi v2)', () => {
    let chain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let treasury: SandboxContract<TreasuryContract>;
    let creator: SandboxContract<TreasuryContract>;
    let whale: SandboxContract<TreasuryContract>;
    let factory: SandboxContract<Factory>;
    const tiers = defaultTiers();

    beforeAll(async () => {
        chain = await Blockchain.create({ storage: new RemoteBlockchainStorage(toncenterClient) });
        // STON.fi keeps its contract code in library cells; load them so the sandbox can run it.
        const cells = [];
        for (const a of [ROUTER, PTON_WALLET]) {
            const acc = (await chain.getContract(a)).accountState;
            if (acc?.type === 'active') cells.push(...[acc.state.code, acc.state.data].filter((c): c is NonNullable<typeof c> => !!c));
        }
        chain.libs = beginCell().storeDictDirect(await fetchLibraries(cells)).endCell();
        admin = await chain.treasury('fork-admin');
        treasury = await chain.treasury('fork-treasury');
        creator = await chain.treasury('fork-creator', { balance: toNano('1000') });
        whale = await chain.treasury('fork-whale', { balance: toNano('1000000') });
        factory = chain.openContract(
            await Factory.fromInit(admin.address, treasury.address, tiers[0], tiers[1], tiers[2], dexConfig(ROUTER, PTON_WALLET, BURN_ADDRESS), 0n),
        );
        await factory.send(admin.getSender(), { value: toNano('1') }, null);
    }, 120000);

    it.each([[0, 'low'], [1, 'mid'], [2, 'high']])('tier %i (%s): creates the STON.fi pool with the raised TON and remaining supply, LP burned', async (tier) => {
        const params = tiers[tier];
        const content = beginCell().storeUint(1, 8).storeStringTail('https://example.com/meta.json').endCell();
        const index = await factory.getNextIndex();
        await factory.send(creator.getSender(), { value: toNano('0.5') },
            { $$type: 'CreateToken', queryId: 0n, content, tier: BigInt(tier), initialBuy: 0n });
        const master = chain.openContract(TokenMaster.fromAddress(await factory.getTokenAddress(index)));

        const buyAmount = params.graduationTon + params.graduationTon / 5n;
        const res = await master.send(whale.getSender(), { value: buyAmount + toNano('0.2') },
            { $$type: 'Buy', queryId: 0n, tonAmount: buyAmount, minTokensOut: 0n });

        // Every transaction in the chain (ours and STON.fi's) must succeed.
        const failed = res.transactions.filter((t) => t.description.type === 'generic' &&
            (t.description.aborted || (t.description.computePhase.type === 'vm' && !t.description.computePhase.success)));
        for (const t of failed) {
            const d = t.description as any;
            console.log('FAILED tx at', t.inMessage?.info.dest?.toString(), 'exit', d.computePhase?.exitCode, 'action', d.actionPhase?.resultCode);
        }
        expect(failed).toHaveLength(0);

        const state = await master.getCurveState();
        expect(state.graduated).toBe(true);

        // Locate the pool the router created for (pTON, our token).
        const routerJettonWallet = await master.getGetWalletAddress(ROUTER);
        const args = new TupleBuilder();
        args.writeAddress(PTON_WALLET);
        args.writeAddress(routerJettonWallet);
        const poolRes = await chain.runGetMethod(ROUTER, 'get_pool_address', args.build());
        const pool = poolRes.stackReader.readAddress();
        const poolAccount = await chain.getContract(pool);
        expect(poolAccount.accountState?.type).toBe('active');

        const data = (await chain.runGetMethod(pool, 'get_pool_data')).stackReader;
        const isLocked = data.readBoolean();
        data.readAddress(); // router
        const lpSupply = data.readBigNumber();
        const reserve0 = data.readBigNumber();
        const reserve1 = data.readBigNumber();
        const token0 = data.readAddress();
        expect(isLocked).toBe(false);

        const [tonReserve, tokenReserve] = token0.equals(PTON_WALLET) ? [reserve0, reserve1] : [reserve1, reserve0];
        const poolTokens = params.maxSupply - state.tokensSold;
        expect(tokenReserve).toBe(poolTokens);
        expect(tonReserve).toBeGreaterThan(params.graduationTon - toNano('1'));

        // LP minted to the burn address (STON.fi locks a small minimum on first deposit).
        const lpWalletRes = await chain.runGetMethod(pool, 'get_wallet_address', (() => {
            const b = new TupleBuilder(); b.writeAddress(BURN_ADDRESS); return b.build();
        })());
        const lpWallet = lpWalletRes.stackReader.readAddress();
        const lpData = (await chain.runGetMethod(lpWallet, 'get_wallet_data')).stackReader;
        const burnedLp = lpData.readBigNumber();
        expect(burnedLp).toBeGreaterThan(0n);
        expect(burnedLp).toBeLessThanOrEqual(lpSupply);

        const leftover = await chain.openContract(TokenWallet.fromAddress(routerJettonWallet)).getGetWalletData();
        console.log(`pool ${pool.toString()}\n  TON reserve ${fromNano(tonReserve)}, token reserve ${tokenReserve / 10n ** 9n}\n` +
            `  LP supply ${lpSupply}, burned ${burnedLp} (${Number((burnedLp * 10000n) / lpSupply) / 100}%)\n` +
            `  router jetton wallet balance ${leftover.balance / 10n ** 9n}`);
    }, 300000);
});
