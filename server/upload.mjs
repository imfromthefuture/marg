// Token image upload service. No dependencies.
// POST /api/upload with the raw image as the body (Content-Type: image/png|jpeg|webp|gif).
// Stores the file under its SHA-256 and returns { url }. nginx serves the files from /u/.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 8810);
const DIR = process.env.UPLOAD_DIR ?? '/var/www/tron-uploads';
const PUBLIC_BASE = process.env.PUBLIC_BASE ?? '';  // e.g. https://tron.example
const MAX_BYTES = 5 * 1024 * 1024;
// Total size of the upload folder; new files are refused above it (default 2 GB).
const DISK_QUOTA = Number(process.env.UPLOAD_QUOTA_BYTES ?? 2 * 1024 ** 3);
// New bytes stored per client IP per UTC day (default 50 MB). Duplicates of stored files are free.
const IP_DAILY_BYTES = Number(process.env.UPLOAD_IP_DAILY_BYTES ?? 20 * 1024 ** 2);
// New bytes stored per UTC day by everyone together (default 150 MB): many IPs together can no
// longer fill DISK_QUOTA in one day (audit R2-L5); it would take two weeks and is visible.
const ALL_DAILY_BYTES = Number(process.env.UPLOAD_ALL_DAILY_BYTES ?? 150 * 1024 ** 2);

// Folder usage, read once at start and kept up to date on each write.
let used = 0;
try {
    for (const f of readdirSync(DIR)) {
        try { used += statSync(join(DIR, f)).size; } catch { /* vanished */ }
    }
} catch (e) {
    console.error('cannot read upload dir', e?.message ?? e);
}

// Per-IP bytes for the current UTC day (reset at midnight; in memory, so a restart resets it too).
let day = '';
const perIp = new Map();
let allToday = 0;
function ipUsage(ip) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) { day = today; perIp.clear(); allToday = 0; }
    return perIp.get(ip) ?? 0;
}
// nginx sets X-Real-IP to $remote_addr; the service only listens on 127.0.0.1.
// IPv6 users get a whole /64 each, so the daily cap is keyed on the /64, not the full address.
const clientIp = (req) => {
    const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '?').slice(0, 64);
    return ip.includes(':') && !ip.startsWith('::ffff:') ? ip.split(':').slice(0, 4).join(':') + '::/64' : ip;
};

// Content is identified by its magic bytes, never by the client's claim. No SVG (it can carry scripts).
function detect(buf) {
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.length >= 6 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'gif';
    if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return null;
}

function reply(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/upload') return reply(res, 404, { error: 'Not found' });
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BYTES) return reply(res, 413, { error: 'Image is larger than 5 MB' });
    const ip = clientIp(req);
    if (used >= DISK_QUOTA) return reply(res, 507, { error: 'Upload storage is full, try again later' });
    if (ipUsage(ip) + Math.max(declared, 0) > IP_DAILY_BYTES) return reply(res, 429, { error: 'Daily upload limit reached' });
    if (allToday + Math.max(declared, 0) > ALL_DAILY_BYTES) return reply(res, 429, { error: 'Uploads are paused for today, try again tomorrow' });

    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
        if (aborted) return;
        size += c.length;
        if (size > MAX_BYTES) {
            aborted = true;
            reply(res, 413, { error: 'Image is larger than 5 MB' });
            req.destroy();
            return;
        }
        chunks.push(c);
    });
    req.on('end', () => {
        if (aborted) return;
        const buf = Buffer.concat(chunks);
        const ext = detect(buf);
        if (!ext) return reply(res, 415, { error: 'Only PNG, JPG, WEBP or GIF images are allowed' });
        const name = `${createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${ext}`;
        const path = join(DIR, name);
        try {
            if (!existsSync(path)) {
                if (used + buf.length > DISK_QUOTA) return reply(res, 507, { error: 'Upload storage is full, try again later' });
                if (ipUsage(ip) + buf.length > IP_DAILY_BYTES) return reply(res, 429, { error: 'Daily upload limit reached' });
                if (allToday + buf.length > ALL_DAILY_BYTES) return reply(res, 429, { error: 'Uploads are paused for today, try again tomorrow' });
                writeFileSync(path + '.tmp', buf, { mode: 0o644 });
                renameSync(path + '.tmp', path);
                used += buf.length;
                perIp.set(ip, ipUsage(ip) + buf.length);
                allToday += buf.length;
            }
        } catch (e) {
            console.error('write failed', e);
            return reply(res, 500, { error: 'Could not store image' });
        }
        reply(res, 200, { url: `${PUBLIC_BASE}/u/${name}` });
    });
    req.on('error', () => {});
});

server.requestTimeout = 30_000;
server.listen(PORT, '127.0.0.1', () => console.log(`upload service on 127.0.0.1:${PORT}, storing in ${DIR}`));
