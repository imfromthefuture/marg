import { Address, beginCell, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Router } from '../dex/v2/build/Router_Router';
import { LaunchFactory } from '../launch/build/Launch_LaunchFactory';
import { FeeConverter } from '../fees/build/FeeConverter_FeeConverter';
import { requireBasechain } from './guards';

// Step 1 of the two-step admin handover for the Router, the launch factory and the fee converter:
// the current admin nominates NEW_ADMIN (pendingAdmin). Nothing changes until NEW_ADMIN sends the
// matching Claim message from its own wallet (links printed at the end). Until then the current
// admin stays admin and can cancel by nominating itself.
// Usage: ROUTER=<a> FACTORY=<a> CONVERTER=<a> NEW_ADMIN=<wallet> npx blueprint run transferAdmin --mainnet --mnemonic
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(provider: NetworkProvider) {
    const newAdmin = requireBasechain('NEW_ADMIN', process.env.NEW_ADMIN);
    const router = provider.open(Router.fromAddress(Address.parse(process.env.ROUTER!)));
    const factory = provider.open(LaunchFactory.fromAddress(Address.parse(process.env.FACTORY!)));
    const converter = provider.open(FeeConverter.fromAddress(Address.parse(process.env.CONVERTER!)));
    const me = provider.sender().address!;
    const fmt = (a: Address | null) => (a ? a.toString({ bounceable: false }) : '-');

    const items = [
        { name: 'Router', c: router, data: () => router.getGetRouterData(), send: () => router.send(provider.sender(), { value: toNano('0.05') }, { $$type: 'TransferAdmin', queryId: 0n, newAdmin }), claimOp: 0x4d480018 },
        { name: 'Factory', c: factory, data: () => factory.getGetFactoryData(), send: () => factory.send(provider.sender(), { value: toNano('0.05') }, { $$type: 'TransferAdmin', queryId: 0n, newAdmin }), claimOp: 0x4d4c0014 },
        { name: 'Converter', c: converter, data: () => converter.getGetConverterData(), send: () => converter.send(provider.sender(), { value: toNano('0.05') }, { $$type: 'TransferConverterAdmin', queryId: 0n, newAdmin }), claimOp: 0x4d460008 },
    ];

    for (const it of items) {
        const d: any = await it.data();
        console.log(`${it.name}: admin ${fmt(d.admin)} pending ${fmt(d.pendingAdmin)}`);
        if (d.admin.equals(newAdmin)) { console.log('  already admin'); continue; }
        if (d.pendingAdmin && d.pendingAdmin.equals(newAdmin)) { console.log('  already pending'); continue; }
        if (!d.admin.equals(me)) throw new Error(`${it.name}: sender is not admin`);
        await it.send();
        for (let i = 0; i < 30; i++) {
            await sleep(3000);
            const n: any = await it.data();
            if (n.pendingAdmin && n.pendingAdmin.equals(newAdmin)) { console.log('  pending set'); break; }
        }
        await sleep(2000);
    }

    console.log('\nClaim links (sign each with NEW_ADMIN):');
    for (const it of items) {
        const bin = beginCell().storeUint(it.claimOp, 32).storeUint(0, 64).endCell().toBoc().toString('base64url');
        console.log(`${it.name}: https://app.tonkeeper.com/transfer/${it.c.address.toString()}?amount=50000000&bin=${bin}`);
    }
}
