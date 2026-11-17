// Marg indexer: follows every token the factories launched, stores each trade in SQLite and
// serves lists, trades, candles and holders. Direct launches (LAUNCH_FACTORY) trade in their
// Marg DEX pool (SwapEvent); plain DEX pools are followed too (src/dex.ts).
//
// Robustness rules: one bad token or transaction never stops the loop. Each token's discovery
// and each transaction is handled in its own try; a token that keeps failing is stored with
// placeholder metadata (repaired later) so the index advances.
import http from 'node:http';
import Database from 'better-sqlite3';
import { Address, beginCell, Cell, TupleReader, type TupleItem } from '@ton/core';
import { TonClient } from '@ton/ton';
import { LaunchFactory } from '../../../launch/build/Launch_LaunchFactory';
import { LaunchJetton } from '../../../launch/build/Launch_LaunchJetton';
import { Router } from '../../../dex/v2/build/Router_Router';
import { loadGetterTuplePoolState, loadModifyEvent, Pool } from '../../../dex/v2/build/Router_Pool';
import { loadSwapEvent } from './swapevent';
import { parseMeta, TokenMeta } from './meta';
import { createDex, PoolSnap } from './dex';

const NETWORK = process.env.NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
// Comma-separated, append-only: the position of a factory fixes its tokens' idx range.
const LAUNCH_FACTORIES = (process.env.LAUNCH_FACTORY ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((a) => Address.parse(a));
const API_KEY = process.env.TONCENTER_API_KEY || undefined;
const PORT = Number(process.env.PORT ?? 8811);
const BASE = NETWORK === 'mainnet' ? 'https://toncenter.com' : 'https://testnet.toncenter.com';
// Tokens left out of the public lists (tests, scams); their pages still work by address.
const HIDDEN = new Set((process.env.HIDE_TOKENS ?? '').split(',').filter(Boolean).map((a) => Address.parse(a.trim()).toRawString()));
const SWAP_OP = 0x4d480071;
const MODIFY_OP = 0x4d480072;
// Launch factory k (0-based, in LAUNCH_FACTORY order) gives its token i idx = SPAN * (k + 1) + i,
// so the first launch factory keeps 1_000_000 + i (idx below SPAN is not used).
const SPAN = 1_000_000;
const SUPPLY = 10n ** 18n; // 1B tokens, 9 decimals
const Q192 = 1n << 192n;
const DAY = 86400;
const MAX_FAILS = Number(process.env.MAX_TOKEN_FAILS ?? 5); // rounds before a token is stored as a placeholder
const DISCOVER_BATCH = 50;                                   // tokens per source per round, so trades keep flowing
const CANDLE_TRADES = 5000;                                  // candles cover at most the last N trades

const client = new TonClient({ endpoint: `${BASE}/api/v2/jsonRPC`, apiKey: API_KEY });
// DEX Routers (one per launch factory); their jetton wallets hold pool liquidity, not a holder's tokens.
export const dexRouters = new Set<string>();

// ---------------------------------------------------------------- storage

export const db = new Database(process.env.DB_PATH ?? './indexer.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS tokens (
    address TEXT PRIMARY KEY, idx INTEGER UNIQUE NOT NULL,
    name TEXT, symbol TEXT, description TEXT, image TEXT, creator TEXT,
    created_at INTEGER, ton_reserve TEXT, token_reserve TEXT, real_ton TEXT,
    graduated INTEGER NOT NULL DEFAULT 0, last_lt TEXT NOT NULL DEFAULT '0', last_trade_at INTEGER,
    -- launch price inputs (virtual_ton = start price scaled by SUPPLY); graduated/graduation_ton are legacy
    virtual_ton TEXT NOT NULL, virtual_tokens TEXT NOT NULL, graduation_ton TEXT NOT NULL, max_supply TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trades (
    hash TEXT PRIMARY KEY, token TEXT NOT NULL, lt TEXT NOT NULL, utime INTEGER NOT NULL,
    is_buy INTEGER NOT NULL, trader TEXT NOT NULL, ton TEXT NOT NULL, tokens TEXT NOT NULL,
    ton_reserve TEXT NOT NULL, token_reserve TEXT NOT NULL, real_ton TEXT NOT NULL, price REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_token_time ON trades (token, utime);
CREATE INDEX IF NOT EXISTS trades_time ON trades (utime);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);
// Direct launches: kind = 'dex' and the pool their trades happen in. Their price is kept in
// ton_reserve / token_reserve as Gram per token scaled by SUPPLY, so mcap and price math is shared.
// placeholder = 1: discovery kept failing, metadata (and maybe the pool) is still to be filled in.
for (const col of ["kind TEXT NOT NULL DEFAULT 'curve'", 'pool TEXT', 'placeholder INTEGER NOT NULL DEFAULT 0']) {
    try { db.exec(`ALTER TABLE tokens ADD COLUMN ${col}`); } catch { /* already there */ }
}
db.exec('CREATE INDEX IF NOT EXISTS tokens_pool ON tokens (pool)');
const kvGet = (k: string) => (db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as any)?.v as string | undefined;
const kvSet = (k: string, v: string) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);

// ---------------------------------------------------------------- toncenter

// One request at a time with a gap: 1 rps without a key, ~8 rps with one.
const GAP = API_KEY ? 120 : 1100;
let nextSlot = 0;
async function call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        const at = Math.max(Date.now(), nextSlot);
        nextSlot = at + GAP;
        if (at > Date.now()) await sleep(at - Date.now());
        try {
            return await fn();
        } catch (e: any) {
            if (attempt < 4 && /429|ECONNRESET|ETIMEDOUT|fetch failed|50\d/.test(errText(e))) {
                await sleep(GAP * (attempt + 2));
                continue;
            }
            throw e;
        }
    }
}

async function v3(path: string, params: [string, string][]): Promise<any> {
    const url = `${BASE}/api/v3/${path}?` + new URLSearchParams(params).toString();
    return call(async () => {
        const res = await fetch(url, { headers: API_KEY ? { 'X-API-Key': API_KEY } : {}, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`toncenter ${res.status} ${path}`);
        return res.json();
    });
}

// Last masterchain block toncenter has indexed (for the DexScreener latest-block).
async function mcInfo(): Promise<{ seqno: number; utime: number }> {
    const r = await v3('masterchainInfo', []);
    return { seqno: Number(r?.last?.seqno), utime: Number(r?.last?.gen_utime) };
}

// get_pool_state of any Router generation: fields were appended at the end (platformFees,
// platformBps); a shorter stack from an older pool is padded with zeros.
async function readPoolState(address: Address) {
    const r = await client.runMethod(address, 'get_pool_state');
    const items = (r.stack as any).items as TupleItem[];
    return loadGetterTuplePoolState(new TupleReader([...items, ...Array.from({ length: 4 }, (): TupleItem => ({ type: 'int', value: 0n }))]));
}

// A Marg DEX v2 pool's get_pool_state; null if the pool is not deployed.
async function poolState(addr: string): Promise<PoolSnap | null> {
    let s;
    try {
        s = await call(() => readPoolState(Address.parse(addr)));
    } catch (e) {
        if (notDeployed(e)) return null;
        throw e;
    }
    return {
        reserve0: s.reserve0, reserve1: s.reserve1, tickSpacing: Number(s.key.tickSpacing),
        token0: s.key.token0.toRawString(), token1: s.key.token1.toRawString(),
        feePips: Number(s.fs.hookFeeSet ? s.fs.hookFeePips : s.fs.baseFeePips),
    };
}

// A jetton master's get_wallet_address(owner).
async function walletAddress(master: string, owner: string): Promise<Address> {
    const r = await call(() => client.runMethod(Address.parse(master), 'get_wallet_address', [
        { type: 'slice', cell: beginCell().storeAddress(Address.parse(owner)).endCell() },
    ]));
    return r.stack.readAddress();
}

// Network entry points, replaceable in tests.
export const io = { v3, mcInfo, poolState, walletAddress };

const errText = (e: any) => String(e?.message ?? e);
// A get method on an account that is not deployed (yet): exit code -13 / -256 or "not active".
const notDeployed = (e: any) => /exit[_ ]code:?\s*(-13|-256)\b|not active|uninit|not (been )?deployed|account.+(missing|not found)/i.test(errText(e));

// ---------------------------------------------------------------- sources

// Set once a factory answers; the API reports 'starting' until then.
let ready = false;
export const setReady = () => { ready = true; };
let lastSync = 0;

// Plain pools are derived with this Router (default: the first launch factory's Router).
const DEX_ROUTER = process.env.DEX_ROUTER ? Address.parse(process.env.DEX_ROUTER).toRawString() : null;

const raw = (a: string | Address) => (typeof a === 'string' ? Address.parse(a) : a).toRawString();
const friendly = (r: string | null | undefined) => {
    if (!r) return null;
    try { return Address.parse(r).toString({ testOnly: NETWORK === 'testnet' }); } catch { return null; }
};

export type Found = {
    creator: Address | null;
    createdAt: number | null;
    content: Cell | null;
    pool?: Address;
    sqrtPriceX96?: bigint;
};

// A factory whose tokens are discovered by index.
export interface Source {
    kind: 'dex';
    address: Address;
    base: number;                                       // idx of its token 0
    next(): Promise<number | null>;                     // number of tokens; null = factory not deployed
    addressOf(i: number): Promise<Address>;
    details(token: Address): Promise<Found | 'pending'>; // 'pending' = not launched / deployed yet
}

function launchSource(address: Address, ordinal: number): Source {
    const f = client.open(LaunchFactory.fromAddress(address));
    return {
        kind: 'dex', address, base: SPAN * (ordinal + 1),
        async next() {
            // Read by position: FactoryData is (admin, pendingAdmin, treasury, router, launchFee,
            // params | tiers, nextIndex); the params became 3 tiers in the third factory.
            let fd;
            try {
                fd = await call(async () => {
                    // Flattened: 5 fixed fields, then 2 (params) or 6 (tiers) numbers, then nextIndex last.
                    const t = (await client.runMethod(address, 'get_factory_data')).stack;
                    t.readAddress(); t.readAddressOpt(); t.readAddress();
                    const router = t.readAddress();
                    let nextIndex = 0n;
                    while (t.remaining > 0) nextIndex = t.readBigNumber();
                    return { router, nextIndex };
                });
            } catch (e) {
                if (notDeployed(e)) return null;
                throw e;
            }
            dexRouters.add(raw(fd.router));
            return Number(fd.nextIndex);
        },
        // Only tokens the factory itself derives are accepted (master == get_token_address(i)).
        addressOf: (i) => call(() => f.getGetTokenAddress(BigInt(i))),
        async details(token) {
            const m = client.open(LaunchJetton.fromAddress(token));
            // The launch chain finishes a few messages after the factory counts it.
            try {
                if (!(await call(() => m.getGetLaunched()))) return 'pending';
            } catch (e) {
                if (notDeployed(e)) return 'pending';
                throw e;
            }
            const data = await call(() => m.getGetJettonData());
            // Read by position (the vault fields appended in the third factory are not needed here).
            const info = await call(async () => {
                const t = (await client.runMethod(token, 'get_launch_info')).stack;
                const creator = t.readAddress();
                const router = t.readAddress();
                t.readAddress(); t.readBigNumber(); t.readBigNumber(); t.readBigNumber();
                const sqrtPriceX96 = t.readBigNumber();
                t.readAddressOpt(); t.readBigNumber(); t.readBigNumber(); t.readAddressOpt();
                t.readBigNumber(); t.readBigNumber(); t.readBigNumber(); t.readBigNumber();
                return { creator, router, sqrtPriceX96, createdAt: t.readBigNumber() };
            });
            const key = await call(() => m.getGetPoolKey());
            const router = client.open(Router.fromAddress(info.router));
            const pool = await call(() => router.getGetPoolAddress(key.token0, key.token1, key.tickSpacing, key.ext));
            return { creator: info.creator, createdAt: Number(info.createdAt), content: data.jettonContent, pool, sqrtPriceX96: info.sqrtPriceX96 };
        },
    };
}

// Replaceable in tests. Order matters for launch factories (idx ranges).
export const sources: Source[] = [...LAUNCH_FACTORIES.map((a, k) => launchSource(a, k))];

function sourceOfIdx(idx: number): { src: Source; i: number } | null {
    for (const src of sources) if (idx >= src.base && idx < src.base + SPAN) return { src, i: idx - src.base };
    return null;
}

// Gram per token, scaled by SUPPLY (token0 = Gram, so the pool price is tokens per Gram).
const scaledPrice = (sqrtPriceX96: bigint) => (sqrtPriceX96 > 0n ? (Q192 * SUPPLY) / (sqrtPriceX96 * sqrtPriceX96) : 0n);

// found = null stores a placeholder (defaults, no pool) so the index can move on.
function storeToken(src: Source, i: number, address: Address, found: Found | null, meta: TokenMeta) {
    const placeholder = found && !meta.partial ? 0 : 1;
    const creator = found?.creator ? raw(found.creator) : null;
    const start = scaledPrice(found?.sqrtPriceX96 ?? 0n).toString();
    db.prepare(`INSERT OR IGNORE INTO tokens
        (address, idx, name, symbol, description, image, creator, created_at, ton_reserve, token_reserve, real_ton, graduated,
         virtual_ton, virtual_tokens, graduation_ton, max_supply, kind, pool, placeholder)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', 1, ?, ?, '1', ?, 'dex', ?, ?)`).run(
        raw(address), src.base + i, meta.name, meta.symbol, meta.description ?? null, meta.image ?? null, creator,
        found?.createdAt ?? null, start, SUPPLY.toString(), start, SUPPLY.toString(), SUPPLY.toString(),
        found?.pool ? raw(found.pool) : null, placeholder,
    );
}

const failures = new Map<string, number>();

// Next index to look at for a source: a kv cursor, else (first run) one past its highest stored idx.
function cursorOf(src: Source): number {
    const k = `disc:${raw(src.address)}`;
    const v = kvGet(k);
    if (v !== undefined) return Number(v);
    const r = db.prepare('SELECT MAX(idx) AS m FROM tokens WHERE idx >= ? AND idx < ?').get(src.base, src.base + SPAN) as any;
    return r?.m == null ? 0 : r.m - src.base + 1;
}

export async function discoverSource(src: Source) {
    const next = await src.next();
    if (next === null) return; // factory not deployed (yet)
    ready = true;
    const ck = `disc:${raw(src.address)}`;
    const end = Math.min(next, cursorOf(src) + DISCOVER_BATCH);
    for (let i = cursorOf(src); i < end; i++) {
        const tag = `${raw(src.address)}#${i}`;
        let address: Address;
        try {
            address = await src.addressOf(i);
        } catch (e) {
            console.error(`discover ${src.kind} #${i}: address failed: ${errText(e)}`);
            return; // without an address there is nothing to store; retried next round
        }
        let found: Found | 'pending' | null;
        try {
            found = await src.details(address);
        } catch (e) {
            const n = (failures.get(tag) ?? 0) + 1;
            failures.set(tag, n);
            console.error(`discover ${src.kind} #${i} ${address.toString()}: failed ${n}/${MAX_FAILS}: ${errText(e)}`);
            if (n < MAX_FAILS) return; // keep the order: retry this one next round
            found = null;
        }
        if (found === 'pending') return; // not launched yet: stop this source for this round
        const meta = await parseMeta(found?.content ?? null); // never throws
        try {
            storeToken(src, i, address, found, meta);
        } catch (e) {
            console.error(`discover ${src.kind} #${i}: store failed, using placeholder: ${errText(e)}`);
            try { storeToken(src, i, address, null, await parseMeta(null)); } catch (e2) { console.error(`placeholder failed: ${errText(e2)}`); }
        }
        failures.delete(tag);
        kvSet(ck, String(i + 1));
        console.log(`launch #${i}${found ? '' : ' (placeholder)'} ${meta.symbol} ${address.toString()}${found?.pool ? ' pool ' + found.pool.toString() : ''}`);
    }
}

// Retries a couple of placeholders per round; fills in metadata (and the pool) once they answer.
// Rotates through them, so ones that never answer do not block the rest.
let repairAfter = -1;
export async function repairPlaceholders(limit = 2) {
    const q = db.prepare('SELECT address, idx FROM tokens WHERE placeholder = 1 AND idx > ? ORDER BY idx LIMIT ?');
    let rows = q.all(repairAfter, limit) as any[];
    if (rows.length === 0) rows = q.all(-1, limit) as any[];
    for (const r of rows) {
        repairAfter = r.idx;
        const s = sourceOfIdx(r.idx);
        if (!s) continue;
        try {
            const found = await s.src.details(Address.parse(r.address));
            if (found === 'pending') continue;
            const meta = await parseMeta(found.content);
            db.prepare(`UPDATE tokens SET name = ?, symbol = ?, description = ?, image = ?, creator = COALESCE(?, creator),
                created_at = COALESCE(created_at, ?), pool = COALESCE(pool, ?), placeholder = ? WHERE address = ?`).run(
                meta.name, meta.symbol, meta.description ?? null, meta.image ?? null, found.creator ? raw(found.creator) : null,
                found.createdAt, found.pool ? raw(found.pool) : null, meta.partial ? 1 : 0, r.address,
            );
            if (found.pool && found.sqrtPriceX96) {
                const start = scaledPrice(found.sqrtPriceX96).toString();
                db.prepare("UPDATE tokens SET virtual_ton = ?, ton_reserve = CASE WHEN last_lt = '0' THEN ? ELSE ton_reserve END WHERE address = ?")
                    .run(start, start, r.address);
            }
            if (!meta.partial) console.log(`repaired placeholder #${r.idx} ${meta.symbol}`);
        } catch (e) {
            console.error(`repair #${r.idx}: ${errText(e)}`);
        }
    }
}

// ---------------------------------------------------------------- trades

// Pools and the DexScreener adapter (src/dex.ts).
export const dex = createDex({
    db, io, testOnly: NETWORK === 'testnet',
    router: () => DEX_ROUTER ?? dexRouters.values().next().value ?? null,
    externalBodies: (tx) => externalBodies(tx),
    handleTx: (tx) => handleTx(tx),
    kvGet, kvSet,
    log: (...a) => console.log(...a),
    err: (...a) => console.error(...a),
});

const insertTrade = db.prepare(`INSERT OR IGNORE INTO trades
    (hash, token, lt, utime, is_buy, trader, ton, tokens, ton_reserve, token_reserve, real_ton, price)
    VALUES (@hash, @token, @lt, @utime, @is_buy, @trader, @ton, @tokens, @ton_reserve, @token_reserve, @real_ton, @price)`);

// External-out bodies of a transaction in emission order (created_lt; bad base64 / cells are skipped).
function* externalBodies(tx: any) {
    const outs: any[] = Array.isArray(tx.out_msgs) ? [...tx.out_msgs] : [];
    if (outs.every((o) => /^\d+$/.test(String(o?.created_lt)))) {
        outs.sort((a, b) => { const x = BigInt(a.created_lt), y = BigInt(b.created_lt); return x < y ? -1 : x > y ? 1 : 0; });
    }
    for (const out of outs) {
        if (out?.destination || !out?.message_content?.body) continue; // external out only
        let s;
        try { s = Cell.fromBase64(out.message_content.body).beginParse(); } catch { continue; }
        if (s.remainingBits < 32) continue;
        yield s;
    }
}

export function handleTx(tx: any) {
    if (!tx?.account || !tx.hash) return;
    const pooled = db.prepare('SELECT address FROM tokens WHERE pool = ?').get(raw(tx.account)) as any;
    if (pooled) return handleSwapTx(tx, raw(tx.account), pooled.address);
    if (dex.poolKind(raw(tx.account)) === 'plain') return handleSwapTx(tx, raw(tx.account), null);
}

// SwapEvents and ModifyEvents logged by a tracked pool go to dex_events, numbered 0, 1, 2… in
// emission order within the transaction; a direct launch's swaps (token set) are also its trades
// (token0 = Gram, so zeroForOne is a buy).
function handleSwapTx(tx: any, pool: string, token: string | null) {
    if (tx.emulated || tx.description?.aborted) return;
    const row = token ? db.prepare('SELECT last_lt FROM tokens WHERE address = ?').get(token) as any : null;
    const utime = Number(tx.now);
    if ((token && !row) || !Number.isFinite(utime)) return;
    let eventIndex = 0;
    for (const s of externalBodies(tx)) {
        try {
            const op = s.preloadUint(32);
            if (op === MODIFY_OP) {
                const idx = eventIndex++;
                const m = loadModifyEvent(s);
                try { dex.recordModify(tx, pool, m, idx); } catch (err) { console.error(`tx ${tx.hash}: dex modify skipped: ${errText(err)}`); }
                continue;
            }
            if (op !== SWAP_OP) continue;
            const idx = eventIndex++;
            const e = loadSwapEvent(s);
            if (e.amountIn <= 0n || e.amountOut <= 0n) continue;
            try { dex.recordSwap(tx, pool, e, idx); } catch (err) { console.error(`tx ${tx.hash}: dex event skipped: ${errText(err)}`); }
            if (!token) continue;
            const buy = e.zeroForOne;
            const ton = buy ? e.amountIn : e.amountOut;
            const tokens = buy ? e.amountOut : e.amountIn;
            const after = scaledPrice(e.sqrtPriceX96);
            const price = Number(after) / Number(SUPPLY);
            if (!Number.isFinite(price)) continue;
            const r = insertTrade.run({
                hash: tx.hash, token, lt: String(tx.lt), utime, is_buy: buy ? 1 : 0, trader: raw(e.fromUser),
                ton: ton.toString(), tokens: tokens.toString(), ton_reserve: after.toString(), token_reserve: SUPPLY.toString(),
                real_ton: '0', price,
            });
            if (r.changes && BigInt(tx.lt) > BigInt(row.last_lt)) {
                db.prepare('UPDATE tokens SET ton_reserve = ?, last_lt = ?, last_trade_at = ? WHERE address = ?')
                    .run(after.toString(), String(tx.lt), utime, token);
            }
        } catch (err) {
            console.error(`tx ${tx.hash}: bad swap event skipped: ${errText(err)}`);
        }
    }
}

export async function pollTrades() {
    const accounts = [...(db.prepare("SELECT pool AS a FROM tokens WHERE kind = 'dex'").all() as any[])
        .map((r) => r.a as string | null).filter((a): a is string => !!a), ...dex.activePlainPools()];
    if (accounts.length === 0) return;
    // A small overlap re-reads the last two minutes; trades are keyed by tx hash.
    const since = Math.max(0, Number(kvGet('cursor') ?? 0) - 120);
    let newest = Number(kvGet('cursor') ?? 0);
    for (let i = 0; i < accounts.length; i += 50) {
        const chunk = accounts.slice(i, i + 50);
        for (let offset = 0; ; offset += 256) {
            const res = await io.v3('transactions', [
                ...chunk.map((a): [string, string] => ['account', a]),
                ['start_utime', String(since)], ['sort', 'asc'], ['limit', '256'], ['offset', String(offset)],
            ]);
            const txs: any[] = Array.isArray(res?.transactions) ? res.transactions : [];
            // One transaction failing never rolls back the others (or stalls the cursor).
            db.transaction(() => {
                for (const tx of txs) {
                    try { handleTx(tx); } catch (e) { console.error(`tx ${tx?.hash}: skipped: ${errText(e)}`); }
                }
            })();
            for (const tx of txs) {
                const t = Number(tx?.now);
                if (Number.isFinite(t) && t <= now() + 600) newest = Math.max(newest, t);
            }
            if (txs.length < 256) break;
        }
    }
    kvSet('cursor', String(newest));
}

// One round: every stage on its own, so a failing factory or token never blocks trades.
export async function syncOnce() {
    for (const src of sources) {
        try {
            await discoverSource(src);
        } catch (e) {
            console.error(`discover ${src.kind} ${src.address.toString()}: ${errText(e)}`);
        }
    }
    try { await repairPlaceholders(); } catch (e) { console.error('repair error:', errText(e)); }
    try { dex.seedLaunchPools(); } catch (e) { console.error('dex seed error:', errText(e)); }
    try { await dex.maintainPlain(); } catch (e) { console.error('dex plain pools error:', errText(e)); }
    // The masterchain block is read before the poll, so every event up to it is in once the poll succeeds.
    let block: { seqno: number; utime: number } | null = null;
    try { block = await io.mcInfo(); } catch (e) { console.error('masterchain info error:', errText(e)); }
    try {
        dex.beginRound();
        await pollTrades();
        lastSync = Date.now();
        await dex.endRound(block);
    } catch (e) {
        console.error('trades error:', errText(e));
    }
    try { await dex.backfillStep(); } catch (e) { console.error('dex backfill error:', errText(e)); }
    try { await dex.describeStep(); } catch (e) { console.error('dex describe error:', errText(e)); }
}

async function loop() {
    for (;;) {
        try {
            await syncOnce();
        } catch (e) {
            console.error('sync error:', errText(e));
        }
        await sleep(API_KEY ? 3000 : 8000);
    }
}

// ---------------------------------------------------------------- API

const big = (s: unknown, fallback: bigint) => { try { return BigInt(String(s)); } catch { return fallback; } };
const startPrice = (t: any) => Number(t.virtual_ton) / (Number(t.virtual_tokens) || 1);

function tokenView(t: any, stats?: { vol: number; n: number }, open24?: number) {
    const tr = big(t.token_reserve, SUPPLY) || 1n;
    const price = Number(t.ton_reserve) / Number(tr);
    const mcap = (big(t.ton_reserve, 0n) * big(t.max_supply, SUPPLY)) / tr;
    const s = sourceOfIdx(t.idx);
    const grad = Number(t.graduation_ton) || 1;
    return {
        address: friendly(t.address), index: t.idx, name: t.name, symbol: t.symbol, description: t.description,
        image: t.image, creator: friendly(t.creator), createdAt: t.created_at, lastTradeAt: t.last_trade_at,
        kind: t.kind, pool: friendly(t.pool),
        // The factory that created it and its index there: get_token_address(factoryIndex) on
        // `factory` returns this token's address (lets the web verify it on-chain).
        factory: s ? friendly(raw(s.src.address)) : null, factoryIndex: s ? s.i : null,
        placeholder: !!t.placeholder,
        graduated: !!t.graduated, price, mcap: mcap.toString(), realTon: t.real_ton,
        graduationTon: t.graduation_ton,
        progress: t.graduated ? 1 : Number(t.real_ton) / grad,
        volume24h: stats ? Math.round(stats.vol).toString() : '0', trades24h: stats?.n ?? 0,
        change24h: open24 ? (price / open24 - 1) * 100 : 0,
    };
}

// Price at a moment: the last trade before it, or the launch price.
function priceAt(t: any, utime: number) {
    const r = db.prepare('SELECT price FROM trades WHERE token = ? AND utime <= ? ORDER BY utime DESC, lt DESC LIMIT 1').get(t.address, utime) as any;
    return r?.price ?? startPrice(t);
}

function listTokens(kind: string | null) {
    const since = now() - DAY;
    const stats = new Map((db.prepare(`SELECT token, SUM(CAST(ton AS REAL)) AS vol, COUNT(*) AS n
        FROM trades WHERE utime > ? GROUP BY token`).all(since) as any[]).map((r) => [r.token, r]));
    // Hourly closes for the last 24h, for the sparkline.
    const recent = db.prepare('SELECT token, utime, price FROM trades WHERE utime > ? ORDER BY utime, lt').all(since) as any[];
    const byToken = new Map<string, any[]>();
    for (const r of recent) (byToken.get(r.token) ?? byToken.set(r.token, []).get(r.token)!).push(r);

    // Direct launches only (rows of the retired curve factory may remain in old databases).
    const rows = (kind && kind !== 'dex' ? [] : db.prepare("SELECT * FROM tokens WHERE kind = 'dex' ORDER BY idx DESC").all()) as any[];
    return rows.filter((t) => !HIDDEN.has(t.address)).map((t) => {
        const open = priceAt(t, since);
        const spark: number[] = [];
        let p = open;
        const trades = byToken.get(t.address) ?? [];
        for (let h = 0, j = 0; h < 24; h++) {
            const end = since + (h + 1) * 3600;
            while (j < trades.length && trades[j].utime <= end) p = trades[j++].price;
            spark.push(p);
        }
        return { ...tokenView(t, stats.get(t.address), open), spark };
    });
}

function tokenRow(addr: string) {
    try {
        return db.prepare("SELECT * FROM tokens WHERE address = ? AND kind = 'dex'").get(raw(addr)) as any;
    } catch {
        return undefined; // not an address
    }
}

function tradeView(r: any) {
    return {
        hash: r.hash, utime: r.utime, isBuy: !!r.is_buy, trader: friendly(r.trader),
        ton: r.ton, tokens: r.tokens, price: r.price,
        ...(r.symbol !== undefined ? { token: friendly(r.token), symbol: r.symbol, image: r.image } : {}),
    };
}

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
// Per token + timeframe, valid until the token's trade count or last trade changes.
const candleCache = new Map<string, { stamp: string; data: Candle[] }>();

function candles(t: any, tf: number): Candle[] {
    const k = `${t.address}:${tf}`;
    const n = (db.prepare('SELECT COUNT(*) AS n FROM trades WHERE token = ?').get(t.address) as any).n as number;
    const stamp = `${n}:${t.last_lt}:${t.created_at}`;
    const hit = candleCache.get(k);
    if (hit && hit.stamp === stamp) return hit.data;

    const rows = (db.prepare('SELECT utime, price, ton FROM trades WHERE token = ? ORDER BY utime DESC, lt DESC LIMIT ?')
        .all(t.address, CANDLE_TRADES) as any[]).reverse();
    const truncated = n > rows.length;
    const out: Candle[] = [];
    // A truncated history starts at its first kept trade instead of the launch price.
    let prev = truncated && rows.length ? rows[0].price : startPrice(t);
    if (!truncated && t.created_at) out.push({ time: Math.floor(t.created_at / tf) * tf, open: prev, high: prev, low: prev, close: prev, volume: 0 });
    for (const r of rows) {
        const time = Math.floor(r.utime / tf) * tf;
        let c = out[out.length - 1];
        if (!c || c.time !== time) {
            c = { time, open: prev, high: prev, low: prev, close: prev, volume: 0 };
            out.push(c);
        }
        c.high = Math.max(c.high, r.price);
        c.low = Math.min(c.low, r.price);
        c.close = r.price;
        c.volume += Number(r.ton) / 1e9;
        prev = r.price;
    }
    if (candleCache.size > 2000) candleCache.clear();
    candleCache.set(k, { stamp, data: out });
    return out;
}

const HOLDERS_TTL = 60_000;
const MAX_HOLDER_FETCHES = 4; // distinct tokens fetched from toncenter at once
const holderCache = new Map<string, { at: number; data: any }>();
const holderInflight = new Map<string, Promise<any>>();

// Net pool trades per wallet (misses plain transfers); no network.
function holdersFromTrades(t: any) {
    const rows = db.prepare(`SELECT trader, SUM(CASE WHEN is_buy THEN CAST(tokens AS REAL) ELSE -CAST(tokens AS REAL) END) AS bal
        FROM trades WHERE token = ? GROUP BY trader HAVING bal > 0 ORDER BY bal DESC`).all(t.address) as any[];
    return {
        source: 'trades', count: rows.length, more: false,
        top: rows.slice(0, 20).map((r) => ({ owner: friendly(r.trader), balance: BigInt(Math.round(r.bal)).toString() })),
    };
}

async function fetchHolders(t: any) {
    let data: any;
    try {
        const res = await io.v3('jetton/wallets', [
            ['jetton_address', t.address], ['exclude_zero_balance', 'true'], ['limit', '100'], ['sort', 'desc'],
        ]);
        const all: any[] = Array.isArray(res?.jetton_wallets) ? res.jetton_wallets : [];
        const list = all.filter((w) => { try { return !dexRouters.has(raw(w.owner)); } catch { return false; } })
            .map((w) => ({ owner: friendly(w.owner), balance: String(w.balance) }));
        // `more` follows the unfiltered page: a full page means there are more, even with the Router dropped.
        data = { source: 'chain', count: list.length, more: all.length === 100, top: list.slice(0, 20) };
    } catch {
        data = null;
    }
    if (!data || (data.count === 0 && t.last_trade_at)) data = holdersFromTrades(t);
    holderCache.set(t.address, { at: Date.now(), data });
    if (holderCache.size > 5000) holderCache.delete(holderCache.keys().next().value!);
    return data;
}

// One request per token at a time; floods share it (or get stale / trade-based data) instead of
// queueing toncenter calls ahead of the sync.
async function holders(t: any) {
    const hit = holderCache.get(t.address);
    if (hit && Date.now() - hit.at < HOLDERS_TTL) return hit.data;
    const pending = holderInflight.get(t.address);
    if (pending) return pending;
    if (holderInflight.size >= MAX_HOLDER_FETCHES) return hit?.data ?? holdersFromTrades(t);
    const p = fetchHolders(t).finally(() => holderInflight.delete(t.address));
    holderInflight.set(t.address, p);
    return p;
}

const TIMEFRAMES = new Set([60, 300, 900, 3600, 21600, 86400]);

export async function route(path: string, query: URLSearchParams): Promise<[number, unknown]> {
    if (!ready) return [503, { error: 'starting' }];
    if (path === '/api/idx/status') {
        const n = (db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE kind = 'dex'").get() as any).n;
        const testOnly = NETWORK === 'testnet';
        return [200, {
            network: NETWORK, factory: null, // the old curve factory is retired
            launchFactory: LAUNCH_FACTORIES[0]?.toString({ testOnly }) ?? null,
            launchFactories: LAUNCH_FACTORIES.map((a, k) => ({ address: a.toString({ testOnly }), idxBase: SPAN * (k + 1) })),
            tokens: n, lastSync,
        }];
    }
    if (path.startsWith('/api/idx/dexscreener/')) return dex.route(path.slice('/api/idx/dexscreener/'.length), query);
    if (path.startsWith('/api/idx/defillama/')) return dex.llamaRoute(path.slice('/api/idx/defillama/'.length), query);
    if (path === '/api/idx/tokens') return [200, listTokens(query.get('kind'))];
    if (path === '/api/idx/trades') {
        const limit = Math.min(Number(query.get('limit') ?? 30) || 30, 100);
        const rows = (db.prepare(`SELECT trades.*, tokens.symbol, tokens.image FROM trades JOIN tokens ON tokens.address = trades.token
            WHERE tokens.kind = 'dex' ORDER BY utime DESC, lt DESC LIMIT ?`).all(limit + HIDDEN.size * 50) as any[]).filter((r) => !HIDDEN.has(r.token));
        return [200, rows.slice(0, limit).map(tradeView)];
    }
    const m = path.match(/^\/api\/idx\/token\/([^/]+)(?:\/(trades|candles|holders))?$/);
    if (m) {
        let id: string;
        try { id = decodeURIComponent(m[1]); } catch { return [400, { error: 'bad address' }]; }
        const t = tokenRow(id);
        if (!t) return [404, { error: 'unknown token' }];
        if (!m[2]) {
            const since = now() - DAY;
            const s = db.prepare('SELECT SUM(CAST(ton AS REAL)) AS vol, COUNT(*) AS n FROM trades WHERE token = ? AND utime > ?').get(t.address, since) as any;
            const all = db.prepare('SELECT COUNT(*) AS n, SUM(CAST(ton AS REAL)) AS vol FROM trades WHERE token = ?').get(t.address) as any;
            return [200, { ...tokenView(t, { vol: s.vol ?? 0, n: s.n }, priceAt(t, since)), tradesTotal: all.n, volumeTotal: Math.round(all.vol ?? 0).toString() }];
        }
        if (m[2] === 'trades') {
            const limit = Math.min(Number(query.get('limit') ?? 50) || 50, 200);
            const rows = db.prepare('SELECT * FROM trades WHERE token = ? ORDER BY utime DESC, lt DESC LIMIT ?').all(t.address, limit);
            return [200, rows.map(tradeView)];
        }
        if (m[2] === 'candles') {
            const tf = Number(query.get('tf') ?? 300);
            if (!TIMEFRAMES.has(tf)) return [400, { error: 'tf must be one of ' + [...TIMEFRAMES].join(', ') }];
            return [200, candles(t, tf)];
        }
        return [200, await holders(t)];
    }
    return [404, { error: 'not found' }];
}

export function start() {
    http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        let status = 405;
        let body: unknown = { error: 'GET only' };
        if (req.method === 'GET') {
            try {
                [status, body] = await route(url.pathname, url.searchParams);
            } catch (e: any) {
                console.error('api error:', errText(e));
                [status, body] = [500, { error: 'internal error' }];
            }
        }
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': status === 200 ? 'public, max-age=3' : 'no-store' });
        res.end(JSON.stringify(body));
    }).listen(PORT, '127.0.0.1', () => console.log(`indexer API on 127.0.0.1:${PORT} (${NETWORK}, ${LAUNCH_FACTORIES.length} launch factories)`));

    loop();
}

if (require.main === module && !process.env.INDEXER_NO_START) start();

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}
function now() {
    return Math.floor(Date.now() / 1000);
}
