import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Router } from '../dex/v2/build/Router_Router';
import { LaunchFactory } from '../launch/build/Launch_LaunchFactory';
import { FeeConverter } from '../fees/build/FeeConverter_FeeConverter';
import { requireBasechain } from './guards';

// Fresh MARG deploy with the Gram platform fee: Router, FeeConverter (every platform fee ends up with
// TREASURY as Gram), Router treasury -> converter, then the launch factory (treasury/feeClaimer = converter,
// Low/Mid/High tiers on the 0.05% preset, tickSpacing 10). Optionally sets the converter's keeper.
// Usage: TREASURY=<wallet> [KEEPER=<addr>] LAUNCH_FEE=<gram> [DRY_RUN=1] npx blueprint run deployMargV3 --mainnet --mnemonic
export async function run(provider: NetworkProvider) {
    const admin = provider.sender().address!;
    const treasury = requireBasechain('TREASURY', process.env.TREASURY);
    const keeper = process.env.KEEPER ? Address.parse(process.env.KEEPER) : null;
    const launchFee = toNano(process.env.LAUNCH_FEE ?? '0.5');
    const lp = (mcap: string) => ({ $$type: 'LaunchParams' as const, startMcap: toNano(mcap), tickSpacing: 10n });
    const tiers = { $$type: 'LaunchTiers' as const, low: lp('2600'), mid: lp('10000'), high: lp('30000') };

    // The Router starts with the wallet as treasury (its address must not depend on the converter's),
    // and is pointed at the converter right after.
    const router = provider.open(await Router.fromInit(admin, treasury));
    const converter = provider.open(await FeeConverter.fromInit(treasury, router.address, admin));
    const factory = provider.open(await LaunchFactory.fromInit(admin, converter.address, router.address, launchFee, tiers));

    console.log('Admin     ', admin.toString());
    console.log('Treasury  ', treasury.toString(), '(receives only Gram)');
    console.log('Router    ', router.address.toString());
    console.log('Converter ', converter.address.toString());
    console.log('Factory   ', factory.address.toString(), `(launch fee ${process.env.LAUNCH_FEE ?? '0.5'} Gram, tiers 2.6K/10K/30K on spacing 10)`);
    console.log('Keeper    ', keeper ? keeper.toString() : '(not set: only the admin converts)');
    if (process.env.DRY_RUN) return;

    if (!(await provider.isContractDeployed(router.address))) {
        await router.send(provider.sender(), { value: toNano('1') }, null);
        await provider.waitForDeploy(router.address);
    }
    console.log('Router deployed');
    if (!(await provider.isContractDeployed(converter.address))) {
        await converter.send(provider.sender(), { value: toNano('0.1') }, null);
        await provider.waitForDeploy(converter.address);
    }
    console.log('Converter deployed');
    const rd = await router.getGetRouterData();
    if (!rd.treasury.equals(converter.address)) {
        await router.send(provider.sender(), { value: toNano('0.05') }, { $$type: 'SetTreasury', queryId: 0n, treasury: converter.address });
        for (let i = 0; i < 20 && !(await router.getGetRouterData()).treasury.equals(converter.address); i++) await sleep(3000);
    }
    console.log('Router treasury = converter:', (await router.getGetRouterData()).treasury.equals(converter.address));
    if (keeper) {
        await converter.send(provider.sender(), { value: toNano('0.05') }, { $$type: 'SetKeeper', queryId: 0n, keeper });
        await sleep(8000);
    }
    if (!(await provider.isContractDeployed(factory.address))) {
        await factory.send(provider.sender(), { value: toNano('0.5') }, null);
        await provider.waitForDeploy(factory.address);
    }
    console.log('Factory deployed');
}

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Set ${name}`);
    return v;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
