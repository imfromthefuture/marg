import { Address, beginCell, toNano } from '@ton/core';
import { SendMessageResult } from '@ton/sandbox';
import {
    BURN_POOL_GAS, COLLECT_GAS, Dex, expectNoFailures, GRAM, JETTON_PAYOUT_VALUE, LP_ACCOUNT_MIN_STORAGE,
    LP_ACCOUNT_REFUND_GAS, POOL_MIN_STORAGE, PROVIDE_BOTH_GAS, PROVIDE_GAS, SWAP_GAS,
} from './helpers';

// Measures what each flow really costs (fees of every DEX-side transaction plus the forward
// fees it pays, plus any storage buffer it leaves behind) and checks that the gas constants
// keep at least the 1.5x margin DESIGN.md asks for. Prints a table for tuning.

const MARGIN_NUM = 3n;   // cost * 1.5 <= constant  <=>  cost * 3 <= constant * 2
const MARGIN_DEN = 2n;

function cost(res: SendMessageResult, skip: Address[]) {
    let total = 0n;
    for (const tx of res.transactions) {
        const dest = tx.inMessage?.info.dest;
        if (dest instanceof Address && skip.some((s) => s.equals(dest))) continue;
        total += tx.totalFees.coins;
        for (const m of tx.outMessages.values()) if (m.info.type === 'internal') total += m.info.forwardFee;
    }
    return total;
}

describe('gas margins', () => {
    const rows: { flow: string; cost: string; constant: string; ratio: string }[] = [];
    afterAll(() => {
        // eslint-disable-next-line no-console
        console.table(rows);
    });

    function check(flow: string, c: bigint, constant: bigint) {
        rows.push({ flow, cost: (Number(c) / 1e9).toFixed(5), constant: (Number(constant) / 1e9).toFixed(3), ratio: (Number(constant) / Number(c)).toFixed(1) + 'x' });
        expect(c * MARGIN_NUM).toBeLessThanOrEqual(constant * MARGIN_DEN);
    }

    it('swaps, deposits, burns, collection and refunds stay well inside their constants', async () => {
        const d = await Dex.create();
        const native = await d.seedNative(d.jA, toNano('1000'), toNano('5000000'));
        const jj = await d.seedJJ(d.jA, toNano('1000000'), d.jB, toNano('4000000'));
        const big = beginCell().storeUint(1, 32).storeRef(beginCell().storeBuffer(Buffer.alloc(120, 7)).endCell()).endCell();
        const users = [d.alice.address, d.bob.address, d.carol.address];
        const wallets = async (m: any) => Promise.all(users.map((u) => m.getGetWalletAddress(u))) as Promise<Address[]>;
        const userSide = [...users, ...(await wallets(d.jA)), ...(await wallets(d.jB)), ...(await wallets(d.jC)), d.treasury.address];

        let res = await d.swapNative(d.bob, toNano('10'), d.tokA, { referral: d.carol.address, refBps: 10n, fwdTon: toNano('0.01'), fwdPayload: big, receiver: d.carol.address });
        expectNoFailures(res);
        check('swap Gram->jetton, referral + fwdPayload', cost(res, userSide), SWAP_GAS);

        res = await d.swapJetton(d.jA, d.bob, toNano('1000'), GRAM, { referral: d.carol.address, refBps: 10n, fwdPayload: big });
        expectNoFailures(res);
        check('swap jetton->Gram, jetton referral', cost(res, userSide), SWAP_GAS + JETTON_PAYOUT_VALUE);

        res = await d.swapJetton(d.jA, d.bob, toNano('1000'), d.tokB, { referral: d.carol.address, refBps: 10n, fwdTon: toNano('0.01'), fwdPayload: big });
        expectNoFailures(res);
        check('swap jetton->jetton, referral + fwdPayload', cost(res, userSide), SWAP_GAS + JETTON_PAYOUT_VALUE);

        res = await d.swapNative(d.bob, toNano('1'), d.tokC);
        expectNoFailures(res);
        check('swap Gram into a missing pool (deploy + refund)', cost(res, userSide) + POOL_MIN_STORAGE, SWAP_GAS);

        res = await d.swapJetton(d.jC, d.bob, toNano('1'), d.tokB);
        expectNoFailures(res);
        check('swap jetton into a missing pool (deploy + refund)', cost(res, userSide) + POOL_MIN_STORAGE, SWAP_GAS);

        res = await d.provideJetton(d.jB, d.carol, toNano('100'), d.tokC);
        expectNoFailures(res);
        check('first side, new pool + LpAccount', cost(res, userSide) + POOL_MIN_STORAGE + LP_ACCOUNT_MIN_STORAGE, PROVIDE_GAS);

        expectNoFailures(await d.provideJetton(d.jA, d.carol, toNano('100'), d.tokB));
        res = await d.provideJetton(d.jB, d.carol, toNano('1000'), d.tokA);   // completes with ~600 B unused
        expectNoFailures(res);
        check('completing side, jetton/jetton, unused-side refund', cost(res, userSide), PROVIDE_GAS);

        res = await d.provideBoth(d.jA, d.carol, toNano('100000'), toNano('1'));
        expectNoFailures(res);
        check('dual deposit, unused-jetton refund', cost(res, userSide), PROVIDE_BOTH_GAS);

        res = await d.provideBoth(d.jC, d.carol, toNano('100000'), toNano('1'));
        expectNoFailures(res);
        check('dual deposit creating a pool (graduation)', cost(res, userSide) + POOL_MIN_STORAGE, PROVIDE_BOTH_GAS);

        const lp = await d.lpBal(jj, d.alice.address);
        res = await d.burnLp(jj, d.alice, lp / 3n);
        expectNoFailures(res);
        // The LpWallet hop is paid before the Pool's check: count only what follows it.
        const lw = (await d.lpWallet(jj, d.alice.address)).address;
        check('burn jetton/jetton (after the LP wallet)', cost(res, [...userSide, lw]), BURN_POOL_GAS);

        res = await d.burnLp(native, d.alice, (await d.lpBal(native, d.alice.address)) / 3n);
        expectNoFailures(res);
        check('burn native', cost(res, [...userSide, (await d.lpWallet(native, d.alice.address)).address]), BURN_POOL_GAS);

        res = await d.router.send(d.bob.getSender(), { value: COLLECT_GAS }, { $$type: 'CollectProtocolFees', queryId: 0n, tokenA: d.tokA, tokenB: d.tokB });
        expectNoFailures(res);
        check('collect jetton/jetton (two legs)', cost(res, userSide), COLLECT_GAS);

        expectNoFailures(await d.provideJetton(d.jB, d.bob, toNano('5'), d.tokC));
        const acc = await d.lpAccount(await d.poolOf(d.tokB, d.tokC), d.bob.address);
        res = await acc.send(d.bob.getSender(), { value: LP_ACCOUNT_REFUND_GAS }, { $$type: 'LpAccountRefund', queryId: 0n });
        expectNoFailures(res);
        check('LpAccountRefund (jetton)', cost(res, userSide), LP_ACCOUNT_REFUND_GAS);
    });
});
