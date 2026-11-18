import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    CLOSED_LABEL, codeText, DEX_LIVE, DEX_ROUTER, decreaseMessage, DexPool, DexToken, feeParts, findPools, GAS, GRAM_TOKEN,
    launchPool, MINT_VALUE, mintMessages, trustedJetton, MyPosition, myPositions, openPool, pct, PRESETS, presetOf, priceScale, recentLaunches,
    resolveToken, taxOf, tokenKey,
} from '../dex';
import {
    depositFor, fullRange, maxUsable, minUsable, priceToSqrt, rangeSides, rangeToTicks, sqrtToPrice, tickAt, tickToPrice,
} from '../dexmath';
import { fmtTon, parseAmount, q } from '../ton';
import { fmtPrice } from '../api';
import { fmtAmt, TokenIcon, TokenPicker, useBalance, useSend } from '../SwapBox';

type Tab = 'pools' | 'mine' | 'vaults';
const LOCKED_FOREVER = 0xFFFFFFFFn;

export function Pools() {
    const [tab, setTab] = useState<Tab>('pools');
    const [creating, setCreating] = useState(false);
    const [preset, setPreset] = useState<DexToken | null>(null);

    function newPosition(t?: DexToken) {
        setPreset(t ?? null);
        setCreating(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    return (
        <div className="pools-page">
            <div className="home-top">
                <div>
                    <h1>Pools</h1>
                    <p>Pick a price range, earn the swap fees while the price is inside it, and hold the position as an NFT.</p>
                </div>
                <button className="button primary" onClick={() => (creating ? setCreating(false) : newPosition())}>{creating ? 'Close' : '+ New position'}</button>
            </div>
            {!DEX_LIVE && (
                <div className="card notice">
                    <span className="pill blue">Marg DEX · coming soon</span>
                    <span className="dim small">Everything here can be explored now; adding liquidity opens when the DEX is deployed.</span>
                </div>
            )}
            {creating && <NewPosition key={preset ? tokenKey(preset) : 'new'} initial={preset} />}

            <div className="toolbar">
                <div className="tabs-boxed">
                    <button className={tab === 'pools' ? 'active' : ''} onClick={() => setTab('pools')}>All pools</button>
                    <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>My positions</button>
                    <button className={tab === 'vaults' ? 'active' : ''} onClick={() => setTab('vaults')}>Vaults <span className="soon-tag">soon</span></button>
                </div>
            </div>
            {tab === 'pools' && <PoolList onAdd={newPosition} />}
            {tab === 'mine' && <Positions />}
            {tab === 'vaults' && (
                <div className="card empty">
                    <span className="pill blue">Coming soon</span>
                    <h2 style={{ marginTop: 14 }}>Vaults</h2>
                    <p>Deposit once and let a vault keep your range around the price. They open after the DEX itself.</p>
                </div>
            )}
        </div>
    );
}

// Launch pools of the newest direct launches (the indexer does not list DEX pools yet).
function PoolList({ onAdd }: { onAdd: (t: DexToken) => void }) {
    const [rows, setRows] = useState<DexPool[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const masters = await recentLaunches(12);
                if (!alive) return;
                setRows([]);
                for (const m of masters) {
                    const t = await resolveToken(m).catch(() => null);
                    const p = t && (await launchPool(t).catch(() => null));
                    if (!alive) return;
                    if (p?.state) setRows((r) => [...(r ?? []), p]);
                }
            } catch (e: any) {
                if (alive) setError(e?.message ?? String(e));
            }
        })();
        return () => { alive = false; };
    }, []);

    if (error) return <div className="card error">{error}</div>;
    if (rows === null) return <div className="table"><div className="trow skeleton" /><div className="trow skeleton" /><div className="trow skeleton" /></div>;
    if (rows.length === 0) {
        return (
            <div className="card empty">
                <h2>No pools yet</h2>
                <p>Pools show up here once tokens launch on Marg DEX. Use “New position” to open one for any pair.</p>
            </div>
        );
    }
    return (
        <div className="table">
            <div className="thead pool-cols"><span>Pool</span><span>Fee</span><span className="right">Price</span><span className="right col-graph">Liquidity</span><span /></div>
            {rows.map((p) => {
                const s = p.state!;
                const fee = feeParts(p);
                const tax = taxOf(p);
                return (
                    <div key={p.address.toRawString()} className="trow pool-cols">
                        <Link to={p.token1.master ? `/token/${p.token1.master.toString()}` : '/swap'} className="tcell-token">
                            <Pair a={p.token0} b={p.token1} />
                            <div style={{ minWidth: 0 }}>
                                <div className="tname">{p.token0.symbol} / {p.token1.symbol}</div>
                                <div className="pool-tags">
                                    {p.canonical && <span className="pill blue">Launch pool</span>}
                                    {tax.buy + tax.sell > 0 && <span className="pill">Tax {tax.buy / 100}/{tax.sell / 100}%</span>}
                                </div>
                            </div>
                        </Link>
                        <span className="mono small">{pct(fee.total)}{fee.launch > 0n && <span className="hint"> ↘</span>}</span>
                        <span className="right mono small">{s.initialized ? fmtPrice(sqrtToPrice(s.sqrtPriceX96) * priceScale(p.token0, p.token1)) : '—'}</span>
                        <span className="right mono small col-graph">{fmtTon(s.reserve0, 0)} {p.token0.symbol}<br /><span className="hint">{fmtAmt(p.token1, s.reserve1)} {p.token1.symbol}</span></span>
                        <span className="right"><button className="button ghost" onClick={() => onAdd(p.token1)}>Add</button></span>
                    </div>
                );
            })}
        </div>
    );
}

export function Pair({ a, b, size = 28 }: { a: DexToken; b: DexToken; size?: number }) {
    return <span className="pair"><TokenIcon token={a} size={size} /><TokenIcon token={b} size={size} /></span>;
}

const RANGE_PRESETS: [string, number][] = [['±5%', 5], ['±10%', 10], ['±25%', 25], ['±50%', 50]];

// New position: pair, fee tier, price range and deposit (Uniswap v3 style), minted through the Router.
function NewPosition({ initial }: { initial: DexToken | null }) {
    const { wallet, send, connect } = useSend();
    const [tokenA, setTokenA] = useState<DexToken>(GRAM_TOKEN);
    const [tokenB, setTokenB] = useState<DexToken | null>(initial);
    const [picker, setPicker] = useState<'a' | 'b' | null>(null);
    const [pools, setPools] = useState<DexPool[] | null>(null);
    const [sel, setSel] = useState(0);
    const [full, setFull] = useState(false);
    const [minP, setMinP] = useState('');
    const [maxP, setMaxP] = useState('');
    const [startP, setStartP] = useState('');
    const [side, setSide] = useState<0 | 1>(0);
    const [input, setInput] = useState('');
    const [slippage, setSlippage] = useState(1);
    const [check, setCheck] = useState<string | null>(null);
    const [status, setStatus] = useState<string | null>(null);

    useEffect(() => {
        if (!tokenB) return;
        let alive = true;
        setPools([]);
        setSel(0);
        findPools(tokenA, tokenB, { onPool: (p) => alive && setPools((ps) => [...(ps ?? []), p]) }).catch(() => {});
        return () => { alive = false; };
    }, [tokenKey(tokenA), tokenB && tokenKey(tokenB)]);

    const pool = pools?.[sel] ?? null;
    const spacing = pool ? Number(pool.key.tickSpacing) : 60;
    const live = !!pool?.state?.initialized;
    const t0 = pool?.token0 ?? null;
    const t1 = pool?.token1 ?? null;
    // A pool that does not exist yet starts at the price the user enters (plain keys only).
    // Prices on screen are in whole tokens; the pool works in base units (USDT has 6 decimals).
    const scale = t0 && t1 ? priceScale(t0, t1) : 1;
    const initPrice = Number(startP.replace(',', '.'));
    const sqrtP = live ? pool!.state!.sqrtPriceX96 : initPrice > 0 ? priceToSqrt(initPrice / scale) : 0n;
    const tick = live ? Number(pool!.state!.tick) : sqrtP > 0n ? tickAt(sqrtP) : 0;
    const price = sqrtP > 0n ? sqrtToPrice(sqrtP) * scale : 0;
    const canInit = !!pool && !live && !pool.key.ext;

    // Center the range on the price when the pool changes, or when a new pool's starting price is edited.
    useEffect(() => {
        if (!(price > 0)) return;
        const t = setTimeout(() => applyPreset(25), live ? 0 : 500);
        return () => clearTimeout(t);
    }, [pool?.address.toRawString(), live, live ? 0 : startP]);

    function applyPreset(pctW: number) {
        setFull(false);
        setMinP(sig(price * (1 - pctW / 100)));
        setMaxP(sig(price * (1 + pctW / 100)));
    }

    const ticks = useMemo<[number, number] | null>(() => {
        if (full) return fullRange(spacing);
        const lo = Number(minP.replace(',', '.'));
        const hi = Number(maxP.replace(',', '.'));
        if (!(lo > 0) || !(hi > lo)) return null;
        return rangeToTicks(lo / scale, hi / scale, spacing);
    }, [full, minP, maxP, spacing, scale]);

    const sides = ticks && sqrtP > 0n ? rangeSides(tick, ticks[0], ticks[1]) : { need0: true, need1: true };
    const fixedSide: 0 | 1 = sides.need0 && sides.need1 ? side : sides.need0 ? 0 : 1;
    const amount = parseAmount(input, (fixedSide === 0 ? t0 : t1)?.decimals ?? 9);
    const dep = ticks && sqrtP > 0n ? depositFor(tick, sqrtP, ticks[0], ticks[1], fixedSide, amount) : null;
    const bal0 = useBalance(t0, wallet);
    const bal1 = useBalance(t1, wallet);
    // Gram the wallet attaches: one mint per leg (two for a jetton/jetton pair), plus 0.15 per jetton transfer.
    const jettonLegs = (t0?.master && dep?.a0 ? 1 : 0) + (t1?.master && dep?.a1 ? 1 : 0);
    const mintFee = (t0?.master && dep?.a0 && dep?.a1 ? 2n : 1n) * MINT_VALUE + BigInt(jettonLegs) * GAS.WALLET;
    const short0 = dep && bal0 !== null && dep.a0 + (t0?.master ? 0n : mintFee) > bal0;
    const short1 = dep && bal1 !== null && dep.a1 > bal1;
    // A new range moved to one side of the price: the typed amount may belong to the other token now.
    useEffect(() => { setInput(''); }, [sides.need0, sides.need1]);
    // Liquidity added during a launch's anti-snipe window is locked until the window ends.
    const launchEnds = pool?.state && pool.ext ? feeParts(pool).launchEnds : 0;
    const lockedTill = launchEnds > Date.now() / 1000 ? launchEnds : 0;
    const minLiquidity = dep ? (dep.L * BigInt(10_000 - slippage * 100)) / 10_000n : 0n;

    // Cross-check with the Pool's own get_mint_quote (deployed pools only), debounced.
    useEffect(() => {
        setCheck(null);
        if (!pool?.state || !ticks || !dep || dep.L === 0n) return;
        const t = setTimeout(() => {
            q(() => openPool(pool.address).getGetMintQuote(BigInt(ticks[0]), BigInt(ticks[1]), dep.a0, dep.a1, live ? 0n : sqrtP))
                .then((m) => setCheck(m.code === 0n ? null : codeText(m.code))).catch(() => {});
        }, 600);
        return () => clearTimeout(t);
    }, [pool?.address.toRawString(), ticks?.[0], ticks?.[1], dep?.a0, dep?.a1]);

    async function submit() {
        if (!wallet) return connect();
        if (!pool || !ticks || !dep || !DEX_ROUTER) return;
        try {
            setStatus('Confirm in your wallet…');
            const messages = await mintMessages({
                router: pool.router ?? DEX_ROUTER, pool, tickLower: ticks[0], tickUpper: ticks[1], amount0: dep.a0, amount1: dep.a1,
                minLiquidity, sqrtPriceInit: live ? 0n : sqrtP, slippageBps: slippage * 100, owner: wallet,
            });
            setStatus((await send(messages, 'Deposit')) || null);
        } catch (e: any) {
            setStatus(`Error: ${e?.message ?? e}`);
        }
    }

    // Gram + an unverified jetton in one transfer is refused (see trustedJetton in dex.ts).
    const untrusted = !!t1 && !!t0 && !t0.master && !!dep && dep.a0 > 0n && dep.a1 > 0n && !trustedJetton(t1);
    // MARG launch tokens: no new positions, in the launch pool or in any other pool of the pair. A
    // one-sided range in a taxed launch pool works as a limit order that skips the creator tax and the
    // platform fee (both are charged on swaps only), and a second plain pool would split the token's
    // liquidity away from its taxed launch pool. Existing positions are unaffected.
    const launchPair = !!pools?.some((p) => p.canonical || !!p.key.ext);
    const ready = !launchPair && !!pool && (live || (canInit && sqrtP > 0n)) && !!ticks && !!dep && dep.L >= 1000n && !short0 && !short1 && !check && !untrusted;
    const label = !DEX_LIVE ? CLOSED_LABEL
        : !wallet ? 'Connect wallet'
            : !tokenB ? 'Select a token'
                : !pool ? 'Loading pools…'
                : launchPair ? 'Launch tokens trade in their launch pool only'
                    : !live && !canInit ? 'This pool is opened by its launch'
                        : !live && !(sqrtP > 0n) ? 'Set a starting price'
                            : !ticks ? 'Set a price range'
                                : !dep || dep.L === 0n ? 'Enter an amount'
                                    : untrusted ? `Unverified token: add only ${t1!.symbol} (range above the price) or pick a MARG token`
                                    : short0 ? `Not enough ${t0!.symbol}` : short1 ? `Not enough ${t1!.symbol}`
                                        : check ?? 'Add liquidity';
    const priceUnit = t0 && t1 ? `${t0.symbol} per ${t1.symbol}` : '';

    return (
        <div className="card new-position">
            <h3>New position</h3>
            <div className="field-label">Pair</div>
            <div className="pair-pick">
                <button className="asset pick" onClick={() => setPicker('a')}><TokenIcon token={tokenA} />{tokenA.symbol}</button>
                <span className="hint">/</span>
                <button className="asset pick" onClick={() => setPicker('b')}>
                    {tokenB ? <><TokenIcon token={tokenB} />{tokenB.symbol}</> : <span className="pick-empty">Select token</span>}
                </button>
            </div>

            {tokenB && (
                <>
                    <div className="field-label">Fee tier</div>
                    <div className="tier-grid tiers-4">
                        {pools === null || pools.length === 0 ? <div className="hint small">Finding pools…</div> : pools.map((p, i) => {
                            const pr = presetOf(Number(p.key.tickSpacing));
                            return (
                                <button key={p.address.toRawString()} className={`tier-card ${i === sel ? 'active' : ''}`} onClick={() => setSel(i)}>
                                    <span className="tier-name">{p.canonical ? 'Launch pool' : pr?.name ?? `Spacing ${p.key.tickSpacing}`}</span>
                                    <span className="tier-raise">{pr ? pct(pr.basePips) : '—'}</span>
                                    <span className="tier-blurb">{p.state?.initialized ? `Live · ${fmtAmt(p.token0, p.state.reserve0)} ${p.token0.symbol}` : 'Not created yet'}</span>
                                </button>
                            );
                        })}
                    </div>
                </>
            )}

            {launchPair && (
                <p className="swap-warn">{t1?.symbol ?? 'This token'} is a MARG launch token. Its liquidity is locked in the launch pool, so new positions are not offered for this pair.</p>
            )}

            {pool && canInit && !launchPair && (
                <label>
                    Starting price ({priceUnit})
                    <input value={startP} onChange={(e) => setStartP(e.target.value)} inputMode="decimal" placeholder="0.000001" />
                    <span className="dim small">This pool does not exist yet. Your deposit creates it at this price, so set it to the market price.</span>
                </label>
            )}

            {pool && sqrtP > 0n && !launchPair && (
                <>
                    <div className="panel-head range-head">
                        <span className="field-label">Price range <span className="hint">({priceUnit})</span></span>
                        <span className="small">Now <b className="mono">{fmtPrice(price)}</b></span>
                    </div>
                    <div className="chips range-chips">
                        <button className={full ? 'active' : ''} onClick={() => setFull(true)}>Full range</button>
                        {RANGE_PRESETS.map(([l, v]) => <button key={l} onClick={() => applyPreset(v)}>{l}</button>)}
                    </div>
                    <div className="range-fields">
                        <label>Min price<input value={full ? '0' : minP} disabled={full} onChange={(e) => setMinP(e.target.value)} inputMode="decimal" /></label>
                        <label>Max price<input value={full ? '∞' : maxP} disabled={full} onChange={(e) => setMaxP(e.target.value)} inputMode="decimal" /></label>
                    </div>
                    {ticks && (
                        <p className="hint small range-note">
                            Ticks {ticks[0]} to {ticks[1]} (spacing {spacing})
                            {!full && ` · ${fmtPrice(tickToPrice(ticks[1]) * scale)} to ${fmtPrice(tickToPrice(ticks[0]) * scale)}`}
                            {!(sides.need0 && sides.need1) && ` · out of range now: only ${sides.need0 ? t0!.symbol : t1!.symbol} goes in`}
                            {(ticks[0] === minUsable(spacing) || ticks[1] === maxUsable(spacing)) && !full ? ' · clamped to the tick limits' : ''}
                        </p>
                    )}

                    <div className="field-label">Deposit</div>
                    {[0, 1].map((i) => {
                        const t = i === 0 ? t0! : t1!;
                        const needed = i === 0 ? sides.need0 : sides.need1;
                        const bal = i === 0 ? bal0 : bal1;
                        const typed = fixedSide === i;
                        const value = typed ? input : dep && dep.L > 0n ? trim(fmtUnits(i === 0 ? dep.a0 : dep.a1, t.decimals)) : '';
                        return (
                            <div key={i} className={`swap-field deposit ${needed ? '' : 'off'}`}>
                                <div className="row"><span>{needed ? (typed ? 'You deposit' : 'Matching amount') : 'Not needed in this range'}</span>{bal !== null && <span>Balance {fmtAmt(t, bal)}</span>}</div>
                                <div className="amount">
                                    <input value={value} disabled={!needed} placeholder="0" inputMode="decimal"
                                        onChange={(e) => { setSide(i as 0 | 1); setInput(e.target.value); }} />
                                    <span className="asset"><TokenIcon token={t} />{t.symbol}</span>
                                </div>
                            </div>
                        );
                    })}

                    <div className="meta">
                        <div className="row">
                            <span className="hint">Max slippage</span>
                            <span className="chips inline">{[0.5, 1, 3].map((s) => <button key={s} className={s === slippage ? 'active' : ''} onClick={() => setSlippage(s)}>{s}%</button>)}</span>
                        </div>
                        <div className="row"><span className="hint">Network fee</span><span className="mono">≤ {fmtTon(mintFee, 2)} Gram</span></div>
                        {lockedTill > 0 && (
                            <p className="swap-warn">This pool is in its launch window: liquidity added now is locked until {new Date(lockedTill * 1000).toLocaleTimeString()}. Fees can still be collected.</p>
                        )}
                        <p className="hint small" style={{ margin: '6px 0 0' }}>
                            Each new tick at your range edges costs {fmtTon(GAS.TICK_INIT_FEE + GAS.TICK_RENT, 2)} Gram, included above:
                            {' '}{fmtTon(GAS.TICK_INIT_FEE, 1)} stays in the pool for storage, {fmtTon(GAS.TICK_RENT, 2)} comes back when the tick is cleared.
                            If the price leaves the band you allowed, the deposit is refunded.
                        </p>
                    </div>
                </>
            )}
            <button className="button primary wide big" disabled={!DEX_LIVE || (!!wallet && !ready)} onClick={submit}>{label}</button>
            {status && <div className="status">{status}</div>}

            {picker && (
                <TokenPicker
                    exclude={picker === 'a' ? tokenB : tokenA}
                    onClose={() => setPicker(null)}
                    onPick={(t) => { if (picker === 'a') setTokenA(t); else setTokenB(t); setPicker(null); setInput(''); setStartP(''); }}
                />
            )}
        </div>
    );
}

// Position NFTs of the connected wallet, with collect / remove.
function Positions() {
    const { wallet, send, connect } = useSend();
    const [list, setList] = useState<MyPosition[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [version, setVersion] = useState(0);

    useEffect(() => {
        if (!wallet || !DEX_LIVE) return;
        let alive = true;
        setList(null);
        setError(null);
        myPositions(wallet, (p) => alive && setList((l) => [...(l ?? []), p]))
            .then((all) => alive && setList(all))
            .catch((e) => alive && setError(e?.message ?? String(e)));
        return () => { alive = false; };
    }, [wallet?.toRawString(), version]);

    async function act(p: MyPosition, fraction: number) {
        const delta = fraction === 0 ? 0n : (p.data.liquidity * BigInt(Math.round(fraction * 100))) / 100n;
        // 1% slippage on the principal; fees are always paid in full.
        const min = (a: bigint) => (a * BigInt(Math.round(fraction * 100)) * 99n) / 10_000n;
        setStatus('Confirm in your wallet…');
        const s = await send([decreaseMessage(p.address, delta, fraction ? min(p.amount0) : 0n, fraction ? min(p.amount1) : 0n)],
            fraction === 0 ? 'Fee claim' : 'Withdrawal');
        setStatus(s || null);
        if (s.includes(' sent')) setTimeout(() => setVersion((v) => v + 1), 12_000);
    }

    if (!DEX_LIVE) return <div className="card empty"><h2>No positions yet</h2><p>Your positions show up here once Marg DEX is live.</p></div>;
    if (!wallet) return <div className="card empty"><h2>Connect your wallet</h2><p>to see your liquidity positions.</p><button className="button primary" onClick={connect}>Connect wallet</button></div>;
    if (error) return <div className="card error">{error}</div>;
    if (list === null) return <div className="card skeleton" />;
    if (list.length === 0) return <div className="card empty"><h2>No positions</h2><p>Positions are NFTs in your wallet. Open one with “New position”.</p></div>;
    return (
        <>
            {status && <div className="card status">{status}</div>}
            <div className="positions">
                {list.map((p) => <PositionCard key={p.address.toRawString()} p={p} onAct={(f) => act(p, f)} />)}
            </div>
        </>
    );
}

function PositionCard({ p, onAct }: { p: MyPosition; onAct: (fraction: number) => void }) {
    const [part, setPart] = useState(100);
    const { token0: t0, token1: t1, state } = p.pool;
    const tL = Number(p.data.tickLower);
    const tU = Number(p.data.tickUpper);
    const tick = Number(state!.tick);
    const inRange = tick >= tL && tick < tU;
    const isFull = tL === minUsable(Number(p.pool.key.tickSpacing)) && tU === maxUsable(Number(p.pool.key.tickSpacing));
    const now = BigInt(Math.floor(Date.now() / 1000));
    const lock = p.data.lockedUntil === LOCKED_FOREVER ? 'Locked forever' : p.data.lockedUntil > now
        ? `Locked until ${new Date(Number(p.data.lockedUntil) * 1000).toLocaleString()}` : null;
    const pr = presetOf(Number(p.pool.key.tickSpacing));
    const hasFees = p.fees0 > 0n || p.fees1 > 0n;
    return (
        <div className="card position">
            <div className="info-head">
                <h3><Pair a={t0} b={t1} size={24} /> {t0.symbol} / {t1.symbol}</h3>
                <span className={`pill ${inRange ? 'green' : ''}`}>{inRange ? 'In range' : 'Out of range'}</span>
            </div>
            <div className="pool-tags">
                <span className="pill">{p.pool.canonical ? 'Launch pool' : pr ? `${pr.name} ${pct(pr.basePips)}` : `Spacing ${p.pool.key.tickSpacing}`}</span>
                <span className="pill">#{p.data.index.toString()}</span>
                {lock && <span className="pill blue">{lock}</span>}
            </div>
            <div className="row"><span className="hint">Range ({t0.symbol} per {t1.symbol})</span><span className="mono small">{isFull ? 'Full range' : `${fmtPrice(tickToPrice(tU) * priceScale(t0, t1))} – ${fmtPrice(tickToPrice(tL) * priceScale(t0, t1))}`}</span></div>
            <div className="row"><span className="hint">Liquidity</span><span className="mono small right">{fmtAmt(t0, p.amount0)} {t0.symbol} · {fmtAmt(t1, p.amount1)} {t1.symbol}</span></div>
            <div className="row"><span className="hint">Unclaimed fees</span><span className="mono small right">{fmtAmt(t0, p.fees0)} {t0.symbol} · {fmtAmt(t1, p.fees1)} {t1.symbol}</span></div>
            <div className="position-actions">
                <button className="button" disabled={!hasFees || p.data.busy} onClick={() => onAct(0)}>Collect fees</button>
                {!lock && (
                    <>
                        <span className="chips inline">{[25, 50, 100].map((v) => <button key={v} className={v === part ? 'active' : ''} onClick={() => setPart(v)}>{v}%</button>)}</span>
                        <button className="button sell" disabled={p.data.liquidity === 0n || p.data.busy} onClick={() => onAct(part / 100)}>Remove {part}%</button>
                    </>
                )}
            </div>
            {p.data.busy && <p className="hint small" style={{ margin: '8px 0 0' }}>An operation on this position is still settling.</p>}
        </div>
    );
}

// Price inputs: 6 significant digits, no exponent for normal ranges.
function sig(n: number): string {
    if (!(n > 0) || !Number.isFinite(n)) return '';
    return n >= 1e-6 && n < 1e15 ? String(Number(n.toPrecision(6))) : n.toPrecision(6);
}
const fmtUnits = (u: bigint, decimals = 9) => { const d = 10n ** BigInt(decimals); return `${u / d}.${(u % d).toString().padStart(decimals, '0')}`; };
const trim = (s: string) => s.replace(/\.?0+$/, '');

