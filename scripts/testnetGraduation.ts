import { Address, beginCell, fromNano, toNano, TupleBuilder } from '@ton/core';
import { NetworkProvider, sleep } from '@ton/blueprint';
import { Factory } from '../build/Factory_Factory';
import { TokenMaster } from '../build/Factory_TokenMaster';
import { BURN_ADDRESS, buildCurveParams, dexConfig } from './params';

// STON.fi v2.1 testnet (docs.ston.fi); the pTON wallet is the router's wallet on pTON master kQACS30D…
export const TESTNET_ROUTER = Address.parse('kQALh-JBBIKK7gr0o4AVf9JZnEsFndqO0qTCyT-D-yBsWk0v');
export const TESTNET_PTON_WALLET = Address.parse('kQBbJjnahBMGbMUJwhAXLn8BiigcGXMJhSC0l7DBhdYABhG7');

// Same curve shape as mainnet, scaled down so a faucet wallet can fill it: graduates at 1.5 TON.
export const testnetParams = () => buildCurveParams({
    maxSupply: 1_000_000_000n,
    startMcapTon: 0.3,
    graduationTon: 1.5,
    curveTokens: 900_000_000n,
    platformFeeBps: 100,
});

// npx blueprint run testnetGraduation --testnet --mnemonic
// Deploys a factory (or reuses FACTORY), launches a token, buys until it graduates,
// then checks the STON.fi pool. Needs ~2.5 testnet TON.
export async function run(provider: NetworkProvider) {
    const me = provider.sender().address!;
    const ui = provider.ui();

    let factory;
    if (process.env.FACTORY) {
        factory = provider.open(Factory.fromAddress(Address.parse(process.env.FACTORY)));
    } else {
        factory = provider.open(await Factory.fromInit(me, me, testnetParams(), testnetParams(), testnetParams(),
            dexConfig(TESTNET_ROUTER, TESTNET_PTON_WALLET, BURN_ADDRESS), 0n));
        if (!(await provider.isContractDeployed(factory.address))) {
            await factory.send(provider.sender(), { value: toNano('0.1') }, null);
            await provider.waitForDeploy(factory.address);
        }
    }
    ui.write(`Factory: ${factory.address.toString({ testOnly: true })}`);

    const index = await factory.getNextIndex();
    const content = beginCell().storeUint(1, 8).storeStringTail('https://example.com/testnet-token.json').endCell();
    await factory.send(provider.sender(), { value: toNano('0.3') },
        { $$type: 'CreateToken', queryId: 0n, content, tier: 0n, initialBuy: 0n });
    const master = provider.open(TokenMaster.fromAddress(await factory.getTokenAddress(index)));
    await provider.waitForDeploy(master.address, 30);
    ui.write(`Token #${index}: ${master.address.toString({ testOnly: true })}`);

    // Overpay slightly; the master only takes what fills the curve and refunds the rest.
    const amount = toNano('1.6');
    await master.send(provider.sender(), { value: amount + toNano('0.2') },
        { $$type: 'Buy', queryId: 0n, tonAmount: amount, minTokensOut: 0n });

    ui.write('Waiting for graduation…');
    for (let i = 0; i < 30 && !(await master.getCurveState()).graduated; i++) await sleep(4000);
    const state = await master.getCurveState();
    if (!state.graduated) throw new Error('Did not graduate');
    ui.write(`Graduated. Tokens sold on curve: ${state.tokensSold / 10n ** 9n}`);

    // Find the pool and wait for STON.fi to finish the two-leg provide.
    const routerJettonWallet = await master.getGetWalletAddress(TESTNET_ROUTER);
    const args = new TupleBuilder();
    args.writeAddress(TESTNET_PTON_WALLET);
    args.writeAddress(routerJettonWallet);
    const router = provider.provider(TESTNET_ROUTER);
    const pool = (await router.get('get_pool_address', args.build())).stack.readAddress();
    ui.write(`Pool: ${pool.toString({ testOnly: true })}`);

    for (let i = 0; i < 30; i++) {
        if (await provider.isContractDeployed(pool)) {
            const s = (await provider.provider(pool).get('get_pool_data', [])).stack;
            s.readBoolean(); s.readAddress();
            const lpSupply = s.readBigNumber();
            const r0 = s.readBigNumber();
            const r1 = s.readBigNumber();
            if (lpSupply > 0n) {
                ui.write(`Pool live: reserves ${fromNano(r0)} / ${fromNano(r1)}, LP supply ${lpSupply}`);
                ui.write(`https://testnet.tonviewer.com/${pool.toString({ testOnly: true })}`);
                return;
            }
        }
        await sleep(4000);
    }
    throw new Error('Pool not created yet — check the router transactions on tonviewer');
}
