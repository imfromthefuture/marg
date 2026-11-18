import { Address, Cell, contractAddress, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Router } from '../dex/v2/build/Router_Router';
import { Pool } from '../dex/v2/build/Router_Pool';
import { LaunchFactory } from '../launch/build/Launch_LaunchFactory';
import { FeeConverter } from '../fees/build/FeeConverter_FeeConverter';
import { requireBasechain } from './guards';
import { Assembler } from '../tools/assembler/build/Assembler_Assembler';
import { bocSize, plan, PIECE_LIMIT } from './assembler';

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
    // Every launch master derives its own pool address from the Pool code (audit L-4).
    const zero = new Address(0, Buffer.alloc(32));
    const poolCode = (await Pool.fromInit(zero, { $$type: 'PoolKey', token0: zero, token1: zero, tickSpacing: 1n, ext: null })).init!.code;
    const factory = provider.open(await LaunchFactory.fromInit(admin, converter.address, router.address, launchFee, tiers,
        BigInt('0x' + poolCode.hash().toString('hex')), BigInt(poolCode.depth())));

    console.log('Admin     ', admin.toString());
    console.log('Treasury  ', treasury.toString(), '(receives only Gram)');
    console.log('Router    ', router.address.toString());
    console.log('Converter ', converter.address.toString());
    console.log('Factory   ', factory.address.toString(), `(launch fee ${process.env.LAUNCH_FEE ?? '0.5'} Gram, tiers 2.6K/10K/30K on spacing 10)`);
    console.log('Keeper    ', keeper ? keeper.toString() : '(not set: only the admin converts)');
    if (process.env.DRY_RUN) return;

    if (!(await provider.isContractDeployed(router.address))) {
        if (bocSize(router.init!.code) <= PIECE_LIMIT) {
            await router.send(provider.sender(), { value: toNano('1') }, null);
        } else {
            // Too large for one external message: upload it through the Assembler helper.
            await deployViaAssembler(provider, router.init!.code, router.init!.data, router.address);
        }
        await provider.waitForDeploy(router.address, 40);
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

async function deployViaAssembler(provider: NetworkProvider, code: Cell, data: Cell, expected: Address) {
    if (!contractAddress(0, { code, data }).equals(expected)) throw new Error('StateInit mismatch');
    const me = provider.sender().address!;
    const asm = provider.open(await Assembler.fromInit(me, 1n));
    console.log('Assembler ', asm.address.toString());
    if (!(await provider.isContractDeployed(asm.address))) {
        await asm.send(provider.sender(), { value: toNano('0.1') }, null);
        await provider.waitForDeploy(asm.address, 40);
    }
    const hashOf = (c: Cell) => BigInt('0x' + c.hash().toString('hex'));
    const waitSlot = async (slot: number, h: bigint) => {
        for (let i = 0; i < 40; i++) {
            if ((await asm.getGetSlotHash(BigInt(slot))) === h) return;
            await sleep(3000);
        }
        throw new Error(`slot ${slot} not filled`);
    };
    const { steps, root } = plan(code);
    for (const st of steps) {
        const h = hashOf(st.cell);
        if ((await asm.getGetSlotHash(BigInt(st.slot))) === h) { console.log(`  slot ${st.slot} already set`); continue; }
        const body = st.kind === 'put'
            ? { $$type: 'Put' as const, slot: BigInt(st.slot), cell: st.cell }
            : { $$type: 'Join' as const, slot: BigInt(st.slot), bits: st.bits, n: BigInt(st.refs.length),
                r0: BigInt(st.refs[0] ?? 0), r1: BigInt(st.refs[1] ?? 0), r2: BigInt(st.refs[2] ?? 0), r3: BigInt(st.refs[3] ?? 0) };
        await asm.send(provider.sender(), { value: toNano('0.05') }, body);
        await waitSlot(st.slot, h);
        console.log(`  slot ${st.slot} ${st.kind} ok (${bocSize(st.cell)} bytes)`);
    }
    if ((await asm.getGetSlotHash(BigInt(root))) !== hashOf(code)) throw new Error('assembled code hash mismatch');
    await asm.send(provider.sender(), { value: toNano('1.5') }, { $$type: 'Launch', codeSlot: BigInt(root), data, value: toNano('1') });
    for (let i = 0; i < 40 && !(await provider.isContractDeployed(expected)); i++) await sleep(3000);
    await asm.send(provider.sender(), { value: toNano('0.02') }, { $$type: 'Close' });
}

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Set ${name}`);
    return v;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
