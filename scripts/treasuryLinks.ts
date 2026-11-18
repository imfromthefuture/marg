import { Address, beginCell } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Router, storeSetTreasury as storeRouterSetTreasury } from '../dex/v2/build/Router_Router';
import { LaunchFactory, storeSetTreasury as storeFactorySetTreasury } from '../launch/build/Launch_LaunchFactory';
import { requireBasechain } from './guards';

// Builds Tonkeeper links that point the Router and/or the LaunchFactory at a new treasury. The admin
// is a Tonkeeper wallet now, so it signs these links itself. The new address is checked first: only
// basechain addresses pass (see guards.ts), and the script shows the current admin and treasury.
// Normally the treasury of both is the FeeConverter, which forwards Gram to the wallet; to change the
// final wallet, use setFeeTreasury on the converter instead.
// Usage: ROUTER=<a> [FACTORY=<a>] TREASURY=<addr> npx blueprint run treasuryLinks --mainnet
export async function run(provider: NetworkProvider) {
    const treasury = requireBasechain('TREASURY', process.env.TREASURY);
    const fmt = (a: Address) => a.toString({ bounceable: false });
    const link = (to: Address, body: ReturnType<typeof beginCell>) =>
        `https://app.tonkeeper.com/transfer/${to.toString()}?amount=50000000&bin=${body.endCell().toBoc().toString('base64url')}`;

    if (process.env.ROUTER) {
        const router = provider.open(Router.fromAddress(requireBasechain('ROUTER', process.env.ROUTER)));
        const d = await router.getGetRouterData();
        console.log(`Router ${router.address}\n  admin ${fmt(d.admin)}\n  treasury now ${d.treasury.toString()}\n  treasury new ${treasury.toString()}`);
        console.log('  Sign with the admin wallet:', link(router.address, beginCell().store(storeRouterSetTreasury({ $$type: 'SetTreasury', queryId: 0n, treasury }))));
    }
    if (process.env.FACTORY) {
        const factory = provider.open(LaunchFactory.fromAddress(requireBasechain('FACTORY', process.env.FACTORY)));
        const d: any = await factory.getGetFactoryData();
        console.log(`Factory ${factory.address}\n  admin ${fmt(d.admin)}\n  treasury now ${d.treasury?.toString?.() ?? '?'}\n  treasury new ${treasury.toString()}`);
        console.log('  Sign with the admin wallet:', link(factory.address, beginCell().store(storeFactorySetTreasury({ $$type: 'SetTreasury', queryId: 0n, treasury }))));
    }
}
