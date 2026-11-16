// Fee-on-transfer (FoT) jettons. The Router credits the amount its wallet NOTIFIES and assumes a
// payout of X costs its wallet exactly X. That is what TON jettons do, and it stays exact for a
// FoT jetton whose wallet notifies the amount it really credited ("honest"): the deposit
// is counted net of the fee, and outgoing fees only reduce what the receiver gets. A wallet that
// notifies MORE than it credited lies about its balance. The Router cannot detect that (it
// cannot read wallet balances synchronously), so such a token is unsupported, like any fake
// jetton. The damage stays inside that token's Router wallet: other tokens' pools are unaffected,
// and the last withdrawals of that token bounce back to the Router (TRANSFER_BOUNCED).
// This is the documented rule; nothing in the contracts refuses FoT jettons.

import { Address, toNano } from '@ton/core';
import { SandboxContract } from '@ton/sandbox';
import {
    Dex, GRAM, Q96, CODES, Pool, expectNoFailures, refundCodes, modifyEvents, txOk,
} from './helpers';
import { FotJettonMaster } from '../build/FotJetton_FotJettonMaster';

jest.setTimeout(600000);

describe('fee-on-transfer jettons', () => {
    let d: Dex;

    async function fot(honest: boolean) {
        const m = d.chain.openContract(await FotJettonMaster.fromInit(d.admin.address, 100n, honest)); // 1% per transfer
        for (const who of [d.alice, d.bob]) {
            const res = await m.send(d.admin.getSender(), { value: toNano('0.3') }, {
                $$type: 'TestMint', queryId: 0n, to: who.address, amount: toNano('10000000'),
                responseDestination: d.admin.address, forwardTonAmount: 0n, forwardPayload: null,
            });
            expectNoFailures(res);
        }
        const token = await m.getGetWalletAddress(d.router.address);
        return { m: m as any, token };
    }

    async function owedOf(pool: SandboxContract<Pool>) {
        const s = await pool.getGetPoolState();
        return s.reserve1 + s.protocolFees1 + s.hookFees1;
    }

    beforeAll(async () => {
        d = await Dex.create();
    });

    it('honest FoT (notifies what it credited): every operation stays exactly backed; full exit leaves no deficit', async () => {
        const { m, token } = await fot(true);
        const pool = await d.poolOf(GRAM, token, 60n, null);
        const dep = toNano('1000000');
        let res = await d.mintJetton(m, d.alice, dep, GRAM, 60000n, 76200n, toNano('1000'), { sqrtPriceInit: Q96 * 30n });
        expectNoFailures(res);
        // The pool counts the deposit net of the 1% fee: that is all the Router's wallet received.
        const ev = modifyEvents(res)[0];
        expect(ev.amount1).toBeLessThanOrEqual((dep * 99n) / 100n);
        expect(await d.routerHolds(token)).toBe(await owedOf(pool));
        for (let i = 0; i < 6; i++) {
            res = i % 2 === 0
                ? await d.swapNative(d.bob, toNano('7'), token)
                : await d.swapJetton(m, d.bob, toNano('5000'), GRAM);
            expectNoFailures(res);
            expect(refundCodes(res)).toEqual([]);
            expect(await d.routerHolds(token)).toBe(await owedOf(pool));
        }
        // Everyone exits: the LP withdraws everything, the treasury collects protocol fees.
        const pos = await d.position(pool, 0n);
        const pd = await pos.getGetPositionData();
        res = await d.decrease(pos, d.alice, pd.liquidity);
        expectNoFailures(res);
        const st = await pool.getGetPoolState();
        res = await d.router.send(d.bob.getSender(), { value: toNano('0.3') }, {
            $$type: 'CollectProtocolFees', queryId: 0n,
            key: { $$type: 'PoolKey', token0: st.key.token0, token1: st.key.token1, tickSpacing: st.key.tickSpacing, ext: st.key.ext },
        });
        expectNoFailures(res);
        expect(await owedOf(pool)).toBeLessThan(1000n);
        expect(await d.routerHolds(token)).toBe(await owedOf(pool));
        await d.checkSolvency([pool]);
    });

    it('lying FoT (notifies the gross amount): the deficit is confined to that token; other pools stay solvent', async () => {
        const { m, token } = await fot(false);
        const pool = await d.poolOf(GRAM, token, 60n, null);
        // A healthy pool of another token next to it.
        const other = await d.poolOf(GRAM, d.tokA, 60n, null);
        expectNoFailures(await d.mintJetton(d.jA, d.alice, toNano('1000000'), GRAM, 60000n, 76200n, toNano('1000'), { sqrtPriceInit: Q96 * 30n }));
        const dep = toNano('1000000');
        let res = await d.mintJetton(m, d.alice, dep, GRAM, 60000n, 76200n, toNano('1000'), { sqrtPriceInit: Q96 * 30n });
        expectNoFailures(res);
        // Booked 1,000,000 but only 990,000 arrived: this token's Router wallet is short.
        const short = (await owedOf(pool)) - (await d.routerHolds(token));
        expect(short).toBeGreaterThanOrEqual(dep / 100n - toNano('1'));
        // Trading still works (the shortfall only bites at the very end)...
        expectNoFailures(await d.swapNative(d.bob, toNano('7'), token));
        expectNoFailures(await d.swapNative(d.bob, toNano('7'), d.tokA));
        // ...and the last full withdrawal cannot be paid: the Router's transfer bounces and is
        // reported (TRANSFER_BOUNCED). The pool's own books are unchanged by the bounce.
        const pos = await d.position(pool, 0n);
        const pd = await pos.getGetPositionData();
        res = await d.decrease(pos, d.alice, pd.liquidity);
        const failed = res.transactions.filter((tx) => !txOk(tx));
        expect(failed.length).toBe(1);
        expect((failed[0].inMessage!.info.dest as Address).equals(token)).toBe(true);
        expect(refundCodes(res)).toEqual([CODES.TRANSFER_BOUNCED]);
        // Every other token is unaffected.
        await d.checkSolvency([other]);
        expect(await d.routerHolds(d.tokA)).toBe(await owedOf(other));
    });
});
