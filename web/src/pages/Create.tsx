import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Address, beginCell, toNano } from '@ton/core';
import { useTonAddress, useTonConnectUI } from '@tonconnect/ui-react';
import { storeCreateToken, type FactoryData } from '../../../launch/build/Launch_LaunchFactory';
import { buildOnchainContent, client, explorer, fmtCompact, fmtTon, q } from '../ton';
import { buyMove, devBuyShare, LAUNCH_FACTORY, launchFactory, loadFactoryData, SNIPE_MAX_PCT, SNIPE_MAX_SEC, TAX_MAX_PCT, TAX_MIN_PCT, TIER_INFO, type TierKey } from '../launch';
import { TokenImage } from './Home';

const CREATE_MARGIN = toNano('0.05');
import { useGramUsd } from '../usd';
import { ImageUpload } from '../ImageUpload';

// Used only when the factory getter can't be read; the excess is refunded.

function parseGram(s: string): bigint {
    try {
        return s ? toNano(s.replace(',', '.')) : 0n;
    } catch {
        return -1n;
    }
}

// "2.5" -> 250 bps; null when it isn't 0 or a value between min and max.
function parsePctBps(s: string, min: number, max: number): number | null {
    if (s.trim() === '') return 0;
    const n = Number(s.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || (n > 0 && n < min) || n > max) return null;
    return Math.round(n * 100);
}

type Snipe = 'off' | 'fast' | 'slow' | 'custom';
const SNIPE_PRESETS: Record<Exclude<Snipe, 'custom'>, { pct: number; sec: number; label: string }> = {
    off: { pct: 0, sec: 0, label: 'Off' },
    fast: { pct: 90, sec: 15, label: '90% · 15 s' },
    slow: { pct: 15, sec: 300, label: '15% · 5 min' },
};

type SplitKey = 'rewards' | 'wallet' | 'buyback';
const SPLITS: { key: SplitKey; label: string; hint: string; color: string }[] = [
    { key: 'rewards', label: 'Holder rewards', hint: 'Paid to holders in Gram, by how much they hold. They claim it on the token page.', color: 'var(--accent)' },
    { key: 'wallet', label: 'Wallet', hint: 'Sent straight to your wallet, or to the address below.', color: '#8b5cf6' },
    { key: 'buyback', label: 'Buyback & burn', hint: 'Buys the token on its pool and burns it, automatically and in small steps.', color: '#f59e0b' },
];
const SPLIT_PRESETS: [string, [number, number, number]][] = [
    ['Even', [34, 33, 33]], ['Holders', [80, 0, 20]], ['Burn', [0, 0, 100]], ['Wallet', [0, 100, 0]],
];

const pctNum = (s: string) => { const n = Number(s.replace(',', '.')); return Number.isFinite(n) ? n : 0; };

// Dragging one share's slider moves the other two in proportion, so the split stays at 100%.
function rebalance(split: Record<SplitKey, string>, key: SplitKey, v: number): Record<SplitKey, string> {
    const [a, b] = SPLITS.map((s) => s.key).filter((k) => k !== key);
    const rest = 100 - v;
    const wa = Math.max(0, pctNum(split[a])), wb = Math.max(0, pctNum(split[b]));
    const na = wa + wb === 0 ? Math.round(rest / 2) : Math.round((rest * wa) / (wa + wb));
    return { ...split, [key]: String(v), [a]: String(na), [b]: String(rest - na) } as Record<SplitKey, string>;
}

// Ring showing how the tax is shared; the middle shows the buy / sell tax.
function SplitDonut({ parts, buy, sell }: { parts: { value: number; color: string }[]; buy: string; sell: string }) {
    const r = 42, c = 2 * Math.PI * r;
    const total = parts.reduce((t, p) => t + Math.max(0, p.value), 0);
    let at = 0;
    return (
        <svg className="split-donut" viewBox="0 0 110 110" role="img" aria-label="Tax split">
            <circle cx="55" cy="55" r={r} fill="none" stroke="var(--border)" strokeWidth="14" />
            {total > 0 && parts.map((p, i) => {
                const len = (Math.max(0, p.value) / Math.max(total, 100)) * c;
                const el = len > 0 && (
                    <circle key={i} cx="55" cy="55" r={r} fill="none" stroke={p.color} strokeWidth="14"
                        strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-at} transform="rotate(-90 55 55)" />
                );
                at += len;
                return el;
            })}
            <text x="55" y="51" textAnchor="middle" className="donut-big">{buy || 0}% / {sell || 0}%</text>
            <text x="55" y="68" textAnchor="middle" className="donut-small">buy / sell</text>
        </svg>
    );
}

export function Create() {
    const [tonConnect] = useTonConnectUI();
    const wallet = useTonAddress();

    const [name, setName] = useState('');
    const [symbol, setSymbol] = useState('');
    const [description, setDescription] = useState('');
    const [image, setImage] = useState('');
    const [devBuy, setDevBuy] = useState('');
    const [snipe, setSnipe] = useState<Snipe>('fast');
    const [snipePct, setSnipePct] = useState('90');
    const [snipeSec, setSnipeSec] = useState('15');
    const [tier, setTier] = useState<TierKey>('low');
    const usd = useGramUsd();
    const [taxOn, setTaxOn] = useState(false);
    // Creator vault: up to 50% of supply, locked 7..365 days, then unlocked over 0..365 days.
    const [vaultOn, setVaultOn] = useState(false);
    const [vaultPct, setVaultPct] = useState('20');
    const [lockDays, setLockDays] = useState('7');
    const [vestDays, setVestDays] = useState('30');
    const [buyTax, setBuyTax] = useState('3');
    const [sellTax, setSellTax] = useState('3');
    const [split, setSplit] = useState({ rewards: '34', wallet: '33', buyback: '33' });
    const [taxTo, setTaxTo] = useState('');
    const [data, setData] = useState<FactoryData | null>(null);
    const [createValue, setCreateValue] = useState<bigint | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [launched, setLaunched] = useState<Address | null>(null);
    const navigate = useNavigate();

    useEffect(() => {
        loadFactoryData().then(setData).catch(() => setStatus('The launch factory is not reachable right now.'));
    }, []);

    const devBuyNano = parseGram(devBuy);
    useEffect(() => {
        // Cleared at once so the button waits for the value that matches this dev buy.
        setCreateValue(null);
        if (!launchFactory || devBuyNano < 0n) return;
        const t = setTimeout(() => {
            q(() => launchFactory!.getGetCreateValue2(devBuyNano, vaultOn)).then((v) => alive && setCreateValue(v)).catch(() => alive && setCreateValue(null));
        }, 400);
        let alive = true;
        return () => { alive = false; clearTimeout(t); };
    }, [devBuyNano, vaultOn]);

    const tierParams = data?.tiers[tier] ?? null;
    const startMcap = tierParams?.startMcap ?? TIER_INFO[tier].fallback;

    // Anti-snipe: pips are millionths of the input (900000 = 90%).
    const snipeVal = (() => {
        if (snipe !== 'custom') return SNIPE_PRESETS[snipe];
        const pct = Number(snipePct.replace(',', '.'));
        const sec = Math.round(Number(snipeSec));
        // At least 1 pip (0.0001%): the contract needs fee and duration both set or both 0.
        if (!(pct >= 0.0001 && pct <= SNIPE_MAX_PCT) || !(sec >= 1 && sec <= SNIPE_MAX_SEC)) return null;
        return { pct, sec, label: '' };
    })();

    const buyBps = taxOn ? parsePctBps(buyTax, TAX_MIN_PCT, TAX_MAX_PCT) : 0;
    const sellBps = taxOn ? parsePctBps(sellTax, TAX_MIN_PCT, TAX_MAX_PCT) : 0;
    const anyTax = (buyBps ?? 0) + (sellBps ?? 0) > 0;
    const splitBps = {
        rewards: parsePctBps(split.rewards, 0, 100), wallet: parsePctBps(split.wallet, 0, 100), buyback: parsePctBps(split.buyback, 0, 100),
    };
    const splitSum = (splitBps.rewards ?? 0) + (splitBps.wallet ?? 0) + (splitBps.buyback ?? 0);
    const splitValid = !anyTax || (splitBps.rewards !== null && splitBps.wallet !== null && splitBps.buyback !== null && splitSum === 10_000
        && ((splitBps.rewards ?? 0) === 0 || (splitBps.wallet ?? 0) + (splitBps.buyback ?? 0) > 0));
    const taxWallet = (() => {
        if (!anyTax || taxTo.trim() === '') return null;
        try {
            return Address.parse(taxTo.trim());
        } catch {
            return undefined;
        }
    })();
    // Ticking "Tax token" with both sides at 0 would silently launch untaxed.
    const taxValid = buyBps !== null && sellBps !== null && splitValid && taxWallet !== undefined && (!taxOn || anyTax);

    const vault = (() => {
        if (!vaultOn) return { bps: 0, lock: 0, vest: 0 };
        const pct = Number(vaultPct.replace(',', '.'));
        const lock = Number(lockDays);
        const vest = Number(vestDays || '0');
        if (!(pct >= 0.01 && pct <= 50) || !(Number.isInteger(lock) && lock >= 7 && lock <= 365) || !(Number.isInteger(vest) && vest >= 0 && vest <= 365)) return null;
        return { bps: Math.round(pct * 100), lock: lock * 86400, vest: vest * 86400 };
    })();

    // Dev buy preview: tokens and share of supply (platform fee 1% = the Router's starting rate).
    const devShare = devBuyShare(Number(devBuyNano) / 1e9, Number(startMcap) / 1e9,
        1 - (vault?.bps ?? 0) / 10_000, buyBps ?? 0, 100);
    const fmtTokensShort = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0);

    const valid = vault !== null && image.length > 0 && name.trim().length > 0 && /^[A-Za-z0-9]{1,10}$/.test(symbol)
        && devBuyNano >= 0n && taxValid && snipeVal !== null;
    // The factory's own get_create_value2 for this exact dev buy, plus a margin so a gas-price rise between
    // this page and the launch does not make the factory refuse it (audit R7A-3). The unused gas comes back.
    const total = createValue !== null ? createValue + CREATE_MARGIN : null;

    async function launch() {
        if (!wallet) return tonConnect.openModal();
        if (!launchFactory || !LAUNCH_FACTORY || total === null || !snipeVal || !data || !tierParams || !valid) return;
        try {
            setStatus('Confirm in your wallet…');
            const index = (await q(() => launchFactory!.getGetFactoryData())).nextIndex;
            const me = Address.parse(wallet);
            const content = buildOnchainContent({
                name: name.trim(), symbol: symbol.toUpperCase(),
                description: description.trim() || undefined, image: image.trim() || undefined,
            });
            const body = beginCell().store(storeCreateToken({
                $$type: 'CreateToken', queryId: 0n, content,
                devBuy: devBuyNano, minDevOut: 0n,
                buyTaxBps: BigInt(buyBps ?? 0), sellTaxBps: BigInt(sellBps ?? 0),
                taxWallet: taxWallet ?? null,
                rewardsBps: BigInt(anyTax ? splitBps.rewards ?? 0 : 0),
                walletBps: BigInt(anyTax ? splitBps.wallet ?? 0 : 0),
                buybackBps: BigInt(anyTax ? splitBps.buyback ?? 0 : 0),
                antiSnipePips: BigInt(Math.round(snipeVal.pct * 10_000)), antiSnipeDuration: BigInt(snipeVal.sec),
                // The factory refuses (and refunds) if its launch params changed after this page loaded.
                startMcap: tierParams.startMcap, tickSpacing: tierParams.tickSpacing,
                vaultBps: BigInt(vault!.bps), vaultLock: BigInt(vault!.lock), vaultVest: BigInt(vault!.vest),
            })).endCell();
            await tonConnect.sendTransaction({
                validUntil: Math.floor(Date.now() / 1000) + 300,
                messages: [{ address: LAUNCH_FACTORY.toString(), amount: total.toString(), payload: body.toBoc().toString('base64') }],
            });
            setStatus('Launching… waiting for the chain');
            // Ours is the first new token created by this wallet (someone else may launch at the same time),
            // and it counts only once its pool exists (get_launched).
            const checked = new Set<bigint>();
            for (let i = 0; i < 40; i++) {
                await new Promise((r) => setTimeout(r, 3000));
                const next = (await q(() => launchFactory!.getGetFactoryData())).nextIndex;
                for (let k = index; k < next; k++) {
                    if (checked.has(k)) continue;
                    const master = await q(() => launchFactory!.getGetTokenAddress(k));
                    const info = await q(() => client.runMethod(master, 'get_launch_info')).catch(() => null);
                    if (!info) continue; // not deployed yet: look again next round
                    if (!info.stack.readTuple().readAddress().equals(me)) { checked.add(k); continue; }
                    const live = await q(() => client.runMethod(master, 'get_launched')).then((r) => r.stack.readBoolean()).catch(() => false);
                    if (live) {
                        setLaunched(master);
                        // Straight to the new token's page (the success line stays as a fallback).
                        navigate(`/token/${master.toString()}`);
                        setStatus(null);
                        return;
                    }
                }
            }
            setStatus('Sent, but no live pool showed up yet. Check your wallet history: if the launch was refused, the Gram came back.');
        } catch (e: any) {
            setStatus(e?.message?.includes('Reject') ? 'Cancelled in wallet' : `Error: ${e?.message ?? e}`);
        }
    }

    const snipeFact = !snipeVal ? '—' : snipeVal.pct === 0 ? 'Off' : `${snipeVal.pct}%`;
    const snipeSub = !snipeVal || snipeVal.pct === 0 ? 'no anti-snipe fee' : `fading to 0 over ${snipeVal.sec < 120 ? `${snipeVal.sec} s` : `${Math.round(snipeVal.sec / 60)} min`}`;

    return (
        <div className="narrow">
            <Link to="/" className="back">‹ Discover</Link>
            <h1>Launch a token</h1>
            <p className="dim">
                Your token goes straight into a MARG DEX pool and trades from the first block. No bonding curve,
                nothing to fill, no graduation.
            </p>

            <div className="launch-facts">
                <div><span>Supply</span><b>1B</b><small>all of it in the pool</small></div>
                <div><span>Starts at</span><b>{fmtCompact(startMcap)}</b><small>Gram market cap</small></div>
                <div><span>Liquidity</span><b>Locked</b><small>forever, nobody can pull it</small></div>
                <div><span>Anti-snipe</span><b>{snipeFact}</b><small>{snipeSub}</small></div>
            </div>

            <div className="preview">
                <TokenImage src={image.trim() || undefined} symbol={symbol || '?'} size={56} />
                <div style={{ minWidth: 0 }}>
                    <b>{name || 'Token name'}</b> <span className="hint">${symbol || 'TICKER'}</span>
                    <div className="hint small">{description || 'Your description shows up here.'}</div>
                </div>
            </div>

            <div className="card form">
                <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Gram Cat" /></label>
                <label>Ticker<input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} maxLength={10} placeholder="GCAT" /></label>
                <label>Description<textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} rows={3} /></label>
                <ImageUpload value={image} onChange={setImage} />

                <label>
                    Dev buy (optional, Gram)
                    <input value={devBuy} onChange={(e) => setDevBuy(e.target.value)} inputMode="decimal" placeholder="0" />
                    {devShare > 0 && (
                        <span className="dev-preview mono">
                            ≈ {fmtTokensShort(devShare * 1e9)} {symbol.trim() ? symbol.toUpperCase() : 'tokens'} · {(devShare * 100).toFixed(devShare < 0.001 ? 3 : 2)}% of supply
                        </span>
                    )}
                    <span className="dim small">Bought in the launch transaction itself, so nobody can buy before you. The anti-snipe fee doesn't apply to it; the platform fee, the pool fee and your buy tax do.</span>
                </label>

                <div className="opt-field">
                    <span className="field-label">Liquidity</span>
                    <div className="tier-grid">
                        {(Object.keys(TIER_INFO) as TierKey[]).map((k) => {
                            const m = data?.tiers[k].startMcap ?? TIER_INFO[k].fallback;
                            const g = Number(m) / 1e9;
                            return (
                                <button key={k} type="button" className={`tier-card ${tier === k ? 'active' : ''}`} onClick={() => setTier(k)}>
                                    <span className="tier-name">{TIER_INFO[k].name}</span>
                                    <span className="tier-raise">{fmtCompact(m)}</span>
                                    <span className="tier-blurb">Gram start mcap{usd ? ` · ≈$${fmtCompact(BigInt(Math.round(g * usd * 1e9)))}` : ''}</span>
                                    <span className="tier-blurb">+{(buyMove(10, g) * 100).toFixed(2)}% per 10 Gram buy</span>
                                </button>
                            );
                        })}
                    </div>
                    <span className="dim small">{TIER_INFO[tier].blurb} The whole supply always goes into the pool and the liquidity is locked forever; the tier only sets where the price starts, which decides how much each buy moves it.</span>
                </div>

                <div className="opt-field">
                    <span className="field-label">Anti-snipe fee</span>
                    <div className="chips">
                        {(Object.keys(SNIPE_PRESETS) as Exclude<Snipe, 'custom'>[]).map((k) => (
                            <button key={k} type="button" className={snipe === k ? 'active' : ''} onClick={() => setSnipe(k)}>{SNIPE_PRESETS[k].label}</button>
                        ))}
                        <button type="button" className={snipe === 'custom' ? 'active' : ''} onClick={() => setSnipe('custom')}>Custom</button>
                    </div>
                    {snipe === 'custom' && (
                        <div className="tax-fields">
                            <label>Starting fee %<input value={snipePct} onChange={(e) => setSnipePct(e.target.value)} inputMode="decimal" /></label>
                            <label>Fades out over (seconds)<input value={snipeSec} onChange={(e) => setSnipeSec(e.target.value)} inputMode="numeric" /></label>
                        </div>
                    )}
                    <span className="dim small">
                        {snipeVal === null ? `Fee up to ${SNIPE_MAX_PCT}%, over 1 s to ${SNIPE_MAX_SEC / 60} min. ` : ''}
                        An extra fee on buys right after launch that drops to 0 second by second, so bots gain little by buying first.
                    </span>
                </div>

                <label className="check">
                    <input type="checkbox" checked={vaultOn} onChange={(e) => setVaultOn(e.target.checked)} />
                    <span>Creator vault <span className="dim small">· lock up to 50% of the supply for yourself, released after a lock</span></span>
                </label>
                {vaultOn && (
                    <div className="tax-box">
                        <div className="tax-fields" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
                            <label>Share of supply %<input value={vaultPct} onChange={(e) => setVaultPct(e.target.value)} inputMode="decimal" placeholder="20" /></label>
                            <label>Locked for (days)<input value={lockDays} onChange={(e) => setLockDays(e.target.value)} inputMode="numeric" placeholder="7" /></label>
                            <label>Then unlocks over (days)<input value={vestDays} onChange={(e) => setVestDays(e.target.value)} inputMode="numeric" placeholder="30" /></label>
                        </div>
                        <div className="chips">
                            {[10, 20, 30, 50].map((p) => <button key={p} type="button" className={vaultPct === String(p) ? 'active' : ''} onClick={() => setVaultPct(String(p))}>{p}%</button>)}
                        </div>
                        <span className="dim small">
                            {vault === null ? 'Share 0.01–50%, lock 7–365 days, unlock 0–365 days (whole days). ' : ''}
                            {vault && vault.bps > 0 ? `${vault.bps / 100}% of the supply (${(vault.bps / 100 * 10).toLocaleString('en-US')}M tokens) goes to a vault only you can claim from: nothing for ${vault.lock / 86400} days, then ${vault.vest === 0 ? 'all of it at once' : `gradually over ${vault.vest / 86400} days`}. The other ${100 - vault.bps / 100}% goes into the pool. ` : ''}
                            Buyers see the vault and its schedule on the token page. Vault tokens don't earn holder rewards while locked.
                        </span>
                    </div>
                )}

                <label className="check">
                    <input type="checkbox" checked={taxOn} onChange={(e) => setTaxOn(e.target.checked)} />
                    <span>Tax token <span className="dim small">· take {TAX_MIN_PCT}–{TAX_MAX_PCT}% of every buy and sell, in Gram</span></span>
                </label>
                {taxOn && (
                    <div className="tax-box">
                        <div className="tax-top">
                            <SplitDonut buy={buyTax} sell={sellTax} parts={SPLITS.map((s) => ({ value: pctNum(split[s.key]), color: s.color }))} />
                            <div className="tax-sliders">
                                {([['Buy tax', buyTax, setBuyTax], ['Sell tax', sellTax, setSellTax]] as const).map(([label, v, set]) => (
                                    <label key={label}>
                                        <span className="slider-head">{label}<span className="split-input"><input value={v} onChange={(e) => set(e.target.value)} inputMode="decimal" placeholder="0" />%</span></span>
                                        <input type="range" min={0} max={TAX_MAX_PCT} step={0.1} value={pctNum(v)}
                                            style={{ '--p': `${Math.min(100, (pctNum(v) / TAX_MAX_PCT) * 100)}%` } as React.CSSProperties}
                                            onChange={(e) => { const n = Number(e.target.value); set(String(n > 0 && n < TAX_MIN_PCT ? TAX_MIN_PCT : n)); }} />
                                    </label>
                                ))}
                            </div>
                        </div>

                        <span className="field-label">Where the tax goes</span>
                        <div className="chips">
                            {SPLIT_PRESETS.map(([label, [r, w, b]]) => (
                                <button key={label} type="button" onClick={() => setSplit({ rewards: String(r), wallet: String(w), buyback: String(b) })}>{label}</button>
                            ))}
                        </div>
                        {SPLITS.map((s) => (
                            <div key={s.key} className="split-row" style={{ '--c': s.color } as React.CSSProperties}>
                                <div className="split-main">
                                    <div className="split-head">
                                        <div><b><i className="split-dot" />{s.label}</b><span className="dim small">{s.hint}</span></div>
                                        <span className="split-input">
                                            <input value={split[s.key]} onChange={(e) => setSplit({ ...split, [s.key]: e.target.value })} inputMode="decimal" />%
                                        </span>
                                    </div>
                                    <input type="range" min={0} max={100} step={1} value={Math.min(100, Math.max(0, pctNum(split[s.key])))}
                                        style={{ '--p': `${Math.min(100, Math.max(0, pctNum(split[s.key])))}%` } as React.CSSProperties}
                                        onChange={(e) => setSplit(rebalance(split, s.key, Number(e.target.value)))} />
                                </div>
                            </div>
                        ))}
                        <div className={`split-sum ${splitValid ? 'ok' : 'bad'}`}>
                            Total {splitSum / 100}% {splitSum !== 10_000 ? '· must be 100%' : (splitBps.rewards ?? 0) > 0 && (splitBps.wallet ?? 0) + (splitBps.buyback ?? 0) === 0 ? '· holder rewards need a buyback or wallet share' : '✓'}
                        </div>

                        {(splitBps.wallet ?? 0) > 0 && (
                            <label>
                                Wallet share goes to
                                <input value={taxTo} onChange={(e) => setTaxTo(e.target.value)} placeholder="Your wallet" />
                            </label>
                        )}
                        <span className="dim small">
                            {buyBps === null || sellBps === null ? `Each tax can be 0 or ${TAX_MIN_PCT} to ${TAX_MAX_PCT}%. ` : ''}
                            {taxWallet === undefined ? 'That address is not valid. ' : ''}
                            Taxes and the split are fixed at launch and can't be changed later. With holder rewards on, token
                            transfers cost a little more gas (about 0.1 Gram), because rewards are tracked on every transfer.
                        </span>
                        {(splitBps.rewards ?? 0) > 0 && (
                            <span className="dim small">
                                Holder rewards start once holders together own at least 1% of the supply (tokens in the pool
                                don't count). Until then the rewards share goes to the buyback, else the tax wallet, so holder rewards need a
                                buyback or wallet share. A dev buy of at least 1% of the supply starts rewards at once.
                            </span>
                        )}
                    </div>
                )}

                <div className="summary">
                    <span className="dim">You pay</span>
                    <span>{total !== null ? `${fmtTon(total)} Gram` : '—'} <span className="dim small">(includes a 0.05 Gram gas margin; unused gas is refunded)</span></span>
                </div>

                <button className="button primary wide" disabled={!LAUNCH_FACTORY || (!!wallet && (!valid || total === null))} onClick={launch}>
                    {!LAUNCH_FACTORY ? 'Opens with Marg DEX' : wallet ? 'Launch token' : 'Connect wallet'}
                </button>
                {status && <div className="status">{status}</div>}
                {launched && (
                    <div className="status">
                        Launched. <Link to={`/token/${launched.toString()}`}>Open the token</Link> · <a href={explorer(launched)} target="_blank" rel="noreferrer">explorer ↗</a>
                    </div>
                )}
            </div>
        </div>
    );
}
