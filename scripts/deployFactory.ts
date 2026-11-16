import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Factory } from '../build/Factory_Factory';
import { BURN_ADDRESS, defaultTiers, dexConfig } from './params';

// Usage: ROUTER=<STON.fi v2 router> PTON_WALLET=<router's pTON wallet> TREASURY=<addr> npx blueprint run deployFactory
export async function run(provider: NetworkProvider) {
    const admin = provider.sender().address!;
    const treasury = process.env.TREASURY ? Address.parse(process.env.TREASURY) : admin;
    const router = Address.parse(required('ROUTER'));
    const ptonWallet = Address.parse(required('PTON_WALLET'));

    const factory = provider.open(
        await Factory.fromInit(admin, treasury, ...defaultTiers(), dexConfig(router, ptonWallet, BURN_ADDRESS), 0n),
    );
    await factory.send(provider.sender(), { value: toNano('0.5') }, null);
    await provider.waitForDeploy(factory.address);
    console.log('Factory deployed at', factory.address.toString());
}

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Set ${name}`);
    return v;
}
