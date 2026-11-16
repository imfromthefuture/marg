import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Router } from '../dex/v2/build/Router_Router';
import { LaunchFactory } from '../launch/build/Launch_LaunchFactory';

// Deploys the MARG DEX Router, then the LaunchFactory pointing at it.
// Usage: TREASURY=<addr> LAUNCH_FEE=<gram> [DRY_RUN=1] npx blueprint run deployMarg --mainnet --mnemonic
// DRY_RUN=1 prints the addresses and sends nothing.
export async function run(provider: NetworkProvider) {
    const admin = provider.sender().address!;
    const treasury = process.env.TREASURY ? Address.parse(process.env.TREASURY) : admin;
    const launchFee = toNano(process.env.LAUNCH_FEE ?? '0.5');
    // Liquidity tiers (start market cap; all on the 1% fee preset).
    const lp = (mcap: string) => ({ $$type: 'LaunchParams' as const, startMcap: toNano(mcap), tickSpacing: 200n });
    const tiers = { $$type: 'LaunchTiers' as const, low: lp('2600'), mid: lp('10000'), high: lp('30000') };

    const router = provider.open(await Router.fromInit(admin, treasury));
    const factory = provider.open(await LaunchFactory.fromInit(admin, treasury, router.address, launchFee, tiers));

    console.log('Admin    ', admin.toString());
    console.log('Treasury ', treasury.toString());
    console.log('Router   ', router.address.toString());
    console.log('Factory  ', factory.address.toString(), `(launch fee ${process.env.LAUNCH_FEE ?? '0.5'} Gram)`);
    if (process.env.DRY_RUN) return;

    if (!(await provider.isContractDeployed(router.address))) {
        await router.send(provider.sender(), { value: toNano('1') }, null);
        await provider.waitForDeploy(router.address);
    }
    console.log('Router deployed');
    if (!(await provider.isContractDeployed(factory.address))) {
        await factory.send(provider.sender(), { value: toNano('0.5') }, null);
        await provider.waitForDeploy(factory.address);
    }
    console.log('Factory deployed');
}
