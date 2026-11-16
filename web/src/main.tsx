import './polyfills';
import React, { lazy, Suspense, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { useGramUsd } from './usd';
import { BrowserRouter, Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { Address } from '@ton/core';
import { TonConnectButton, TonConnectUIProvider, THEME, useTonConnectUI } from '@tonconnect/ui-react';
import { Home } from './pages/Home';
import { Create } from './pages/Create';
import { Token } from './pages/Token';
import { DEX_LIVE } from './dexenv';
import { Docs } from './pages/Docs';
import { IS_TESTNET } from './ton';
import { initialTheme, initTelegram, saveTheme } from './telegram';
import { api, ApiToken } from './api';
import { Change } from './pages/Home';
import { fmtCompact } from './ton';
import './styles.css';

initTelegram();
const startTheme = initialTheme();

// The DEX pages carry the contract bindings: load them on demand.
const Swap = lazy(() => import('./pages/Swap').then((m) => ({ default: m.Swap })));
const Pools = lazy(() => import('./pages/Pools').then((m) => ({ default: m.Pools })));

const manifestUrl = import.meta.env.VITE_MANIFEST_URL || `${window.location.origin}/tonconnect-manifest.json`;
const TG_BLUE = '#2f8ff0';

const icons = {
    explore: <><circle cx="12" cy="12" r="9" /><path d="M12 4l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" /></>,
    launch: <path d="M6 20V9a6 6 0 0 1 12 0v11zM12 9v6M9 12h6" />,
    wallet: <path d="M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2h11M16 14h.01" />,
    moon: <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>,
    swap: <path d="M7 4v16M7 4L3 8M7 4l4 4M17 20V4M17 20l-4-4M17 20l4-4" />,
    pools: <><circle cx="9" cy="9" r="5" /><circle cx="15" cy="15" r="5" /></>,
};

export function Icon({ name, size = 20 }: { name: keyof typeof icons; size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            {icons[name]}
        </svg>
    );
}

export const X_URL = 'https://x.com/Marg_lol';
export const TG_URL = 'https://t.me/marglolportal';
export const TG_LAUNCHES_URL = 'https://t.me/marglollaunches';

function XLogo({ size = 16 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.78zm-1.08 16.17h1.7L7.4 4.74H5.58z" />
        </svg>
    );
}


function Search() {
    const navigate = useNavigate();
    const [value, setValue] = useState('');
    function submit(v: string) {
        try {
            navigate(`/token/${Address.parse(v.trim()).toString()}`);
            setValue('');
        } catch {
            navigate(`/?q=${encodeURIComponent(v.trim())}`);
        }
    }
    return (
        <form className="search" onSubmit={(e) => { e.preventDefault(); if (value.trim()) submit(value); }}>
            <Icon name="search" size={18} />
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Search name, ticker or address" />
        </form>
    );
}

function Ticker() {
    const [tokens, setTokens] = useState<ApiToken[]>([]);
    useEffect(() => {
        const load = () => api.tokens().then((t) => setTokens(t.filter((x) => (x.kind ?? 'dex') === 'dex' && x.trades24h > 0).slice(0, 20))).catch(() => {});
        load();
        const t = setInterval(load, 30_000);
        return () => clearInterval(t);
    }, []);
    if (tokens.length < 3) return null;
    const items = [...tokens, ...tokens];
    return (
        <div className="ticker">
            <div className="track">
                {items.map((t, i) => (
                    <Link key={i} to={`/token/${t.address}`}>
                        <span>{t.symbol}</span> {fmtCompact(BigInt(t.mcap))} <Change value={t.change24h} />
                    </Link>
                ))}
            </div>
        </div>
    );
}

function App() {
    const [theme, setTheme] = useState(startTheme);
    const [, setOptions] = useTonConnectUI();
    const usd = useGramUsd();

    function toggleTheme() {
        const next = theme === 'dark' ? 'light' : 'dark';
        saveTheme(next);
        setTheme(next);
        setOptions({ uiPreferences: { theme: next === 'dark' ? THEME.DARK : THEME.LIGHT } });
    }

    return (
        <>
            <header className="topbar">
                <Link to="/" className="brand" title="Marg">
                    <img src="/icon.png" alt="" /><span>MARG</span>
                </Link>
                <nav className="nav">
                    <NavLink to="/" end>Discover</NavLink>
                    <NavLink to="/create">Launch</NavLink>
                    <NavLink to="/swap">Swap {!DEX_LIVE && <span className="soon">soon</span>}</NavLink>
                    <NavLink to="/pools">Pools {!DEX_LIVE && <span className="soon">soon</span>}</NavLink>
                    <NavLink to="/docs">Docs</NavLink>
                </nav>
                <Search />
                {IS_TESTNET && <span className="net">testnet</span>}
                {usd !== null && <span className="chip mono"><span className="dot">G</span><b>${usd.toFixed(2)}</b></span>}
                <a className="chip icon-btn x-link" href={X_URL} target="_blank" rel="noreferrer" title="MARG on X"><XLogo /></a>
                <button className="chip icon-btn" onClick={toggleTheme} title="Light / dark">
                    <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
                </button>
                <TonConnectButton className="connect" />
            </header>
            <Ticker />
            <main>
                <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/create" element={<Create />} />
                    <Route path="/token/:address" element={<Token />} />
                    <Route path="/swap" element={<Suspense fallback={<div className="card skeleton tall" />}><Swap /></Suspense>} />
                    <Route path="/pools" element={<Suspense fallback={<div className="card skeleton tall" />}><Pools /></Suspense>} />
                    <Route path="/docs" element={<Docs />} />
                    <Route path="*" element={<div className="card empty"><b>Page not found</b><p className="dim"><Link to="/">Back to Discover</Link></p></div>} />
                </Routes>
            </main>
            <footer className="footer">
                <span>© MARG · launch and trade on TON · <Link to="/docs">Docs</Link> · <a href={X_URL} target="_blank" rel="noreferrer">X @Marg_lol</a> · <a href={TG_URL} target="_blank" rel="noreferrer">Telegram</a> · <a href={TG_LAUNCHES_URL} target="_blank" rel="noreferrer">New launches</a></span>
                <span>Trades settle on-chain. Nothing here is financial advice.</span>
            </footer>
            <nav className="bottom-nav">
                <NavLink to="/" end><Icon name="explore" />Discover</NavLink>
                <NavLink to="/create"><Icon name="launch" />Launch</NavLink>
                <NavLink to="/swap"><Icon name="swap" />Swap{!DEX_LIVE && <span className="soon">soon</span>}</NavLink>
                <a href="https://t.me/wallet" target="_blank" rel="noreferrer"><Icon name="wallet" />Wallet</a>
            </nav>
        </>
    );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <TonConnectUIProvider
            manifestUrl={manifestUrl}
            uiPreferences={{
                theme: startTheme === 'dark' ? THEME.DARK : THEME.LIGHT,
                borderRadius: 'm',
                colorsSet: {
                    [THEME.LIGHT]: { accent: TG_BLUE, connectButton: { background: TG_BLUE, foreground: '#ffffff' } },
                    [THEME.DARK]: { accent: TG_BLUE, connectButton: { background: TG_BLUE, foreground: '#ffffff' } },
                },
            }}
        >
            <BrowserRouter>
                <App />
            </BrowserRouter>
        </TonConnectUIProvider>
    </React.StrictMode>,
);
