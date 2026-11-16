import { useEffect, useState } from 'react';
import { explorer, fmtTokens, fmtTon, short } from '../ton';
import { ago, api, ApiTrade, Holders } from '../api';

// Trades / holders tabs and the stat tile of a token page.
export function Activity({ address, symbol, holders, version }: { address: string; symbol: string; holders: Holders | null; version: bigint }) {
    const [tab, setTab] = useState<'trades' | 'holders'>('trades');
    const [trades, setTrades] = useState<ApiTrade[] | null>(null);

    useEffect(() => {
        let alive = true;
        const load = () => api.trades(address, 50).then((t) => alive && setTrades(t)).catch(() => {});
        load();
        const t = setInterval(load, 10_000);
        return () => { alive = false; clearInterval(t); };
    }, [address, version]);

    return (
        <div className="activity">
            <div className="underline-tabs">
                <button className={tab === 'trades' ? 'active' : ''} onClick={() => setTab('trades')}>Trades</button>
                <button className={tab === 'holders' ? 'active' : ''} onClick={() => setTab('holders')}>
                    Holders{holders ? ` ${holders.count}${holders.more ? '+' : ''}` : ''}
                </button>
            </div>
            {tab === 'trades' ? (
                !trades ? <div className="hint list-empty">Loading trades…</div>
                    : trades.length === 0 ? <div className="hint list-empty">No trades yet.</div>
                        : (
                            <div className="list">
                                {trades.map((t) => (
                                    <a key={t.hash} className="list-row" href={explorer(t.trader)} target="_blank" rel="noreferrer">
                                        <span className={t.isBuy ? 'up' : 'down'}><b>{t.isBuy ? 'Buy' : 'Sell'}</b></span>
                                        <span>{short(t.trader)}</span>
                                        <span className="right">{fmtTon(BigInt(t.ton), 2)} Gram</span>
                                        <span className="right hint">{fmtTokens(BigInt(t.tokens))} {symbol}</span>
                                        <span className="right hint">{ago(t.utime)}</span>
                                    </a>
                                ))}
                            </div>
                        )
            ) : (
                !holders ? <div className="hint list-empty">Loading holders…</div>
                    : holders.top.length === 0 ? <div className="hint list-empty">No holders yet.</div>
                        : (
                            <div className="list">
                                {holders.top.map((h, i) => (
                                    <a key={h.owner} className="list-row holders" href={explorer(h.owner)} target="_blank" rel="noreferrer">
                                        <span className="hint">{i + 1}</span>
                                        <span>{short(h.owner)}</span>
                                        <span className="right">{fmtTokens(BigInt(h.balance))} {symbol}</span>
                                        <span className="right hint">{(Number(BigInt(h.balance) / 10n ** 6n) / 1e12 * 100).toFixed(2)}%</span>
                                    </a>
                                ))}
                                {holders.source === 'trades' && <div className="hint small list-empty">Counted from trades; transfers between wallets aren't included yet.</div>}
                            </div>
                        )
            )}
        </div>
    );
}

export function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="stat">
            <div className="hint small">{label}</div>
            <div className="v">{value}</div>
        </div>
    );
}
