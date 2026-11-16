import { Address, toNano } from '@ton/core';
import { CurveParams, DexConfig } from '../build/Factory_Factory';

const DECIMALS = 10n ** 9n;

export type CurveInput = {
    maxSupply: bigint;       // whole tokens
    startMcapTon: number;    // market cap at launch, in TON (Gram)
    graduationTon: number;   // TON raised on the curve before graduation
    curveTokens: bigint;     // whole tokens sold by the curve at graduation
    platformFeeBps: number;
    graduationFeeTon?: number;
};

// Solves the virtual reserves so that the curve starts at startMcapTon and has
// sold exactly curveTokens once graduationTon has been raised:
//   V0 / T0 = startMcap / supply      and   (V0 + R)(T0 - S) = V0 * T0
//   =>  T0 = R * S / (R - S * startPrice)
export function buildCurveParams(input: CurveInput): CurveParams {
    const supply = input.maxSupply * DECIMALS;
    const sold = input.curveTokens * DECIMALS;
    const raise = toNano(input.graduationTon.toString());
    const startMcap = toNano(input.startMcapTon.toFixed(9));

    // startPrice = startMcap / supply, kept as a fraction to stay in integers
    const denom = raise * supply - sold * startMcap;
    if (denom <= 0n) throw new Error('Raise too small for this start mcap and curve size');
    const virtualTokens = (raise * sold * supply) / denom;
    const virtualTon = (virtualTokens * startMcap) / supply;

    return {
        $$type: 'CurveParams',
        maxSupply: supply,
        virtualTon,
        virtualTokens,
        graduationTon: raise,
        platformFeeBps: BigInt(input.platformFeeBps),
        graduationFee: toNano((input.graduationFeeTon ?? 0).toString()),
        // STON.fi v2.1 SDK defaults for provide_lp
        lpJettonValue: toNano('0.3'),
        lpJettonForward: toNano('0.235'),
        lpTonForward: toNano('0.3'),
    };
}

// Liquidity tiers, shaped like pump.fun (30 SOL virtual / 1.073B virtual tokens, ~793M sold for
// 85 SOL): every tier climbs ~15x from launch to graduation and the STON.fi pool opens at the
// curve's final price. Bigger tiers raise more, so they start higher and graduate into a deeper pool.
export const TIER_RAISE_GRAM = [8_000, 25_000, 60_000] as const; // low, mid, high
export const TIER_NAMES = ['Low', 'Mid', 'High'] as const;

export function tierParams(raiseGram: number, platformFeeBps = 100): CurveParams {
    return buildCurveParams({
        maxSupply: 1_000_000_000n,
        startMcapTon: raiseGram * (27.959 / 85),
        graduationTon: raiseGram,
        curveTokens: 793_100_000n,
        platformFeeBps,
    });
}

export const defaultTiers = (): [CurveParams, CurveParams, CurveParams] =>
    [tierParams(TIER_RAISE_GRAM[0]), tierParams(TIER_RAISE_GRAM[1]), tierParams(TIER_RAISE_GRAM[2])];

export function dexConfig(router: Address, routerPtonWallet: Address, lpReceiver: Address): DexConfig {
    return { $$type: 'DexConfig', router, routerPtonWallet, lpReceiver };
}

// addr_std 0:000…0, nobody holds its key; LP sent here is effectively burned.
export const BURN_ADDRESS = Address.parse('0:0000000000000000000000000000000000000000000000000000000000000000');
