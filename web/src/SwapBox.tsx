import { useEffect, useMemo, useState } from 'react';
import { Address } from '@ton/core';
import { useTonAddress, useTonConnectUI } from '@tonconnect/ui-react';
import {
    CLOSED_LABEL, codeText, DEX_LIVE, DEX_ROUTER, DexPool, DexToken, feeParts, findPools, GAS, GRAM_TOKEN, isGram, pct,
    crossingsFor, platformBpsOf, presetOf, quote, Quote, resolveToken, STOPS, swapGas, swapMessage, taxOf, tokenKey, tokenList, TokenListItem,
    recentLaunches, trustedJetton, TxMessage,
} from './dex';
import { estimateOut, minOutFor, priceImpact } from './dexmath';
import { client, fmtTokens, fmtTon, jettonBalance, parseAmount, prefetchWalletTopUp, q, short, unitsToString } from './ton';
import { TokenImage } from './pages/Home';

const SLIPPAGES = [0.5, 1, 3, 5];

// Gram with 4 digits, jettons compact.
export const fmtAmt = (t: DexToken, units: bigint) => (t.master ? fmtTokens(units, t.decimals) : fmtTon(units, 4));

export function TokenIcon({ token, size = 24 }: { token: DexToken | TokenListItem; size?: number }) {
    if (!('address' in token) && !token.master) {
        return <img className="token-img round" src="/gram.svg" alt="Gram" width={size} height={size} style={{ width: size, height: size }} />;
    }
    return <TokenImage src={token.image} symbol={token.symbol} size={size} round />;
}

// Sends one TonConnect transaction; returns a status line for the UI.
export function useSend() {
    const [tonConnect] = useTonConnectUI();
    const wallet = useTonAddress(false);
    async function send(messages: TxMessage[], label: string): Promise<string> {
        if (!wallet) {
            tonConnect.openModal();
            return '';
        }
        try {
            await tonConnect.sendTransaction({ validUntil: Math.floor(Date.now() / 1000) + 300, messages });
            return `${label} sent. It settles in a few seconds; unused gas comes back.`;
        } catch (e: any) {
            return e?.message?.includes('Reject') ? 'Cancelled in wallet' : `Error: ${e?.message ?? e}`;
        }
    }
    return { wallet: wallet ? Address.parse(wallet) : null, send, connect: () => tonConnect.openModal() };
}

// Balance of a token for the connected wallet (null while unknown).
export function useBalance(token: DexToken | null, owner: Address | null, version = 0) {
    const [balance, setBalance] = useState<bigint | null>(null);
    useEffect(() => {
        setBalance(null);
        if (!token || !owner) return;
        let alive = true;
        const read = token.master
            // C8: a launch token's wallet gets its top-up check now, before the sell click (see ton.ts).
            ? jettonBalance(token.master, owner).then((b) => { if (token.launch && b.balance > 0n) prefetchWalletTopUp(b.wallet); return b.balance; })
            : q(() => client.getBalance(owner));
        // One retry pass after a pause if Toncenter still refuses (the sell side needs the balance).
        read.catch(() => new Promise((r) => setTimeout(r, 4000)).then(() => (token.master
            ? jettonBalance(token.master, owner).then((b) => b.balance) : q(() => client.getBalance(owner)))))
            .then((b) => alive && setBalance(b)).catch(() => {});
        return () => { alive = false; };
    }, [token && tokenKey(token), owner?.toRawString(), version]);
    return balance;
}

// The swap box: free pair with a token picker (/swap), or Gram <-> one token with Buy/Sell tabs
// (token page, `fixed`). Quotes come from the Pool's get_quote; messages from the DEX bindings.
export function SwapBox({ fixed, fixedPool, initialOut, onSent }: {
    fixed?: DexToken; fixedPool?: DexPool | null; initialOut?: DexToken | null; onSent?: () => void;
}) {
    const { wallet, send, connect } = useSend();
    const [tokenIn, setTokenIn] = useState<DexToken | null>(GRAM_TOKEN);
    const [tokenOut, setTokenOut] = useState<DexToken | null>(fixed ?? initialOut ?? null);
    const [input, setInput] = useState('');
    const [slippage, setSlippage] = useState(1);
    const [pools, setPools] = useState<DexPool[] | null>(fixedPool ? [fixedPool] : null);
    const [poolIdx, setPoolIdx] = useState(0);
    const [q1, setQ1] = useState<Quote | null>(null);
    const [quoting, setQuoting] = useState(false);
    const [picker, setPicker] = useState<'in' | 'out' | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [version, setVersion] = useState(0);
    const balance = useBalance(tokenIn, wallet, version);
    // Sell slider position (1-100% of the balance).
    const [pctSel, setPctSel] = useState(100);
    // Gram for gas when paying with a jetton (null = same as balance).
    const jettonIn = !!tokenIn?.master;
    const gramBal = useBalance(jettonIn ? GRAM_TOKEN : null, wallet, version);
    // Re-quote every 15 s so minOut isn't built from a stale price.
    const [tick, setTick] = useState(0);
    useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 15_000); return () => clearInterval(t); }, []);
    const amount = parseAmount(input, tokenIn?.decimals ?? 9);

    useEffect(() => { if (initialOut && !fixed) setTokenOut(initialOut); }, [initialOut && tokenKey(initialOut)]);
    useEffect(() => { if (fixedPool) setPools([fixedPool]); }, [fixedPool]);

    // Pools of the pair (free mode): live ones only, the deepest first.
    const pairKey = tokenIn && tokenOut ? `${tokenKey(tokenIn)}|${tokenKey(tokenOut)}` : '';
    useEffect(() => {
        if (fixed || !tokenIn || !tokenOut) return;
        let alive = true;
        setPools(null);
        setPoolIdx(0);
        findPools(tokenIn, tokenOut, { onlyLive: true, preferCanonical: true })
            .then((ps) => alive && setPools([...ps].sort((a, b) => (b.state!.liquidity > a.state!.liquidity ? 1 : -1))))
            .catch(() => alive && setPools([]));
        return () => { alive = false; };
    }, [pairKey, !!fixed]);

    const pool = pools?.[poolIdx] ?? null;
    const zeroForOne = !!(pool && tokenIn?.id && tokenIn.id.equals(pool.key.token0));

    useEffect(() => {
        setQ1(null);
        if (!pool?.state?.initialized || amount <= 0n) return;
        let alive = true;
        setQuoting(true);
        const t = setTimeout(() => {
            quote(pool, zeroForOne, amount).then((r) => alive && setQ1(r)).catch(() => {}).finally(() => alive && setQuoting(false));
        }, 450);
        return () => { alive = false; clearTimeout(t); setQuoting(false); };
    }, [amount, pool?.address.toRawString(), zeroForOne, version, tick]);

    const ok = q1 !== null && q1.code === 0n && q1.amountOut > 0n;
    const partial = ok && q1!.refund > 0n;
    const minOut = ok ? minOutFor(q1!.amountOut, Math.round(slippage * 100)) : 0n;
    const impact = ok && pool?.state ? priceImpact(pool.state.sqrtPriceX96, q1!.sqrtPriceAfter) : 0;
    const fee = pool?.state ? feeParts(pool) : null;
    const tax = pool ? taxOf(pool) : { buy: 0, sell: 0 };
    const isBuy = !!tokenIn && isGram(tokenIn.id!);
    const taxBps = pool && tax.buy + tax.sell > 0 ? (isBuy ? tax.buy : tax.sell) : 0;
    const mc = crossingsFor(ok ? q1!.crossings : undefined);
    const gas = swapGas(partial, mc, pool);
    const platBps = platformBpsOf(pool);
    // Shown at once from the loaded pool state; the exact quote replaces it when it arrives.
    const est = !ok && pool?.state?.initialized && amount > 0n
        ? estimateOut(pool.state.sqrtPriceX96, pool.state.liquidity, zeroForOne, amount, pool.state.feePipsNow,
            zeroForOne ? tax.buy + platBps : 0, zeroForOne ? 0 : tax.sell + platBps)
        : 0n;
    // Gram the wallet must attach: swap gas, plus the jetton wallet hop when paying with a jetton.
    const attached = jettonIn ? gas + GAS.WALLET : gas;
    const tooMuch = balance !== null && (jettonIn ? amount > balance : amount + attached > balance);
    const lowGas = jettonIn && gramBal !== null && gramBal < attached;

    function flip() {
        if (fixed) return;
        setTokenIn(tokenOut);
        setTokenOut(tokenIn);
        setInput('');
    }
    function side(buy: boolean) {
        setTokenIn(buy ? GRAM_TOKEN : fixed!);
        setTokenOut(buy ? fixed! : GRAM_TOKEN);
        setInput('');
    }

    async function submit() {
        if (!wallet) return connect();
        if (!pool || !tokenIn || !tokenOut || !ok || !DEX_ROUTER) return;
        try {
            setStatus('Confirm in your wallet…');
            const m = await swapMessage({ router: DEX_ROUTER, pool, tokenIn, tokenOut, amountIn: amount, minOut, allowPartial: partial, owner: wallet, maxCrossings: mc });
            const s = await send(m, 'Swap');
            setStatus(s || null);
            if (s.includes(' sent')) {
                setInput('');
                setTimeout(() => { setVersion((v) => v + 1); onSent?.(); }, 9000);
            }
        } catch (e: any) {
            setStatus(`Error: ${e?.message ?? e}`);
        }
    }

    const label = !DEX_LIVE ? CLOSED_LABEL
        : !wallet ? 'Connect wallet'
            : !tokenIn || !tokenOut ? 'Select a token'
                : pools !== null && !pool ? 'No pool for this pair yet'
                    : amount <= 0n ? 'Enter an amount'
                        : tooMuch ? (jettonIn ? `Not enough ${tokenIn.symbol}` : 'Not enough Gram (incl. network fee)')
                            : lowGas ? `Need ${fmtTon(attached, 2)} Gram in your wallet for gas (mostly refunded)`
                            : q1 && q1.code !== 0n ? codeText(q1.code)
                                : fixed ? (isBuy ? `Buy ${fixed.symbol}` : `Sell ${fixed.symbol}`) : 'Swap';
    const disabled = !DEX_LIVE || (!!wallet && (!ok || tooMuch || lowGas || amount <= 0n));
    const btnClass = fixed && wallet && DEX_LIVE ? (isBuy ? 'buy' : 'sell') : 'primary';

    const assetBtn = (t: DexToken | null, which: 'in' | 'out') => fixed
        ? <span className="asset">{t && <TokenIcon token={t} />}{t?.symbol}</span>
        : (
            <button className="asset pick" onClick={() => setPicker(which)}>
                {t ? <><TokenIcon token={t} />{t.symbol}</> : <span className="pick-empty">Select token</span>}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
            </button>
        );

    return (
        <div className="card swap">
            {fixed && (
                <div className="tabs">
                    <button className={isBuy ? 'active buy' : ''} onClick={() => side(true)}>Buy</button>
                    <button className={!isBuy ? 'active sell' : ''} onClick={() => side(false)}>Sell</button>
                </div>
            )}

            <div className="swap-field">
                <div className="row"><span>You pay</span>{wallet && balance !== null && tokenIn && <span>Balance {fmtAmt(tokenIn, balance)}</span>}</div>
                <div className="amount">
                    <input value={input} onChange={(e) => setInput(e.target.value)} inputMode="decimal" placeholder="0" />
                    {assetBtn(tokenIn, 'in')}
                </div>
                {tokenIn && (
                    <div className="chips">
                        {isGram(tokenIn.id!) && !tokenIn.master
                            ? ['1', '5', '10', '50'].map((v) => <button key={v} onClick={() => setInput(v)}>{v}</button>)
                            : balance !== null ? [25, 50, 75, 100].map((p) => (
                                <button key={p} onClick={() => { setPctSel(p); setInput(unitsToString((balance * BigInt(p)) / 100n, tokenIn?.decimals ?? 9)); }}>{p === 100 ? 'Max' : `${p}%`}</button>
                            )) : wallet ? <span className="hint small">Loading balance…</span> : null}
                    </div>
                )}
                {tokenIn?.master && balance !== null && balance > 0n && (
                    <div className="pct-slider">
                        <input type="range" min={1} max={100} step={1} value={pctSel}
                            style={{ '--p': `${pctSel}%` } as React.CSSProperties}
                            onChange={(e) => {
                                const p = Number(e.target.value);
                                setPctSel(p);
                                setInput(unitsToString((balance * BigInt(p)) / 100n, tokenIn.decimals));
                            }} />
                        <span className="mono small">{pctSel}%</span>
                    </div>
                )}
            </div>
            <div className="flip">
                <button title="Switch" onClick={() => (fixed ? side(!isBuy) : flip())}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
                </button>
            </div>
            <div className="swap-field">
                <div className="row"><span>You receive</span>{quoting && <span>Quoting…</span>}</div>
                <div className="amount">
                    <span className={`out ${ok ? '' : 'empty'}`}>{ok && tokenOut ? fmtAmt(tokenOut, q1!.amountOut) : est > 0n && tokenOut ? `≈ ${fmtAmt(tokenOut, est)}` : '0'}</span>
                    {assetBtn(tokenOut, 'out')}
                </div>
            </div>

            <div className="meta">
                {!fixed && pools && pools.length > 1 && (
                    <div className="row">
                        <span className="hint">Pool</span>
                        <span className="chips inline">
                            {pools.map((p, i) => (
                                <button key={p.address.toRawString()} className={i === poolIdx ? 'active' : ''} onClick={() => setPoolIdx(i)}>
                                    {p.canonical ? 'Launch' : presetOf(Number(p.key.tickSpacing))?.name ?? p.key.tickSpacing.toString()}
                                </button>
                            ))}
                        </span>
                    </div>
                )}
                {tokenIn && tokenOut && pools === null && !fixed && <div className="row"><span className="hint">Finding pools…</span></div>}
                {ok && tokenIn && tokenOut && (
                    <div className="row">
                        <span className="hint">Rate</span>
                        <span className="mono small">1 {tokenIn.symbol} = {fmtRate(q1!.amountOut, amount - q1!.refund, tokenIn.decimals - tokenOut.decimals)} {tokenOut.symbol}</span>
                    </div>
                )}
                <div className="row">
                    <span className="hint">Price impact</span>
                    <span className={`mono ${impact > 0.05 ? 'down' : ''}`}>{ok ? `${(impact * 100).toFixed(2)}%` : '—'}</span>
                </div>
                <div className="row">
                    <span className="hint">Fee</span>
                    <span className="mono small right">
                        {fee ? pct(fee.total) : '—'}
                        {fee && (fee.dynamic > 0n || fee.launch > 0n) && (
                            <span className="hint"> ({pct(fee.base)} base{fee.dynamic > 0n ? ` + ${pct(fee.dynamic)} volatility` : ''}{fee.launch > 0n ? ` + ${pct(fee.launch, 1)} anti-snipe` : ''})</span>
                        )}
                        {ok && tokenIn && <span className="hint"> · {fmtAmt(tokenIn, q1!.feeTotal)} {tokenIn.symbol}</span>}
                    </span>
                </div>
                {taxBps > 0 && (
                    <div className="row">
                        <span className="hint">{isBuy ? 'Buy' : 'Sell'} tax</span>
                        <span className="mono small">{(taxBps / 100).toFixed(2)}%{ok ? ` · ${fmtTon(q1!.tax, 4)} Gram` : ''}</span>
                    </div>
                )}
                <div className="row">
                    <span className="hint">Max slippage</span>
                    <span className="chips inline">
                        {SLIPPAGES.map((s) => <button key={s} className={s === slippage ? 'active' : ''} onClick={() => setSlippage(s)}>{s}%</button>)}
                    </span>
                </div>
                <div className="row"><span className="hint">Minimum received</span><span className="mono">{ok && tokenOut ? `${fmtAmt(tokenOut, minOut)} ${tokenOut.symbol}` : '—'}</span></div>
                <div className="row"><span className="hint" title="Attached for gas; the unused part comes back in the same transaction">Network fee</span><span className="mono">≈ 0.07 Gram <span className="hint">(sends {fmtTon(attached, 2)}, rest refunded)</span></span></div>
            </div>
            {partial && tokenIn && (
                <p className="swap-warn">
                    Only {fmtAmt(tokenIn, amount - q1!.refund)} of {fmtAmt(tokenIn, amount)} {tokenIn.symbol} fills in one transaction
                    ({STOPS[Number(q1!.stop)] ?? 'limit'}). The rest comes back to you; swap it again after this one settles.
                </p>
            )}
            {[tokenIn, tokenOut].filter((t): t is DexToken => !!t && !trustedJetton(t)).map((t) => (
                <p key={t.master!.toRawString()} className="swap-warn">
                    Unverified token: {t.symbol} ({short(t.master!.toString())}) is not a MARG launch or one of the main tokens.
                    Its name, ticker and logo are set by whoever created it. Check the address before you swap.
                </p>
            ))}
            <button className={`button wide big ${btnClass}`} disabled={disabled} onClick={submit}>{label}</button>
            {status && <div className="status">{status}</div>}
            <p className="swap-note">
                {taxBps > 0 || platBps > 0 ? 'Amounts shown are after fees and tax. ' : ''}If the price moves more than your slippage, the swap is refunded. Unused gas comes back.
            </p>

            {picker && (
                <TokenPicker
                    exclude={picker === 'in' ? tokenOut : tokenIn}
                    onClose={() => setPicker(null)}
                    onPick={(t) => {
                        if (picker === 'in') setTokenIn(t); else setTokenOut(t);
                        setPicker(null);
                        setInput('');
                    }}
                />
            )}
        </div>
    );
}

// inShift = decimals of the input token minus the output's.
function fmtRate(out: bigint, inp: bigint, inShift = 0): string {
    if (inp === 0n) return '0';
    const r = (Number(out) / Number(inp)) * 10 ** inShift;
    return r >= 1 ? r.toLocaleString('en-US', { maximumFractionDigits: 4 }) : r.toPrecision(4);
}

// Modal token list: Gram, the indexer's tokens, recent direct launches, or a pasted master address.
export function TokenPicker({ exclude, onPick, onClose }: { exclude?: DexToken | null; onPick: (t: DexToken) => void; onClose: () => void }) {
    const [list, setList] = useState<TokenListItem[] | null>(null);
    const [search, setSearch] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        tokenList().then((l) => alive && setList(l));
        // Direct launches are not in the indexer yet: read the newest ones from the factory.
        recentLaunches(8).then(async (masters) => {
            for (const m of masters) {
                const t = await resolveToken(m).catch(() => null);
                if (!alive || !t) continue;
                setList((l) => [{ address: m.toString(), symbol: t.symbol, name: t.name, image: t.image, launch: true },
                    ...(l ?? []).filter((x) => !sameRaw(x.address, m))]);
            }
        }).catch(() => {});
        return () => { alive = false; };
    }, []);

    const pasted = useMemo(() => {
        try {
            return Address.parse(search.trim());
        } catch {
            return null;
        }
    }, [search]);

    const s = search.trim().toLowerCase();
    const shown = (list ?? []).filter((t) => !s || pasted || t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s));

    async function pick(address: string) {
        setBusy(address);
        setError(null);
        try {
            const t = await resolveToken(Address.parse(address));
            if (!t.id) throw new Error('This token has no Marg DEX id until the Router address is configured.');
            onPick(t);
        } catch (e: any) {
            setError(e?.message?.includes('exit_code') ? 'That address is not a jetton.' : e?.message ?? String(e));
        } finally {
            setBusy(null);
        }
    }

    const gramHidden = exclude && !exclude.master;
    return (
        <div className="modal-back" onClick={onClose}>
            <div className="modal card" onClick={(e) => e.stopPropagation()}>
                <div className="panel-head"><h3>Select a token</h3><button className="button ghost" onClick={onClose}>Close</button></div>
                <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Symbol, name or jetton address" />
                <div className="pick-list">
                    {pasted && (
                        <button className="pick-row" onClick={() => pick(pasted.toString())} disabled={!!busy}>
                            <span className="token-img round placeholder" style={{ width: 32, height: 32, fontSize: 12 }}>?</span>
                            <span><b>Use this address</b><span className="hint small mono"> {short(pasted)}</span></span>
                            <span className="hint small">{busy === pasted.toString() ? 'Loading…' : ''}</span>
                        </button>
                    )}
                    {!pasted && !gramHidden && 'gram'.includes(s) && (
                        <button className="pick-row" onClick={() => onPick(GRAM_TOKEN)}>
                            <TokenIcon token={GRAM_TOKEN} size={32} />
                            <span><b>Gram</b><span className="hint small"> native coin</span></span>
                            <span />
                        </button>
                    )}
                    {!pasted && shown.filter((t) => !exclude?.master || !sameRaw(t.address, exclude.master)).slice(0, 60).map((t) => (
                        <button key={t.address} className="pick-row" onClick={() => pick(t.address)} disabled={!!busy}>
                            <TokenIcon token={t} size={32} />
                            <span className="pick-name"><b>{t.symbol}</b><span className="hint small"> {t.name}</span></span>
                            <span className="hint small">{busy === t.address ? 'Loading…' : t.launch ? <span className="pill blue">DEX</span> : short(t.address)}</span>
                        </button>
                    ))}
                    {list === null && <div className="hint list-empty">Loading tokens…</div>}
                    {list !== null && !pasted && shown.length === 0 && <div className="hint list-empty">No match. Paste the jetton's address.</div>}
                </div>
                {error && <div className="status down">{error}</div>}
            </div>
        </div>
    );
}

function sameRaw(a: string, b: Address) {
    try {
        return Address.parse(a).equals(b);
    } catch {
        return false;
    }
}
