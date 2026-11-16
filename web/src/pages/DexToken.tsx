import { fmtUsd, useGramUsd } from '../usd';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Address } from '@ton/core';
import { DexPool, DexToken, feeParts, LaunchInfo, launchPool, loadPoolState, pct, presetOf, resolveToken, taxOf } from '../dex';
import { mcapNano, sqrtToPrice } from '../dexmath';
import { explorer, fmtCompact, fmtTokens, fmtTon, short } from '../ton';
import { ago, api, ApiToken, fmtPrice, Holders } from '../api';
import { shareUrl } from '../telegram';
import { PriceChart } from '../Chart';
import { SwapBox } from '../SwapBox';
import { Change, TokenImage } from './Home';
import { Activity, Stat } from './Activity';
import { RewardsCard } from '../Rewards';
import { VaultCard } from '../VaultCard';

// Token page of a direct launch (launch/): no curve, it trades in its Marg DEX launch pool from the
// first block. Price and market cap come from the pool's sqrtPriceX96.
export function DexTokenPage({ address }: { address: Address }) {
    const usd = useGramUsd();
    const [token, setToken] = useState<DexToken | null>(null);
    const [pool, setPool] = useState<DexPool | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [stats, setStats] = useState<ApiToken | null>(null);
    const [holders, setHolders] = useState<Holders | null>(null);
    const [copied, setCopied] = useState(false);
    const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

    useEffect(() => {
        let alive = true;
        resolveToken(address)
            .then(async (t) => {
                if (!alive) return;
                setToken(t);
                // Retried: without the pool the page can't price a trade.
                for (let i = 0; alive && i < 5; i++) {
                    const p = await launchPool(t).catch(() => undefined);
                    if (p !== undefined) { if (alive) setPool(p); break; }
                    await new Promise((r) => setTimeout(r, 3000));
                }
            })
            .catch((e) => alive && setError(e?.message ?? String(e)));
        // The indexer may not follow DEX tokens yet; the page works without it.
        api.token(address.toString()).then((s) => alive && setStats(s)).catch(() => {});
        api.holders(address.toString()).then((h) => alive && setHolders(h)).catch(() => {});
        return () => { alive = false; };
    }, [address.toRawString()]);

    // Pool state every 20 s (and after a trade).
    async function refresh() {
        if (!pool) return;
        const state = await loadPoolState(pool.address).catch(() => null);
        if (state) setPool({ ...pool, state });
    }
    useEffect(() => {
        if (!pool) return;
        const t = setInterval(refresh, 20_000);
        return () => clearInterval(t);
    }, [pool?.address.toRawString()]);

    // Ticks the anti-snipe countdown.
    useEffect(() => {
        const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
        return () => clearInterval(t);
    }, []);

    if (error && !token) return <div className="card error">{error}</div>;
    if (!token || !token.launch) return <div className="card skeleton tall" />;

    const info = token.launch;
    const state = pool?.state ?? null;
    const live = !!state?.initialized;
    const price = live ? sqrtToPrice(state!.sqrtPriceX96) : 0;
    const mcap = live ? mcapNano(state!.sqrtPriceX96) : 0n;
    const fee = live && pool ? feeParts(pool) : null;
    const tax = pool ? taxOf(pool) : { buy: Number(info.buyTaxBps), sell: Number(info.sellTaxBps) };
    const snipeLeft = fee && fee.launchEnds > now ? fee.launchEnds - now : 0;
    const createdAt = Number(info.createdAt);

    function copyAddress() {
        navigator.clipboard?.writeText(address.toString());
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    return (
        <div className="token-page">
            <div className="col-main">
                <Link to="/" className="back">‹ Discover</Link>
                <div className="token-header">
                    <TokenImage src={token.image} symbol={token.symbol} size={56} round />
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <h1>
                            {token.name} <span className="ticker-tag">${token.symbol}</span>
                            <span className="pill blue">Marg DEX</span>
                            {tax.buy > 0 && <span className="pill tax">Buy tax {tax.buy / 100}%</span>}
                            {tax.sell > 0 && <span className="pill tax">Sell tax {tax.sell / 100}%</span>}
                        </h1>
                        <div className="addr">
                            <span>by <a href={explorer(info.creator)} target="_blank" rel="noreferrer">{short(info.creator)}</a> ·</span>
                            <button className="copy" onClick={copyAddress}>{copied ? 'Copied' : short(address) + ' ⧉'}</button>
                            <a className="copy" href={explorer(address)} target="_blank" rel="noreferrer">↗</a>
                            <a className="copy" href={shareUrl(window.location.href, `${token.name} ($${token.symbol}) on Marg`)} target="_blank" rel="noreferrer">Share</a>
                        </div>
                    </div>
                    <div className="head-mcap">
                        <b>{live ? fmtCompact(mcap) : '—'} <span className="hint small">Gram mcap</span></b>
                        <span className="small"><span className="hint">{live ? `${fmtPrice(price)} Gram ` : ''}</span><Change value={stats?.change24h} always /></span>
                    </div>
                </div>
                {snipeLeft > 0 && fee && (
                    <div className="card notice">
                        <span className="pill">Anti-snipe {pct(fee.launch, 1)}</span>
                        <span className="dim small">Extra launch fee, fading to 0 in {Math.floor(snipeLeft / 60)}:{String(snipeLeft % 60).padStart(2, '0')}.</span>
                    </div>
                )}

                {stats ? <PriceChart address={address.toString()} version={Number(state?.tick ?? 0n)} /> : (
                    <div className="chart-card">
                        <div className="chart-empty">
                            <div style={{ textAlign: 'center' }}>
                                <b className="mono" style={{ fontSize: 22, color: 'var(--text)' }}>{live ? `${fmtPrice(price)} Gram` : '—'}</b>
                                <div className="small">Live pool price. The chart shows up a few seconds after launch.</div>
                            </div>
                        </div>
                    </div>
                )}

                <div className="stats">
                    <Stat label="Market cap" value={live ? `${fmtCompact(mcap)} Gram` : '—'} />
                    <Stat label="Price" value={live ? `${fmtPrice(price)} Gram` : '—'} />
                    <Stat label="Pool Gram" value={state ? `${fmtTon(state.reserve0, 2)} Gram` : '—'} />
                    <Stat label={`Pool ${token.symbol}`} value={state ? fmtTokens(state.reserve1) : '—'} />
                    <Stat label="Fee now" value={fee ? pct(fee.total) : '—'} />
                    <Stat label="Buy / sell tax" value={`${tax.buy / 100}% / ${tax.sell / 100}%`} />
                    <Stat label="Volume 24h" value={stats ? fmtUsd(BigInt(stats.volume24h), usd) ?? `${fmtCompact(BigInt(stats.volume24h))} Gram` : '—'} />
                    <Stat label="Created" value={createdAt ? `${ago(createdAt)} ago` : '—'} />
                </div>

                <div className="card info-box">
                    <div className="info-head">
                        <h3>Launch pool</h3>
                        <span className="pill green">Liquidity locked forever</span>
                    </div>
                    <p>
                        The whole 1B supply went into one {presetOf(Number(info.tickSpacing))?.name ?? ''} pool position
                        ({pct(presetOf(Number(info.tickSpacing))?.basePips ?? 0)} base fee) that nobody can withdraw. There was no bonding curve:
                        it has traded on Marg DEX from its first block.
                        {tax.buy + tax.sell > 0 && ` Taxes are taken in Gram and fixed for good: ${taxSplit(info)}.`}
                    </p>
                    {pool && (
                        <div className="row small" style={{ marginTop: 10 }}>
                            <span className="hint">Pool</span>
                            <a className="mono" href={explorer(pool.address)} target="_blank" rel="noreferrer">{short(pool.address)} ↗</a>
                        </div>
                    )}
                    {pool && !state && <p>The pool is not deployed yet: the launch may still be settling.</p>}
                </div>

                <RewardsCard master={address} info={info} symbol={token.symbol} poolTax={pool?.state?.taxFees} />
                <VaultCard master={address} info={info} symbol={token.symbol} />

                {stats ? (
                    <Activity address={address.toString()} symbol={token.symbol} holders={holders} version={state?.tick ?? 0n} />
                ) : (
                    <div className="activity">
                        <div className="underline-tabs"><button className="active">Activity</button></div>
                        <div className="hint list-empty">
                            Trades of Marg DEX tokens are not indexed yet.{' '}
                            <a href={`${explorer(address)}?section=holders`} target="_blank" rel="noreferrer">Holders on tonviewer ↗</a>
                        </div>
                    </div>
                )}
            </div>

            <div className="col-side">
                <SwapBox fixed={token} fixedPool={pool} onSent={refresh} />
            </div>
        </div>
    );
}

// Where the collected tax goes (LaunchInfo split, in bps of the tax).
function taxSplit(info: LaunchInfo): string {
    const parts: string[] = [];
    if (info.rewardsBps > 0n) parts.push(`${Number(info.rewardsBps) / 100}% to holders`);
    if (info.walletBps > 0n) parts.push(`${Number(info.walletBps) / 100}% to ${info.taxWallet ? short(info.taxWallet) : 'the creator'}`);
    if (info.buybackBps > 0n) parts.push(`${Number(info.buybackBps) / 100}% buyback and burn`);
    return parts.join(', ') || `paid to ${info.taxRecipient ? short(info.taxRecipient) : 'the creator'}`;
}
