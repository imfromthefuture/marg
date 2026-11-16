// BigInt reference model of the vault's pricing (DESIGN §4.2, §8). Uses dex/v2's independent v3
// model (dex/v2/tests/model.ts) for sqrtAt / amountsForLiquidity, never the vault's own code. The
// TWAP comes from the pool's own accumulator (get_observe) and the anchors the vault recorded; the
// uncollected fees from the pool's get_position_amounts.

import * as M from '../../dex/v2/tests/model';

export const SHARES_PER_UNIT = 1000n;
export const DEAD_SHARES = 1_000_000n;

export type OracleState = {
    spotTick: bigint; spotSqrtP: bigint; spotTs: bigint; spotCum: bigint;
    c0: bigint; t0: bigint; c1: bigint; t1: bigint; c2: bigint; t2: bigint;
};

export type PosModel = { tL: bigint; tU: bigint; L: bigint; reserved: bigint };
export type FeeModel = { f0: bigint; f1: bigint };

const floorDiv = (a: bigint, b: bigint) => {
    const q = a / b;
    return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
};

// The vault's view right after an observation at pool time `now` with accumulator `cumNow`: the
// anchor rule (one per half window) first, then the newest anchor at least `window` old.
export function oracleAfterObserve(o: OracleState, cumNow: bigint, now: bigint, window: bigint, spot: bigint, spotSqrtP: bigint) {
    let a = { ...o };
    if (a.t2 === 0n || now - a.t2 >= window / 2n) {
        a = { ...a, c0: a.c1, t0: a.t1, c1: a.c2, t1: a.t2, c2: cumNow, t2: now };
    }
    for (const [c, t] of [[a.c2, a.t2], [a.c1, a.t1], [a.c0, a.t0]]) {
        if (t > 0n && now - t >= window && now > t) {
            return { ready: true, spot, spotSqrtP, twap: floorDiv(cumNow - c, now - t) };
        }
    }
    return { ready: false, spot, spotSqrtP, twap: spot };
}

export const priceQ64 = (sqrtP: bigint) => (sqrtP * sqrtP) >> 128n;
export const valueOf = (x0: bigint, x1: bigint, p: bigint) => x0 * p + (x1 << 64n);

// NAV at (tick, sqrtP): idle + in flight (net) + every position's principal + its uncollected fees
// net of the performance fee, valued at that price.
export function navAt(tick: bigint, sqrtP: bigint, x0: bigint, x1: bigint, positions: PosModel[], fees: FeeModel[], bps: bigint) {
    const p = priceQ64(sqrtP);
    let v = valueOf(x0, x1, p);
    positions.forEach((pos, i) => {
        const l = pos.L - pos.reserved;
        if (l > 0n) {
            const am = M.amountsForLiquidity(Number(tick), sqrtP, Number(pos.tL), Number(pos.tU), l, false);
            v += valueOf(am.a, am.b, p);
        }
        const f = fees[i] ?? { f0: 0n, f1: 0n };
        v += valueOf(f.f0 - (f.f0 * bps) / 10000n, f.f1 - (f.f1 * bps) / 10000n, p);
    });
    return v;
}

// Deposit quote: the smaller of the TWAP quote and the spot quote (DESIGN §4.2).
export function quoteShares(a0: bigint, a1: bigint, twap: bigint, spotTick: bigint, spotSqrtP: bigint, supply: bigint,
                            x0: bigint, x1: bigint, positions: PosModel[], fees: FeeModel[], bps: bigint) {
    const sT = M.sqrtAt(Number(twap));
    const nT = navAt(twap, sT, x0, x1, positions, fees, bps);
    const nS = navAt(spotTick, spotSqrtP, x0, x1, positions, fees, bps);
    if (nT <= 0n || nS <= 0n) return 0n;
    const qT = (valueOf(a0, a1, priceQ64(sT)) * supply) / nT;
    const qS = (valueOf(a0, a1, priceQ64(spotSqrtP)) * supply) / nS;
    return qT < qS ? qT : qS;
}

export function withdrawSplit(shares: bigint, supply: bigint, idle0: bigint, idle1: bigint, positions: PosModel[]) {
    return {
        g: (idle0 * shares) / supply < 1_000_000n ? 0n : (idle0 * shares) / supply,   // DUST_GRAM
        u: (idle1 * shares) / supply,
        dL: positions.map((p) => (p.L * shares) / supply),
    };
}

export { M };
