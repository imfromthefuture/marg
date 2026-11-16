// Local check that one bad token or transaction never stops the indexer loop. No network:
// the factories and toncenter are mocked. Run with `npm test` (uses a temp DB, removed after).
import assert from 'node:assert/strict';
import { Address, beginCell, Cell, Dictionary } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import { Pool, storeModifyEvent, storeSwapEvent } from '../../../dex/v2/build/Router_Pool';
import { db, dexRouters, io, route, setReady, sources, syncOnce, Source, Found } from '../src/index';
import Database from 'better-sqlite3';
import { createDex, priceNative, ratio, units } from '../src/dex';
import { loadModifyEvent, loadSwapEvent } from '../../../dex/v2/build/Router_Pool';
import { fetchableUrl, isBlockedIp, parseMeta } from '../src/meta';

const addr = (n: number) => new Address(0, Buffer.alloc(32, n));
const key = (k: string) => BigInt('0x' + sha256_sync(k).toString('hex'));
const snake = (s: string) => beginCell().storeUint(0, 8).storeStringTail(s).endCell();
function onchain(fields: Record<string, string>): Cell {
    const d = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    for (const [k, v] of Object.entries(fields)) d.set(key(k), snake(v));
    return beginCell().storeUint(0, 8).storeDict(d).endCell();
}

const ROUTER = addr(0xee);
const POOL = addr(0xa0);
const TOKENS = [addr(1), addr(2), addr(3), addr(4), addr(5)];
let detailsCalls = 0;

const good: Found = {
    creator: addr(0xc0), createdAt: 1_700_000_000, pool: POOL, sqrtPriceX96: 1n << 96n,
    content: onchain({ name: 'Good\u0000 token ' + 'x'.repeat(200), symbol: 'GOODSYMBOLWAYTOOLONG', image: 'javascript:alert(1)', description: 'ok' }),
};
const launch: Source = {
    kind: 'dex', address: addr(0xf1), base: 1_000_000,
    next: async () => 5,
    addressOf: async (i) => TOKENS[i],
    async details(t) {
        detailsCalls++;
        if (t.equals(TOKENS[0])) return good;
        // Malformed content: prefix 0 with a dict ref that is not a dict.
        if (t.equals(TOKENS[1])) return { ...good, pool: addr(0xa1), content: beginCell().storeUint(0, 8).storeBit(1).storeRef(beginCell().storeUint(5, 3).endCell()).endCell() };
        if (t.equals(TOKENS[2])) throw new Error('getter exploded');
        // Off-chain metadata on a loopback host: must be refused without a request.
        if (t.equals(TOKENS[3])) return { ...good, pool: addr(0xa3), content: beginCell().storeUint(1, 8).storeStringTail('https://127.0.0.1/meta.json').endCell() };
        return 'pending'; // master not deployed yet
    },
};
const undeployed: Source = { kind: 'dex', address: addr(0xf2), base: 2_000_000, next: async () => null, addressOf: async () => { throw new Error('no'); }, details: async () => 'pending' };
const broken: Source = { kind: 'dex', address: addr(0xf3), base: 3_000_000, next: async () => { throw new Error('factory down'); }, addressOf: async () => addr(9), details: async () => 'pending' };
sources.length = 0;
sources.push(broken, launch, undeployed);

const swapEv = (zeroForOne: boolean, amountIn: bigint, amountOut: bigint, sqrtPriceX96: bigint, protocolFee = 0n) => beginCell().store(storeSwapEvent({
    $$type: 'SwapEvent', fromUser: addr(0xb0), zeroForOne, amountIn, amountOut,
    refFee: 0n, feeTotal: 0n, protocolFee, hookFee: 0n, sqrtPriceX96, tick: 0n, liquidity: 1n,
    crossings: 0n, steps: 1n, stop: 0n, tax: 0n, platformFee: 0n,
})).endCell().toBoc().toString('base64');
const modifyEv = (owner: Address, liquidityDelta: bigint, amount0: bigint, amount1: bigint, fees0 = 0n, fees1 = 0n) => beginCell().store(storeModifyEvent({
    $$type: 'ModifyEvent', owner, index: 0n, tickLower: -887200n, tickUpper: 887200n, liquidityDelta, amount0, amount1, fees0, fees1,
})).endCell().toBoc().toString('base64');
const swap = (n: number) => swapEv(true, 1_000_000_000n, 5n * 10n ** 15n, (1n << 96n) + BigInt(n));

// Plain Gram/USDT pool (spacing 60) derived from the Router and its mocked USDT wallet.
const USDT = Address.parse('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs');
const NOT = Address.parse('EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT');
const walletOf = (m: string) => (Address.parse(m).equals(USDT) ? addr(0x71) : addr(0x72));
let USDT_POOL = '';
const hash = (n: number) => Buffer.alloc(32, n).toString('base64');
const out = (body: string, created_lt?: string) => ({ destination: null, message_content: { body }, ...(created_lt ? { created_lt } : {}) });
const nowS = Math.floor(Date.now() / 1000);
const txs = [
    { account: POOL.toRawString(), hash: 'bad-b64', lt: '10', now: nowS, out_msgs: [out('!!!not base64!!!')] },
    { account: POOL.toRawString(), hash: 'truncated', lt: '11', now: nowS, out_msgs: [out(beginCell().storeUint(0x4d480071, 32).storeUint(1, 8).endCell().toBoc().toString('base64'))] },
    { account: POOL.toRawString(), hash: 'garbage-shape', lt: 'NaN?', now: 'x', out_msgs: 'nope' },
    { account: 'not an address', hash: 'bad-account', lt: '1', now: nowS },
    // launch: locked position (1B tokens, ModifyEvent) then the dev buy, in one tx; the out_msgs are
    // listed out of order and must be numbered by created_lt (join = 0, swap = 1).
    { account: POOL.toRawString(), hash: hash(1), lt: '12', now: nowS, mc_block_seqno: 990,
        out_msgs: [out(swap(1), '1202'), out(modifyEv(addr(0xd0), 1000n, 0n, 10n ** 18n), '1201')] },
    // launch buy: 1 Gram in (0.01 protocol fee), 5M tokens out, price after = 4 tokens per Gram (sqrtP = 2 * 2^96)
    { account: POOL.toRawString(), hash: hash(2), lt: '13', now: nowS, mc_block_seqno: 995, out_msgs: [out(swapEv(true, 1_000_000_000n, 5n * 10n ** 15n, 1n << 97n, 10_000_000n))] },
    // exit of 0.5 Gram + 100M tokens (+0.001 Gram fees), then a fee collect (not served)
    { account: POOL.toRawString(), hash: hash(5), lt: '14', now: nowS, mc_block_seqno: 996,
        out_msgs: [out(modifyEv(addr(0xd0), -100n, 500_000_000n, 10n ** 17n, 1_000_000n)), out(modifyEv(addr(0xd0), 0n, 0n, 0n, 0n, 10n ** 9n))] },
    // after the latest indexed block: must not be served yet
    { account: POOL.toRawString(), hash: hash(3), lt: '16', now: nowS, mc_block_seqno: 1005, out_msgs: [out(swap(3))] },
];
const plainTxs = () => [
    // plain USDT pool: join 10 Gram + 50 USDT
    { account: USDT_POOL, hash: hash(6), lt: '19', now: nowS, mc_block_seqno: 996, out_msgs: [out(modifyEv(addr(0xd1), 5000n, 10_000_000_000n, 50_000_000n))] },
    // plain USDT sell: 2.5 USDT in, 2 Gram out, sqrtP = 2^96 -> 1 raw USDT per raw nanoGram -> 1000 USDT per Gram
    { account: USDT_POOL, hash: hash(4), lt: '20', now: nowS, mc_block_seqno: 997, out_msgs: [out(swapEv(false, 2_500_000n, 2_000_000_000n, 1n << 96n))] },
];
const poolStateCalls: string[] = [];
io.mcInfo = async () => ({ seqno: 1000, utime: nowS });
io.walletAddress = async (master: string) => walletOf(master);
io.poolState = async (pool: string) => {
    poolStateCalls.push(pool);
    return pool === USDT_POOL
        ? { reserve0: 8_000_000_000n, reserve1: 52_500_000n, tickSpacing: 60, token1: addr(0x71).toRawString(), feePips: 3000 }
        : { reserve0: 7_000_000_000n, reserve1: 10n ** 17n, tickSpacing: 200, token1: addr(0x73).toRawString(), feePips: 10_000 };
};
io.v3 = async (path: string, params: [string, string][]) => {
    if (path === 'transactions') {
        const accts = new Set(params.filter(([k]) => k === 'account').map(([, v]) => v));
        return { transactions: [...txs, ...plainTxs()].filter((t) => accts.has(t.account) || t.account === 'not an address' || !t.mc_block_seqno) };
    }
    if (path === 'jetton/masters') return { jetton_masters: [
        { address: USDT.toRawString().toUpperCase(), total_supply: '1429976002510000', jetton_content: { decimals: '6' } },
        { address: NOT.toRawString().toUpperCase(), total_supply: '102000000000000000000', jetton_content: {} },
    ], metadata: { [USDT.toRawString().toUpperCase()]: { token_info: [{ name: 'Tether USD', symbol: 'USD\u20ae' }] } } };
    if (path === 'accountStates') return { accounts: params.filter(([k, v]) => k === 'address' && v === USDT_POOL).map(([, v]) => ({ address: v, status: 'active' })) };
    if (path === 'jetton/wallets') return { jetton_wallets: [
        { owner: ROUTER.toRawString(), balance: '900' }, ...Array.from({ length: 99 }, (_, i) => ({ owner: addr(i + 20).toRawString(), balance: '1' })),
    ] };
    throw new Error('unexpected ' + path);
};

(async () => {
    USDT_POOL = (await Pool.fromInit(addr(0xee), { $$type: 'PoolKey', token0: new Address(0, Buffer.alloc(32)), token1: addr(0x71), tickSpacing: 60n, ext: null })).address.toRawString();
    // Formatting units
    assert.equal(units(2_500_000n, 6), '2.5');
    assert.equal(units(1000n * 10n ** 9n, 9), '1000');
    assert.equal(units(1n, 9), '0.000000001');
    assert.equal(ratio(1n, 3n, 5), '0.33333');
    assert.equal(priceNative(1n << 96n, 9, 6), '1000');                 // USDT per Gram
    assert.equal(priceNative(1n << 97n, 9, 9), '4');                    // tokens per Gram
    assert.equal(priceNative(1n << 95n, 9, 9), '0.25');
    assert.equal(priceNative(1n, 9, 9), '0');                           // < 1e-50: never served
    assert.equal(priceNative(3n << 96n, 9, 9), '9');
    assert.equal(ratio(1n, 7n), '0.142857142857142857142857');           // 24 significant digits
    assert.equal(ratio(1n, 10n ** 60n), '0');                           // at most 50 decimals
    assert.equal(units(1n, 60), '0');
    assert.equal(units(10n ** 10n + 1n, 60), '0.00000000000000000000000000000000000000000000000001');
    // Parser units
    assert.equal(isBlockedIp('127.0.0.1'), true);
    assert.equal(isBlockedIp('::ffff:10.0.0.1'), true);
    assert.equal(isBlockedIp('8.8.8.8'), false);
    assert.equal(fetchableUrl('http://example.com/x'), null);
    assert.equal(fetchableUrl('https://localhost/x'), null);
    assert.equal(fetchableUrl('https://[::1]/x'), null);
    assert.equal(fetchableUrl('https://example.com:8443/x'), null);
    assert.ok(fetchableUrl('ipfs://bafyabc/meta.json')?.toString().startsWith('https://ipfs.io/ipfs/bafyabc'));
    assert.equal((await parseMeta('not a cell')).symbol, '???');
    assert.equal((await parseMeta(beginCell().endCell())).name, 'Unknown');

    for (let round = 1; round <= 3; round++) {
        await syncOnce();
        console.log(`round ${round}: tokens=${(db.prepare('SELECT COUNT(*) n FROM tokens').get() as any).n} trades=${(db.prepare('SELECT COUNT(*) n FROM trades').get() as any).n}`);
    }
    const rows = db.prepare('SELECT idx, name, symbol, image, pool, placeholder FROM tokens ORDER BY idx').all() as any[];
    console.table(rows.map((r) => ({ ...r, name: r.name.slice(0, 30) + (r.name.length > 30 ? '…' : '') })));
    assert.deepEqual(rows.map((r) => r.idx), [1_000_000, 1_000_001, 1_000_002, 1_000_003]); // #4 pending, not stored
    assert.equal(rows[0].name.length, 64);
    assert.ok(!rows[0].name.includes('\u0000'));
    assert.equal(rows[0].symbol, 'GOODSYMBOLWAYTOO');
    assert.equal(rows[0].image, null);
    assert.equal(rows[1].symbol, '???');         // malformed content -> defaults
    assert.equal(rows[2].placeholder, 1);        // kept failing -> placeholder, index advanced
    assert.equal(rows[3].name, 'Unknown');       // loopback metadata refused
    assert.equal(rows[3].placeholder, 1);        // ... and kept for a later retry
    const trades = db.prepare('SELECT hash FROM trades').all() as any[];
    assert.deepEqual(trades.map((t) => t.hash).sort(), [hash(1), hash(2), hash(3)].sort());

    setReady(); // the API still answers
    dexRouters.add(ROUTER.toRawString());
    const [s0, status] = await route('/api/idx/status', new URLSearchParams()) as [number, any];
    assert.equal(s0, 200);
    assert.equal(status.factory, null); // no curve factory
    // A leftover row of the retired curve factory is neither listed nor served.
    db.prepare(`INSERT INTO tokens (address, idx, name, symbol, virtual_ton, virtual_tokens, graduation_ton, max_supply, kind)
        VALUES (?, 7, 'Old', 'OLD', '0', '1', '1', '1', 'curve')`).run(addr(0x99).toRawString());
    assert.equal((await route(`/api/idx/token/${addr(0x99).toString()}`, new URLSearchParams()))[0], 404);
    const [s1, list] = await route('/api/idx/tokens', new URLSearchParams('kind=dex')) as [number, any[]];
    assert.equal(s1, 200);
    assert.equal(list.length, 4);
    assert.equal(list[3].factoryIndex, 0);
    const [, candles] = await route(`/api/idx/token/${TOKENS[0].toString()}/candles`, new URLSearchParams('tf=60')) as [number, any[]];
    assert.ok(candles.length >= 1);
    // Holders: the Router wallet is dropped but `more` still follows the full page; floods share one request.
    const [r1, r2] = await Promise.all([1, 2].map(() => route(`/api/idx/token/${TOKENS[0].toString()}/holders`, new URLSearchParams())));
    assert.equal(r1[1], r2[1]);
    assert.equal((r1[1] as any).count, 99);
    assert.equal((r1[1] as any).more, true);

    // DexScreener adapter
    const ds = (p: string, q = '') => route(`/api/idx/dexscreener/${p}`, new URLSearchParams(q)) as Promise<[number, any]>;
    const f = (a: Address | string) => (typeof a === 'string' ? Address.parse(a) : a).toString({ testOnly: true });
    const NATIVE = f(new Address(0, Buffer.alloc(32)));
    const plainRows = db.prepare("SELECT * FROM pools WHERE kind = 'plain' ORDER BY tick_spacing").all() as any[];
    assert.equal(plainRows.length, 8); // 2 assets x 4 presets
    assert.deepEqual(plainRows.filter((r) => r.active).map((r) => r.address), [USDT_POOL]);
    assert.equal(plainRows.find((r) => r.address === USDT_POOL).decimals1, 6);
    assert.equal(plainRows.find((r) => r.asset1 === NOT.toRawString()).decimals1, 9);
    assert.ok(poolStateCalls.includes(USDT_POOL) && poolStateCalls.includes(POOL.toRawString()));

    assert.deepEqual(await ds('latest-block'), [200, { block: { blockNumber: 1000, blockTimestamp: nowS } }]);
    assert.deepEqual(await ds('asset', `id=${f(USDT)}`), [200, { asset: { id: f(USDT), name: 'Tether USD', symbol: 'USD\u20ae', decimals: 6, totalSupply: '1429976002.51' } }]);
    assert.deepEqual(await ds('asset', `id=${f(TOKENS[0])}`), [200, { asset: { id: f(TOKENS[0]), name: rows[0].name, symbol: 'GOODSYMBOLWAYTOO', decimals: 9, totalSupply: '1000000000' } }]);
    // NOT: no name/symbol in the metadata -> never empty
    assert.deepEqual((await ds('asset', `id=${f(NOT)}`))[1].asset, { id: f(NOT), name: 'Unknown', symbol: '???', decimals: 9, totalSupply: '102000000000' });
    assert.deepEqual(await ds('asset', `id=${NATIVE}`), [200, { asset: {
        id: NATIVE, name: 'Toncoin', symbol: 'TON', decimals: 9, totalSupply: '5000000000', coinGeckoId: 'the-open-network' } }]);
    assert.equal((await ds('asset', 'id=nope'))[0], 404);
    // Pairs follow on-chain order: asset0 = token0 = Gram (native), asset1 = the jetton master.
    const [, plainPair] = await ds('pair', `id=${f(USDT_POOL)}`);
    assert.deepEqual(plainPair.pair, {
        id: f(USDT_POOL), dexKey: 'marg', asset0Id: NATIVE, asset1Id: f(USDT), feeBps: 30,
        // creation = its first transaction (backfill); no InitializeEvent in the mock, so no creator
        createdAtBlockNumber: 996, createdAtBlockTimestamp: nowS, createdAtTxnId: Buffer.alloc(32, 6).toString('hex'),
    });
    const [, launchPair] = await ds('pair', `id=${f(POOL)}`);
    assert.equal(launchPair.pair.asset0Id, NATIVE);
    assert.equal(launchPair.pair.asset1Id, f(TOKENS[0]));
    assert.equal(launchPair.pair.feeBps, 100);                     // from get_pool_state (fee 10000 pips)
    assert.equal(launchPair.pair.creator, f(addr(0xc0)));
    assert.equal(launchPair.pair.createdAtTxnId, Buffer.alloc(32, 1).toString('hex')); // first pool tx (backfill)
    assert.equal(launchPair.pair.createdAtBlockNumber, 990);
    assert.equal((await ds('pair', `id=${f(plainRows.find((r) => !r.active).address)}`))[0], 404); // not deployed

    const [se, { events }] = await ds('events', 'fromBlock=900&toBlock=2000');
    assert.equal(se, 200);
    // 1005 > latest block; the fee collect (996) is not served
    assert.deepEqual(events.map((e: any) => [e.block.blockNumber, e.eventType, e.eventIndex]),
        [[990, 'join', 0], [990, 'swap', 1], [995, 'swap', 0], [996, 'exit', 0], [996, 'join', 0], [997, 'swap', 0]]);
    const hx = (n: number) => Buffer.alloc(32, n).toString('hex');
    const blk = (n: number) => ({ blockNumber: n, blockTimestamp: nowS });
    // Reserves replayed exactly from the pool's creation (the mock pool state disagrees on purpose).
    assert.deepEqual(events[0], {
        block: blk(990), eventType: 'join', txnId: hx(1), txnIndex: 12, eventIndex: 0, maker: f(addr(0xd0)), pairId: f(POOL),
        amount0: '0', amount1: '1000000000', reserves: { asset0: '0', asset1: '1000000000' },
    });
    assert.deepEqual(events[1], {
        block: blk(990), eventType: 'swap', txnId: hx(1), txnIndex: 12, eventIndex: 1, maker: f(addr(0xb0)), pairId: f(POOL),
        asset0In: '1', asset1Out: '5000000', priceNative: '1', reserves: { asset0: '1', asset1: '995000000' },
    });
    assert.deepEqual(events[2], {
        block: blk(995), eventType: 'swap', txnId: hx(2), txnIndex: 13, eventIndex: 0, maker: f(addr(0xb0)), pairId: f(POOL),
        asset0In: '1', asset1Out: '5000000', priceNative: '4',
        reserves: { asset0: '1.99', asset1: '990000000' },          // the 0.01 protocol fee left the reserves
    });
    assert.deepEqual(events[3], {
        block: blk(996), eventType: 'exit', txnId: hx(5), txnIndex: 14, eventIndex: 0, maker: f(addr(0xd0)), pairId: f(POOL),
        amount0: '0.5', amount1: '100000000', reserves: { asset0: '1.489', asset1: '890000000' }, // fees paid out too
    });
    assert.deepEqual(events[4], {
        block: blk(996), eventType: 'join', txnId: hx(6), txnIndex: 19, eventIndex: 0, maker: f(addr(0xd1)), pairId: f(USDT_POOL),
        amount0: '10', amount1: '50', reserves: { asset0: '10', asset1: '50' },
    });
    const plainSell = events[5];
    assert.deepEqual(plainSell, {
        block: blk(997), eventType: 'swap', txnId: hx(4), txnIndex: 20, eventIndex: 0, maker: f(addr(0xb0)), pairId: f(USDT_POOL),
        asset1In: '2.5', asset0Out: '2', priceNative: '1000',
        reserves: { asset0: '8', asset1: '52.5' },
    });
    for (const e of events) {
        assert.ok(e.reserves, 'reserves on every event');
        if (e.eventType === 'swap') assert.ok(Number(e.priceNative) > 0);
    }
    // Every event, the not-yet-served one included, has reserves stored; the launch pool is exact.
    assert.equal((db.prepare('SELECT COUNT(*) n FROM dex_events WHERE reserve0 IS NULL OR reserve1 IS NULL').get() as any).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM dex_events WHERE pool = ? AND exact = 0').get(POOL.toRawString()) as any).n, 0);
    assert.deepEqual((await ds('events', 'fromBlock=991&toBlock=994'))[1], { events: [] });
    assert.deepEqual((await ds('events', 'fromBlock=996&toBlock=996'))[1].events.map((e: any) => e.txnIndex), [14, 19]); // inclusive bounds
    assert.equal((await ds('events', 'fromBlock=0&toBlock=10001'))[0], 400);
    assert.equal((await ds('events', 'fromBlock=5&toBlock=4'))[0], 400);
    assert.equal((await ds('events', 'fromBlock=-1&toBlock=4'))[0], 400);
    assert.equal((await ds('events', 'fromBlock=1.5&toBlock=4'))[0], 400);
    assert.equal((await ds('events', 'toBlock=4'))[0], 400);
    assert.equal((await ds('nope'))[0], 404);

    // Reserves on a separate DB: v1 migration, snapshot-backward fill, exact replay, checkpoint reset.
    {
        const mdb = new Database(':memory:');
        mdb.exec(`CREATE TABLE pools (address TEXT PRIMARY KEY, token0 TEXT NOT NULL, token1 TEXT, asset0 TEXT NOT NULL, asset1 TEXT NOT NULL,
            decimals0 INTEGER NOT NULL, decimals1 INTEGER NOT NULL, tick_spacing INTEGER, fee_bps REAL, kind TEXT NOT NULL,
            created_utime INTEGER, created_mc_seqno INTEGER, created_tx TEXT, creator TEXT, active INTEGER NOT NULL DEFAULT 0,
            reserve0 TEXT, reserve1 TEXT, backfill_lt TEXT, backfill_done INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE dex_events (id INTEGER PRIMARY KEY, tx_hash TEXT NOT NULL, event_index INTEGER NOT NULL, lt TEXT NOT NULL,
            utime INTEGER NOT NULL, mc_seqno INTEGER NOT NULL, pool TEXT NOT NULL, maker TEXT NOT NULL, amount0_in TEXT NOT NULL,
            amount1_in TEXT NOT NULL, amount0_out TEXT NOT NULL, amount1_out TEXT NOT NULL, sqrt_price TEXT NOT NULL,
            reserve0 TEXT, reserve1 TEXT, UNIQUE (tx_hash, event_index));
            INSERT INTO dex_events VALUES (1, 'h', 0, '1', 1, 1, 'p', 'm', '0', '0', '0', '0', '1', NULL, NULL);`);
        const P = addr(0x99).toRawString();
        mdb.prepare(`INSERT INTO pools (address, token0, asset0, asset1, decimals0, decimals1, kind, active, backfill_lt, backfill_done)
            VALUES (?, ?, 'native', ?, 9, 9, 'plain', 1, '5', 1)`).run(P, '0:' + '0'.repeat(64), addr(0x98).toRawString());
        let snap = { reserve0: 0n, reserve1: 0n, tickSpacing: 60, token1: addr(0x97).toRawString(), feePips: 3000 };
        const kv = new Map<string, string>();
        const m = createDex({
            db: mdb, testOnly: true, router: () => null, externalBodies: () => [], handleTx: () => {},
            io: { v3: async () => ({}), poolState: async () => snap, walletAddress: async () => addr(0) },
            kvGet: (k) => kv.get(k), kvSet: (k, v) => { kv.set(k, v); }, log: () => {}, err: () => {},
        });
        assert.equal((mdb.prepare('SELECT COUNT(*) n FROM dex_events').get() as any).n, 0);          // v1 dropped
        assert.deepEqual(mdb.prepare('SELECT backfill_lt, backfill_done FROM pools').get(), { backfill_lt: null, backfill_done: 0 });
        const cell = (b64: string) => Cell.fromBase64(b64).beginParse();
        const tx = (lt: number) => ({ hash: hash(lt), lt: String(lt), now: nowS, mc_block_seqno: 2000 + lt });
        const res = () => (mdb.prepare('SELECT lt, event_index, reserve0, reserve1, exact FROM dex_events ORDER BY CAST(lt AS INTEGER), event_index').all() as any[])
            .map((r) => `${r.lt}/${r.event_index}:${r.reserve0},${r.reserve1}${r.exact ? '!' : ''}`);
        // Backfill not started: polled events get reserves walked back from the snapshot.
        m.beginRound();
        m.recordSwap(tx(20), P, loadSwapEvent(cell(swapEv(true, 100n, 40n, 1n << 96n))), 0);
        m.recordSwap(tx(21), P, loadSwapEvent(cell(swapEv(false, 10n, 20n, 1n << 96n))), 0);
        snap = { ...snap, reserve0: 1080n, reserve1: 970n };
        await m.endRound({ seqno: 2021, utime: nowS });
        assert.deepEqual(res(), ['20/0:1100,960', '21/0:1080,970']);
        // History from creation arrives (backfill done): exact replay replaces the approximation.
        m.recordModify(tx(10), P, loadModifyEvent(cell(modifyEv(addr(1), 5n, 1000n, 1000n))), 0);
        mdb.prepare('UPDATE pools SET backfill_lt = ?, backfill_done = 1').run('21');
        m.beginRound();
        await m.endRound(null);
        m.beginRound();
        m.recordSwap(tx(22), P, loadSwapEvent(cell(swapEv(true, 5n, 2n, 1n << 96n))), 0);
        await m.endRound(null);
        assert.deepEqual(res(), ['10/0:1000,1000!', '20/0:1100,960!', '21/0:1080,970!', '22/0:1085,968!']);
        assert.equal((mdb.prepare('SELECT replay_lt FROM pools').get() as any).replay_lt, '22');
        // An older event shows up later: checkpoint reset, full replay.
        m.beginRound();
        m.recordModify(tx(15), P, loadModifyEvent(cell(modifyEv(addr(1), -1n, 100n, 100n, 1n, 0n))), 0);
        await m.endRound(null);
        assert.deepEqual(res(), ['10/0:1000,1000!', '15/0:899,900!', '20/0:999,860!', '21/0:979,870!', '22/0:984,868!']);
        mdb.close();
    }
    console.log(`OK: loop survived (details calls: ${detailsCalls})`);
    process.exit(0);
})().catch((e) => {
    console.error('FAIL', e);
    process.exit(1);
});
