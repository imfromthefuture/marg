// Shared by the web app and the indexer, so nothing here may touch import.meta or the DOM.
import { beginCell, Cell, Dictionary } from '@ton/core';
import { sha256_sync } from '@ton/crypto';

// --- TEP-64 metadata ------------------------------------------------------

// incomplete: off-chain metadata could not be fetched, so decimals may be wrong; callers must not trade on it.
export type TokenMeta = { name: string; symbol: string; description?: string; image?: string; decimals?: number; incomplete?: boolean };

const key = (k: string) => BigInt('0x' + sha256_sync(k).toString('hex'));
const snake = (s: string) => beginCell().storeUint(0, 8).storeStringTail(s).endCell();

// On-chain content, so no metadata server is needed.
export function buildOnchainContent(meta: TokenMeta): Cell {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    dict.set(key('name'), snake(meta.name));
    dict.set(key('symbol'), snake(meta.symbol));
    dict.set(key('decimals'), snake('9'));
    if (meta.description) dict.set(key('description'), snake(meta.description));
    if (meta.image) dict.set(key('image'), snake(meta.image));
    return beginCell().storeUint(0, 8).storeDict(dict).endCell();
}

const metaCache = new Map<string, TokenMeta>();

// TEP-64 decimals (a string, 9 when missing).
const decimalsOf = (v: unknown) => { const n = Number(v ?? 9); return Number.isInteger(n) && n >= 0 && n <= 18 ? n : 9; };

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const safeUrl = (v: unknown) => { const u = str(v, 500); return u && /^(https?|ipfs):\/\//i.test(u) ? u : undefined; };

async function fetchJson(url: string): Promise<any> {
    const res = await fetch(url.replace('ipfs://', 'https://ipfs.io/ipfs/'), { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`metadata ${res.status}`);
    return res.json();
}

// TEP-64 content: on-chain dict (optionally with a `uri` to merge, "semi-chain"), or an off-chain URL.
// Values are coerced to short strings, so odd metadata can't break a page. A failed fetch is not
// cached, so the next visit retries (decimals matter: a wrong 9 would scale amounts).
export async function parseContent(content: Cell): Promise<TokenMeta> {
    const cacheKey = content.hash().toString('hex');
    const hit = metaCache.get(cacheKey);
    if (hit) return hit;
    let raw: Record<string, unknown> = {};
    let complete = true;
    try {
        const s = content.beginParse();
        const prefix = s.loadUint(8);
        if (prefix === 0) {
            const dict = s.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
            const read = (k: string) => {
                try {
                    const c = dict.get(key(k));
                    if (!c) return undefined;
                    const cs = c.beginParse();
                    if (cs.remainingBits >= 8 && cs.preloadUint(8) === 0) cs.skip(8);
                    return cs.loadStringTail();
                } catch {
                    return undefined;
                }
            };
            const uri = safeUrl(read('uri'));
            if (uri) {
                try { raw = { ...(await fetchJson(uri)) }; } catch { complete = false; }
            }
            for (const k of ['name', 'symbol', 'description', 'image', 'decimals']) {
                const v = read(k);
                if (v !== undefined) raw[k] = v;
            }
        } else if (prefix === 1) {
            const url = safeUrl(s.loadStringTail());
            if (url) {
                try { raw = { ...(await fetchJson(url)) }; } catch { complete = false; }
            }
        }
    } catch {
        /* malformed content cell: defaults */
    }
    const meta: TokenMeta = {
        name: str(raw.name, 64) || 'Unknown', symbol: str(raw.symbol, 16) || '???',
        description: str(raw.description, 1000), image: safeUrl(raw.image), decimals: decimalsOf(raw.decimals),
        incomplete: !complete || undefined,
    };
    if (complete) metaCache.set(cacheKey, meta);
    return meta;
}
