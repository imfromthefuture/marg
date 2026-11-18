import { Address } from '@ton/core';

// The Router's SetTreasury only refuses its own address. A treasury outside the basechain (wc 0)
// makes every platform-fee payout fail in the Pool's action phase, and because Router -> Pool hops
// do not bounce, buyers' Gram and launch supply would be stranded. Every script that sets a treasury,
// fee recipient or admin goes through this check before anything is signed or sent.
export function requireBasechain(name: string, raw: string | undefined): Address {
    if (!raw) throw new Error(`${name} is required`);
    let a: Address;
    try {
        a = Address.parse(raw.trim());
    } catch {
        throw new Error(`${name}: not a valid TON address: ${raw}`);
    }
    if (a.workChain !== 0) throw new Error(`${name} must be a basechain (workchain 0) address, got workchain ${a.workChain}`);
    if (a.hash.every((b) => b === 0)) throw new Error(`${name} must not be the zero address`);
    return a;
}
