import { Address, fromNano } from '@ton/core';
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
    return { wallet, balance: data.balance };
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
