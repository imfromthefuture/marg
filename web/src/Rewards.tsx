import { useEffect, useState } from 'react';
import { Address, beginCell, toNano } from '@ton/core';
import { useTonAddress, useTonConnectUI } from '@tonconnect/ui-react';
import { LaunchJetton, storeHarvest, type BuybackStatus, type RewardsData } from '../../launch/build/Launch_LaunchJetton';
import { LaunchWallet, storeClaimRewards } from '../../launch/build/Launch_LaunchWallet';
import { client, fmtTokens, fmtTon, q, walletTopUp } from './ton';
import type { LaunchInfo } from './dex';

// Covers get_reward_values().claim (gas-priced, ~0.01 Gram today); the unused part comes back with the rewards.
const CLAIM_ATTACH = toNano('0.06');

// Holder rewards and buyback & burn of a taxed launch token (both live in the token master).
// poolTax: tax waiting in the pool (PoolState.taxFees); a keeper collects it, anyone can too.
export function RewardsCard({ master, info, symbol, poolTax }: { master: Address; info: LaunchInfo; symbol: string; poolTax?: bigint }) {
    const [tonConnect] = useTonConnectUI();
    const owner = useTonAddress(false);
    const [rewards, setRewards] = useState<RewardsData | null>(null);
    const [buyback, setBuyback] = useState<BuybackStatus | null>(null);
    const [mine, setMine] = useState<{ wallet: Address; pending: bigint; busy: boolean } | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    // Caller-paid Harvest value (null on masters deployed before Harvest could be caller-paid).
    const [harvestValue, setHarvestValue] = useState<bigint | null>(null);

    const hasRewards = info.rewardsBps > 0n;
    const hasBuyback = info.buybackBps > 0n;

    async function load() {
        const m = client.open(LaunchJetton.fromAddress(master));
        setHarvestValue(await q(() => m.getGetHarvestValue()).catch(() => null));
        if (hasRewards) setRewards(await q(() => m.getGetRewardsData()).catch(() => null));
        if (hasBuyback) setBuyback(await q(() => m.getGetBuybackStatus()).catch(() => null));
        if (!hasRewards || !owner) return setMine(null);
        try {
            const wallet = await q(() => m.getGetWalletAddress(Address.parse(owner)));
            const st = await q(() => client.getContractState(wallet));
            if (st.state !== 'active') return setMine({ wallet, pending: 0n, busy: false });
            const rs = await q(() => client.open(LaunchWallet.fromAddress(wallet)).getGetRewardState());
            const pending = await q(() => m.getGetPendingRewards(rs.acked, rs.lastAcc, rs.frac, rs.owed));
            setMine({ wallet, pending, busy: rs.inFlight !== 0n });
        } catch {
            setMine(null);
        }
    }
    useEffect(() => { load(); }, [master.toRawString(), owner]);

    async function claim() {
        if (!owner) return tonConnect.openModal();
        if (!mine) return;
        try {
            setStatus('Confirm in your wallet…');
            const body = beginCell().store(storeClaimRewards({ $$type: 'ClaimRewards', queryId: 0n })).endCell();
            const top = await walletTopUp(mine.wallet);    // a nearly empty wallet first gets 0.05 Gram (see ton.ts)
            await tonConnect.sendTransaction({
                validUntil: Math.floor(Date.now() / 1000) + 300,
                messages: [
                    ...(top ? [top] : []),
                    { address: mine.wallet.toString(), amount: CLAIM_ATTACH.toString(), payload: body.toBoc().toString('base64') },
                ],
            });
            setStatus('Claim sent. The Gram arrives in your wallet in a few seconds.');
            setTimeout(load, 15_000);
        } catch (e: any) {
            setStatus(e?.message?.includes('Reject') ? 'Cancelled in wallet' : `Error: ${e?.message ?? e}`);
        }
    }

    async function collect() {
        if (!owner) return tonConnect.openModal();
        if (harvestValue === null) return;
        try {
            setStatus('Confirm in your wallet…');
            const body = beginCell().store(storeHarvest({ $$type: 'Harvest', queryId: 0n })).endCell();
            await tonConnect.sendTransaction({
                validUntil: Math.floor(Date.now() / 1000) + 300,
                messages: [{ address: master.toString(), amount: harvestValue.toString(), payload: body.toBoc().toString('base64') }],
            });
            setStatus('Sent. The tax is paid out to holders, the wallet and the buyback in a few seconds.');
            setTimeout(load, 20_000);
        } catch (e: any) {
            setStatus(e?.message?.includes('Reject') ? 'Cancelled in wallet' : `Error: ${e?.message ?? e}`);
        }
    }

    const taxed = info.buyTaxBps + info.sellTaxBps > 0n;
    if (!taxed && !hasRewards && !hasBuyback) return null;
    return (
        <div className="card info-box">
            {taxed && poolTax !== undefined && (
                <div className="reward-claim" style={{ marginTop: 0, marginBottom: 14 }}>
                    <div>
                        <span className="hint small">Tax waiting in the pool</span>
                        <b className="mono">{fmtTon(poolTax, 4)} Gram</b>
                    </div>
                    {harvestValue !== null && (
                        <button className="button ghost" onClick={collect} disabled={!!owner && poolTax === 0n} title={`Costs ${fmtTon(harvestValue, 2)} Gram of gas`}>
                            Collect now
                        </button>
                    )}
                </div>
            )}
            {hasRewards && (
                <>
                    <div className="info-head">
                        <h3>Holder rewards</h3>
                        <span className="pill blue">{Number(info.rewardsBps) / 100}% of the tax</span>
                    </div>
                    <div className="row small"><span className="hint">Paid out to holders so far</span><b className="mono">{rewards ? `${fmtTon(rewards.accrued)} Gram` : '—'}</b></div>
                    <div className="row small"><span className="hint">Claimed</span><b className="mono">{rewards ? `${fmtTon(rewards.claimed)} Gram` : '—'}</b></div>
                    <div className="reward-claim">
                        <div>
                            <span className="hint small">Your rewards</span>
                            <b className="mono">{owner ? (mine ? `${fmtTon(mine.pending, 4)} Gram` : '—') : 'Connect wallet'}</b>
                        </div>
                        <button className="button primary" onClick={claim} disabled={!!owner && (!mine || mine.pending === 0n || mine.busy)}>
                            {!owner ? 'Connect wallet' : mine?.busy ? 'Syncing…' : 'Claim'}
                        </button>
                    </div>
                    {status && <div className="status">{status}</div>}
                    <p>Every holder earns Gram from the tax in proportion to how many {symbol} they hold. The pool's own liquidity doesn't earn rewards.</p>
                </>
            )}
            {hasBuyback && (
                <>
                    <div className="info-head" style={{ marginTop: hasRewards ? 16 : 0 }}>
                        <h3>Buyback &amp; burn</h3>
                        <span className="pill">{Number(info.buybackBps) / 100}% of the tax</span>
                    </div>
                    <div className="row small"><span className="hint">Burned so far</span><b className="mono">{buyback ? `${fmtTokens(buyback.burned)} ${symbol}` : '—'}</b></div>
                    <div className="row small"><span className="hint">Gram spent on buybacks</span><b className="mono">{buyback ? fmtTon(buyback.spent) : '—'}</b></div>
                    <div className="row small"><span className="hint">Waiting for the next buyback</span><b className="mono">{buyback ? `${fmtTon(buyback.balance)} Gram` : '—'}</b></div>
                    <p>Runs each time tax is paid out (a MARG keeper collects it regularly; anyone can with “Collect now”): buys {symbol} on its pool and burns it, at most {buyback ? fmtTon(buyback.cap, 0) : '—'} Gram every 5 minutes.</p>
                </>
            )}
        </div>
    );
}
