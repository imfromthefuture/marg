import { fmtUsd, useGramUsd } from '../usd';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fmtCompact, fmtTon, short } from '../ton';
import { ago, api, ApiTrade } from '../api';
import { Sparkline } from '../Chart';

type Tab = 'mcap' | 'new' | 'active';
const TABS: [Tab, string][] = [['mcap', 'Top'], ['new', 'New'], ['active', 'Most traded']];

// One row in the list, from the indexer.
type ListToken = {
    address: string; name: string; symbol: string; image?: string; creator: string; description?: string | null;
    mcap: bigint; createdAt?: number | null; change24h?: number; spark?: number[];
    volume24h?: bigint; trades24h?: number;
};

export function Home() {
    const usd = useGramUsd();
    const [params] = useSearchParams();
    const [tokens, setTokens] = useState<ListToken[]>([]);
    const [total, setTotal] = useState<bigint | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>('mcap');
    const [feed, setFeed] = useState<ApiTrade[] | null>(null);
    const search = params.get('q') ?? '';

    useEffect(() => {
        let cancelled = false;
        api.tokens().then((all) => {
            if (cancelled) return;
            // Direct launches only (kind 'dex'); the indexer lists nothing else.
            const list = all.filter((t) => (t.kind ?? 'dex') === 'dex');
            setTokens(list.map((t) => ({
                address: t.address, name: t.name, symbol: t.symbol, image: t.image ?? undefined, creator: t.creator, description: t.description,
                mcap: BigInt(t.mcap), createdAt: t.createdAt,
                change24h: t.change24h, spark: t.spark, volume24h: BigInt(t.volume24h), trades24h: t.trades24h,
            })));
            setTotal(BigInt(list.length));
        }).catch(() => {
            if (!cancelled) setError('Token list is unavailable right now. Try again in a minute.');
        });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        let alive = true;
        const load = () => api.feed(12).then((f) => alive && setFeed(f)).catch(() => {});
        load();
        const t = setInterval(load, 10_000);
        return () => { alive = false; clearInterval(t); };
    }, []);

    const byMcap = (a: ListToken, b: ListToken) => (b.mcap > a.mcap ? 1 : b.mcap < a.mcap ? -1 : 0);
    const totals = useMemo(() => ({
        volume: tokens.reduce((s, t) => s + (t.volume24h ?? 0n), 0n),
        trades: tokens.reduce((s, t) => s + (t.trades24h ?? 0), 0),
    }), [tokens]);

    const shown = useMemo(() => {
        const s = search.trim().toLowerCase();
        let list = tokens.filter((t) => !s || t.name.toLowerCase().includes(s) || t.symbol.toLowerCase().includes(s));
        if (tab === 'mcap') list = [...list].sort(byMcap);
        if (tab === 'new') list = [...list].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        if (tab === 'active') list = list.filter((t) => (t.trades24h ?? 0) > 0).sort((a, b) => (b.trades24h ?? 0) - (a.trades24h ?? 0));
        return list;
    }, [tokens, tab, search]);

    const loading = total === null && !error;

    const trending = useMemo(() => [...tokens]
        .sort((a, b) => Number((b.volume24h ?? 0n) - (a.volume24h ?? 0n)) || byMcap(a, b))
        .slice(0, 4), [tokens]);
    const dayAgo = Date.now() / 1000 - 86400;
    const newCount = tokens.filter((t) => (t.createdAt ?? 0) > dayAgo).length;

    return (
        <>
            <div className="home-top">
                <div>
                    <h1>Discover</h1>
                    <p>Every coin launched on Marg, live from the chain.</p>
                </div>
                <Link to="/create" className="button primary">+ Launch a token</Link>
            </div>

            <div className="kpis">
                <div className="kpi"><span>Volume 24h</span><b>{fmtUsd(totals.volume, usd) ?? <>{fmtCompact(totals.volume)} <small className="hint">Gram</small></>}</b></div>
                <div className="kpi"><span>Trades 24h</span><b>{totals.trades.toLocaleString('en-US')}</b></div>
                <div className="kpi"><span>Tokens launched</span><b>{total !== null ? Number(total).toLocaleString('en-US') : '—'}</b></div>
                <div className="kpi"><span>New 24h</span><b>{newCount.toLocaleString('en-US')}</b></div>
            </div>

            {trending.length > 0 && (
                <div className="trending">
                    {trending.map((t, i) => (
                        <Link key={t.address} to={`/token/${t.address}`} className="tcard">
                            <div className="tcard-top">
                                <TokenImage src={t.image} symbol={t.symbol} size={40} round />
                                <div>
                                    <div className="tcard-name">{t.name}</div>
                                    <div className="hint small">${t.symbol}</div>
                                </div>
                                <span className="rank-badge">#{i + 1}</span>
                            </div>
                            <div className="tcard-bottom">
                                <div>
                                    <div className="tcard-mcap">{fmtUsd(t.mcap, usd) ?? fmtCompact(t.mcap)}</div>
                                    <div className="small"><span className="hint">mcap · </span><Change value={t.change24h} always /></div>
                                </div>
                                <Sparkline points={t.spark} />
                            </div>
                        </Link>
                    ))}
                </div>
            )}

            <div className="home-grid">
                <section>
                    <div className="toolbar">
                        <div className="tabs-boxed">
                            {TABS.map(([key, label]) => (
                                <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
                            ))}
                        </div>
                        {search && <span className="hint small">Results for “{search}” · <Link to="/">clear</Link></span>}
                    </div>

                    {error && <div className="card error">{error}</div>}
                    {total === 0n && (
                        <div className="card empty">
                            <h2>No tokens yet</h2>
                            <p>Be the first. It takes one transaction.</p>
                            <Link to="/create" className="button primary">Launch a token</Link>
                        </div>
                    )}
                    {total !== null && total > 0n && !loading && shown.length === 0 && (
                        <div className="card empty">Nothing here yet.</div>
                    )}

                    {(shown.length > 0 || loading) && (
                        <div className="token-grid">
                            {shown.map((t, i) => <TokenCard key={t.address} t={t} rank={i + 1} />)}
                            {loading && Array.from({ length: 4 }).map((_, i) => <div key={'s' + i} className="token-card skeleton" />)}
                        </div>
                    )}
                </section>

                <aside className="side">
                    <div className="card" style={{ marginBottom: 0 }}>
                        <div className="panel-head"><h3>Live trades</h3><span className="live">live</span></div>
                        {!feed || feed.length === 0 ? <div className="hint small">No trades yet.</div> : (
                            <div className="feed">
                                {feed.map((f) => (
                                    <Link key={f.hash} to={`/token/${f.token}`} className="feed-row">
                                        <span className={`side-dot ${f.isBuy ? 'up' : 'down'}`}>{f.isBuy ? 'B' : 'S'}</span>
                                        <span><span className="feed-sym">{f.symbol}</span> <span className={`mono ${f.isBuy ? 'up' : 'down'}`}>{fmtTon(BigInt(f.ton), 2)}</span></span>
                                        <span className="hint small">{ago(f.utime)}</span>
                                    </Link>
                                ))}
                            </div>
                        )}
                    </div>
                    <div className="card" id="how" style={{ marginBottom: 0 }}>
                        <div className="panel-head"><h3>How it works</h3></div>
                        <div className="steps">
                            <div className="step"><i>1</i><div><b>Launch in one transaction</b><span>Name, ticker, picture. An optional dev buy lands in the same transaction, so nobody gets in first.</span></div></div>
                            <div className="step"><i>2</i><div><b>Trades on Marg DEX at once</b><span>The supply goes straight into the pool. No presale and no curve to fill; a creator vault, if set, is locked and shown on the token page.</span></div></div>
                            <div className="step"><i>3</i><div><b>Liquidity locked forever</b><span>Nobody can pull the pool. A short anti-snipe fee fades out over the first minutes.</span></div></div>
                        </div>
                    </div>
                </aside>
            </div>
        </>
    );
}

// One token as a card: logo, name, age and creator, description, market cap with 24h change,
// volume / trades and a 24h sparkline.
function TokenCard({ t, rank }: { t: ListToken; rank: number }) {
    const usd = useGramUsd();
    const mcapUsd = fmtUsd(t.mcap, usd);
    return (
        <Link to={`/token/${t.address}`} className="token-card">
            <div className="tc-head">
                <TokenImage src={t.image} symbol={t.symbol} size={72} />
                <div className="tc-id">
                    <div className="tc-name">{t.name}</div>
                    <div className="tc-sym">${t.symbol}</div>
                    <div className="hint small">{t.createdAt ? `${ago(t.createdAt)} · ` : ''}by {short(t.creator)}</div>
                </div>
                <span className="tc-rank">#{rank}</span>
            </div>
            {t.description && <p className="tc-desc">{t.description}</p>}
            <div className="tc-stats">
                <div>
                    <span className="hint small">Market cap</span>
                    <b className="mono">{mcapUsd ?? `${fmtCompact(t.mcap)} Gram`}</b>
                    <span className="small"><Change value={t.change24h} always /></span>
                </div>
                <div className="tc-spark"><Sparkline points={t.spark} /></div>
            </div>
            <div className="tc-foot hint small">
                <span>Vol 24h <b className="mono">{t.volume24h ? fmtUsd(t.volume24h, usd) ?? fmtCompact(t.volume24h) : '—'}</b></span>
                <span>{(t.trades24h ?? 0).toLocaleString('en-US')} trades</span>
            </div>
        </Link>
    );
}

export function Change({ value, always }: { value?: number; always?: boolean }) {
    if (value === undefined || (!always && Math.abs(value) < 0.05)) return null;
    if (Math.abs(value) < 0.05) return <span className="small hint">0%</span>;
    return <span className={`small ${value > 0 ? 'up' : 'down'}`}>{value > 0 ? '+' : ''}{value.toFixed(1)}%</span>;
}

export function TokenImage({ src, symbol, size = 44, round }: { src?: string; symbol: string; size?: number; round?: boolean }) {
    const [broken, setBroken] = useState(false);
    const url = src?.replace('ipfs://', 'https://ipfs.io/ipfs/');
    const cls = `token-img${round ? ' round' : ''}`;
    if (!url || broken) {
        return (
            <div className={`${cls} placeholder`} style={{ width: size, height: size, fontSize: size / 3 }}>
                {symbol.slice(0, 2)}
            </div>
        );
    }
    return <img className={cls} src={url} width={size} height={size} alt="" onError={() => setBroken(true)} />;
}
