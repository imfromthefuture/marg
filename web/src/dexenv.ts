import { Address } from '@ton/core';
import { client, q } from './ton';

// Marg DEX config, kept apart from dex.ts so the main bundle does not pull in the DEX bindings
// (they embed the contract code); the DEX pages load them on demand.
export const DEX_ROUTER = import.meta.env.VITE_DEX_ROUTER ? Address.parse(import.meta.env.VITE_DEX_ROUTER) : null;
export const DEX_LIVE = !!DEX_ROUTER;
// Every MARG Router (current first, then past deployments). Funds are only ever sent to one of these:
// a token's own get_launch_info can claim any "router", so it is never trusted on its own.
export const DEX_ROUTERS: Address[] = [import.meta.env.VITE_DEX_ROUTER, ...String(import.meta.env.VITE_PAST_DEX_ROUTERS ?? '').split(',')]
    .map((s) => (s ?? '').trim()).filter(Boolean).map((s) => Address.parse(s));
export const isMargRouter = (a: Address) => DEX_ROUTERS.some((r) => r.equals(a));
export function assertMargRouter(a: Address) {
    if (!isMargRouter(a)) throw new Error('Refused: this pool does not belong to a MARG Router.');
}
export const CLOSED_LABEL = 'Opens with Marg DEX';

// Main TON jettons, listed first in the token picker. Their metadata is mostly off-chain, so the
// basics are kept here (checked against toncenter's jetton/masters on 2026-11-13).
export type KnownToken = { address: string; symbol: string; name: string; decimals: number; image: string };
export const KNOWN_TOKENS: KnownToken[] = [
    { address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', symbol: 'USDT', name: 'Tether USD', decimals: 6, image: 'https://tether.to/images/logoCircle.png' },
    { address: 'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT', symbol: 'NOT', name: 'Notcoin', decimals: 9, image: 'https://cdn.joincommunity.xyz/clicker/not_logo.png' },
    { address: 'EQCvxJy4eG8hyHBFsZ7eePxrRsUQSFE_jpptRAYBmcG_DOGS', symbol: 'DOGS', name: 'Dogs', decimals: 9, image: 'https://cdn.dogs.dev/dogs.png' },
    { address: 'EQA2kCVNwVsil2EM2mB0SkXytxCqQjS4mttjDpnXmwG9T6bO', symbol: 'STON', name: 'STON', decimals: 9, image: 'https://static.ston.fi/logo/ston_symbol.png' },
    { address: 'EQAJ8uWd7EBqsmpSWaRdf_I-8R8-XHwh3gsNKhy-UrdrPcUo', symbol: 'HMSTR', name: 'Hamster Kombat', decimals: 9, image: 'https://token.hamsterkombatgame.io/token/icon.png' },
    { address: 'EQD-cvR0Nz6XAyRBvbhz-abTrRC6sI5tvHvvpeQraV9UAAD7', symbol: 'CATI', name: 'Catizen', decimals: 9, image: 'https://catizen.ai/CATI_TOKEN.png' },
    { address: 'EQC98_qAmNEptUtPc7W6xdHh_ZHrBUFpw5Ft_IzNU20QAJav', symbol: 'tsTON', name: 'Tonstakers TON', decimals: 9, image: 'https://tonstakers.com/jetton/logo.svg' },
    { address: 'EQDNhy-nxYFgUqzfUzImBEP67JqsyMIcyk2S5_RwNNEYku0k', symbol: 'stGRAM', name: 'Staked GRAM', decimals: 9, image: 'https://raw.githubusercontent.com/bemo-fi/tokens/main/stGRAM.png' },
];
export const knownToken = (master: Address) => KNOWN_TOKENS.find((t) => Address.parse(t.address).equals(master)) ?? null;

// Toncenter answers an unknown get method with exit code 11 (or -13); anything else is a real error.
export const isMissingGetter = (e: any) => /exit_code: ?(11|-13)\b|exit code (11|-13)\b/i.test(String(e?.message ?? e));

// MARG launch factories, current first (earlier deployments keep their tokens tradable).
export const LAUNCH_FACTORIES: Address[] = [import.meta.env.VITE_LAUNCH_FACTORY, ...String(import.meta.env.VITE_PAST_LAUNCH_FACTORIES ?? '').split(',')]
    .map((s) => (s ?? '').trim()).filter(Boolean).map((s) => Address.parse(s));

// Direct-launch masters (launch/) have get_launch_info; other jettons do not. Anything can answer
// get_launch_info, so a launch token only counts if a MARG factory lists it at its own index
// ('fake' otherwise: the page must not show it with MARG branding).
export async function isLaunchToken(master: Address): Promise<boolean | 'fake'> {
    try {
        const r = await q(() => client.runMethod(master, 'get_launch_info'));
        if (r.stack.remaining === 0) return false;
    } catch (e) {
        if (isMissingGetter(e)) return false;
        throw e;
    }
    const index = (await q(() => client.runMethod(master, 'get_index'))).stack.readBigNumber();
    for (const f of LAUNCH_FACTORIES) {
        try {
            const r = await q(() => client.runMethod(f, 'get_token_address', [{ type: 'int', value: index }]));
            if (r.stack.readAddress().equals(master)) return true;
        } catch {
            /* index beyond this factory's count */
        }
    }
    return 'fake';
}
