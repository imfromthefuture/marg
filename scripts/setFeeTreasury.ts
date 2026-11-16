import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { FeeConverter } from '../fees/build/FeeConverter_FeeConverter';

// Points the FeeConverter at a new treasury wallet (admin only). The attached 0.05 is forwarded to
// the treasury like any other Gram.
// Usage: CONVERTER=<addr> TREASURY=<wallet> npx blueprint run setFeeTreasury --mainnet --mnemonic
export async function run(provider: NetworkProvider) {
    const converter = provider.open(FeeConverter.fromAddress(Address.parse(process.env.CONVERTER!)));
    const treasury = Address.parse(process.env.TREASURY!);
    const before = await converter.getGetConverterData();
    const sender = provider.sender().address!;
    console.log('Converter     ', converter.address.toString());
    console.log('Admin         ', before.admin.toString({ bounceable: false }));
    console.log('Sender        ', sender.toString({ bounceable: false }));
    console.log('Treasury now  ', before.treasury.toString({ bounceable: false }));
    console.log('Treasury new  ', treasury.toString({ bounceable: false }));
    if (!before.admin.equals(sender)) throw new Error('Sender is not the converter admin');
    if (before.treasury.equals(treasury)) return console.log('Already set.');
    await converter.send(provider.sender(), { value: toNano('0.05') }, { $$type: 'SetFeeTreasury', queryId: 0n, treasury });
    for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const after = await converter.getGetConverterData();
        if (after.treasury.equals(treasury)) return console.log('Done. Treasury is now', after.treasury.toString({ bounceable: false }));
    }
    console.log('Sent, but not confirmed yet. Check again in a minute.');
}
