import { Address, beginCell, Builder, Cell, contractAddress, toNano, TupleReader, type TupleItem } from '@ton/core';
import {
    loadKeyExt, Router, storeJettonTransfer, storeMintNative, storeMintPayload, storePositionDecrease, storeSwapNative,
    storeSwapPayload, type KeyExt, type PoolKey, type PoolState, type Quote,
} from '../../dex/v2/build/Router_Router';
import { loadGetterTuplePoolState, loadGetterTupleQuote, Pool } from '../../dex/v2/build/Router_Pool';
import { Position, type PositionData } from '../../dex/v2/build/Router_Position';
import { LaunchJetton, type LaunchInfo } from '../../launch/build/Launch_LaunchJetton';
import { client, IS_TESTNET, openMaster, openWallet, parseContent, q, TONCENTER, verifiedWallet } from './ton';
import { launchFactory } from './launch';
import { api } from './api';
import { launchExtra, sqrtBand } from './dexmath';
import { assertMargRouter, DEX_ROUTER, DEX_ROUTERS, isLaunchToken, isMargRouter, isMissingGetter, KNOWN_TOKENS, knownToken } from './dexenv';

export type { PoolKey, PoolState, Quote, LaunchInfo, PositionData };

// Marg DEX v2 Router (dex/v2). Until it is set, the DEX pages render but every action is disabled.
export { CLOSED_LABEL, DEX_LIVE, DEX_ROUTER, isMissingGetter } from './dexenv';
const API_KEY = import.meta.env.VITE_TONCENTER_KEY as string | undefined;

// Gram is the zero address: it always sorts first, so it is token0 of every Gram pool.
export const GRAM = new Address(0, Buffer.alloc(32));
export const isGram = (a: Address) => a.equals(GRAM);

// Fee tiers (dex/v2 README "Fee model"). Presets are add-only, so these keep working.
export const PRESETS = [
    { spacing: 1, name: 'Stable', basePips: 100 },
    { spacing: 10, name: 'Low', basePips: 500 },
    { spacing: 60, name: 'Standard', basePips: 3000 },
    { spacing: 200, name: 'Launch', basePips: 10000 },
];
export const presetOf = (spacing: number) => PRESETS.find((p) => p.spacing === spacing);
export const pct = (pips: bigint | number, digits = 2) => `${(Number(pips) / 10_000).toFixed(digits)}%`;

// Value to attach, from dex/v2/contracts/constants.tact. The Router refuses less than the user's
// own worst case (the Router -> Pool hop is non-bounceable); everything unused comes back.
export const GAS = {
    SWAP_BASE: toNano('0.35'),      // SWAP_BASE_GAS
    CROSS: toNano('0.006'),         // CROSS_GAS, per allowed crossing
    PAYOUT: toNano('0.07'),         // JETTON_PAYOUT_VALUE, added for allowPartial (the refund leg)
    MINT: toNano('0.6'),            // MINT_GAS: covers 2 new ticks incl. TICK_INIT_FEE
    DECREASE: toNano('0.25'),       // DECREASE_GAS (Position minimum)
    TICK_INIT_FEE: toNano('0.1'),   // per new tick, stays in the pool for good
    TICK_RENT: toNano('0.02'),      // per new tick, refundable when the tick is cleared
    WALLET: toNano('0.15'),         // the user's jetton wallet hop; +0.05 for a holder-rewards checkpoint (launch/README.md)
    MARGIN: toNano('0.05'),         // 2 forward fees and some slack
};
// The contracts allow 24 (MAX_CROSSINGS_CAP), but a swap is one Pool transaction and TON caps it at
// 1M gas: on an adversarial tick layout 24 crossings plus fee checkpoints can exceed that, the Pool
// aborts, and because the Router -> Pool hop does not bounce the input would be left in the Pool.
// The app asks for at most 12 (measured worst case about 470k gas); a bigger swap partly fills or
// is refunded instead.
export const MAX_CROSSINGS = 12n;
// Crossings to allow for a quoted swap: what the quote crossed plus 4 spare (the price may move a
// little before execution), capped. The Router charges CROSS gas per allowed crossing, so this keeps
// the attached Gram low; a swap that would need more stops and is refunded (or partly fills).
export const crossingsFor = (quoted?: bigint) => (quoted === undefined ? MAX_CROSSINGS : quoted + 4n < MAX_CROSSINGS ? quoted + 4n : MAX_CROSSINGS);
// Launch pools pay the platform fee out in the swap (PAYOUT_MSG_GAS 0.01), and taxed ones may also pay
// the creator tax out (PAYOUT_MSG_GAS + TAX_PAYOUT_GAS = 0.05): dex/v2 constants.tact, Router swapGas.
const LAUNCH_PAYOUT_GAS = toNano('0.01');
const TAX_PAYOUT_GAS = toNano('0.05');
export const swapGas = (allowPartial: boolean, maxCrossings: bigint = MAX_CROSSINGS, pool?: DexPool | null) =>
    GAS.SWAP_BASE + maxCrossings * GAS.CROSS + (allowPartial ? GAS.PAYOUT : 0n) + GAS.MARGIN
    + (pool?.ext?.initializer ? LAUNCH_PAYOUT_GAS + (pool.ext.taxRecipient ? TAX_PAYOUT_GAS : 0n) : 0n);
// Platform fee rate the pool last saw (0 on pools of earlier Routers and on plain pools).
export const platformBpsOf = (pool: DexPool | null) => (pool?.ext?.initializer ? Number(pool.state?.platformBps ?? 0n) : 0);
export const MINT_VALUE = GAS.MINT + 2n * GAS.MARGIN;
export const DECREASE_VALUE = GAS.DECREASE + GAS.MARGIN;
const DEADLINE_SECS = 600;
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECS);

// Quote.code / RefundEvent.code (constants.tact).
const CODES: Record<number, string> = {
    202: 'Price moved past your slippage', 203: 'The pool is empty', 208: 'Too small to get anything out',
    217: 'The pool has not started yet', 220: 'Price out of range', 222: 'Only part of it can fill',
    223: 'No liquidity at this price', 229: 'Amount too large', 230: 'Bad price limit',
};
export const codeText = (code: bigint | number) => CODES[Number(code)] ?? `Refused (code ${code})`;
export const STOPS = ['filled', 'price limit', 'crossing cap (24 ticks per transaction)', 'step cap', 'no more liquidity', 'gas limit of one transaction'];

export const openRouter = (a: Address) => client.open(Router.fromAddress(a));
export const openPool = (a: Address) => client.open(Pool.fromAddress(a));

// get_pool_state / get_quote, tolerant of older pools: fields were appended at the end (platformFees,
// platformBps, Quote.platformFee), so a shorter stack from a pool of an earlier Router is padded with
// zeros (those pools have no platform fee).
const padded = (items: TupleItem[], n = 4) => new TupleReader([...items, ...Array.from({ length: n }, (): TupleItem => ({ type: 'int', value: 0n }))]);
async function poolStateOf(address: Address): Promise<PoolState> {
    const r = await client.runMethod(address, 'get_pool_state');
    return loadGetterTuplePoolState(padded((r.stack as any).items as TupleItem[]));
}
async function quoteOf(address: Address, zeroForOne: boolean, amountIn: bigint): Promise<Quote> {
    const args: TupleItem[] = [
        { type: 'int', value: zeroForOne ? -1n : 0n }, { type: 'int', value: amountIn }, { type: 'int', value: 0n },
        { type: 'int', value: MAX_CROSSINGS }, { type: 'int', value: 0n }, { type: 'int', value: -1n },
    ];
    const r = await client.runMethod(address, 'get_quote', args);
    return loadGetterTupleQuote(padded((r.stack as any).items as TupleItem[]));
}
export const openPosition = (a: Address) => client.open(Position.fromAddress(a));
export const openLaunch = (a: Address) => client.open(LaunchJetton.fromAddress(a));

// --- tokens -------------------------------------------------------------------

// id is the token's id on the DEX: Gram, or the Router's jetton wallet. master is null for Gram.
export type DexToken = {
    id: Address | null; master: Address | null; symbol: string; name: string; image?: string;
    decimals: number;
    launch: LaunchInfo | null;
};
export const GRAM_TOKEN: DexToken = { id: GRAM, master: null, symbol: 'Gram', name: 'Gram', image: '/gram.svg', decimals: 9, launch: null };
// UI price (token0 per token1, in whole tokens) = raw pool price (base units) × this.
export const priceScale = (token0: DexToken, token1: DexToken) => 10 ** (token1.decimals - token0.decimals);
export const tokenKey = (t: DexToken) => (t.master ? t.master.toRawString() : 'gram');

// A list entry before it is resolved on-chain (from the indexer or the launch factory).
export type TokenListItem = { address: string; symbol: string; name: string; image?: string; launch?: boolean };

// get_launch_info, read field by field: masters from earlier factories end at createdAt; current ones
// append the creator vault (vaultBps, vaultLock, vaultVest), read as 0 when absent.
async function readLaunchInfo(master: Address): Promise<LaunchInfo> {
    const t = (await client.runMethod(master, 'get_launch_info')).stack;
    const info = {
        $$type: 'LaunchInfo' as const, creator: t.readAddress(), router: t.readAddress(), feeClaimer: t.readAddress(),
        tickSpacing: t.readBigNumber(), launchFeePips: t.readBigNumber(), launchDuration: t.readBigNumber(), sqrtPriceX96: t.readBigNumber(),
        taxRecipient: t.readAddressOpt(), buyTaxBps: t.readBigNumber(), sellTaxBps: t.readBigNumber(), taxWallet: t.readAddressOpt(),
        rewardsBps: t.readBigNumber(), walletBps: t.readBigNumber(), buybackBps: t.readBigNumber(), buybackCap: t.readBigNumber(),
        createdAt: t.readBigNumber(), vaultBps: 0n, vaultLock: 0n, vaultVest: 0n,
    };
    if (t.remaining >= 3) {
        info.vaultBps = t.readBigNumber();
        info.vaultLock = t.readBigNumber();
        info.vaultVest = t.readBigNumber();
    }
    return info;
}

const launchCache = new Map<string, Promise<LaunchInfo | null>>();
// Launch info of a direct-launch master, null for any other jetton.
export function loadLaunchInfo(master: Address): Promise<LaunchInfo | null> {
    const k = master.toRawString();
    if (!launchCache.has(k)) {
        const p = q(() => readLaunchInfo(master)).catch((e) => {
            if (isMissingGetter(e)) return null;
            launchCache.delete(k);
            throw e;
        });
        launchCache.set(k, p);
    }
    return launchCache.get(k)!;
}

const tokenCache = new Map<string, Promise<DexToken>>();
// Metadata, launch info and DEX id of a jetton master. id stays null for a non-launch jetton
// while no Router is configured.
export function resolveToken(master: Address): Promise<DexToken> {
    const k = master.toRawString();
    if (!tokenCache.has(k)) {
        const p = (async () => {
            const data = await q(() => openMaster(master).getGetJettonData());
            const meta = knownToken(master) ?? await parseContent(data.jettonContent);
            // A launch counts only if a MARG factory created this master and it uses a MARG Router;
            // anything else is treated as a plain jetton (no launch pool, no custom router).
            let launch = await loadLaunchInfo(master);
            if (launch && (!isMargRouter(launch.router) || (await isLaunchToken(master)) !== true)) launch = null;
            if ('incomplete' in meta && meta.incomplete) throw new Error('Could not load this token\'s details (decimals). Try again in a moment.');
            let id: Address | null = null;
            if (launch) id = await q(() => openLaunch(master).getGetRouterWallet());
            else if (DEX_ROUTER) {
                id = await q(() => openMaster(master).getGetWalletAddress(DEX_ROUTER!));
                // A deployed id must be this master's wallet of the Router (not, say, the Router's USDT
                // wallet named by a fake master).
                if ((await q(() => client.getContractState(id!))).state === 'active') {
                    const w = await q(() => openWallet(id!).getGetWalletData());
                    if (!w.master.equals(master) || !w.owner.equals(DEX_ROUTER)) throw new Error('This token\'s contract does not check out (wallet mismatch).');
                }
            }
            return { id, master, symbol: meta.symbol, name: meta.name, image: meta.image, decimals: meta.decimals ?? 9, launch };
        })();
        p.catch(() => tokenCache.delete(k));
        tokenCache.set(k, p);
    }
    return tokenCache.get(k)!;
}

// Token for a DEX id (a Router jetton wallet): its master tells us the rest.
const idCache = new Map<string, Promise<DexToken>>();
export function tokenById(id: Address): Promise<DexToken> {
    if (isGram(id)) return Promise.resolve(GRAM_TOKEN);
    const k = id.toRawString();
    if (!idCache.has(k)) {
        // The id's own wallet names its master; the master must name the same id back, else a fake
        // wallet claiming master = USDT would be shown (and traded) as USDT.
        const p = q(() => openWallet(id).getGetWalletData()).then((w) => resolveToken(w.master)).then((t) => {
            if (!t.id || !t.id.equals(id)) throw new Error('Unverified pool token');
            return { ...t, id };
        });
        p.catch(() => idCache.delete(k));
        idCache.set(k, p);
    }
    return idCache.get(k)!;
}

// Recent direct launches, newest first (each one costs a getter call, so keep `limit` small).
let launchList: Promise<Address[]> | null = null;
export function recentLaunches(limit = 12): Promise<Address[]> {
    if (!launchFactory) return Promise.resolve([]);
    if (!launchList) {
        launchList = (async () => {
            const next = (await q(() => launchFactory!.getGetFactoryData())).nextIndex;
            const out: Address[] = [];
            for (let i = next - 1n; i >= 0n && out.length < limit; i--) out.push(await q(() => launchFactory!.getGetTokenAddress(i)));
            return out;
        })();
        launchList.catch(() => { launchList = null; });
    }
    return launchList;
}

// Token picker list: the indexer's tokens first (no chain reads), then recent direct launches.
export async function tokenList(): Promise<TokenListItem[]> {
    const list: TokenListItem[] = KNOWN_TOKENS.map(({ address, symbol, name, image }) => ({ address, symbol, name, image }));
    try {
        for (const t of await api.tokens()) list.push({ address: t.address, symbol: t.symbol, name: t.name, image: t.image ?? undefined });
    } catch {
        /* indexer down: launches and pasted addresses still work */
    }
    return list;
}

// --- pools --------------------------------------------------------------------

export function extOf(key: PoolKey): KeyExt | null {
    return key.ext ? loadKeyExt(key.ext.beginParse()) : null;
}

export type DexPool = {
    address: Address; key: PoolKey; state: PoolState | null;   // state null: not deployed yet
    token0: DexToken; token1: DexToken; canonical: boolean; ext: KeyExt | null;
    router?: Address;   // the Router that owns this pool (a past deployment for older launches)
};

// Sorted like the Router's makeKey: by the address hash as an unsigned integer.
export function sortTokens(a: DexToken, b: DexToken): [DexToken, DexToken] {
    const h = (t: DexToken) => BigInt('0x' + t.id!.hash.toString('hex'));
    return h(a) < h(b) ? [a, b] : [b, a];
}

export async function loadPool(router: Address, key: PoolKey, token0: DexToken, token1: DexToken, canonical = false): Promise<DexPool> {
    assertMargRouter(router);
    // The current Router's pools are computed locally (initOf Pool(router, key) for a sorted key; the
    // getter can't take a plain key's null ext over Toncenter). A past Router deployed pools from
    // older Pool code, so its own getter is asked (launch keys always have an ext).
    const address = DEX_ROUTER && router.equals(DEX_ROUTER)
        ? (await Pool.fromInit(router, key)).address
        : await q(() => openRouter(router).getGetPoolAddress(key.token0, key.token1, key.tickSpacing, key.ext));
    return { address, key, token0, token1, canonical, ext: extOf(key), state: await loadPoolState(address), router };
}

export async function loadPoolState(address: Address): Promise<PoolState | null> {
    const s = await q(() => client.getContractState(address));
    if (s.state !== 'active') return null;
    return q(() => poolStateOf(address));
}

// The canonical pool of a direct launch (key from the master; only the master can initialize it).
export async function launchPool(token: DexToken): Promise<DexPool | null> {
    if (!token.launch || !token.master || !token.id) return null;
    const key = await q(() => openLaunch(token.master!).getGetPoolKey());
    return loadPool(token.launch.router, key, GRAM_TOKEN, token, true);
}

// Every pool of a pair the app knows about: the launch pool, then the plain key of each preset.
// onPool fires as each one loads, so the UI can fill in while Toncenter is rate limited.
// Without a Router configured, only a launch token's own pool can be found.
export async function findPools(a: DexToken, b: DexToken, o: { onPool?: (p: DexPool) => void; onlyLive?: boolean; preferCanonical?: boolean } = {}): Promise<DexPool[]> {
    const out: DexPool[] = [];
    const push = (p: DexPool) => { out.push(p); o.onPool?.(p); };
    const launch = a.launch && isGram(b.id!) ? a : b.launch && isGram(a.id!) ? b : null;
    if (launch) {
        const p = await launchPool(launch);
        if (p) push(p);
        // A launch token trades in its launch pool; skip 8+ reads for keys nobody uses.
        if (p?.state?.initialized && o.preferCanonical) return out;
    }
    const router = DEX_ROUTER ?? launch?.launch?.router;
    if (!router || !a.id || !b.id) return out;
    const [t0, t1] = sortTokens(a, b);
    for (const pr of PRESETS) {
        const key: PoolKey = { $$type: 'PoolKey', token0: t0.id!, token1: t1.id!, tickSpacing: BigInt(pr.spacing), ext: null };
        const p = await loadPool(router, key, t0, t1);
        if (!o.onlyLive || p.state?.initialized) push(p);
    }
    return out;
}

// Fee right now, split into what the UI shows. feePipsNow already includes the launch extra.
export function feeParts(pool: DexPool) {
    const s = pool.state!;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const base = s.fs.hookFeeSet ? s.fs.hookFeePips : s.fs.baseFeePips;
    const launch = pool.ext ? launchExtra(pool.ext.launchFeePips, pool.ext.launchDuration, s.fs.startTs, now) : 0n;
    const dynamic = s.feePipsNow - base - launch > 0n ? s.feePipsNow - base - launch : 0n;
    const launchEnds = pool.ext && pool.ext.launchDuration > 0n ? Number(s.fs.startTs + pool.ext.launchDuration) : 0;
    return { base, dynamic, launch, total: s.feePipsNow, launchEnds };
}

export const taxOf = (pool: DexPool) => ({ buy: Number(pool.ext?.buyTaxBps ?? 0n), sell: Number(pool.ext?.sellTaxBps ?? 0n) });

export function quote(pool: DexPool, zeroForOne: boolean, amountIn: bigint): Promise<Quote> {
    return q(() => quoteOf(pool.address, zeroForOne, amountIn));
}

// --- messages -----------------------------------------------------------------

export type TxMessage = { address: string; amount: string; payload: string };
const msg = (to: Address, amount: bigint, body: Cell): TxMessage =>
    ({ address: to.toString(), amount: amount.toString(), payload: body.toBoc().toString('base64') });
const cell = (store: (b: Builder) => void) => beginCell().store(store).endCell();

// Jetton transfer to the Router with a payload in a ref (Either bit = 1), as the DEX tests send it.
function jettonToRouter(userWallet: Address, router: Address, owner: Address, amount: bigint, forwardTon: bigint, payload: Cell): TxMessage {
    const forwardPayload = beginCell().storeBit(1).storeRef(payload).endCell().beginParse();
    return msg(userWallet, forwardTon + GAS.WALLET, cell(storeJettonTransfer({
        $$type: 'JettonTransfer', queryId: 0n, amount, destination: router, responseDestination: owner,
        customPayload: null, forwardTonAmount: forwardTon, forwardPayload,
    })));
}

// Swap: Gram in = SwapNative to the Router; jetton in = jetton transfer with a SwapPayload.
export async function swapMessage(o: {
    router: Address; pool: DexPool; tokenIn: DexToken; tokenOut: DexToken; amountIn: bigint; minOut: bigint;
    allowPartial: boolean; owner: Address; maxCrossings?: bigint;
}): Promise<TxMessage> {
    const mc = o.maxCrossings ?? MAX_CROSSINGS;
    const gas = swapGas(o.allowPartial, mc, o.pool);
    const router = o.pool.router ?? o.router;
    assertMargRouter(router);
    const common = {
        tickSpacing: o.pool.key.tickSpacing, ext: o.pool.key.ext, minOut: o.minOut, sqrtPriceLimitX96: 0n,
        maxCrossings: mc, allowPartial: o.allowPartial, deadline: deadline(), receiver: null, refundTo: null,
        referral: null, refBps: 0n, fwdTon: 0n, fwdPayload: null,
    };
    if (isGram(o.tokenIn.id!)) {
        return msg(router, o.amountIn + gas, cell(storeSwapNative({
            $$type: 'SwapNative', queryId: 0n, amount: o.amountIn, otherToken: o.tokenOut.id!, ...common,
        })));
    }
    const wallet = await verifiedWallet(o.tokenIn.master!, o.owner);
    const payload = cell(storeSwapPayload({ $$type: 'SwapPayload', otherToken: o.tokenOut.id!, ...common }));
    return jettonToRouter(wallet, router, o.owner, o.amountIn, gas, payload);
}

// Mint a position. Gram pools: Gram only = MintNative; with a jetton leg = one jetton transfer whose
// forward value carries the Gram leg. Jetton/jetton in range = both legs through a MintAccount.
// A jetton whose wallet address we can trust: a verified MARG launch, or one of the main tokens. Any
// other master answers get_wallet_address itself, so it could name its own contract as the "wallet"
// and keep Gram that rides along with the transfer.
export const trustedJetton = (t: DexToken) => !t.master || !!t.launch || !!knownToken(t.master);

export async function mintMessages(o: {
    router: Address; pool: DexPool; tickLower: number; tickUpper: number; amount0: bigint; amount1: bigint;
    minLiquidity: bigint; sqrtPriceInit: bigint; slippageBps: number; owner: Address;
}): Promise<TxMessage[]> {
    const { pool, router, owner } = o;
    assertMargRouter(router);
    if (pool.router) assertMargRouter(pool.router);
    const sqrtNow = pool.state?.initialized ? pool.state.sqrtPriceX96 : 0n;
    const [sqrtMin, sqrtMax] = sqrtNow > 0n ? sqrtBand(sqrtNow, o.slippageBps) : [0n, 0n];
    const base = {
        tickSpacing: pool.key.tickSpacing, ext: pool.key.ext, tickLower: BigInt(o.tickLower), tickUpper: BigInt(o.tickUpper),
        sqrtPriceInitX96: sqrtNow > 0n ? 0n : o.sqrtPriceInit, minLiquidity: o.minLiquidity, owner: null, refundTo: null,
        deadline: deadline(), sqrtPriceMinX96: sqrtMin, sqrtPriceMaxX96: sqrtMax,
    };
    const t0 = pool.token0;
    const t1 = pool.token1;
    const walletOf = (t: DexToken) => verifiedWallet(t.master!, owner);
    const payload = (otherToken: Address, gramAmount: bigint, viaAccount: boolean) =>
        cell(storeMintPayload({ $$type: 'MintPayload', otherToken, gramAmount, viaAccount, ...base }));

    if (isGram(t0.id!)) {
        if (o.amount1 === 0n) {
            return [msg(router, o.amount0 + MINT_VALUE, cell(storeMintNative({
                $$type: 'MintNative', queryId: 0n, amount: o.amount0, otherToken: t1.id!, ...base,
            })))];
        }
        if (o.amount0 > 0n && !trustedJetton(t1)) throw new Error(`Adding Gram together with ${t1.symbol} is only possible for MARG launches and the main tokens: this token's contract isn't verified.`);
        return [jettonToRouter(await walletOf(t1), router, owner, o.amount1, o.amount0 + MINT_VALUE, payload(GRAM, o.amount0, false))];
    }
    if (o.amount0 === 0n) return [jettonToRouter(await walletOf(t1), router, owner, o.amount1, MINT_VALUE, payload(t0.id!, 0n, false))];
    if (o.amount1 === 0n) return [jettonToRouter(await walletOf(t0), router, owner, o.amount0, MINT_VALUE, payload(t1.id!, 0n, false))];
    return [
        jettonToRouter(await walletOf(t0), router, owner, o.amount0, MINT_VALUE, payload(t1.id!, 0n, true)),
        jettonToRouter(await walletOf(t1), router, owner, o.amount1, MINT_VALUE, payload(t0.id!, 0n, true)),
    ];
}

// PositionDecrease to the Position NFT: liquidityDelta 0 collects fees only.
export function decreaseMessage(position: Address, liquidityDelta: bigint, min0: bigint, min1: bigint): TxMessage {
    return msg(position, DECREASE_VALUE, cell(storePositionDecrease({
        $$type: 'PositionDecrease', queryId: 0n, liquidityDelta, amount0Min: min0, amount1Min: min1,
        deadline: deadline(), recipient: null,
    })));
}

// --- positions ----------------------------------------------------------------

export type MyPosition = {
    address: Address; data: PositionData; pool: DexPool;
    amount0: bigint; amount1: bigint; fees0: bigint; fees1: bigint;
};

// NFTs owned by the wallet (Toncenter v3 index), kept only when the collection is a genuine Marg
// pool: the Router must derive the same pool address from the pool's own key.
export async function myPositions(owner: Address, onPosition?: (p: MyPosition) => void): Promise<MyPosition[]> {
    if (!DEX_ROUTER) return [];
    const base = `${TONCENTER}/api/v3`;
    const res = await q(() => fetch(`${base}/nft/items?owner_address=${owner.toRawString()}&limit=100`,
        { headers: API_KEY ? { 'X-API-Key': API_KEY } : {} }).then((r) => {
        if (!r.ok) throw new Error(`toncenter ${r.status}`);
        return r.json();
    }));
    const pools = new Map<string, DexPool | null>();
    const out: MyPosition[] = [];
    for (const item of (res.nft_items ?? []) as { address: string; collection_address: string | null }[]) {
        if (!item.collection_address) continue;
        const ck = Address.parse(item.collection_address).toRawString();
        if (!pools.has(ck)) pools.set(ck, await genuinePool(Address.parse(item.collection_address)).catch(() => null));
        const pool = pools.get(ck);
        if (!pool?.state) continue;
        const address = Address.parse(item.address);
        const data = await q(() => openPosition(address).getGetPositionData());
        if (!data.initialized || !data.owner.equals(owner)) continue;
        // The NFT must be the pool's own position at that index (its getters could lie otherwise).
        const real = await q(() => openPool(pool.address).getGetPositionAddress(data.index)).catch(() => null);
        if (!real?.equals(address)) continue;
        const a = await q(() => openPool(pool.address).getGetPositionAmounts(
            data.tickLower, data.tickUpper, data.liquidity, data.fgLast0, data.fgLast1, data.liquidity));
        const p = { address, data, pool, amount0: a.amount0, amount1: a.amount1, fees0: a.fees0, fees1: a.fees1 };
        out.push(p);
        onPosition?.(p);
    }
    return out;
}

// Pool code of earlier Routers (code hash of the deployed Pool, built from the mainnet-v2 tag). A pool of
// a past Router is genuine when its own code has one of these hashes and that code with initOf data
// Pool(router, key) gives its address; the current Router's pools are derived from the bundled code.
const PAST_POOL_CODE_HASHES = new Set([
    '6813c538ded762550e3add2c58ecba178a63e92f71d3ff73ec0db4a3064e2c56', // v2 (Router EQDBEgfj…)
]);

async function poolRouter(address: Address, k: PoolKey): Promise<Address | null> {
    if ((await Pool.fromInit(DEX_ROUTER!, k)).address.equals(address)) return DEX_ROUTER!;
    const past = DEX_ROUTERS.filter((r) => !r.equals(DEX_ROUTER!));
    if (past.length === 0) return null;
    const st = await q(() => client.getContractState(address));
    if (st.state !== 'active' || !st.code) return null;
    const code = Cell.fromBoc(st.code)[0];
    if (!PAST_POOL_CODE_HASHES.has(code.hash().toString('hex'))) return null;
    for (const r of past) {
        const data = (await Pool.fromInit(r, k)).init!.data;   // same init layout: (router, key)
        if (contractAddress(0, { code, data }).equals(address)) return r;
    }
    return null;
}

async function genuinePool(address: Address): Promise<DexPool | null> {
    const state = await q(() => poolStateOf(address));
    const k = state.key;
    const router = await poolRouter(address, k);
    if (!router) return null;
    const [token0, token1] = [await tokenById(k.token0), await tokenById(k.token1)];
    const canonical = !!token1.launch && extOf(k)?.initializer?.equals(token1.master!) === true;
    return { address, key: k, state, token0, token1, canonical, ext: extOf(k), router };
}
