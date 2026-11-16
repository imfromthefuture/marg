// Hardened TEP-64 metadata parser for the indexer. Never throws: any malformed content cell or
// unreachable off-chain JSON gives the defaults. Strings are coerced, cleaned and length-capped,
// and the off-chain fetch is limited (https/ipfs only, 5 s, 64 KB, no private or loopback hosts).
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { Cell, Dictionary, Slice } from '@ton/core';
import { sha256_sync } from '@ton/crypto';

// partial: off-chain metadata could not be fetched (defaults used); worth retrying later.
export type TokenMeta = { name: string; symbol: string; description?: string; image?: string; decimals: number; partial?: boolean };

export const LIMITS = { name: 64, symbol: 16, description: 1000, image: 500 };
const FETCH_TIMEOUT = 5000;
const FETCH_MAX_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const IPFS_GATEWAY = (process.env.IPFS_GATEWAY ?? 'https://ipfs.io/ipfs/').replace(/\/?$/, '/');
const DEFAULTS = (): TokenMeta => ({ name: 'Unknown', symbol: '???', decimals: 9 });

// ---------------------------------------------------------------- string coercion

// Any value -> a clean string of at most `max` characters (code points), or undefined.
export function cleanText(v: unknown, max: number, multiline = false): string | undefined {
    if (typeof v === 'number' || typeof v === 'bigint') v = String(v);
    if (typeof v !== 'string') return undefined;
    // Control characters (keep \n and \t in descriptions), bidi overrides and zero-width chars.
    const ctrl = multiline ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g;
    let s = v.replace(ctrl, multiline ? '' : ' ').replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').trim();
    if (!multiline) s = s.replace(/\s+/g, ' ');
    if (!s) return undefined;
    const chars = Array.from(s);
    return chars.length > max ? chars.slice(0, max).join('') : s;
}

// Image URL: http(s) or ipfs only, no whitespace, at most LIMITS.image characters.
export function cleanImage(v: unknown): string | undefined {
    if (typeof v !== 'string') return undefined;
    const s = v.trim();
    if (!s || s.length > LIMITS.image || /[\s"'<>\\`]/.test(s)) return undefined;
    if (/^ipfs:\/\/[A-Za-z0-9._\-/]+$/.test(s)) return s;
    try {
        const u = new URL(s);
        if ((u.protocol === 'https:' || u.protocol === 'http:') && u.hostname && !u.username && !u.password) return s;
    } catch { /* not a URL */ }
    return undefined;
}

const decimalsOf = (v: unknown) => {
    const n = Number(typeof v === 'string' || typeof v === 'number' ? v : 9);
    return Number.isInteger(n) && n >= 0 && n <= 18 ? n : 9;
};

function metaFrom(o: Record<string, unknown>): TokenMeta {
    return {
        name: cleanText(o.name, LIMITS.name) ?? 'Unknown',
        symbol: cleanText(o.symbol, LIMITS.symbol) ?? '???',
        description: cleanText(o.description, LIMITS.description, true),
        image: cleanImage(o.image),
        decimals: decimalsOf(o.decimals),
    };
}

// ---------------------------------------------------------------- on-chain cells

const key = (k: string) => BigInt('0x' + sha256_sync(k).toString('hex'));
const KEYS = ['name', 'symbol', 'description', 'image', 'decimals'] as const;
const KEY_IDS = new Map(KEYS.map((k) => [k, key(k)]));

// Snake string with a byte cap; bad UTF-8 is replaced, not thrown.
function readSnake(s: Slice, maxBytes: number): string {
    const parts: Buffer[] = [];
    let total = 0;
    let cur: Slice | null = s;
    for (let depth = 0; cur && depth < 64 && total < maxBytes; depth++) {
        const bytes = Math.floor(cur.remainingBits / 8);
        if (bytes > 0) {
            const b = cur.loadBuffer(bytes);
            parts.push(b);
            total += b.length;
        }
        cur = cur.remainingRefs > 0 ? cur.loadRef().beginParse() : null;
    }
    return Buffer.concat(parts).subarray(0, maxBytes).toString('utf8');
}

function readValue(c: Cell, maxBytes: number): string | undefined {
    const cs = c.beginParse();
    if (cs.remainingBits >= 8) {
        const tag = cs.preloadUint(8);
        if (tag === 0) cs.skip(8); // snake
        else if (tag === 1) return undefined; // chunked: not used by Marg launches
    }
    return readSnake(cs, maxBytes);
}

function parseOnchain(s: Slice): TokenMeta {
    const dict = s.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    const o: Record<string, unknown> = {};
    for (const k of KEYS) {
        try {
            const c = dict.get(KEY_IDS.get(k)!);
            // Read a little more than the character cap (UTF-8 is up to 4 bytes per character).
            if (c) o[k] = readValue(c, (k === 'decimals' ? 4 : LIMITS[k]) * 4 + 16);
        } catch { /* one bad entry only loses that field */ }
    }
    return metaFrom(o);
}

// ---------------------------------------------------------------- off-chain fetch

// True for addresses that must never be fetched: loopback, private, link-local, CGNAT,
// multicast, reserved, unspecified, and their IPv4-mapped IPv6 forms.
export function isBlockedIp(ip: string): boolean {
    const v = net.isIP(ip);
    if (v === 4) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
            (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
    }
    if (v === 6) {
        const x = ip.toLowerCase();
        const mapped = x.match(/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isBlockedIp(mapped[1]);
        if (x === '::' || x === '::1') return true;
        return /^(fc|fd|fe[89ab]|ff)/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8') || /^0*:/.test(x);
    }
    return true; // not an IP at all
}

// DNS lookup that refuses blocked addresses. Used by the socket itself, so a rebinding DNS
// answer between a check and the connect cannot slip through.
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
    dns.lookup(hostname, { ...(options as dns.LookupOptions), all: true }, (err, addresses) => {
        if (err) return (callback as any)(err);
        const list = (addresses as dns.LookupAddress[]).filter((a) => !isBlockedIp(a.address));
        if (list.length === 0 || list.length !== (addresses as dns.LookupAddress[]).length) {
            return (callback as any)(Object.assign(new Error(`blocked address for ${hostname}`), { code: 'EBLOCKED' }));
        }
        if ((options as dns.LookupOptions).all) return (callback as any)(null, list);
        (callback as any)(null, list[0].address, list[0].family);
    });
};

// Rewrites ipfs:// to the gateway; returns null for anything other than https (port 443).
export function fetchableUrl(raw: string): URL | null {
    let s = raw.trim();
    if (s.length > 1000) return null;
    if (s.startsWith('ipfs://')) {
        const path = s.slice(7).replace(/^ipfs\//, '');
        if (!/^[A-Za-z0-9._\-/]+$/.test(path)) return null;
        s = IPFS_GATEWAY + path;
    }
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isBlockedIp(host)) return null;
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) return null;
    return u;
}

// GET with the limits above; resolves the body or rejects.
export function fetchLimited(raw: string, redirects = MAX_REDIRECTS): Promise<Buffer> {
    const u = fetchableUrl(raw);
    if (!u) return Promise.reject(new Error('url not allowed'));
    return new Promise((resolve, reject) => {
        const req = https.get(u, {
            lookup: safeLookup, signal: AbortSignal.timeout(FETCH_TIMEOUT),
            headers: { Accept: 'application/json', 'User-Agent': 'marg-indexer' },
        }, (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                if (redirects <= 0) return reject(new Error('too many redirects'));
                let next: string;
                try { next = new URL(res.headers.location, u).toString(); } catch { return reject(new Error('bad redirect')); }
                return fetchLimited(next, redirects - 1).then(resolve, reject);
            }
            if (status !== 200) {
                res.resume();
                return reject(new Error(`status ${status}`));
            }
            if (Number(res.headers['content-length'] ?? 0) > FETCH_MAX_BYTES) {
                res.destroy();
                return reject(new Error('too large'));
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (c: Buffer) => {
                size += c.length;
                if (size > FETCH_MAX_BYTES) {
                    res.destroy();
                    reject(new Error('too large'));
                    return;
                }
                chunks.push(c);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}

async function parseOffchain(s: Slice): Promise<TokenMeta> {
    const url = readSnake(s, 1024);
    const body = await fetchLimited(url);
    const json = JSON.parse(body.toString('utf8'));
    if (!json || typeof json !== 'object' || Array.isArray(json)) return DEFAULTS();
    return metaFrom(json as Record<string, unknown>);
}

// ---------------------------------------------------------------- entry

const cache = new Map<string, TokenMeta>();

// Content cell (or anything else) -> metadata. Never throws.
export async function parseMeta(content: unknown): Promise<TokenMeta> {
    if (!(content instanceof Cell)) return DEFAULTS();
    let cacheKey: string;
    try { cacheKey = content.hash().toString('hex'); } catch { return DEFAULTS(); }
    const hit = cache.get(cacheKey);
    if (hit) return hit;
    let meta = DEFAULTS();
    let final = true;
    try {
        const s = content.beginParse();
        if (s.remainingBits >= 8) {
            const prefix = s.loadUint(8);
            if (prefix === 0) meta = parseOnchain(s);
            else if (prefix === 1) {
                try {
                    meta = await parseOffchain(s);
                } catch {
                    final = false; // may be reachable later: do not cache the defaults
                    meta = { ...DEFAULTS(), partial: true };
                }
            }
        }
    } catch {
        meta = DEFAULTS();
    }
    if (final) {
        if (cache.size > 5000) cache.clear();
        cache.set(cacheKey, meta);
    }
    return meta;
}
