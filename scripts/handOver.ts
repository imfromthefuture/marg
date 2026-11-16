import { Address, toNano } from '@ton/core';
import { NetworkProvider, sleep } from '@ton/blueprint';
import { Factory } from '../build/Factory_Factory';

// Points the treasury (platform fees for new tokens) at OWNER, then makes OWNER the admin.
// After this the deployer wallet has no rights left on the factory.
// Usage: FACTORY=<addr> OWNER=<addr> [ADMIN_ONLY=1] npx blueprint run handOver --mainnet --mnemonic
export async function run(provider: NetworkProvider) {
    const factory = provider.open(Factory.fromAddress(Address.parse(process.env.FACTORY!)));
    const owner = Address.parse(process.env.OWNER!);
    const me = provider.sender().address!;

    async function read<T>(fn: () => Promise<T>): Promise<T> {
        for (let i = 0; ; i++) {
            await sleep(1500);
            try {
                return await fn();
            } catch (e) {
                if (i > 8) throw e;
            }
        }
    }
    async function until(what: string, cond: () => Promise<boolean>) {
        for (let i = 0; i < 40; i++) {
            if (await read(cond).catch(() => false)) return console.log(`  ✓ ${what}`);
            await sleep(2000);
        }
        throw new Error(`timed out waiting for: ${what}`);
    }

    if (!(await read(() => factory.getAdmin())).equals(me)) throw new Error('This wallet is not the factory admin');
    // ADMIN_ONLY=1 resumes after the treasury step already landed.
    if (!process.env.ADMIN_ONLY) {
        console.log(`1. Treasury -> ${owner.toString({ bounceable: false })}`);
        await factory.send(provider.sender(), { value: toNano('0.05') }, { $$type: 'SetTreasury', treasury: owner });
        await sleep(15000); // no treasury getter: give it time to land before the admin changes
    }

    console.log(`2. Admin -> ${owner.toString({ bounceable: false })}`);
    await factory.send(provider.sender(), { value: toNano('0.05') }, { $$type: 'TransferAdmin', newAdmin: owner });
    await until('admin is the owner', async () => (await factory.getAdmin()).equals(owner));
}
