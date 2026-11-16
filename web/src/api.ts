// Client for the indexer (server/indexer), served by nginx under /api/idx.
export type ApiToken = {
    address: string; index: number; name: string; symbol: string; description: string | null; image: string | null;
    creator: string; createdAt: number | null; lastTradeAt: number | null;
    price: number; mcap: string;
    volume24h: string; trades24h: number; change24h: number;
    spark?: number[]; tradesTotal?: number; volumeTotal?: string;
    kind?: string; pool?: string | null;
};
export type ApiTrade = {
    hash: string; utime: number; isBuy: boolean; trader: string; ton: string; tokens: string; price: number;
    token?: string; symbol?: string; image?: string | null;
};
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type Holders = { source: 'chain' | 'trades'; count: number; more: boolean; top: { owner: string; balance: string }[] };

async function get<T>(path: string): Promise<T> {
    const res = await fetch(`/api/idx${path}`);
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    return res.json();
}

const enc = encodeURIComponent;
export const api = {
    tokens: () => get<ApiToken[]>('/tokens'),
    token: (a: string) => get<ApiToken>(`/token/${enc(a)}`),
    trades: (a: string, limit = 50) => get<ApiTrade[]>(`/token/${enc(a)}/trades?limit=${limit}`),
    candles: (a: string, tf: number) => get<Candle[]>(`/token/${enc(a)}/candles?tf=${tf}`),
    holders: (a: string) => get<Holders>(`/token/${enc(a)}/holders`),
    feed: (limit = 30) => get<ApiTrade[]>(`/trades?limit=${limit}`),
};

export function ago(utime: number | null | undefined): string {
    if (!utime) return '';
    const s = Math.max(0, Math.floor(Date.now() / 1000) - utime);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
    return `${Math.floor(s / (86400 * 30))}mo`;
}

// Small token prices need more digits: 0.0000123 rather than 0.
export function fmtPrice(p: number): string {
    if (!p) return '0';
    if (p >= 1) return p.toLocaleString('en-US', { maximumFractionDigits: 4 });
    return p.toPrecision(3);
}
