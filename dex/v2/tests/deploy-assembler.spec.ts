import { Blockchain } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { Router } from '../build/Router_Router';
import { Assembler } from '../../../tools/assembler/build/Assembler_Assembler';
import { bocSize, plan } from '../../../scripts/assembler';
import '@ton/test-utils';

describe('deploy helper (Assembler): the v3 Router StateInit is too large for one external message', () => {
    it('rebuilds the exact Router code from pieces < 64 KB and deploys it at the expected address', async () => {
        const chain = await Blockchain.create();
        const admin = await chain.treasury('admin');
        const treasury = await chain.treasury('treasury');
        const router = chain.openContract(await Router.fromInit(admin.address, treasury.address));
        const init = router.init!;
        expect(bocSize(init.code)).toBeGreaterThan(65535);

        const asm = chain.openContract(await Assembler.fromInit(admin.address, 1n));
        await asm.send(admin.getSender(), { value: toNano('2') }, null);
        const { steps, root } = plan(init.code);
        for (const s of steps) {
            const body = s.kind === 'put'
                ? { $$type: 'Put' as const, slot: BigInt(s.slot), cell: s.cell }
                : { $$type: 'Join' as const, slot: BigInt(s.slot), bits: s.bits, n: BigInt(s.refs.length),
                    r0: BigInt(s.refs[0] ?? 0), r1: BigInt(s.refs[1] ?? 0), r2: BigInt(s.refs[2] ?? 0), r3: BigInt(s.refs[3] ?? 0) };
            if (s.kind === 'put') expect(bocSize(s.cell) + 1000).toBeLessThan(65535);
            const r = await asm.send(admin.getSender(), { value: toNano('0.3') }, body as any);
            expect(r.transactions).toHaveTransaction({ to: asm.address, success: true });
        }
        expect(await asm.getGetSlotHash(BigInt(root))).toBe(BigInt('0x' + init.code.hash().toString('hex')));
        // Nobody else can use it.
        const eve = await chain.treasury('eve');
        const bad = await asm.send(eve.getSender(), { value: toNano('0.1') }, { $$type: 'Launch', codeSlot: BigInt(root), data: init.data, value: toNano('1') });
        expect(bad.transactions).toHaveTransaction({ to: asm.address, success: false });

        const r = await asm.send(admin.getSender(), { value: toNano('1.5') }, { $$type: 'Launch', codeSlot: BigInt(root), data: init.data, value: toNano('1') });
        expect(r.transactions).toHaveTransaction({ from: asm.address, to: router.address, deploy: true, success: true });
        const d = await router.getGetRouterData();
        expect(d.admin.equals(admin.address)).toBe(true);
        expect(d.treasury.equals(treasury.address)).toBe(true);

        const c = await asm.send(admin.getSender(), { value: toNano('0.05') }, { $$type: 'Close' });
        expect(c.transactions).toHaveTransaction({ from: asm.address, to: admin.address });
        expect((await chain.getContract(asm.address)).accountState?.type).not.toBe('active');
    });
});
