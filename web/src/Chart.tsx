import { useEffect, useRef, useState } from 'react';
import { AreaSeries, CandlestickSeries, ColorType, createChart, HistogramSeries, IChartApi, UTCTimestamp } from 'lightweight-charts';
import { api, Candle } from './api';

const FRAMES: [string, number][] = [['1m', 60], ['5m', 300], ['15m', 900], ['1h', 3600], ['6h', 21600], ['1d', 86400]];

function css(name: string) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Price chart from the indexer's candles. Refreshes every 10 s.
export function PriceChart({ address, version }: { address: string; version: number }) {
    const box = useRef<HTMLDivElement>(null);
    const [tf, setTf] = useState(300);
    const [mode, setMode] = useState<'candles' | 'line'>('candles');
    const [data, setData] = useState<Candle[] | null>(null);
    const [error, setError] = useState(false);
    const [theme, setTheme] = useState(document.documentElement.dataset.theme);

    useEffect(() => {
        const obs = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => obs.disconnect();
    }, []);

    useEffect(() => {
        let alive = true;
        const load = () => api.candles(address, tf).then((c) => { if (alive) { setData(c); setError(false); } }).catch(() => alive && setError(true));
        load();
        const t = setInterval(load, 10_000);
        return () => { alive = false; clearInterval(t); };
    }, [address, tf, version]);

    useEffect(() => {
        if (!box.current || !data || data.length === 0) return;
        const text = css('--hint');
        const grid = css('--border');
        const green = css('--green');
        const red = css('--red');
        const chart: IChartApi = createChart(box.current, {
            autoSize: true,
            layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: text, fontFamily: 'inherit', attributionLogo: false },
            grid: { vertLines: { color: grid }, horzLines: { color: grid } },
            rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.22 } },
            timeScale: { borderVisible: false, timeVisible: tf < 86400 },
            localization: { priceFormatter: (p: number) => (p >= 1 ? p.toFixed(2) : p.toPrecision(3)) },
            crosshair: { mode: 0 },
        });
        const t = (c: Candle) => c.time as UTCTimestamp;
        if (mode === 'candles') {
            const s = chart.addSeries(CandlestickSeries, {
                upColor: green, downColor: red, wickUpColor: green, wickDownColor: red, borderVisible: false,
                priceFormat: { type: 'price', minMove: 1e-12, precision: 12 },
            });
            s.setData(data.map((c) => ({ time: t(c), open: c.open, high: c.high, low: c.low, close: c.close })));
        } else {
            const s = chart.addSeries(AreaSeries, {
                lineColor: green, topColor: green + '55', bottomColor: green + '00', lineWidth: 2,
                priceFormat: { type: 'price', minMove: 1e-12, precision: 12 },
            });
            s.setData(data.map((c) => ({ time: t(c), value: c.close })));
        }
        const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
        chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        vol.setData(data.map((c) => ({ time: t(c), value: c.volume, color: (c.close >= c.open ? green : red) + '66' })));
        chart.timeScale().fitContent();
        return () => chart.remove();
    }, [data, mode, theme]);

    return (
        <div className="chart-card">
            <div className="chart-tools">
                <div className="seg">
                    <button className={mode === 'line' ? 'active' : ''} onClick={() => setMode('line')}>Line</button>
                    <button className={mode === 'candles' ? 'active' : ''} onClick={() => setMode('candles')}>Candles</button>
                </div>
                <div className="seg">
                    {FRAMES.map(([label, s]) => (
                        <button key={s} className={tf === s ? 'active' : ''} onClick={() => setTf(s)}>{label}</button>
                    ))}
                </div>
            </div>
            {error && !data ? <div className="chart-empty">Chart unavailable right now.</div>
                : data && data.length === 0 ? <div className="chart-empty">No trades yet.</div>
                    : <div className="chart" ref={box} />}
        </div>
    );
}

// 24h sparkline for the token list.
export function Sparkline({ points }: { points?: number[] }) {
    if (!points || points.length < 2) return null;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    const w = 120;
    const h = 36;
    const d = points.map((p, i) => `${(i / (points.length - 1)) * w},${h - 2 - ((p - min) / span) * (h - 4)}`).join(' ');
    const up = points[points.length - 1] >= points[0];
    return (
        <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
            <polyline points={d} fill="none" stroke={up ? 'var(--green)' : 'var(--red)'} strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
    );
}
