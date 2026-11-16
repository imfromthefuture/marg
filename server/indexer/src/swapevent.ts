import { Slice } from '@ton/core';

// SwapEvent of any Router generation: the platform fee (last field) was appended in the third Router;
// pools of earlier Routers end at `tax`, so it reads as 0 there.
export function loadSwapEvent(slice: Slice) {
    if (slice.loadUint(32) !== 0x4d480071) throw Error('Invalid prefix');
    const fromUser = slice.loadAddress();
    const zeroForOne = slice.loadBit();
    const amountIn = slice.loadCoins();
    const amountOut = slice.loadCoins();
    const refFee = slice.loadCoins();
    const feeTotal = slice.loadCoins();
    const protocolFee = slice.loadCoins();
    const r = slice.loadRef().beginParse();
    const hookFee = r.loadCoins();
    const sqrtPriceX96 = r.loadUintBig(160);
    const tick = r.loadIntBig(24);
    const liquidity = r.loadUintBig(128);
    const crossings = r.loadUintBig(8);
    const steps = r.loadUintBig(8);
    const stop = r.loadUintBig(8);
    const tax = r.loadCoins();
    const platformFee = r.remainingBits >= 4 ? r.loadCoins() : 0n;
    return { $$type: 'SwapEvent' as const, fromUser, zeroForOne, amountIn, amountOut, refFee, feeTotal, protocolFee, hookFee, sqrtPriceX96, tick, liquidity, crossings, steps, stop, tax, platformFee };
}
