import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Address } from '@ton/core';
import { DEX_LIVE, DexToken, PRESETS, pct, resolveToken } from '../dex';
import { SwapBox } from '../SwapBox';

// /swap: Gram and any jetton with a Marg DEX pool. ?out=<jetton master> preselects the token.
export function Swap() {
    const [params] = useSearchParams();
    const [out, setOut] = useState<DexToken | null>(null);
    const outParam = params.get('out');

    useEffect(() => {
        if (!outParam) return;
        try {
            resolveToken(Address.parse(outParam)).then(setOut).catch(() => {});
        } catch {
            /* not an address: start empty */
        }
    }, [outParam]);

    return (
        <div className="swap-page">
            <div className="swap-head">
                <h1>Swap</h1>
                <p className="dim">Concentrated liquidity with a fee that rises when the market moves. Every MARG launch trades here from its first block.</p>
            </div>
            {!DEX_LIVE && (
                <div className="card notice">
                    <span className="pill blue">Marg DEX · coming soon</span>
                    <span className="dim small">Quotes work as soon as pools exist; swapping opens when the DEX is deployed.</span>
                </div>
            )}
            <SwapBox initialOut={out} />
            <div className="card tiers-card">
                <div className="panel-head"><h3>Fee tiers</h3><Link to="/pools" className="button ghost">Pools ›</Link></div>
                <div className="fee-tiers">
                    {PRESETS.map((p) => (
                        <div key={p.spacing}><b>{p.name}</b><span className="mono">{pct(p.basePips)}</span><small className="hint">+ up to {p.spacing === 1 ? '0.05' : p.spacing === 10 ? '0.49' : p.spacing === 60 ? '1.98' : '2.94'}% in volatile markets</small></div>
                    ))}
                </div>
                <p className="hint small" style={{ margin: '10px 0 0' }}>
                    New launches also carry a short anti-snipe fee that fades to zero, and tax tokens add their buy or sell tax in Gram.
                    Large orders fill partly (the app allows up to 12 tick crossings per swap) and the rest is refunded.
                </p>
            </div>
        </div>
    );
}
