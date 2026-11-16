import "./messages";

// TVM primitives Tact does not expose directly. Verified by probe P0.1 / P0.2 (DESIGN.md §15).

// Smallest initialized tick strictly above `pivot`, or null. `n` must be 24 (the key width).
// Stack: (pivot D n -- value key -1 | 0); NULLSWAPIFNOT2 turns failure into (null null 0).
asm fun tickNextGt(pivot: Int, d: map<Int as int24, TickInfo>, n: Int): Int? { DICTIGETNEXT NULLSWAPIFNOT2 DROP NIP }

// Largest initialized tick <= `pivot`, or null.
asm fun tickPrevLe(pivot: Int, d: map<Int as int24, TickInfo>, n: Int): Int? { DICTIGETPREVEQ NULLSWAPIFNOT2 DROP NIP }

// floor(a*b/c), ceil(a*b/c), floor(a*b/2^s) with a 513-bit intermediate. They throw (code 4)
// only if the result does not fit 257 bits, or c == 0.
asm fun mulDiv(a: Int, b: Int, c: Int): Int { MULDIV }
asm fun mulDivC(a: Int, b: Int, c: Int): Int { MULDIVC }
asm fun mulShr(a: Int, b: Int, s: Int): Int { MULRSHIFT }

// Number of bits of a non-negative integer (0 for 0).
asm fun ubitsize(x: Int): Int { UBITSIZE }
