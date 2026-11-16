import { Address, toNano } from '@ton/core';
import { LaunchFactory, type FactoryData } from '../../launch/build/Launch_LaunchFactory';
import { client, q } from './ton';

// Direct-launch factory (launch/): tokens go straight into a Marg DEX pool, no bonding curve.
export const LAUNCH_FACTORY = import.meta.env.VITE_LAUNCH_FACTORY ? Address.parse(import.meta.env.VITE_LAUNCH_FACTORY) : null;
export const launchFactory = LAUNCH_FACTORY ? client.open(LaunchFactory.fromAddress(LAUNCH_FACTORY)) : null;

// Shown until the factory is deployed; these are the contract defaults (launch/README.md).
export const DEFAULT_PARAMS = {
    startMcap: toNano('2600'),
};
// Liquidity tiers (factory get_factory_data().tiers). A higher start market cap is a deeper pool.
export type TierKey = 'low' | 'mid' | 'high';
export const TIER_INFO: Record<TierKey, { name: string; blurb: string; fallback: bigint }> = {
    low: { name: 'Low', blurb: 'Pump-style: cheapest start, fastest climb.', fallback: toNano('2600') },
    mid: { name: 'Mid', blurb: 'Deeper pool, steadier price.', fallback: toNano('10000') },
    high: { name: 'High', blurb: 'Deepest pool, for big communities.', fallback: toNano('30000') },
};
// Launch pool maths: the whole supply sits above the start price, so a buy of b Gram multiplies the
// market cap by (1 + b / startMcap)^2 (before fees).
export const buyMove = (b: number, startMcapGram: number) => (1 + b / startMcapGram) ** 2 - 1;

// Tokens a dev buy of `devBuyGram` gets: the pool holds `poolShare` of the 1B supply from the start
// price (startMcap / 1B per token) upwards, so with x = netGram / startMcap / poolShare the buy takes
// poolShare · x / (1 + x) of the supply. netGram is after the buy tax, the platform fee and the 0.05%
// pool fee (a dev buy pays no anti-snipe fee). Returns the share of total supply (0..1).
export function devBuyShare(devBuyGram: number, startMcapGram: number, poolShare: number, buyTaxBps: number, platformBps: number): number {
    if (!(devBuyGram > 0) || !(startMcapGram > 0) || !(poolShare > 0)) return 0;
    const net = devBuyGram * (1 - (buyTaxBps + platformBps) / 10_000) * (1 - 0.0005);
    const x = net / startMcapGram / poolShare;
    return (poolShare * x) / (1 + x);
}
// CreateToken accepts 0 (off) or 1%..5% per side (launch/contracts/messages.tact).
export const TAX_MIN_PCT = 1;
export const TAX_MAX_PCT = 5;
// Anti-snipe bounds of CreateToken: fee <= 90%, duration 1 s .. 1 h (0/0 = off).
export const SNIPE_MAX_PCT = 90;
export const SNIPE_MAX_SEC = 3600;

export async function loadFactoryData(): Promise<FactoryData | null> {
    if (!launchFactory) return null;
    return q(() => launchFactory!.getGetFactoryData());
}
