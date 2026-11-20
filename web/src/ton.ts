import { Address, fromNano, toNano } from '@ton/core';
import { TonClient } from '@ton/ton';
import { LaunchJetton } from '../../launch/build/Launch_LaunchJetton';
import { LaunchWallet } from '../../launch/build/Launch_LaunchWallet';

export const NETWORK = (import.meta.env.VITE_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
export const IS_TESTNET = NETWORK === 'testnet';
const API_KEY = import.meta.env.VITE_TONCENTER_KEY as string | undefined;
// VITE_TONCENTER_PROXY=1: Toncenter through marg.lol/toncenter, where nginx adds the API key and
// caches reads for a few seconds (server/nginx-tron.conf). The key never reaches the browser.
const PROXY = !!import.meta.env.VITE_TONCENTER_PROXY && typeof location !== 'undefined';
export const TONCENTER = PROXY ? `${location.origin}/toncenter` : IS_TESTNET ? 'https://testnet.toncenter.com' : 'https://toncenter.com';

export const client = new TonClient({ endpoint: `${TONCENTER}/api/v2/jsonRPC`, apiKey: API_KEY });

// Toncenter allows 1 request/second without a key; run reads one at a time with a gap.
let chain: Promise<unknown> = Promise.resolve();
const GAP = API_KEY || PROXY ? 150 : 1100;
export function q<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
        for (let attempt = 0; ; attempt++) {
            try {
                return await fn();
            } catch (e: any) {
                // Rate limited (429) or a flaky network: back off and retry; give up after ~30 s.
                const m = String(e?.message ?? e);
                if (attempt < 7 && /429|Network Error|timeout|50[234]/i.test(m)) {
                    await new Promise((r) => setTimeout(r, Math.min(GAP * 2 ** attempt, 8000)));
                    continue;
                }
                throw e;
            }
        }
    });
    chain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, GAP)));
    return run;
}

// Generic TEP-74 getters (get_jetton_data, get_wallet_address, get_wallet_data); they work on any
// standard jetton, not just MARG launches.
export const openMaster = (a: Address) => client.open(LaunchJetton.fromAddress(a));
export const openWallet = (a: Address) => client.open(LaunchWallet.fromAddress(a));

export async function jettonBalance(master: Address, owner: Address): Promise<{ wallet: Address; balance: bigint }> {
    // One indexed request (Toncenter v3) instead of three getter calls; getters are the fallback.
    try {
        const url = `${TONCENTER}/api/v3/jetton/wallets?owner_address=${owner.toRawString()}&jetton_address=${master.toRawString()}&limit=1`;
        const res = await q(async () => {
            const r = await fetch(url, { headers: API_KEY ? { 'X-API-Key': API_KEY } : {} });
            if (!r.ok) throw new Error(`toncenter ${r.status}`);
            return r.json();
        });
        const w = res?.jetton_wallets?.[0];
        if (w) return { wallet: Address.parse(w.address), balance: BigInt(w.balance) };
    } catch {
        /* fall through to the getters */
    }
    const wallet = await q(() => openMaster(master).getGetWalletAddress(owner));
    const state = await q(() => client.getContractState(wallet));
    if (state.state !== 'active') return { wallet, balance: 0n };
    const data = await q(() => openWallet(wallet).getGetWalletData());
    // The master names the wallet itself: a fake master can name the user's wallet of another token.
    if (!data.master.equals(master) || !data.owner.equals(owner)) return { wallet, balance: 0n };
    return { wallet, balance: data.balance };
}

// The user's jetton wallet for `master`, only if that wallet itself confirms the master and owner.
// Every jetton transfer the app builds goes to this address. A master answers get_wallet_address
// itself, so a fake token could otherwise name the user's wallet of a real token (USDT, ...) and the
// transfer would spend that token instead. A wallet that is not deployed holds nothing to send.
export async function verifiedWallet(master: Address, owner: Address): Promise<Address> {
    const wallet = await q(() => openMaster(master).getGetWalletAddress(owner));
    const state = await q(() => client.getContractState(wallet));
    if (state.state !== 'active') throw new Error('You have no balance of this token.');
    const data = await q(() => openWallet(wallet).getGetWalletData());
    if (!data.master.equals(master) || !data.owner.equals(owner)) {
        throw new Error('This token\'s contract points to a wallet that is not its own. Not sending: it may be a scam token.');
    }
    return wallet;
}

// A launch-token wallet keeps about 0.01 Gram for its storage rent (v4 refills it on every send). After a
// long idle time it can run low; before the site makes such a wallet act (claim, sell), it tops up a
// nearly empty one in the same transaction (audit R4A-1, C8). The Gram stays in the user's own token
// wallet. Plain non-bounceable transfer, sent first.
//
// The stored balance does not include the rent accrued since the wallet's last transaction (it is
// charged only when the wallet next runs), so a live v3 wallet idle for 3 years still reads ~0.0118
// while it really owes more than that. The check therefore estimates the effective balance as
// `balance - WALLET_RENT_PER_YEAR x years since the last transaction` (last tx time from
// getTransactions, limit 1). If that time cannot be read it tops up whenever the stored balance is
// below WALLET_TOPUP_BLIND.
//
// It never blocks the action: the probe bypasses the request queue, gets WALLET_PROBE_MS, and any
// failure or timeout means "no top-up". Pages prefetch it when the claim / sell UI opens
// (prefetchWalletTopUp), so the click normally finds the answer ready.
const WALLET_TOPUP = toNano('0.05');
const WALLET_TOPUP_BELOW = toNano('0.005');      // estimated effective balance below this: top up
const WALLET_TOPUP_BLIND = toNano('0.02');       // last tx time unknown: top up below this stored balance
const WALLET_RENT_PER_YEAR = toNano('0.005');    // a launch wallet's rent is ~0.0045 Gram/year (R4A-1), rounded up
const WALLET_PROBE_MS = 3000;
const WALLET_PROBE_TTL = 60_000;
const YEAR = 365 * 86400;
type TopUp = { address: string; amount: string; payload?: string };

async function probeTopUp(wallet: Address): Promise<TopUp | null> {
    const st = await client.getContractState(wallet);
    if (st.state !== 'active') return null;
    let lastUtime: number | null = null;
    try {
        // The last transaction of a long-idle wallet may only be on an archival node; a slow answer
        // falls back to the stored-balance rule instead of using up the whole probe time.
        const txs = await Promise.race([
            client.getTransactions(wallet, { limit: 1, archival: true }),
            new Promise<null>((r) => setTimeout(() => r(null), WALLET_PROBE_MS - 1200)),
        ]);
        if (txs?.[0]) lastUtime = txs[0].now;
    } catch {
        lastUtime = null;
    }
    let need: boolean;
    if (lastUtime === null) {
        need = st.balance < WALLET_TOPUP_BLIND;
    } else {
        const idle = Math.max(0, Math.floor(Date.now() / 1000) - lastUtime);
        const rent = (WALLET_RENT_PER_YEAR * BigInt(idle)) / BigInt(YEAR);
        need = st.balance - rent < WALLET_TOPUP_BELOW;
    }
    return need ? { address: wallet.toString({ bounceable: false }), amount: WALLET_TOPUP.toString() } : null;
}

const topUpCache = new Map<string, { at: number; p: Promise<TopUp | null> }>();
function topUpProbe(wallet: Address) {
    const k = wallet.toRawString();
    const hit = topUpCache.get(k);
    if (hit && Date.now() - hit.at < WALLET_PROBE_TTL) return hit.p;
    const p = probeTopUp(wallet).catch(() => null);
    topUpCache.set(k, { at: Date.now(), p });
    if (topUpCache.size > 200) topUpCache.delete(topUpCache.keys().next().value!);
    return p;
}

// Start the probe early (when a claim card or a sell quote of a launch token shows up).
export function prefetchWalletTopUp(wallet: Address): void {
    topUpProbe(wallet);
}

// The top-up message to prepend, or null. Resolves within WALLET_PROBE_MS whatever happens.
export async function walletTopUp(wallet: Address): Promise<TopUp | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), WALLET_PROBE_MS); });
    try {
        return await Promise.race([topUpProbe(wallet), timeout]);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export { buildOnchainContent, parseContent } from './content';
export type { TokenMeta } from './content';

// --- formatting -------------------------------------------------------------

export const TOKEN_DECIMALS = 10n ** 9n;

export function fmtTon(nano: bigint, digits = 2): string {
    const n = Number(fromNano(nano));
    return n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : digits });
}

// 12.4K / 1.3M style, for market caps.
export function fmtCompact(nano: bigint): string {
    const n = Number(fromNano(nano));
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 0 });
}

export function fmtTokens(units: bigint, decimals = 9): string {
    const n = Number(units) / 10 ** decimals;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    // Small amounts keep 4 significant digits so they don't read as 0.
    if (n > 0 && n < 1) return Number(n.toPrecision(4)).toLocaleString('en-US', { maximumFractionDigits: decimals });
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Exact decimal string of `units` (no float rounding), trailing zeros trimmed.
export function unitsToString(units: bigint, decimals = 9): string {
    const d = 10n ** BigInt(decimals);
    const frac = (units % d).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${units / d}.${frac}` : `${units / d}`;
}

export function parseAmount(input: string, decimals = 9): bigint {
    const [whole, frac = ''] = input.trim().replace(',', '.').split('.');
    if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac) || (whole === '' && frac === '')) return 0n;
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export const short = (a: Address | string) => {
    const s = (typeof a === 'string' ? Address.parse(a) : a).toString({ testOnly: IS_TESTNET, bounceable: true });
    return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

export const explorer = (a: Address | string) =>
    `https://${IS_TESTNET ? 'testnet.' : ''}tonviewer.com/${(typeof a === 'string' ? Address.parse(a) : a).toString({ testOnly: IS_TESTNET })}`;

export const sameAddress = (a: Address | null | undefined, raw: string | undefined) => {
    if (!a || !raw) return false;
    try {
        return a.equals(Address.parse(raw));
    } catch {
        return false;
    }
};
