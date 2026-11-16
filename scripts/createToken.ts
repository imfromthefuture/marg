import { Address, beginCell, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Factory } from '../build/Factory_Factory';

// Usage: FACTORY=<addr> METADATA_URL=<https://…/meta.json> TIER=0|1|2 DEV_BUY=10 npx blueprint run createToken
export async function run(provider: NetworkProvider) {
    const factory = provider.open(Factory.fromAddress(Address.parse(process.env.FACTORY!)));
    const url = process.env.METADATA_URL!;
    const initialBuy = toNano(process.env.DEV_BUY ?? '0');
    const launchFee = await factory.getLaunchFee();

    // TEP-64 off-chain content: 0x01 prefix + URL
    const content = beginCell().storeUint(1, 8).storeStringTail(url).endCell();
    const index = await factory.getNextIndex();
    await factory.send(provider.sender(), { value: toNano('0.3') + launchFee + initialBuy },
        { $$type: 'CreateToken', queryId: 0n, content, tier: BigInt(process.env.TIER ?? '1'), initialBuy });
    console.log('Token master:', (await factory.getTokenAddress(index)).toString());
}
