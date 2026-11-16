// Marg DEX v2 pool tracking and the DexScreener HTTP adapter (see DEXSCREENER.md).
//
// Tables: `assets` (plain-pool jettons: metadata + the Router's jetton wallet), `pools` (every
// tracked pool: launch pools from `tokens`, plain Gram/X pools derived locally) and `dex_events`
// (every SwapEvent and ModifyEvent of a tracked pool, with its masterchain block and the pool's
// reserves after it).
//
// On chain token0 is always Gram (zero address), token1 the Router's jetton wallet. DexScreener
// follows that order: asset0 = TON (native id), asset1 = the jetton (master address), so
// priceNative (asset0 quoted in asset1) is jettons per TON.
//
// No import from index.ts: it hands over what this module needs (createDex) to avoid an import cycle.
import Database from 'better-sqlite3';
import { Address, Slice } from '@ton/core';
import { loadInitializeEvent, loadModifyEvent, Pool } from '../../../dex/v2/build/Router_Pool';
import { loadSwapEvent } from './swapevent';

type SwapEvent = ReturnType<typeof loadSwapEvent>;
type ModifyEvent = ReturnType<typeof loadModifyEvent>;

export const GRAM_RAW = '0:' + '0'.repeat(64);
const GRAM = Address.parse(GRAM_RAW);
const Q192 = 1n << 192n;
const INIT_OP = 0x4d480074;
// Default fee presets (Router.init, DESIGN.md §3.2): tickSpacing -> base fee in pips (1e-6).
export const PRESETS: Record<number, number> = { 1: 100, 10: 500, 60: 3000, 200: 10_000 };
const DEFAULT_PLAIN = [
    'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', // USDT (6 decimals)
    'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT', // NOT
    'EQCvxJy4eG8hyHBFsZ7eePxrRsUQSFE_jpptRAYBmcG_DOGS', // DOGS
    'EQA2kCVNwVsil2EM2mB0SkXytxCqQjS4mttjDpnXmwG9T6bO', // STON
];
// Used only when the jetton metadata does not say.
const KNOWN_DECIMALS: Record<string, number> = { [Address.parse(DEFAULT_PLAIN[0]).toRawString()]: 6 };

export const DS_MAX_RANGE = 10_000; // blocks per /events request
export const DS_MAX_EVENTS = 20_000; // events per /events response
const PLAIN_CHECK = Number(process.env.DEX_PLAIN_CHECK_SEC ?? 600); // plain-pool upkeep interval, s
const META_TTL = 3600;                                              // asset metadata refresh, s
const BACKFILL_PAGES = 2;                                           // per round, one pool at a time

export type PoolSnap = { reserve0: bigint; reserve1: bigint; tickSpacing: number; token0?: string; token1: string; feePips: number };

const MAX_DEC = 50; // decimal places in any served amount, price or reserve

export interface DexIo {
    v3(path: string, params: [string, string][]): Promise<any>;
    poolState(pool: string): Promise<PoolSnap | null>;        // null: not deployed
    walletAddress(master: string, owner: string): Promise<Address>;
}

export interface DexCtx {
    db: Database.Database;
    io: DexIo;                                   // read at call time (tests replace members)
    testOnly: boolean;
    router(): string | null;                     // raw Router address, or null if unknown yet
    externalBodies(tx: any): Iterable<Slice>;
    handleTx(tx: any): void;
    kvGet(k: string): string | undefined;
    kvSet(k: string, v: string): void;
    log(...a: unknown[]): void;
    err(...a: unknown[]): void;
}

// ---------------------------------------------------------------- number formatting

// Raw integer amount -> decimal string normalized by `decimals` ("2.5", "1000").
export function units(v: bigint, decimals: number): string {
    const neg = v < 0n;
    const s = (neg ? -v : v).toString().padStart(decimals + 1, '0');
    const int = s.slice(0, s.length - decimals);
    const frac = decimals > 0 ? s.slice(s.length - decimals, s.length - decimals + MAX_DEC).replace(/0+$/, '') : '';
    return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}

// num / den as a decimal string with up to `sig` significant digits and at most MAX_DEC decimal
// places (no exponent, truncated).
export function ratio(num: bigint, den: bigint, sig = 24): string {
    if (den <= 0n || num < 0n) return '0';
    const int = num / den;
    let rem = num % den;
    let out = int.toString() + '.';
    let n = int > 0n ? int.toString().length : 0;
    for (let i = 0; i < MAX_DEC && rem > 0n && n < sig; i++) {
        rem *= 10n;
        const d = rem / den;
        rem %= den;
        out += d.toString();
        if (n > 0 || d > 0n) n++;
    }
    return out.replace(/\.?0*$/, '') || '0';
}

// Price of token0 quoted in token1 (token1 units per token0) at sqrtPriceX96, normalized by
// decimals: sqrtP^2 / 2^192 * 10^dec0 / 10^dec1. For Marg pools: jettons per TON. '0' if it
// rounds to zero at MAX_DEC places (callers must not serve that).
export function priceNative(sqrtPriceX96: bigint, dec0: number, dec1: number): string {
    if (sqrtPriceX96 <= 0n) return '0';
    return ratio(sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(dec0), Q192 * 10n ** BigInt(dec1));
}

// Signed change of the pool's (reserve0, reserve1) caused by an event, exactly as Pool.commitSwap /
// doMint / burnCore / launch init apply it (pool.tact), so reserves can be replayed from zero.
export function swapDeltas(e: SwapEvent): [bigint, bigint] {
    const kept = e.protocolFee + e.hookFee; // leave the reserves (protocol/hook fee buckets)
    return e.zeroForOne
        ? [e.amountIn - e.refFee - e.tax - kept, -e.amountOut]        // buy: tax is part of amountIn
        : [-(e.amountOut + e.tax), e.amountIn - e.refFee - kept];     // sell: amountOut is net of tax
}
export function modifyKind(m: ModifyEvent): 'join' | 'exit' | 'collect' {
    return m.liquidityDelta > 0n ? 'join' : m.liquidityDelta < 0n ? 'exit' : 'collect';
}
export function modifyDeltas(m: ModifyEvent): [bigint, bigint] {
    return m.liquidityDelta > 0n ? [m.amount0, m.amount1] : [-(m.amount0 + m.fees0), -(m.amount1 + m.fees1)];
}

const hexHash = (b64: string) => {
    const b = Buffer.from(b64, 'base64');
    return b.length === 32 ? b.toString('hex') : b64;
};
const intParam = (v: string | null) => (v !== null && /^\d{1,12}$/.test(v) ? Number(v) : null);

// ---------------------------------------------------------------- module

export function createDex(ctx: DexCtx) {
    const { db } = ctx;
    db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
        address TEXT PRIMARY KEY, name TEXT, symbol TEXT, decimals INTEGER, total_supply TEXT,
        router TEXT, router_wallet TEXT, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pools (
        address TEXT PRIMARY KEY,
        token0 TEXT NOT NULL, token1 TEXT,                  -- raw on-chain key (token1 = Router's jetton wallet)
        asset0 TEXT NOT NULL, asset1 TEXT NOT NULL,         -- jetton masters, raw; Gram = 'native'
        decimals0 INTEGER NOT NULL, decimals1 INTEGER NOT NULL,
        tick_spacing INTEGER, fee_bps REAL, kind TEXT NOT NULL,   -- 'launch' | 'plain'
        created_utime INTEGER, created_mc_seqno INTEGER, created_tx TEXT, creator TEXT,
        active INTEGER NOT NULL DEFAULT 0, reserve0 TEXT, reserve1 TEXT,
        backfill_lt TEXT, backfill_done INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS pools_asset1 ON pools (asset1);
    `);
    // v2 events (swap + join/exit/collect, per-event reserve deltas). The v1 table (swaps only,
    // eventIndex counted swaps only) is dropped and every pool's history is backfilled again.
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name as string);
    const evCols = cols('dex_events');
    if (evCols.length && !evCols.includes('kind')) {
        db.exec('DROP TABLE dex_events');
        db.prepare('UPDATE pools SET backfill_lt = NULL, backfill_done = 0').run();
        ctx.log('dex: dex_events v1 dropped, history will be backfilled again');
    }
    const poolCols = cols('pools');
    for (const c of ['replay_lt TEXT', 'replay_idx INTEGER', 'replay_r0 TEXT', 'replay_r1 TEXT']) {
        if (!poolCols.includes(c.split(' ')[0])) db.exec(`ALTER TABLE pools ADD COLUMN ${c}`);
    }
    db.exec(`
    -- kind: swap | join | exit | collect (collect = fee claim, liquidityDelta 0: not served, kept for
    -- the reserve replay). Swaps fill amount*_in/out and sqrt_price; modifies fill amount0/amount1.
    -- d0/d1: signed reserve change; reserve0/1: reserves after the event; exact = 1 when replayed
    -- from the pool's creation (0: derived backwards from a get_pool_state snapshot).
    CREATE TABLE IF NOT EXISTS dex_events (
        id INTEGER PRIMARY KEY, tx_hash TEXT NOT NULL, event_index INTEGER NOT NULL,
        lt TEXT NOT NULL, utime INTEGER NOT NULL, mc_seqno INTEGER NOT NULL, pool TEXT NOT NULL, maker TEXT NOT NULL,
        kind TEXT NOT NULL,
        amount0_in TEXT, amount1_in TEXT, amount0_out TEXT, amount1_out TEXT, sqrt_price TEXT,
        amount0 TEXT, amount1 TEXT,
        d0 TEXT NOT NULL, d1 TEXT NOT NULL,
        reserve0 TEXT, reserve1 TEXT, exact INTEGER NOT NULL DEFAULT 0,
        UNIQUE (tx_hash, event_index)
    );
    CREATE INDEX IF NOT EXISTS dex_events_block ON dex_events (mc_seqno);
    CREATE INDEX IF NOT EXISTS dex_events_pool ON dex_events (pool, mc_seqno);
    `);

    const friendly = (r: string | null | undefined) => {
        if (!r) return null;
        try { return Address.parse(r).toString({ testOnly: ctx.testOnly }); } catch { return null; }
    };
    const NATIVE_ID = process.env.DEX_NATIVE_ID || friendly(GRAM_RAW)!;
    const DEX_KEY = process.env.DEX_KEY || 'marg';
    const NATIVE_SUPPLY = process.env.DEX_NATIVE_SUPPLY || '5000000000';
    const plainAssets = (process.env.DEX_PLAIN_ASSETS ?? DEFAULT_PLAIN.join(','))
        .split(',').map((s) => s.trim()).filter(Boolean)
        .flatMap((a) => { try { return [Address.parse(a).toRawString()]; } catch { ctx.err(`DEX_PLAIN_ASSETS: bad address ${a}`); return []; } });

    const insertEvent = db.prepare(`INSERT OR IGNORE INTO dex_events
        (tx_hash, event_index, lt, utime, mc_seqno, pool, maker, kind, amount0_in, amount1_in, amount0_out, amount1_out,
         sqrt_price, amount0, amount1, d0, d1)
        VALUES (@tx_hash, @event_index, @lt, @utime, @mc_seqno, @pool, @maker, @kind, @amount0_in, @amount1_in, @amount0_out,
         @amount1_out, @sqrt_price, @amount0, @amount1, @d0, @d1)`);
    // An event older than the pool's replay checkpoint invalidates it (full replay next time).
    const resetReplay = db.prepare(`UPDATE pools SET replay_lt = NULL, replay_idx = NULL, replay_r0 = NULL, replay_r1 = NULL
        WHERE address = ? AND replay_lt IS NOT NULL
        AND (CAST(replay_lt AS INTEGER) > CAST(? AS INTEGER) OR (CAST(replay_lt AS INTEGER) = CAST(? AS INTEGER) AND replay_idx >= ?))`);
    // Pools with new events in the running poll round (null outside a round).
    let collect: Set<string> | null = null;

    function insert(tx: any, pool: string, eventIndex: number, row: Record<string, string | null>) {
        const seqno = Number(tx.mc_block_seqno);
        const utime = Number(tx.now);
        if (!Number.isSafeInteger(seqno) || seqno <= 0 || !Number.isFinite(utime) || !/^\d+$/.test(String(tx.lt))) return;
        const lt = String(tx.lt);
        const r = insertEvent.run({
            amount0_in: null, amount1_in: null, amount0_out: null, amount1_out: null, sqrt_price: null, amount0: null, amount1: null,
            ...row, tx_hash: String(tx.hash), event_index: eventIndex, lt, utime, mc_seqno: seqno, pool,
        });
        if (!r.changes) return;
        resetReplay.run(pool, lt, lt, eventIndex);
        collect?.add(pool);
    }

    // A SwapEvent of a tracked pool (launch and plain pools). `eventIndex` = position among the
    // transaction's Swap/Modify events. Needs the tx's masterchain block.
    function recordSwap(tx: any, pool: string, e: SwapEvent, eventIndex: number) {
        const z = e.zeroForOne;
        const [d0, d1] = swapDeltas(e);
        insert(tx, pool, eventIndex, {
            maker: e.fromUser.toRawString(), kind: 'swap',
            amount0_in: z ? e.amountIn.toString() : '0', amount1_in: z ? '0' : e.amountIn.toString(),
            amount0_out: z ? '0' : e.amountOut.toString(), amount1_out: z ? e.amountOut.toString() : '0',
            sqrt_price: e.sqrtPriceX96.toString(), d0: d0.toString(), d1: d1.toString(),
        });
    }

    // A ModifyEvent (mint / burn / fee collect; the launch's locked position too).
    function recordModify(tx: any, pool: string, m: ModifyEvent, eventIndex: number) {
        const [d0, d1] = modifyDeltas(m);
        insert(tx, pool, eventIndex, {
            maker: m.owner.toRawString(), kind: modifyKind(m),
            amount0: m.amount0.toString(), amount1: m.amount1.toString(), d0: d0.toString(), d1: d1.toString(),
        });
    }

    // Reserves after each event of a pool:
    //  1. forward replay from zero (exact) over the history known to be complete from the pool's
    //     creation: everything once backfill is done, else up to backfill_lt. Incremental from a
    //     checkpoint (reset when an older event shows up).
    //  2. the remaining (newer, polled) events: backwards from a get_pool_state snapshot taken right
    //     after the poll (exact unless the pool traded again in between). Replaced by 1 later.
    function settleReserves(pool: string, snap: PoolSnap | null) {
        db.transaction(() => {
            const p = db.prepare('SELECT * FROM pools WHERE address = ?').get(pool) as any;
            if (!p) return;
            if (p.backfill_done || p.backfill_lt != null) {
                let r0 = p.replay_lt != null ? BigInt(p.replay_r0) : 0n;
                let r1 = p.replay_lt != null ? BigInt(p.replay_r1) : 0n;
                const rows = db.prepare(`SELECT id, lt, event_index, d0, d1 FROM dex_events WHERE pool = ?
                    AND (? IS NULL OR CAST(lt AS INTEGER) > CAST(? AS INTEGER) OR (CAST(lt AS INTEGER) = CAST(? AS INTEGER) AND event_index > ?))
                    AND (? = 1 OR CAST(lt AS INTEGER) <= CAST(? AS INTEGER))
                    ORDER BY CAST(lt AS INTEGER), event_index`)
                    .all(pool, p.replay_lt, p.replay_lt, p.replay_lt, p.replay_idx ?? -1, p.backfill_done ? 1 : 0, p.backfill_lt ?? '0') as any[];
                const set = db.prepare('UPDATE dex_events SET reserve0 = ?, reserve1 = ?, exact = 1 WHERE id = ?');
                let last: any = null;
                for (const e of rows) {
                    const n0 = r0 + BigInt(e.d0), n1 = r1 + BigInt(e.d1);
                    if (n0 < 0n || n1 < 0n) { // an event is missing: stop, the rest falls back to 2.
                        ctx.err(`dex: reserve replay of ${pool} went negative at ${e.lt}/${e.event_index}`);
                        break;
                    }
                    r0 = n0; r1 = n1; last = e;
                    set.run(r0.toString(), r1.toString(), e.id);
                }
                if (last) {
                    db.prepare('UPDATE pools SET replay_lt = ?, replay_idx = ?, replay_r0 = ?, replay_r1 = ? WHERE address = ?')
                        .run(last.lt, last.event_index, r0.toString(), r1.toString(), pool);
                }
            }
            if (!snap) return;
            const rest = db.prepare(`SELECT id, d0, d1 FROM dex_events WHERE pool = ? AND exact = 0
                ORDER BY CAST(lt AS INTEGER) DESC, event_index DESC`).all(pool) as any[];
            const set = db.prepare('UPDATE dex_events SET reserve0 = ?, reserve1 = ? WHERE id = ?');
            let r0 = snap.reserve0, r1 = snap.reserve1;
            for (const e of rest) {
                if (r0 < 0n || r1 < 0n) break;
                set.run(r0.toString(), r1.toString(), e.id);
                r0 -= BigInt(e.d0); r1 -= BigInt(e.d1);
            }
        })();
    }

    const poolKind = (address: string) =>
        (db.prepare('SELECT kind FROM pools WHERE address = ?').get(address) as any)?.kind as string | undefined;

    // Launch tokens' pools (no network): one row per dex token with a known pool.
    function seedLaunchPools() {
        db.prepare(`INSERT OR IGNORE INTO pools
            (address, token0, asset0, asset1, decimals0, decimals1, kind, created_utime, creator, active)
            SELECT pool, ?, 'native', address, 9, 9, 'launch', created_at, creator, 1
            FROM tokens WHERE kind = 'dex' AND pool IS NOT NULL`).run(GRAM_RAW);
        db.prepare(`UPDATE pools SET created_utime = COALESCE(created_utime, (SELECT created_at FROM tokens WHERE tokens.pool = pools.address)),
            creator = COALESCE(creator, (SELECT creator FROM tokens WHERE tokens.pool = pools.address))
            WHERE kind = 'launch' AND (created_utime IS NULL OR creator IS NULL)`).run();
    }

    // Plain Gram/X pools: metadata, the Router's wallets, the derived pool addresses and which are
    // deployed. Runs every PLAIN_CHECK seconds; at most 1 + (new wallets) + 1 requests.
    async function maintainPlain(force = false) {
        const nowS = Math.floor(Date.now() / 1000);
        if (!force && nowS - Number(ctx.kvGet('dex:plain_at') ?? 0) < PLAIN_CHECK) return;
        ctx.kvSet('dex:plain_at', String(nowS));
        if (plainAssets.length === 0) return;
        for (const a of plainAssets) db.prepare('INSERT OR IGNORE INTO assets (address) VALUES (?)').run(a);

        // 1. metadata (name, symbol, decimals, supply): one batched request.
        const stale = (db.prepare(`SELECT address FROM assets WHERE updated_at < ? AND address IN (${plainAssets.map(() => '?').join(',')})`)
            .all(nowS - META_TTL, ...plainAssets) as any[]).map((r) => r.address as string);
        if (stale.length) {
            try {
                const res = await ctx.io.v3('jetton/masters', [...stale.map((a): [string, string] => ['address', a]), ['limit', String(stale.length)]]);
                for (const m of Array.isArray(res?.jetton_masters) ? res.jetton_masters : []) {
                    let addr: string;
                    try { addr = Address.parse(m.address).toRawString(); } catch { continue; }
                    const info = res?.metadata?.[m.address]?.token_info?.[0] ?? res?.metadata?.[addr.toUpperCase()]?.token_info?.[0] ?? {};
                    const decRaw = m.jetton_content?.decimals ?? info?.extra?.decimals;
                    const dec = /^\d{1,2}$/.test(String(decRaw)) ? Number(decRaw) : (KNOWN_DECIMALS[addr] ?? 9);
                    const supply = /^\d+$/.test(String(m.total_supply)) ? String(m.total_supply) : null;
                    db.prepare(`UPDATE assets SET name = COALESCE(?, name), symbol = COALESCE(?, symbol), decimals = ?,
                        total_supply = COALESCE(?, total_supply), updated_at = ? WHERE address = ?`).run(
                        typeof info.name === 'string' ? info.name.slice(0, 64) : null,
                        typeof info.symbol === 'string' ? info.symbol.slice(0, 16) : null, dec, supply, nowS, addr);
                }
            } catch (e) {
                ctx.err(`dex: asset metadata: ${String((e as any)?.message ?? e)}`);
            }
        }

        // 2. the Router's jetton wallet per asset (cached; recomputed if the Router changes).
        const router = ctx.router();
        if (!router) return;
        for (const r of db.prepare('SELECT address FROM assets WHERE router_wallet IS NULL OR router IS NOT ?').all(router) as any[]) {
            if (!plainAssets.includes(r.address)) continue;
            try {
                const w = await ctx.io.walletAddress(r.address, router);
                db.prepare('UPDATE assets SET router = ?, router_wallet = ? WHERE address = ?').run(router, w.toRawString(), r.address);
            } catch (e) {
                ctx.err(`dex: router wallet of ${r.address}: ${String((e as any)?.message ?? e)}`);
            }
        }

        // 3. pool addresses, computed locally: Pool.fromInit(router, {Gram, wallet, spacing, ext: null}).
        const routerAddr = Address.parse(router);
        for (const a of db.prepare('SELECT * FROM assets WHERE router = ? AND router_wallet IS NOT NULL').all(router) as any[]) {
            if (!plainAssets.includes(a.address)) continue;
            const dec = a.decimals ?? KNOWN_DECIMALS[a.address] ?? 9;
            for (const [spacing, pips] of Object.entries(PRESETS)) {
                const pool = await Pool.fromInit(routerAddr, {
                    $$type: 'PoolKey', token0: GRAM, token1: Address.parse(a.router_wallet), tickSpacing: BigInt(spacing), ext: null,
                });
                db.prepare(`INSERT OR IGNORE INTO pools (address, token0, token1, asset0, asset1, decimals0, decimals1, tick_spacing, fee_bps, kind)
                    VALUES (?, ?, ?, 'native', ?, 9, ?, ?, ?, 'plain')`).run(
                    pool.address.toRawString(), GRAM_RAW, a.router_wallet, a.address, dec, Number(spacing), pips / 100);
            }
        }

        // 4. which plain pools are deployed now: one batched request.
        const idle = (db.prepare("SELECT address FROM pools WHERE kind = 'plain' AND active = 0").all() as any[]).map((r) => r.address as string);
        for (let i = 0; i < idle.length; i += 50) {
            const chunk = idle.slice(i, i + 50);
            try {
                const res = await ctx.io.v3('accountStates', [...chunk.map((a): [string, string] => ['address', a]), ['include_boc', 'false']]);
                for (const acc of Array.isArray(res?.accounts) ? res.accounts : []) {
                    if (acc?.status !== 'active') continue;
                    let addr: string;
                    try { addr = Address.parse(acc.address).toRawString(); } catch { continue; }
                    if (db.prepare("UPDATE pools SET active = 1 WHERE address = ? AND kind = 'plain'").run(addr).changes) ctx.log(`dex: plain pool active ${friendly(addr)}`);
                }
            } catch (e) {
                ctx.err(`dex: pool states: ${String((e as any)?.message ?? e)}`);
            }
        }
    }

    const activePlainPools = () => (db.prepare("SELECT address FROM pools WHERE kind = 'plain' AND active = 1").all() as any[]).map((r) => r.address as string);

    const beginRound = () => { collect = new Set(); };

    // After a successful poll: one get_pool_state per pool with new events, then its events get
    // reserves (settleReserves). Then the round's masterchain block becomes the latest block served.
    async function endRound(block: { seqno: number; utime: number } | null) {
        const got = collect ?? new Set<string>();
        collect = null;
        for (const pool of got) {
            let s: PoolSnap | null = null;
            try {
                s = await ctx.io.poolState(pool);
                if (s) applySnap(pool, s);
            } catch (e) {
                ctx.err(`dex: reserves of ${pool}: ${String((e as any)?.message ?? e)}`);
            }
            try { settleReserves(pool, s); } catch (e) { ctx.err(`dex: settle ${pool}: ${String((e as any)?.message ?? e)}`); }
        }
        if (block && Number.isSafeInteger(block.seqno) && block.seqno > 0 && Number.isFinite(block.utime)) {
            const prev = latestBlock();
            if (!prev || block.seqno >= prev.seqno) ctx.kvSet('dex:block', JSON.stringify({ seqno: block.seqno, utime: block.utime }));
        }
    }

    function applySnap(pool: string, s: PoolSnap) {
        if (s.token0 && s.token0 !== GRAM_RAW) ctx.err(`dex: pool ${pool} has token0 ${s.token0}, expected Gram`);
        db.prepare(`UPDATE pools SET reserve0 = ?, reserve1 = ?, token1 = COALESCE(token1, ?), tick_spacing = COALESCE(tick_spacing, ?),
            fee_bps = ? WHERE address = ?`).run(s.reserve0.toString(), s.reserve1.toString(), s.token1, s.tickSpacing, s.feePips / 100, pool);
    }

    // Launch pools with an unknown spacing/fee: one get_pool_state per round.
    async function describeStep() {
        const p = db.prepare('SELECT address FROM pools WHERE active = 1 AND tick_spacing IS NULL LIMIT 1').get() as any;
        if (!p) return;
        const s = await ctx.io.poolState(p.address);
        if (s) applySnap(p.address, s);
    }

    // One pool per round, up to BACKFILL_PAGES pages of its history from the start: fills
    // dex_events (and launch `trades`) for swaps before it was tracked and records its creation tx.
    async function backfillStep() {
        const p = db.prepare('SELECT * FROM pools WHERE active = 1 AND backfill_done = 0 ORDER BY rowid LIMIT 1').get() as any;
        if (!p) return;
        let cursor: string | null = p.backfill_lt;
        for (let page = 0; page < BACKFILL_PAGES; page++) {
            const params: [string, string][] = [['account', p.address], ['sort', 'asc'], ['limit', '256']];
            if (cursor) params.push(['start_lt', (BigInt(cursor) + 1n).toString()]);
            const res = await ctx.io.v3('transactions', params);
            const txs: any[] = Array.isArray(res?.transactions) ? res.transactions : [];
            db.transaction(() => {
                for (const tx of txs) {
                    try {
                        if (!p.created_tx && tx?.hash && Number.isSafeInteger(Number(tx.mc_block_seqno))) {
                            db.prepare('UPDATE pools SET created_tx = ?, created_mc_seqno = ?, created_utime = COALESCE(created_utime, ?) WHERE address = ?')
                                .run(String(tx.hash), Number(tx.mc_block_seqno), Number(tx.now) || null, p.address);
                            p.created_tx = tx.hash;
                        }
                        if (!p.creator) {
                            for (const s of ctx.externalBodies(tx)) {
                                if (s.preloadUint(32) !== INIT_OP) continue;
                                const ini = loadInitializeEvent(s);
                                if (ini.initializer) {
                                    p.creator = ini.initializer.toRawString();
                                    db.prepare('UPDATE pools SET creator = COALESCE(creator, ?) WHERE address = ?').run(p.creator, p.address);
                                }
                            }
                        }
                        ctx.handleTx(tx);
                    } catch (e) {
                        ctx.err(`dex: backfill tx ${tx?.hash}: ${String((e as any)?.message ?? e)}`);
                    }
                    if (/^\d+$/.test(String(tx?.lt))) cursor = String(tx.lt);
                }
                db.prepare('UPDATE pools SET backfill_lt = ?, backfill_done = ? WHERE address = ?').run(cursor, txs.length < 256 ? 1 : 0, p.address);
            })();
            if (txs.length < 256) break;
        }
        settleReserves(p.address, null);
    }

    // ------------------------------------------------------------ DexScreener HTTP adapter

    const latestBlock = (): { seqno: number; utime: number } | null => {
        try { return JSON.parse(ctx.kvGet('dex:block') ?? 'null'); } catch { return null; }
    };
    const blockView = (seqno: number, utime: number) => ({ blockNumber: seqno, blockTimestamp: utime });
    const isNative = (id: string) => {
        if (id === NATIVE_ID || id === 'native') return true;
        try { return Address.parse(id).toRawString() === GRAM_RAW; } catch { return false; }
    };
    const rawOf = (id: string) => { try { return Address.parse(id).toRawString(); } catch { return null; } };

    const nonEmpty = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const ID = (raw: string) => (raw === 'native' ? NATIVE_ID : friendly(raw));

    function assetView(id: string) {
        if (isNative(id)) {
            return { id: NATIVE_ID, name: 'Toncoin', symbol: 'TON', decimals: 9, totalSupply: NATIVE_SUPPLY, coinGeckoId: 'the-open-network' };
        }
        const r = rawOf(id);
        if (!r) return null;
        const t = db.prepare("SELECT name, symbol, max_supply FROM tokens WHERE address = ? AND kind = 'dex'").get(r) as any;
        if (t) {
            const symbol = nonEmpty(t.symbol, 16) ?? '???';
            return { id: friendly(r), name: nonEmpty(t.name, 64) ?? symbol, symbol, decimals: 9, totalSupply: units(BigInt(t.max_supply), 9) };
        }
        const a = db.prepare('SELECT * FROM assets WHERE address = ?').get(r) as any;
        if (!a || !db.prepare('SELECT 1 FROM pools WHERE asset1 = ?').get(r)) return null;
        const dec = a.decimals ?? KNOWN_DECIMALS[r] ?? 9;
        const symbol = nonEmpty(a.symbol, 16) ?? '???';
        return {
            id: friendly(r), name: nonEmpty(a.name, 64) ?? (symbol !== '???' ? symbol : 'Unknown'), symbol, decimals: dec,
            ...(a.total_supply ? { totalSupply: units(BigInt(a.total_supply), dec) } : {}),
        };
    }

    // On-chain order: asset0 = token0 (Gram -> native id), asset1 = token1's jetton master.
    function pairView(id: string) {
        const r = rawOf(id);
        const p = r ? db.prepare('SELECT * FROM pools WHERE address = ? AND active = 1').get(r) as any : undefined;
        if (!p) return null;
        return {
            id: friendly(p.address), dexKey: DEX_KEY, asset0Id: ID(p.asset0), asset1Id: ID(p.asset1),
            ...(p.created_mc_seqno != null ? { createdAtBlockNumber: p.created_mc_seqno } : {}),
            ...(p.created_utime != null ? { createdAtBlockTimestamp: p.created_utime } : {}),
            ...(p.created_tx ? { createdAtTxnId: hexHash(p.created_tx) } : {}),
            ...(p.creator ? { creator: friendly(p.creator) } : {}),
            ...(p.fee_bps != null ? { feeBps: p.fee_bps } : {}),
        };
    }

    // One dex_events row (joined with its pool) -> a DexScreener event, or null if it must not be
    // served (fee collects, empty joins/exits, malformed swaps, a price that rounds to 0).
    function eventView(e: any) {
        const d0 = e.decimals0 as number, d1 = e.decimals1 as number;
        const pos = (v: string | null, d: number) => { const b = BigInt(v ?? '0'); return b > 0n ? units(b, d) : null; };
        // Reserves after the event; fallback (never expected once settled): the pool's last snapshot.
        const res = (v: string | null, pv: string | null) => {
            const b = v != null ? BigInt(v) : pv != null ? BigInt(pv) : 0n;
            return b > 0n ? b : 0n;
        };
        const base = {
            block: blockView(e.mc_seqno, e.utime),
            eventType: e.kind as string,
            txnId: hexHash(e.tx_hash),
            txnIndex: Number(e.lt),
            eventIndex: e.event_index as number,
            maker: friendly(e.maker),
            pairId: friendly(e.pool),
        };
        const reserves = {
            asset0: units(res(e.reserve0, e.pool_reserve0), d0),
            asset1: units(res(e.reserve1, e.pool_reserve1), d1),
        };
        if (e.kind === 'swap') {
            const a0In = pos(e.amount0_in, d0), a1In = pos(e.amount1_in, d1);
            const a0Out = pos(e.amount0_out, d0), a1Out = pos(e.amount1_out, d1);
            if (!((a0In && a1Out && !a1In && !a0Out) || (a1In && a0Out && !a0In && !a1Out))) return null;
            const price = priceNative(BigInt(e.sqrt_price), d0, d1);
            if (!/[1-9]/.test(price)) return null;
            return {
                ...base,
                ...(a0In ? { asset0In: a0In } : { asset1In: a1In }),
                ...(a1Out ? { asset1Out: a1Out } : { asset0Out: a0Out }),
                priceNative: price,
                reserves,
            };
        }
        if (e.kind === 'join' || e.kind === 'exit') {
            const a0 = pos(e.amount0, d0) ?? '0', a1 = pos(e.amount1, d1) ?? '0';
            if (a0 === '0' && a1 === '0') return null;
            return { ...base, amount0: a0, amount1: a1, reserves };
        }
        return null;
    }

    function route(sub: string, query: URLSearchParams): [number, unknown] {
        if (sub === 'latest-block') {
            const b = latestBlock();
            return b ? [200, { block: blockView(b.seqno, b.utime) }] : [503, { error: 'no indexed block yet' }];
        }
        if (sub === 'asset' || sub === 'pair') {
            const id = query.get('id');
            if (!id || id.length > 100) return [400, { error: 'id required' }];
            const v = sub === 'asset' ? assetView(id) : pairView(id);
            return v ? [200, { [sub]: v }] : [404, { error: `unknown ${sub}` }];
        }
        if (sub === 'events') {
            const from = intParam(query.get('fromBlock'));
            const to = intParam(query.get('toBlock'));
            if (from === null || to === null) return [400, { error: 'fromBlock and toBlock must be non-negative integers' }];
            if (from > to) return [400, { error: 'fromBlock > toBlock' }];
            if (to - from > DS_MAX_RANGE) return [400, { error: `range is limited to ${DS_MAX_RANGE} blocks` }];
            const b = latestBlock();
            const end = Math.min(to, b?.seqno ?? -1); // never past the last fully indexed block
            if (from > end) return [200, { events: [] }];
            const rows = db.prepare(`SELECT e.*, p.decimals0, p.decimals1, p.reserve0 AS pool_reserve0, p.reserve1 AS pool_reserve1
                FROM dex_events e JOIN pools p ON p.address = e.pool
                WHERE e.mc_seqno BETWEEN ? AND ? AND e.kind != 'collect'
                ORDER BY e.mc_seqno, CAST(e.lt AS INTEGER), e.event_index LIMIT ?`)
                .all(from, end, DS_MAX_EVENTS + 1) as any[];
            if (rows.length > DS_MAX_EVENTS) return [400, { error: `more than ${DS_MAX_EVENTS} events, use a smaller block range` }];
            return [200, { events: rows.map(eventView).filter((v) => v !== null) }];
        }
        return [404, { error: 'not found' }];
    }

    return {
        NATIVE_ID, plainAssets, recordSwap, recordModify, poolKind, seedLaunchPools, maintainPlain, activePlainPools,
        beginRound, endRound, describeStep, backfillStep, route, latestBlock,
    };
}
