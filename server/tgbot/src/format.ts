// Message building. Everything that comes from token metadata or the indexer is untrusted:
// it is length-capped first, then HTML-escaped, and only validated addresses / https images
// ever end up inside a URL.

export const esc = (s: unknown) =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Cap by code points (never split a surrogate pair), strip control characters.
export function cap(s: unknown, max: number): string {
    // eslint-disable-next-line no-control-regex
    const clean = String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').trim();
    const cps = [...clean];
    return cps.length > max ? cps.slice(0, max - 1).join('') + '…' : clean;
}
export const safe = (s: unknown, max: number) => esc(cap(s, max));
const oneLine = (s: unknown) => String(s ?? '').replace(/[\r\n\t]+/g, ' ');

// Token-controlled text (name, symbol, description). Telegram auto-links URLs, @mentions and
// /commands in plain text, so a symbol like "t.me/scam" would become clickable; inside <code>
// nothing is auto-linked. <code> must not be nested in <b>/<i>, so callers never wrap it.
export function tokText(s: unknown, max: number): string {
    return `<code>${safe(oneLine(s), max) || '?'}</code>`;
}

// Friendly (48 chars, base64url) or raw (wc:hex) TON address.
export const isAddress = (s: unknown): s is string =>
    typeof s === 'string' && (/^[A-Za-z0-9_-]{48}$/.test(s) || /^-?\d{1,3}:[0-9a-fA-F]{64}$/.test(s));

// CRC16-XMODEM, the checksum of user-friendly TON addresses.
function crc16(data: Uint8Array): number {
    let crc = 0;
    for (const b of data) {
        crc ^= b << 8;
        for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
}

// Mainnet, bounceable, url-safe form ("EQ…"/"Ef…"), the form the indexer keys tokens by.
export function friendlyAddress(wc: number, hash: Uint8Array): string {
    const b = Buffer.alloc(36);
    b[0] = 0x11;
    b[1] = wc & 0xff;
    Buffer.from(hash).copy(b, 2);
    b.writeUInt16BE(crc16(b.subarray(0, 34)), 34);
    return b.toString('base64url');
}

// Any TON address form (raw wc:hex, bounceable/non-bounceable, mainnet/testnet, base64 or
// base64url) -> friendlyAddress(), or null when malformed or the checksum is wrong.
export function normalizeAddress(s: unknown): string | null {
    if (typeof s !== 'string') return null;
    const raw = s.match(/^(-?\d{1,3}):([0-9a-fA-F]{64})$/);
    if (raw) {
        const wc = Number(raw[1]);
        return wc >= -128 && wc <= 127 ? friendlyAddress(wc, Buffer.from(raw[2], 'hex')) : null;
    }
    if (!/^[A-Za-z0-9_+/-]{48}$/.test(s)) return null;
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length !== 36) return null;
    if (![0x11, 0x51].includes(b[0] & 0x7f)) return null; // 0x80 = testnet flag
    if (b.readUInt16BE(34) !== crc16(b.subarray(0, 34))) return null;
    return friendlyAddress(b.readInt8(1), b.subarray(2, 34));
}

export const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

// nanoGram / 9-decimal token amount string -> number (0 when malformed).
export function fromNano(v: unknown): number {
    const s = typeof v === 'number' ? String(Math.trunc(v)) : String(v ?? '');
    if (!/^\d{1,40}$/.test(s)) return 0;
    const b = BigInt(s);
    return Number(b / 1_000_000_000n) + Number(b % 1_000_000_000n) / 1e9;
}

function trim(n: number, digits: number) {
    return n.toFixed(digits).replace(/\.?0+$/, '');
}
export function compact(n: number): string {
    if (!Number.isFinite(n)) return '0';
    const a = Math.abs(n);
    for (const [v, u] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
        if (a >= v) return trim(n / v, 2) + u;
    }
    if (a >= 1) return trim(n, 2);
    if (a === 0) return '0';
    return Number(n.toPrecision(3)).toString();
}
export const fmtGram = (n: number) => (Math.abs(n) >= 1000 ? compact(n) : Math.abs(n) >= 1 ? trim(n, 2) : Number(n.toPrecision(3)).toString());
export const fmtUsd = (n: number) => (Math.abs(n) >= 1000 ? '$' + compact(n) : '$' + (Math.abs(n) >= 0.01 || n === 0 ? n.toFixed(2) : Number(n.toPrecision(2)).toString()));

export function httpsImage(u: unknown): string | null {
    if (typeof u !== 'string' || u.length > 512) return null;
    try {
        const url = new URL(u);
        if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) return null;
        return url.toString();
    } catch {
        return null;
    }
}

// base64 / base64url 32-byte hash -> hex (what tonviewer's /transaction/ takes), else null.
export function hashHex(h: unknown): string | null {
    if (typeof h !== 'string' || h.length > 100) return null;
    if (/^[0-9a-fA-F]{64}$/.test(h)) return h.toLowerCase();
    if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(h)) return null;
    const b = Buffer.from(h.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return b.length === 32 ? b.toString('hex') : null;
}

export type Button = { text: string; url: string };
export const keyboard = (rows: Button[][]) => ({ inline_keyboard: rows });
export function tokenButtons(site: string, address: string) {
    const url = `${site}/token/${encodeURIComponent(address)}`;
    return keyboard([[{ text: '📈 Chart', url }, { text: '🟢 Buy', url }]]);
}

// Emoji the buy line is built from: 1–3 graphemes of pictographs, nothing ASCII.
export function validEmoji(s: string): boolean {
    if (!s || s.length > 32 || /[\x00-\x7f]/.test(s.replace(/[‍️]/g, ''))) return false;
    if (/[\s<>&]/.test(s)) return false;
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const parts = [...seg.segment(s)].map((x) => x.segment);
    return parts.length >= 1 && parts.length <= 3 && parts.every((p) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(p));
}

export type LaunchInfo = {
    launchFeePips: number; launchDuration: number; buyTaxBps: number; sellTaxBps: number;
    rewardsBps: number; walletBps: number; buybackBps: number;
    vaultBps?: number; vaultLock?: number; vaultVest?: number;
};

const pct = (bps: number) => trim(bps / 100, 2) + '%';
function dur(sec: number) {
    if (sec >= 86400) return trim(sec / 86400, 1) + 'd';
    if (sec >= 3600) return trim(sec / 3600, 1) + 'h';
    if (sec >= 60) return trim(sec / 60, 1) + 'm';
    return sec + 's';
}

export function launchMessage(t: any, usd: number | null, info: LaunchInfo | null): string {
    const mcap = fromNano(t.mcap);
    const lines = [
        '🚀 <b>New launch on MARG</b>',
        '',
        `${tokText(t.name, 64)} ($${tokText(t.symbol, 16)})`,
    ];
    if (cap(oneLine(t.description), 160)) lines.push(tokText(t.description, 160));
    lines.push('', `📊 Start market cap: ${fmtGram(mcap)} Gram${usd ? ` (${fmtUsd(mcap * usd)})` : ''}`);
    if (isAddress(t.creator)) lines.push(`👤 Creator: <a href="https://tonviewer.com/${t.creator}">${shortAddr(t.creator)}</a>`);
    if (info) {
        if (info.buyTaxBps || info.sellTaxBps) {
            const split = [
                info.rewardsBps ? `${pct(info.rewardsBps)} rewards` : '',
                info.walletBps ? `${pct(info.walletBps)} dev` : '',
                info.buybackBps ? `${pct(info.buybackBps)} buyback` : '',
            ].filter(Boolean).join(', ');
            lines.push(`🧾 Tax: ${pct(info.buyTaxBps)} buy / ${pct(info.sellTaxBps)} sell${split ? ` (split: ${split})` : ''}`);
        } else lines.push('🧾 No tax');
        if (info.launchFeePips > 0 && info.launchDuration > 0) {
            lines.push(`🛡 Anti-snipe: ${trim(info.launchFeePips / 10_000, 2)}% fee for the first ${dur(info.launchDuration)}`);
        }
        if (info.vaultBps) {
            lines.push(`🔒 Vault: ${pct(info.vaultBps)} of supply, ${dur(info.vaultLock ?? 0)} lock, ${dur(info.vaultVest ?? 0)} vest`);
        }
    }
    return lines.join('\n');
}

export function buyMessage(tr: any, emoji: string, usd: number | null): string {
    const gram = fromNano(tr.ton);
    const tokens = fromNano(tr.tokens);
    const sym = tokText(tr.symbol, 16);
    const price = typeof tr.price === 'number' && Number.isFinite(tr.price) && tr.price > 0 ? tr.price : 0;
    const mcapGram = price * 1e9; // fixed 1B supply
    const n = Math.max(1, Math.min(30, Math.floor(gram / 0.5)));
    const lines = [emoji.repeat(n), `${sym} <b>buy!</b>`, '', `💎 ${fmtGram(gram)} Gram${usd ? ` (${fmtUsd(gram * usd)})` : ''}`, `🪙 ${compact(tokens)} ${sym}`];
    const hex = hashHex(tr.hash);
    const tx = hex ? ` | <a href="https://tonviewer.com/transaction/${hex}">Tx</a>` : '';
    if (isAddress(tr.trader)) lines.push(`👤 <a href="https://tonviewer.com/${tr.trader}">${shortAddr(tr.trader)}</a>${tx}`);
    if (mcapGram) lines.push(`📊 Market cap ${usd ? fmtUsd(mcapGram * usd) : `${fmtGram(mcapGram)} Gram`}`);
    return lines.join('\n');
}

export const HELP = [
    '<b>MARG bot</b>: buy alerts for MARG tokens.',
    '',
    'Add me to your group, then (group admins):',
    '/track &lt;token address or marg.lol/token link&gt; — post buys of that token',
    '/untrack — stop posting buys',
    '/min &lt;gram&gt; — only post buys of at least this size',
    '/emoji &lt;emoji&gt; — emoji for the buy bar',
    '/status — current settings',
    '',
    'New launches: https://marg.lol',
].join('\n');
