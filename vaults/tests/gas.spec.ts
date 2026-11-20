// Gas of every vault handler (compute phase, sandbox) and what users / keepers really pay.
// DEX convention (dex/v2 DESIGN §10): the value that pays for a handler must be >= 1.5x its cost at
// 400 nanoGram/gas (mainnet basechain price). PRINT_GAS=1 prints the table.

import { SendMessageResult } from '@ton/sandbox';
import { Address, beginCell, toNano } from '@ton/core';
import { stepParallel, VaultFx, GRAM_1, USDT, DEPOSIT_GAS, WITHDRAW_GAS, REBALANCE_GAS, RECOVERY_DELAY, DEP_TIMEOUT, OPD, expectNoFailures, computeGas, gramPaidTo } from './fixture';
import { gramPayouts, REASON, msg, drain } from '../../dex/v2/tests/helpers';
import { storeJettonBurn } from '../build/Vault_VaultWallet';
import { storeBurnReceipt, storeDepositNative } from '../build/Vault_Vault';

const NANO_PER_GAS = 400n;
const rows: { flow: string; vaultGas: string; atMainnet: string; budget: string; note: string }[] = [];
const fmt = (n: bigint) => (Number(n) / 1e9).toFixed(4);
const max = (xs: bigint[]) => xs.reduce((a, b) => (a > b ? a : b), 0n);

function vaultTxs(res: SendMessageResult, vault: Address) {
    return res.transactions.filter((tx) => tx.inMessage?.info.dest instanceof Address && tx.inMessage.info.dest.equals(vault));
}

function maxGas(res: SendMessageResult, vault: Address) {
    let m = 0n;
    for (const tx of vaultTxs(res, vault)) {
        const cp: any = (tx.description as any).computePhase;
        if (cp?.type === 'vm' && cp.gasUsed > m) m = cp.gasUsed;
    }
    return m;
}

function row(flow: string, gas: bigint, budget: bigint, note = '') {
    rows.push({ flow, vaultGas: gas.toString(), atMainnet: fmt(gas * NANO_PER_GAS), budget: fmt(budget), note });
    expect(gas * NANO_PER_GAS * 3n).toBeLessThanOrEqual(budget * 2n);     // budget >= 1.5x cost
}

describe('gas', () => {
    afterAll(() => {
        if (process.env.PRINT_GAS) {
            // eslint-disable-next-line no-console
            console.table(rows);
        }
    });

    it('measures every flow', async () => {
        const f = await VaultFx.create();
        // a swap by someone else costs the vault nothing (no hook)
        const sw = await f.swapGram(f.carol, 3n * GRAM_1);
        expectNoFailures(sw);
        expect(vaultTxs(sw, f.vault.address).length).toBe(0);
        rows.push({ flow: 'Swap by someone else', vaultGas: '0', atMainnet: '0', budget: '-', note: 'no hook: the vault is not involved' });

        await f.wait(3700);
        const dg = await f.depositGram(f.alice, 10n * GRAM_1);
        expectNoFailures(dg);
        row('Deposit Gram: entry (vault)', computeGas(dg, f.vault.address, 0x56410004)[0], DEPOSIT_GAS);
        row('Deposit: observation reply -> shares (vault)', max(computeGas(dg, f.vault.address, OPD.PoolObservation)), DEPOSIT_GAS, 'accepted; paid from the deposit gas');
        const du = await f.depositUsdt(f.bob, 30n * USDT);
        expectNoFailures(du);
        row('Deposit USDT: entry (vault)', computeGas(du, f.vault.address, 0x7362d09c)[0], DEPOSIT_GAS);
        const db = await f.depositUsdt(f.carol, 30n * USDT, 10n * GRAM_1);
        expectNoFailures(db);
        row('Deposit Gram+USDT: entry (vault)', computeGas(db, f.vault.address, 0x7362d09c)[0], DEPOSIT_GAS);
        const depCost = (await f.gram(f.carol.address));
        void depCost;

        // withdrawal: every vault tx of the flow, and the user's net Gram cost
        const s = await f.shares(f.bob.address);
        const gb = await f.gram(f.bob.address);
        const wd = await f.withdraw(f.bob, s);
        expectNoFailures(wd);
        const got = gramPaidTo(wd, f.bob.address, 1);
        const userCost = gb - (await f.gram(f.bob.address)) + got;
        row('Withdraw: burn notification (vault)', computeGas(wd, f.vault.address, 0x7bdd97de)[0], WITHDRAW_GAS);
        row('Withdraw: BurnReceipt (vault, max)', max(computeGas(wd, f.vault.address, OPD.BurnReceipt)), toNano('0.32'), 'accepted after the Position check; op budget');
        row('Withdraw: USDT arrival -> forwarded to the user (vault, max)', max(computeGas(wd, f.vault.address, 0x7362d09c)), toNano('0.07'), 'accepted; compute part of USER_PAY_GAS (0.16 - 0.08 transfer - fees), held by the op');
        row('Withdraw: max vault tx', maxGas(wd, f.vault.address), toNano('0.32'), `${vaultTxs(wd, f.vault.address).length} vault txs; user net cost ${fmt(userCost)} Gram`);
        expect(userCost).toBeLessThan(toNano('0.7'));

        // rebalance
        await f.moveTo((await f.poolState()).tick - 700n);
        await f.warm(4000);
        const kb = await f.gram(f.keeper.address);
        const free = async () => {
            const v = await f.data();
            return (await f.gram(f.vault.address)) - v.idle0 - v.fee0 - v.heldGas;
        };
        const freeBefore = await free();
        const rb = await f.rebalance();
        expectNoFailures(rb);
        const keeperCost = kb - (await f.gram(f.keeper.address));
        row('Rebalance: start (vault)', computeGas(rb, f.vault.address, 0x56410005)[0], toNano('0.3'));
        row('Rebalance: observation -> closes (vault)', max(computeGas(rb, f.vault.address, OPD.PoolObservation)), toNano('0.3'), 'accepted; keeper budget');
        row('Rebalance: last arrival -> mints (vault, max notification)', max(computeGas(rb, f.vault.address, 0x7362d09c)), toNano('0.3'), 'accepted; keeper budget');
        row('MintReceipt (vault, max)', max(computeGas(rb, f.vault.address, OPD.MintReceipt)), toNano('0.3'), 'accepted after the pool check');
        row('GramPayout (vault, max)', max(computeGas(rb, f.vault.address, OPD.GramPayout)), toNano('0.3'));
        row('Rebalance: max vault tx', maxGas(rb, f.vault.address), toNano('0.3'),
            `${rb.transactions.length} txs total; keeper net cost ${fmt(keeperCost)} Gram (DEX tick fees included)`);
        expect(keeperCost).toBeLessThan(toNano('1.5'));
        // The vault's own gas buffer must not pay for rebalances.
        const freeAfter = await free();
        rows.push({ flow: 'Vault free buffer change over a rebalance', vaultGas: '-', atMainnet: fmt(freeAfter - freeBefore), budget: '-', note: 'must be >= 0 (sandbox gas price)' });
        expect(freeAfter).toBeGreaterThanOrEqual(freeBefore);

        // Pre-accept cost of a BurnReceipt: a forged receipt with a LIVE op's queryId from a
        // non-Position sender runs cold load + op lookup + address check, then stops. It must fit the
        // smallest real receipt value (the Position's excess).
        const minReceipt = (res: SendMessageResult) => vaultTxs(res, f.vault.address)
            .filter((tx) => tx.inMessage!.body.beginParse().preloadUint(32) === OPD.BurnReceipt)
            .map((tx) => (tx.inMessage!.info.type === 'internal' ? tx.inMessage!.info.value.coins : 0n));
        const smallest = [...minReceipt(rb), ...minReceipt(wd)].reduce((a, b) => (a < b ? a : b), 10n ** 18n);
        const ws = await f.shares(f.alice.address);
        const wal = await f.shareWallet(f.alice.address);
        const burn = beginCell().store(storeJettonBurn({ $$type: 'JettonBurn', queryId: 1n, amount: ws / 2n, responseDestination: null, customPayload: null })).endCell();
        const { it } = await stepParallel(f.chain, msg(f.alice.address, wal.address, WITHDRAW_GAS + toNano('0.1'), burn), 2);
        const opsNow = await f.vault.getGetOps();
        const k0 = opsNow.keys()[0];
        const live: [bigint, any] = [k0, opsNow.get(k0)!];
        const forgedBody = beginCell().store(storeBurnReceipt({
            $$type: 'BurnReceipt', queryId: live[0], index: live[1].index, ok: true, code: 0n, liquidityDelta: 0n, liquidity: 0n,
            amount0: 0n, amount1: 0n, fees0: 0n, fees1: 0n, fgInside0: 0n, fgInside1: 0n,
        })).endCell();
        const forged = await f.mallory.send({ to: f.vault.address, value: toNano('0.1'), body: forgedBody });
        const pre = computeGas(forged, f.vault.address)[0];
        await drain(it);
        rows.push({ flow: 'BurnReceipt: pre-accept path', vaultGas: pre.toString(), atMainnet: fmt(pre * NANO_PER_GAS),
            budget: fmt(smallest), note: 'smallest real receipt value seen (must be >= 1.5x)' });
        expect(pre * NANO_PER_GAS * 3n).toBeLessThanOrEqual(smallest * 2n);

        // A DEX-routed USDT arrival without an op (swap output sent to the vault) is accepted (real
        // USDT arrived; it is credited to the holders). Its cost to the free buffer vs the attacker's:
        const fb = await free();
        const don = await f.swapGram(f.mallory, GRAM_1, { receiver: f.vault.address, fwdTon: toNano('0.01') });
        expectNoFailures(don);
        const dg2 = computeGas(don, f.vault.address, 0x7362d09c)[0];
        rows.push({ flow: 'USDT arrival without op (accepted)', vaultGas: dg2.toString(), atMainnet: fmt(dg2 * NANO_PER_GAS),
            budget: '0.0100', note: `free buffer change ${fmt((await free()) - fb)} (sandbox); the sender pays a DEX swap` });

        // Poke and fee collection
        const pk = await f.poke();
        expectNoFailures(pk);
        row('Poke (vault)', computeGas(pk, f.vault.address, 0x56410007)[0], toNano('0.1'));
        const cf = await f.vault.send(f.alice.getSender(), { value: toNano('0.15') }, { $$type: 'CollectFees', queryId: 1n });
        expectNoFailures(cf);
        row('CollectFees (vault)', computeGas(cf, f.vault.address, 0x56410009)[0], toNano('0.15'));

        // Recover (audit M-1): a deposit whose observation is lost, then a user decrease that never
        // reached its Position (re-sync collect, retry, forward).
        const dn = beginCell().store(storeDepositNative({ $$type: 'DepositNative', queryId: 1n, amount: GRAM_1, minShares: 0n, receiver: null })).endCell();
        const d1 = await stepParallel(f.chain, msg(f.carol.address, f.vault.address, GRAM_1 + DEPOSIT_GAS + toNano('0.05'), dn), 1);
        void d1;
        await f.wait(DEP_TIMEOUT);
        const rc1 = await f.recover();
        expectNoFailures(rc1);
        row('Recover: stale deposit refunded (vault)', computeGas(rc1, f.vault.address, 0x56410011)[0], toNano('0.5'), 'paid by the caller');
        const s2 = await f.shares(f.admin.address);
        const wa = await f.shareWallet(f.admin.address);
        const burn2 = beginCell().store(storeJettonBurn({ $$type: 'JettonBurn', queryId: 2n, amount: s2 / 4n, responseDestination: null, customPayload: null })).endCell();
        const w2 = await stepParallel(f.chain, msg(f.admin.address, wa.address, WITHDRAW_GAS + toNano('0.1'), burn2), 0);
        for (let i = 0; i < 300; i++) {
            if ([...(await f.vault.getGetOps()).values()].some((o) => o.kind === 4n)) break;
            if ((await w2.it.next()).done) break;
        }
        await f.wait(RECOVERY_DELAY);
        const rc2 = await f.recover();
        expectNoFailures(rc2);
        row('Recover: lost decrease re-synced (vault)', computeGas(rc2, f.vault.address, 0x56410011)[0], toNano('0.5'),
            `${vaultTxs(rc2, f.vault.address).length} vault txs; max ${maxGas(rc2, f.vault.address)} gas`);
        row('Recover flow: max vault tx', maxGas(rc2, f.vault.address), toNano('0.32'));
        const v = await f.data();
        expect([v.workerActive, v.opCount]).toEqual([false, 0n]);
    }, 300000);
});
