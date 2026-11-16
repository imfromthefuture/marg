import { useEffect, useState } from 'react';
import { fromNano } from '@ton/core';

// Gram/USD from CoinGecko (still listed under its old id), shared by every component: one fetch
// every 2 minutes however many places show a USD value.
let current: number | null = null;
const listeners = new Set<(v: number | null) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function load() {
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd')
        .then((r) => r.json())
        .then((j) => {
            const v = j?.['the-open-network']?.usd;
            if (typeof v === 'number' && v > 0) {
                current = v;
                listeners.forEach((l) => l(v));
            }
        })
        .catch(() => {});
}

export function useGramUsd(): number | null {
    const [usd, setUsd] = useState(current);
    useEffect(() => {
        listeners.add(setUsd);
        if (!timer) {
            load();
            timer = setInterval(load, 120_000);
        }
        return () => { listeners.delete(setUsd); };
    }, []);
    return usd;
}

// $12.4K style for a nanoGram amount; null while the price is unknown.
export function fmtUsd(nano: bigint, usd: number | null): string | null {
    if (usd === null) return null;
    const n = Number(fromNano(nano)) * usd;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 0 })}`;
}
