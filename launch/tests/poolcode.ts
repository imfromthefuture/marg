// The DEX Pool code (hash, depth) a LaunchFactory is deployed with: every launch master derives its
// own pool address from it (launch/contracts/jetton.tact dexPoolAddress).
import { Address } from '@ton/core';
import { Pool } from '../../dex/v2/build/Router_Pool';

export async function poolCodeArgs(): Promise<[bigint, bigint]> {
    const zero = new Address(0, Buffer.alloc(32));
    const code = (await Pool.fromInit(zero, { $$type: 'PoolKey', token0: zero, token1: zero, tickSpacing: 1n, ext: null })).init!.code;
    return [BigInt('0x' + code.hash().toString('hex')), BigInt(code.depth())];
}
