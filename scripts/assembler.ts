import { beginCell, Cell } from '@ton/core';

// Splits a code cell into Put/Join steps whose bodies each fit in an external message (see
// tools/assembler/assembler.tact). Slots are numbered in the order they are filled.
export const PIECE_LIMIT = 60_000; // bytes of BOC per uploaded subtree (external messages are capped at 65535)
export const bocSize = (c: Cell) => c.toBoc({ idx: false, crc32: true }).length;

export type Step =
    | { kind: 'put'; slot: number; cell: Cell }
    | { kind: 'join'; slot: number; bits: Cell; refs: number[]; cell: Cell };

export function plan(code: Cell): { steps: Step[]; root: number } {
    const steps: Step[] = [];
    let next = 0;
    const walk = (c: Cell): number => {
        if (c.isExotic) throw new Error('exotic cell in code');
        if (bocSize(c) <= PIECE_LIMIT) {
            const slot = next++;
            steps.push({ kind: 'put', slot, cell: c });
            return slot;
        }
        const refs = c.refs.map(walk);
        const slot = next++;
        steps.push({ kind: 'join', slot, bits: beginCell().storeBits(c.bits).endCell(), refs, cell: c });
        return slot;
    };
    const root = walk(code);
    if (next > 255) throw new Error('too many slots');
    return { steps, root };
}
