# Marg DEX v2 "Tick-CL+": design (build spec)

Marg DEX v2 is a concentrated-liquidity AMM on TON (the native coin is **Gram**). It belongs to the
same class as Uniswap v4 and Meteora DLMM, and is designed for TON's asynchronous, gas-bounded
execution. In short:

- **Engine.** Each pool runs a Uniswap-v3 tick engine (Q64.96 √price, per-tick `liquidityNet` and
  `feeGrowthOutside`). It finds the next initialized tick by walking the tick dictionary directly,
  so there is no tick bitmap.
- **Fees.** A Meteora volatility-accumulator dynamic fee, updated on every step.
- **Pools.** v4-style keyed pools: several pools per pair, and each pool fixes its plugins and its
  async hook at creation.
- **Tokens.** Gram is held natively by its pools (no wrapped TON). All jettons are held by the
  Router's wallets, the same custody model as v1.
- **Positions** are TEP-62 NFT contracts.
- **Graduation.** A single-message, squat-proof launchpad graduation that seeds a full-range
  position, locked forever, whose fees can still be claimed.

Toolchain: Tact 1.6.13, @ton/sandbox 0.45, @ton/core, @ton/test-utils, jest + ts-jest (TS 5), all
from the root `node_modules`. No new packages. Everything lives under `dex/v2/`. v1 (`dex/`) is
read-only: copy its patterns and helpers, never edit or import them.

---

## 0. Decision record: why this architecture

### 0.1 Scores (0-10)

| Criterion | P1 "Marg DLMM" (bins) | P2 "CL4" (v4 + bitmap) | P3 "Tick-CL+" (ticks, dict walk) |
|---|---|---|---|
| Capital efficiency and trader UX vs Meteora/v4 | 8: zero slippage inside a bin, liquidity shapes. Locked graduation LP can never claim fees (fees compound) | 9: arbitrary ranges, claimable fees, v4 keys, plugins | 9: same as P2, plus fee checkpoints so the volatility fee rises *during* a large swap |
| Feasibility and safety under TON gas/async | 5: every non-empty bin on the price path is a dict write, and DLMM liquidity is dense, so 32 bins at 25 bps is about 8% per transaction. Adds and removes are O(width), up to about 570k gas for 48 bins | 7: about 18k gas per crossing plus bitmap scans, 690k worst case (thin headroom) | 8: about 12k gas per crossing, 540k worst case. Mint and burn touch exactly 2 ticks. Crossings scale with position boundaries, not with the size of the price move |
| Buildability in Tact 1.6.13, one pass | 7: simpler constant-sum math, but shapes, per-bin share dicts and the active-bin trim add up | 6: largest scope (bitmap, DepositAccount, gate hook, 3 plugins) | 7: v3 math port plus one asm dict primitive (with a bitmap fallback) |
| Extensibility | 6: one notify hook, one hook-set fee | 9: key-scoped plugins, hook permissions, gate hook planned | 8: key-scoped hook flags, fee controller, hook fee share |
| **Total** | **26** | **31** | **32** |

**Winner: P3 (Tick-CL+).** The deciding factor is gas.

- On TON every touched dict entry costs about 5-7k gas to rewrite, and a transaction is capped at
  1M gas.
- A tick engine pays per *position boundary* crossed. Bins pay per *price increment* crossed and
  per bin deposited, which on TON caps both trade size and position width at levels that do not
  compete with Meteora.
- Ticks also keep fees claimable (fee growth checkpoints). That lets a permanently locked
  graduation position still pay its fee claimer, which is the launchpad's business model.

### 0.2 Ideas grafted from the other proposals

| From | Idea | Where |
|---|---|---|
| P2 | v4 `PoolKey` with an `initializer` that only it can use to set the first price (squat-proof graduation) | §2.2, §6.8 |
| P2 | Compiled-in plugins chosen per key: `LAUNCH_DECAY` anti-snipe fee and `MIN_LP_LOCK` anti-JIT lock | §5.3, §6.6 |
| P2 | Fixed caps declared in the key for hook-set fees and hook fee share; `HookSetFee` applies from the next swap | §7 |
| P2 | The Pool **always** answers a Position (`PositionSync`) on every path, so there is one in-flight op per position | §6.7 |
| P2 | Tracked per-token `reserve0/1`; `keep()` covers native reserves and fees | §2.2 |
| P1 | The fee preset registry is **add-only** and keyed by `tickSpacing`, so a preset can never change under an existing key | §2.1 |
| P1 | Volatility is updated per step (Meteora updates it per bin), and quotes take an explicit `atTime` | §5.3, §9 |
| P1 | The swap runs on local copies and commits only at the end; a failure writes nothing | §6.1 |
| P1 | Cheap TWAP accumulator `tickCumulative` (for lending and hooks) | §2.2, §9 |
| P1 | The Position restores from its own saved state and never trusts a bounce body | §6.7 |
| P1 | Liquidity "shapes" (spot, curve, bid-ask) are provided by the SDK as several range positions | §13 |
| P3 | No bitmap: `IDICTGETNEXT` / `IDICTGETPREVEQ` on the tick map itself (bitmap kept as the fallback) | §4.6 |
| P3 | Virtual fee checkpoints every 8 spacings | §6.1 |
| P3 | `TICK_RENT_BUFFER` per initialized tick; locked full-range graduation position with a fee claimer | §2.2, §6.8 |

### 0.3 What deliberately does not come from EVM

The following EVM features are not copied:
- the singleton PoolManager, flash accounting and transient storage;
- synchronous before/after hooks with return deltas;
- flash swaps and callbacks;
- implicit uint256 wraparound (TVM throws on overflow, so every wrap is explicit);
- `balanceOf` settlement (reserves are tracked in storage);
- multi-transaction swap continuation (not atomic, and `minOut` would be meaningless).

---

## 1. Layout and build

```
dex/v2/
  DESIGN.md
  tact.config.json
  contracts/
    messages.tact       # every message/struct below; TEP-74 + TEP-62 messages copied (not imported)
    constants.tact      # constants, codes, reasons, small helpers (sortKey, isqrt, ceilDiv, eitherPayload, payloadFee, transferFee) copied from v1
    dict.tact           # asm wrappers: tick-map next/prev key, muldiv family
    math.tact           # TickMath, SqrtPriceMath, SwapMath, LiquidityMath, mod-2^256 helpers (pure global funs)
    fees.tact           # volatility accumulator, launch decay, fee composition (pure)
    engine.tact         # computeSwap / computeMint / computeBurn / feeGrowthInside (pure, shared by receivers AND getters)
    router.tact         # contract Router      (imports pool.tact, mint_account.tact)
    pool.tact           # contract Pool        (imports position.tact)  -- also the TEP-62 collection
    position.tact       # contract Position    (TEP-62 item)
    mint_account.tact   # contract MintAccount (copy of v1 LpAccount, for jetton/jetton in-range mints)
    mocks/test_jetton.tact   # copied from v1 (TestMint op renumbered 0x4d4800e1)
    mocks/fake_wallet.tact   # copied from v1 (FakeSend op renumbered 0x4d4800f1)
    mocks/test_hook.tact     # TestHook: records HookAfterSwap/HookAfterModify, sends HookSetFee/HookCollectFees on owner command
    mocks/math_harness.tact  # MathHarness: getters that expose every pure fun in math/fees/engine for vector tests
  build/                # generated
  tests/
    helpers.ts  model.ts  math.spec.ts  swap.spec.ts  position.spec.ts  fees.spec.ts  hooks.spec.ts
    graduation.spec.ts  admin.spec.ts  security.spec.ts  getters.spec.ts  invariant.spec.ts  gas.spec.ts
```

`dex/v2/tact.config.json` (paths relative to `dex/v2/`):
```json
{ "projects": [
  { "name": "Router",     "path": "./contracts/router.tact",              "output": "./build", "options": { "debug": false, "external": false } },
  { "name": "TestJetton", "path": "./contracts/mocks/test_jetton.tact",   "output": "./build", "options": { "debug": false, "external": false } },
  { "name": "Fake",       "path": "./contracts/mocks/fake_wallet.tact",   "output": "./build", "options": { "debug": false, "external": false } },
  { "name": "TestHook",   "path": "./contracts/mocks/test_hook.tact",     "output": "./build", "options": { "debug": false, "external": false } },
  { "name": "MathHarness","path": "./contracts/mocks/math_harness.tact",  "output": "./build", "options": { "debug": false, "external": false } }
] }
```
- Compile: `cd /Users/basedtoni/Tron && npx tact --config dex/v2/tact.config.json`.
- Test: `cd /Users/basedtoni/Tron && npx jest dex/v2/tests`.
- The Router project emits `Router_Router.ts`, `Router_Pool.ts`, `Router_Position.ts` and
  `Router_MintAccount.ts`.

### 1.1 Milestone 0: scratch-compile probes (do first, record the results in §15)

Each probe is a throwaway contract in `dex/v2/scratch/`, deleted afterwards. A failed probe uses
the named fallback.

| # | Probe | Fallback |
|---|---|---|
| P0.1 | An `asm fun` that takes a `map<Int as int24, TickInfo>` (as `Cell?`) and returns the next/prev key using `IDICTGETNEXT` / `IDICTGETPREVEQ` (§4.6) on a map built by Tact. This includes negative keys and the empty map | Tick bitmap `map<Int as int16, Int as uint256>` (word = `tick/spacing >> 8`), msb via `log2`, lsb via `x & -x` (P2 layout) |
| P0.2 | `asm fun mulDiv { MULDIV }`, `mulDivC { MULDIVC }`, `mulShr { MULRSHIFT }` with 513-bit intermediates (e.g. `mulDiv(2^255, 2^255, 2^254)`) | stdlib `muldiv` / `muldivc` / `mulShiftRight` if they exist under those names |
| P0.3 | A struct with a `map` field returned from a global `fun` and assigned back to `self.ticks` | Return the map separately (a tensor of two values) |
| P0.4 | A contract with `init(router: Address, key: PoolKey)`, where `PoolKey` holds a `Cell?`. Both `initOf` and `contractAddress` agree with a TS-side computation | Flatten `PoolKey` into init params |
| P0.5 | `|` and `>>` on negative ints behave like two's complement / arithmetic shift (needed by `getTickAtSqrtRatio`) | Rewrite the log loop with an unsigned offset |
| P0.6 | `try { pure fun call } catch` with a throw from `MULDIV` overflow (code 4) is caught | none; required |

---

## 2. Contracts and storage

Notation: `RW(T)` is the Router's jetton wallet for jetton T, which is also the token id (v1 D1).
`GRAM` is the zero-hash sentinel, always `token0` (v1 D2).

### 2.1 Router: `contract Router` (singleton entry point and jetton custody)
```
admin:          Address
pendingAdmin:   Address?
treasury:       Address
creationPaused: Bool                                  // blocks INITIALIZATION of new pools only
presets:        map<Int as uint16, FeePreset>         // tickSpacing -> preset, ADD-ONLY
init(admin: Address, treasury: Address)               // installs the 4 default presets (§3.2)
```
The Router keeps no per-pool state. Its responsibilities:
- parse jetton notifications and native entries (inside `try`, into locals only);
- validate the key, gas, deadline and recipients;
- forward to `Pool(router, key)` with StateInit and `bounce:false` (v1 D5);
- execute `PayTo` for pools it has authenticated;
- admin.

### 2.2 Pool: `contract Pool` (one per `PoolKey`; native Gram holder; TEP-62 collection)
```
init(router: Address, key: PoolKey)

// identity (from init, immutable)
router:   Address
key:      PoolKey

// price state
initialized:      Bool
sqrtPriceX96:     Int as uint160
tick:             Int as int24
liquidity:        Int as uint128          // active L
feeGrowth0X128:   Int as uint256          // always in [0, 2^256)
feeGrowth1X128:   Int as uint256
ticks:            map<Int as int24, TickInfo>
tickCount:        Int as uint16           // initialized ticks, <= MAX_TICKS_PER_POOL

// custody (tracked, never derived from balances, v1 D4)
reserve0:         Int as coins            // principal + unclaimed LP fees owed to positions
reserve1:         Int as coins
protocolFees0:    Int as coins
protocolFees1:    Int as coins
hookFees0:        Int as coins
hookFees1:        Int as coins

// fees and plugins (one ref cell)
fs:               FeeState

// misc
nextPositionId:   Int as uint64
tickCumulative:   Int as int64            // TWAP accumulator: sum of tick * seconds
obsTs:            Int as uint32
```
Derived values (computed once at init from `key.ext` and cached in `fs`):
- `isNative = key.token0 == GRAM`.
- `keep() = POOL_MIN_STORAGE + tickCount * TICK_RENT_BUFFER + (isNative ? reserve0 + protocolFees0 + hookFees0 : 0)`.

Every handler that sends value starts its actions with `nativeReserve(keep(), ReserveExact)`. If
the balance is below `keep()` (rent debt), use v1's pattern: reserve
`min(keep(), myBalance() - ctx.value)` with `ReserveAtMost`. Gas from incoming messages refills it.

### 2.3 Position: `contract Position` (TEP-62 NFT item, one per mint)
```
init(pool: Address, index: Int as uint64)
initialized:  Bool                        // set by PositionInit from pool
owner:        Address
tickLower:    Int as int24
tickUpper:    Int as int24
liquidity:    Int as uint128
fgLast0:      Int as uint256              // feeGrowthInside snapshot
fgLast1:      Int as uint256
lockedUntil:  Int as uint32               // 0 = unlocked; 0xFFFFFFFF = locked forever
busy:         Bool                        // one in-flight PoolBurn at a time
pendingQuery: Int as uint64               // queryId of the in-flight op (matched on Sync/bounce)
```
`keep() = POSITION_MIN_STORAGE`.

### 2.4 MintAccount: `contract MintAccount` (one per (pool, user); copy of v1 LpAccount)
```
init(pool: Address, user: Address)
pending0: Int as coins         // jetton/jetton pools only, so these are bookkeeping; tokens stay in Router wallets
pending1: Int as coins
params:   MintParams?          // params of the FIRST leg; later legs only add amounts
```
- When both `pending0 > 0` and `pending1 > 0`: zero the pending amounts, clear `params`, then send
  `CbMint` to the pool.
- `MintAccountRefund` from `user`: zero everything and send `CbMintRefund`.
- Overflow (pending > MAX_COINS): send just that deposit back through `CbMintRefund` (v1 §13.5).

### 2.5 Mocks
- **TestJetton, FakeJettonWallet:** copied from v1.
- **TestHook(owner, salt):**
  - stores the last `HookAfterSwap` and `HookAfterModify` it received (getters expose them);
  - `HookCmd{target, body, value}` from its owner sends an arbitrary body (`HookSetFee`,
    `HookCollectFees`);
  - an odd `salt` makes it throw on every notification, to prove a failing hook cannot affect a
    swap.
- **MathHarness:** no state; one getter per pure function (§4, §5, §6.1 `computeSwap` on a map
  passed as a cell argument).

---

## 3. Constants (`constants.tact`)

### 3.1 Math and limits
| Name | Value |
|---|---|
| `Q96` | 2^96 |
| `Q128` | 2^128 |
| `MAX_U256` | 2^256 − 1 (2^256 is **not** representable in a 257-bit signed int) |
| `MIN_TICK` / `MAX_TICK` | −887272 / 887272 |
| `MIN_SQRT_RATIO` | 4295128739 |
| `MAX_SQRT_RATIO` | 1461446703485210103287273052203988822378723970342 |
| `PIPS` | 1_000_000 (fee unit 1e-6, as in v4) |
| `BPS` | 10_000 |
| `MAX_COINS` | 2^120 − 1 |
| `MAX_U128` | 2^128 − 1 |
| `MAX_CROSSINGS_CAP` | **24** (user `maxCrossings` ∈ [1, 24]); was 32, lowered after measurement (§15) |
| `MAX_STEPS` | **48** (steps per swap, crossings and checkpoints included); was 64, lowered after measurement (§15) |
| `CHECKPOINT_SPACINGS` | 8 (a virtual fee checkpoint every 8 spacings) |
| `MAX_TICKS_PER_POOL` | 8192 (keeps the account far below the 65,536-cell limit) |
| `MIN_POSITION_LIQUIDITY` | 1000 |
| `VA_UNIT` | 10_000 (volatility accumulator units per spacing) |

### 3.2 Fees and caps
| Name | Value | Meaning |
|---|---|---|
| `MAX_BASE_FEE_PIPS` | 20_000 | 2%. Cap on a preset base fee and on a hook-set fee |
| `MAX_DYNAMIC_FEE_PIPS` | 50_000 | 5%. Cap on base + variable |
| `MAX_LAUNCH_FEE_PIPS` | 200_000 | 20% extra at t = init, decaying linearly to 0 |
| `MAX_LAUNCH_DURATION` | 3600 s | |
| `MAX_MIN_LOCK` | 30 days | cap on `minLockSecs` |
| `DEFAULT_PROTOCOL_SHARE_BPS` | 1000 | 10% of every swap fee |
| `MAX_PROTOCOL_SHARE_BPS` | 2500 | 25%. Checked in Router **and** Pool |
| `MAX_HOOK_SHARE_BPS` | 2000 | 20%, declared in the key |
| `MAX_REF_FEE_BPS` | 10 | 0.1% of the input, chosen per swap |

Default presets (installed by `Router.init`; admin can only add new spacings):

| tickSpacing | baseFeePips | A (`varFeeControl`) | filterPeriod | decayPeriod | reductionBps | maxVolAcc |
|---|---|---|---|---|---|---|
| 1 | 100 | 400_000 | 10 | 120 | 5000 | 350_000 |
| 10 | 500 | 40_000 | 30 | 600 | 5000 | 350_000 |
| 60 | 3000 | 4_500 | 30 | 600 | 5000 | 350_000 |
| 200 | 10_000 | 600 | 30 | 600 | 5000 | 350_000 |

At `maxVolAcc` (35 spacings moved) the variable part is about 490 / 4900 / 19845 / 29400 pips
respectively (§5.3). `A = 0` disables the volatility fee for a preset.

### 3.3 Gas and storage (starting points; `gas.spec` tunes them to at least 1.5× the measured cost)
| Name | Value | Use |
|---|---|---|
| `ROUTER_MIN_STORAGE` / `POOL_MIN_STORAGE` | 0.05 | |
| `POSITION_MIN_STORAGE` | 0.02 | |
| `MINT_ACCOUNT_MIN_STORAGE` | 0.01 | |
| `TICK_RENT_BUFFER` | 0.02 | reserved per initialized tick, released when the tick is deleted |
| `TICK_INIT_FEE` | **0.1** (new, §15.7) | non-refundable per new tick; kept forever as the pool `endowment` (anti-spam, pre-paid storage) |
| `SWAP_BASE_GAS` | **0.35** (was 0.2, §15) | covers the empty-pool deploy, the fixed cost and MAX_STEPS non-crossing steps |
| `CROSS_GAS` | **0.006** (was 0.008, §15) | extra cost of one requested crossing (`maxCrossings`) over a plain step |
| `JETTON_PAYOUT_VALUE` | 0.07 | one non-final Pool→Router `PayTo` |
| `HOOK_NOTIFY_VALUE` | 0.01 | fixed value of one hook notification, paid by the user |
| `MINT_GAS` | **0.6** (was 0.4, §15.7) | includes 2 × (TICK_RENT_BUFFER + TICK_INIT_FEE), the Position deploy and two refund legs |
| `GRADUATE_GAS` | **0.5** (was 0.4, §15.7) | |
| `POSITION_DEPLOY_VALUE` | 0.03 | stays in the Position as its storage buffer |
| `DECREASE_GAS` | 0.25 | attached by the owner to `PositionDecrease` |
| `BURN_POOL_GAS` | 0.2 | checked by the Pool on `PoolBurn`; covers Sync + all payout legs (+ `HOOK_NOTIFY_VALUE` if AFTER_MODIFY), §15 |
| `MINT_POOL_GAS` | 0.08 | new (§15): Pool-side compute + Position deploy fees in the mint LOW_GAS check |
| `POSITION_SYNC_VALUE` | 0.02 | fixed value of `PositionSync`, sent before the payouts |
| `COLLECT_GAS` | 0.2 | protocol and hook fee collection |
| `ADMIN_GAS` | 0.05 | |
| `ROUTER_REFUND_MIN` | 0.08 | v1 meaning |
| `MINT_ACCOUNT_REFUND_GAS` | 0.2 | |

Every flow minimum also adds `2 * ctx.readForwardFee()`, plus `fwdTon + payloadFee(fwdPayload)`
for swaps (v1 §13.3 and §15.2).

### 3.4 Codes and reasons
Reasons (`GramPayout.reason` / `PayTo.reason`), copied from v1 1-9, plus:
- 10 `PARTIAL_REFUND`
- 11 `POSITION_OUT`
- 12 `HOOK_FEE`
- 13 `MINT_REFUND`

Refund codes (`RefundEvent.code`), copied from v1 201-216, plus:

| Code | Name | Code | Name |
|---|---|---|---|
| 217 | NOT_INITIALIZED | 224 | TICK_LIMIT |
| 218 | NOT_INITIALIZER | 225 | LOCKED |
| 219 | BAD_TICKS | 226 | BUSY |
| 220 | PRICE_OUT_OF_RANGE | 227 | BAD_KEY |
| 221 | LIQUIDITY_BELOW_MIN | 228 | BAD_TICK_SPACING |
| 222 | PARTIAL_NOT_ALLOWED | 229 | MATH_FAILURE (a caught throw in a pure fun) |
| 223 | NO_LIQUIDITY | 230 | BAD_PRICE_LIMIT |
| | | 231 | ALREADY_INITIALIZED |
| | | 232 | BAD_CROSSINGS (new, §15) |

---

## 4. Fixed-point math (`math.tact`, `dict.tact`): a port of Uniswap v3, made explicit for TVM

General rules:
- Every value is a non-negative Int except ticks and `liqNet`.
- TVM `/` is a **floor** division, also for negatives. Solidity truncates. Where v3 divides
  signed values, the spec states the floor form explicitly.
- `mulDiv(a,b,c) = floor(a*b/c)` (`MULDIV`), `mulDivC = ceil` (`MULDIVC`) and
  `mulShr(a,b,s) = floor(a*b/2^s)` (`MULRSHIFT`). All use a 513-bit intermediate, so they only
  throw if the *result* is above 2^256 − 1. Every call site below has a result bound.
- `divC(a,b) = (a + b − 1) / b` for `a ≥ 0`, `b > 0`.

### 4.1 Modular fee growth (v3 relies on uint256 wraparound, TVM throws)
```
fun addMod(a, b): Int { // a,b in [0, 2^256)
    let room = MAX_U256 - a;                 // 2^256-1-a
    return b <= room ? a + b : b - room - 1; // == (a+b) - 2^256
}
fun subMod(a, b): Int { // a,b in [0, 2^256)
    return a >= b ? a - b : (MAX_U256 - b) + 1 + a;   // never forms 2^256
}
```
Every fee-growth add and subtract goes through these. `tests/math.spec` checks them near 0 and
2^256 − 1.

### 4.2 TickMath
- `getSqrtRatioAtTick(tick)` is the exact v3 algorithm.
  - `absTick = abs(tick)`, `require ≤ MAX_TICK` (callers pre-validate).
  - Start: `ratio = absTick & 1 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 2^128`.
  - Then for each bit i = 1..19 with its v3 constant: `ratio = mulShr(ratio, C_i, 128)`.
    The products are below 2^256, and MULRSHIFT is safe anyway.
  - If `tick > 0`: `ratio = MAX_U256 / ratio`.
  - Result: `(ratio >> 32) + (ratio % 2^32 == 0 ? 0 : 1)` (rounds up).
  - All 20 constants are copied verbatim from v3 `TickMath.sol`.
- `getTickAtSqrtRatio(sqrtP)` requires `MIN_SQRT_RATIO ≤ sqrtP < MAX_SQRT_RATIO`. Steps:
  1. `ratio = sqrtP << 32`, `msb = log2(ratio)` (UBITSIZE − 1).
  2. `r = msb ≥ 128 ? ratio >> (msb − 127) : ratio << (127 − msb)`; `log2v = (msb − 128) << 64`.
  3. Loop i = 0..13: `r = (r*r) >> 127`; `f = r >> 128`; `log2v = log2v | (f << (63 − i))`;
     `r = r >> f`. (P0.5 confirms that `|` with a negative `log2v` works.)
  4. `logS = log2v * 255738958999603826347141`.
  5. `tLow = (logS − 3402992956809132418596140100660247210) >> 128` and
     `tHigh = (logS + 291339464771989622907027621153398088495) >> 128`. These are arithmetic
     (floor) shifts, which equal Solidity `>>` on int256.
  6. `tick = tLow == tHigh ? tLow : (getSqrtRatioAtTick(tHigh) <= sqrtP ? tHigh : tLow)`.
- `minUsableTick(s) = ceilDivSigned(MIN_TICK, s) * s` = `-((-MIN_TICK) / s) * s`, and
  `maxUsableTick(s) = (MAX_TICK / s) * s`.
- `maxLiquidityPerTick(s) = MAX_U128 / ((maxUsable − minUsable) / s + 1)`.

### 4.3 SqrtPriceMath (exact-in only)
```
amount0Delta(a, b, L, up):    // a < b (callers sort), L <= 2^128
    n1 = L << 96;  n2 = b - a
    up ? divC(mulDivC(n1, n2, b), a) : mulDiv(n1, n2, b) / a
amount1Delta(a, b, L, up):    // a < b
    up ? mulDivC(L, b - a, Q96) : mulDiv(L, b - a, Q96)

nextSqrtFromAmount0Up(sqrtP, L, amount):            // zeroForOne input, price goes DOWN, rounds UP
    if amount == 0: return sqrtP
    n1 = L << 96
    if amount <= (MAX_U256 - n1) / sqrtP:            // == v3 "product does not overflow and denominator >= n1"
        return mulDivC(n1, sqrtP, n1 + amount * sqrtP)
    return divC(n1, n1 / sqrtP + amount)              // v3 fallback, same rounding
nextSqrtFromAmount1Down(sqrtP, L, amount):         // oneForZero input, price goes UP, rounds DOWN
    return sqrtP + mulDiv(amount, Q96, L)
```
Amounts are at most 2^120, L at most 2^128 and √P below 2^160, so every result fits in 257 bits.
The callers check the results against `MAX_COINS` (§6.1).

### 4.4 SwapMath.computeSwapStep (exact-in, the v3 rule)
```
step(sqrtP, sqrtTarget, L, rem, feePips) -> (sqrtNext, amountIn, amountOut, feeAmount)
    z = sqrtP >= sqrtTarget
    remLessFee = mulDiv(rem, PIPS - feePips, PIPS)
    amountIn = z ? amount0Delta(sqrtTarget, sqrtP, L, true) : amount1Delta(sqrtP, sqrtTarget, L, true)
    sqrtNext = remLessFee >= amountIn ? sqrtTarget
             : (z ? nextSqrtFromAmount0Up(sqrtP, L, remLessFee) : nextSqrtFromAmount1Down(sqrtP, L, remLessFee))
    max = sqrtNext == sqrtTarget
    if z:  amountIn  = max ? amountIn : amount0Delta(sqrtNext, sqrtP, L, true)
           amountOut = amount1Delta(sqrtNext, sqrtP, L, false)
    else:  amountIn  = max ? amountIn : amount1Delta(sqrtP, sqrtNext, L, true)
           amountOut = amount0Delta(sqrtP, sqrtNext, L, false)
    feeAmount = max ? mulDivC(amountIn, feePips, PIPS - feePips) : rem - amountIn
```
- Rounding favours the pool: input is rounded up, output down, and the fee up.
- With `L = 0`: `amountIn = 0` and the step is `max` with a zero fee, so the price jumps for
  free. This is only used to reach an initialized tick (§6.1).

### 4.5 LiquidityMath
```
liqForAmount0(a, b, x) = mulDiv(x, mulDiv(a, b, Q96), b - a)       // floor
liqForAmount1(a, b, y) = mulDiv(y, Q96, b - a)                      // floor
liquidityForAmounts(sqrtP, sA, sB, x, y):
    sqrtP <= sA ? liqForAmount0(sA, sB, x)
  : sqrtP <  sB ? min(liqForAmount0(sqrtP, sB, x), liqForAmount1(sA, sqrtP, y))
  :               liqForAmount1(sA, sB, y)
amountsForLiquidity(tick, sqrtP, tL, tU, L, up):      // TICK-based branch, exactly like v3 _modifyPosition
    sA = sqrtAt(tL), sB = sqrtAt(tU)
    tick <  tL : (amount0Delta(sA, sB, L, up), 0)
    tick <  tU : (amount0Delta(sqrtP, sB, L, up), amount1Delta(sA, sqrtP, L, up))
    else       : (0, amount1Delta(sA, sB, L, up))
```
Mint uses `up = true` and burn uses `up = false`. A mint computes L with `liquidityForAmounts`
(floor), then `use = amountsForLiquidity(.., up=true)`. While `use0 > x || use1 > y`, it sets
`L -= 1` and recomputes, at most 3 times; if it still does not fit, the mint refunds
MATH_FAILURE. This avoids the off-by-one that v3 periphery tolerates by pulling tokens.

### 4.6 Tick dictionary walk (`dict.tact`)
Tact stores `map<Int as int24, TickInfo>` as a hashmap with signed 24-bit keys and the value in a
ref.
```
// returns the smallest key > pivot, or null
asm fun tickNextGt(pivot: Int, d: map<Int as int24, TickInfo>, n: Int): Int? { IDICTGETNEXT NULLSWAPIFNOT2 DROP NIP }
// returns the largest key <= pivot, or null
asm fun tickPrevLe(pivot: Int, d: map<Int as int24, TickInfo>, n: Int): Int? { IDICTGETPREVEQ NULLSWAPIFNOT2 DROP NIP }
```
- Both are called with `n = 24`.
- Stack contract: `(x D n -- value key -1 | 0)`. `NULLSWAPIFNOT2` normalises failure to
  `(null null 0)`, then `DROP NIP` leaves `key | null`.
- Probe P0.1 must confirm the argument order and the signed-key behaviour. If needed, adjust with
  Tact's `asm(d pivot n)` rearrangement syntax or explicit `s0 s1 XCHG`.
- The value is read with `self.ticks.get(key)!!` (≈1k gas).

### 4.7 Price from deposit ratio (graduation)
```
sqrtFromAmounts(a0, a1):       // a0 = Gram (token0), a1 = jetton (token1); price = a1/a0
    if a1 < (a0 << 64):  return isqrt(mulDiv(a1, 2^192, a0))          // exact floor, ratio < 2^64
    if a1 < (a0 << 128): return isqrt(mulDiv(a1, 2^128, a0)) << 32    // coarser, still floor
    return 0                                                          // out of range
```
The result must satisfy `MIN_SQRT_RATIO ≤ p < MAX_SQRT_RATIO`, else PRICE_OUT_OF_RANGE. `isqrt`
is copied from v1 (floor-corrected stdlib `sqrt`).

---

## 5. Fee model (`fees.tact`)

### 5.1 Where the fee is charged
The fee is charged **on the input, per step** (v3).

Each step's `feeAmount` is split as follows:
```
proto = feeAmount * fs.protocolShareBps / BPS        // floor
hook  = feeAmount * key.ext.hookShareBps / BPS       // floor
lp    = feeAmount - proto - hook
if L > 0: feeGrowthIn = addMod(feeGrowthIn, mulDiv(lp, Q128, L))   // floor, the dust stays in the reserve
```
- The protocol share is at most 25%, so LPs keep at least 55%.
- `reserveIn += consumed − Σproto − Σhook`. The LP fee stays in the reserve because it is owed
  to positions.
- `protocolFeesIn += Σproto` and `hookFeesIn += Σhook`.

### 5.2 Referral
The referral fee is taken off the user's input **before** the engine runs and is paid out
immediately (v1 D9). `refBps ≤ 10`, and `referral == null` forces `refBps = 0`.
```
X = amountIn;  R = X * refBps / BPS;  S = X - R            // S = swap budget
engine consumes C <= S
C == S : refFee = R,                                   refund = 0
C <  S : refFee = min(R, C * refBps / (BPS - refBps)), refund = X - C - refFee   (>= 0, proven in §5.2 note)
```
Note: `C ≤ S − 1` and `S ≥ X(BPS − r)/BPS`, so `C·r/(BPS − r) < R + 1`, hence `refund ≥ 0`.

### 5.3 Per-step fee rate
`feePips(step) = min(base + variable(va), MAX_DYNAMIC_FEE_PIPS) + launchExtra(t)`, where:
- `base` is `fs.hookFeeSet ? fs.hookFeePips : fs.baseFeePips`.
- `variable(va) = divC(A * (va * tickSpacing)^2, 10^14)` (rounded up, as Meteora does). `A = 0`
  turns it off.
- `launchExtra(t)` is 0 unless `key.ext.launchFeePips > 0` and
  `t < fs.startTs + key.ext.launchDuration`. In that case it is
  `launchFeePips * (fs.startTs + launchDuration − t) / launchDuration` (floor, linear decay to 0).
  This is the `LAUNCH_DECAY` plugin.
- Overall cap: 250,000 pips, and only during the first hour. The usual cap is 50,000 pips.

**Volatility accumulator** (Meteora semantics; `idx(tick) = floor(tick / tickSpacing)`, Tact `/`
floors):
- Once per swap, before the first step, with `t` = `now()` (or the getter's `atTime`):
  ```
  elapsed = max(0, t - fs.lastTs)
  if elapsed >= filterPeriod:
      fs.idxRef = idx(tick)
      fs.volRef = elapsed < decayPeriod ? fs.volAcc * reductionBps / BPS : 0
  ```
- At each step start: `va = min(maxVolAcc, fs.volRef + abs(fs.idxRef − idx(tick)) * VA_UNIT)`.
- At commit: `fs.volAcc = min(maxVolAcc, fs.volRef + abs(fs.idxRef − idx(final tick)) * VA_UNIT)`
  (the final active bin, as in Meteora; changed in §15.7 from "va of the last step's start") and
  `fs.lastTs = t`.
- Checkpoints are skipped while va is pinned at `maxVolAcc` and the price moves away from
  `idxRef` (the fee cannot change there; §15.7).

Mints and burns do not touch the volatility state.

### 5.4 Hook-set fee (FEE_CONTROL plugin)
- Requires the key flag `HOOK_FEE_CONTROL`. The hook sends
  `HookSetFee{feePips ∈ [key.ext.hookFeeMin, key.ext.hookFeeMax]}`.
- The Pool sets `fs.hookFeeSet = true` and `fs.hookFeePips = feePips`.
- It applies from the **next** swap (it is the v4 `updateDynamicLPFee` analogue). Quotes stay
  exact against the stored state.

### 5.5 Hard caps (enforced in code; the admin cannot change them)
| Item | Cap | Checked at |
|---|---|---|
| base fee (preset or hook) | 2% | `AddFeePreset` (Router), key validation, `HookSetFee` (Pool) |
| base + variable | 5% | `feePips()` |
| launch extra | 90% decaying to 0 over at most 1 h (was 20%; raised 2026-11-12, §15.9) | key validation |
| total fee of a step | base + variable ≤ 5%, plus the launch extra ≤ 90%: **≤ 95% of the input**, never 100% | by construction (`feeFor`) |
| protocol share | 25% of the fee | Router and Pool |
| hook share | 20% of the fee | key validation (immutable) |
| referral | 0.1% of the input | Router and Pool |

---

## 6. Flows

Notation as in v1: `U` user, `UW(T)` the user's jetton wallet, `R` Router, `P` Pool, `Pos`
Position, `MA` MintAccount, `H` hook.

### 6.0 Router common routine
This is v1 §5.0 unchanged except that the key replaces the pair:
- `try`-parse the payload into locals. Refunds follow v1: before the payload parses they go to
  `msg.sender`; afterwards to `refundTo`.
- `buildKey(tokenIn, otherToken, tickSpacing, ext)`:
  - sort the two tokens; both must be basechain and different;
  - `presets.get(tickSpacing) != null` (else BAD_TICK_SPACING);
  - `validateExt(ext)` (§7.1), else BAD_KEY.
- Recipient guard (v1 §15.1): receiver, refundTo, referral, owner and feeClaimer must not equal
  the Router (BAD_RECIPIENT).
- Forward to `contractAddress(initOf Pool(myAddress(), key))` with `init`, `bounce:false` and the
  v1 "keep what we had" reserve plus `SendRemainingBalance`.

### 6.1 Swap (exact-in)
**Entry.**
- Jetton in: `JettonNotification` + `SwapPayload`.
- Gram in: `SwapNative` (may `require`, since a bounce returns the Gram).

The Router checks:
```
value >= SWAP_BASE_GAS + maxCrossings*CROSS_GAS
       + (allowPartial ? JETTON_PAYOUT_VALUE : 0) + (refBps > 0 ? JETTON_PAYOUT_VALUE : 0)
       + (ext has AFTER_SWAP ? HOOK_NOTIFY_VALUE : 0)
       + fwdTon + payloadFee(fwdPayload) + 2*readForwardFee() (+ amount for SwapNative)
```
It also checks `1 ≤ maxCrossings ≤ MAX_CROSSINGS_CAP` (24, §15), `refBps ≤ 10` and the deadline, then sends `PoolSwap`.

**Pool (`receive(PoolSwap)`).** It does `require(sender() == router)`, then never throws.
1. Early refunds:
   - not initialized → NOT_INITIALIZED;
   - deadline passed → DEADLINE;
   - limit invalid → BAD_PRICE_LIMIT. The limit is valid when, for zeroForOne,
     `MIN_SQRT_RATIO < lim < sqrtP`, and for oneForZero `sqrtP < lim < MAX_SQRT_RATIO`.
     `lim = 0` means the extreme.
2. `res = try { computeSwap(snapshot, ticks, params, now()) } catch → MATH_FAILURE refund`.
   `computeSwap` is pure: it gets the stored values and returns new values plus a new `ticks`
   map. **Nothing is written before it returns.**
3. Outcome:
   - `res.out == 0` → ZERO_OUT refund;
   - `res.remaining > 0 && !allowPartial` → PARTIAL_NOT_ALLOWED refund (stop reason in the event);
   - `res.out < minOut` → SLIPPAGE refund;
   - the new `reserveIn` or any fee bucket would be above `MAX_COINS`, or `res.out > reserveOut`
     → OVERFLOW / MATH_FAILURE refund.

   A refund returns the whole `amountIn` and writes no state at all.
4. Commit: price, tick, L, fee growth, ticks, fs (volatility), reserves, fee buckets,
   `tickCumulative += oldTick * (now − obsTs)`, `obsTs = now`.
5. Emit `SwapEvent` (before the reserve and sends, v1 §13.4).
6. Actions:
   1. `nativeReserve(keep())`;
   2. referral payout (if `refFee > 0`);
   3. `HookAfterSwap` (if the flag is set; fixed value, `bounce:false`);
   4. partial refund of `refund` in the input token (if > 0);
   5. **last**: output `out` to `receiver` with `fwdTon`/`fwdPayload`, remaining balance,
      `excessTo = refundTo`.

   Payouts use v1 `payOut` (§5.11 of v1).

**`computeSwap` (engine.tact).**
```
in: sqrtP, tick, L, fg0, fg1, ticks, fs, key, zeroForOne, S (budget), lim, maxCrossings, t
refs update (§5.3)
rem = S; out = 0; crossings = 0; steps = 0; proto = 0; hook = 0; va = fs.volAcc
nextInit = zeroForOne ? tickPrevLe(tick, ticks) : tickNextGt(tick, ticks)     // cached, refreshed only after a crossing
while rem > 0 && sqrtP != lim:
    if steps == MAX_STEPS: stop = STEPS; break
    if nextInit == null && L == 0: stop = NO_LIQUIDITY; break      // never walk an empty book to the extremes
    tgt  = nextInit ?? (zeroForOne ? minUsable : maxUsable)
    init = nextInit != null
    if A > 0 && L > 0:                                              // virtual fee checkpoint
        K  = CHECKPOINT_SPACINGS * tickSpacing
        cp = zeroForOne ? floor(tick / K) * K : (floor(tick / K) + 1) * K
        if zeroForOne && cp == tick && sqrtAt(cp) >= sqrtP: cp -= K   // already at/after it
        if (zeroForOne ? cp > tgt : cp < tgt): tgt = cp; init = false
    sqrtTgtTick = sqrtAt(tgt)
    target = zeroForOne ? max(sqrtTgtTick, lim) : min(sqrtTgtTick, lim)
    va  = min(maxVolAcc, fs.volRef + abs(fs.idxRef - idx(tick)) * VA_UNIT)
    fee = feePips(va, t)
    (sqrtNew, i, o, f) = step(sqrtP, target, L, rem, fee)
    rem -= i + f;  out += o;  steps += 1
    split f (§5.1) into proto/hook/fgIn
    if sqrtNew == sqrtTgtTick:
        if init:                                                    // cross (v3 Tick.cross)
            ti = ticks.get(tgt)!!
            ti.fgOut0 = subMod(fg0, ti.fgOut0);  ti.fgOut1 = subMod(fg1, ti.fgOut1)
            ticks.set(tgt, ti)
            L = zeroForOne ? L - ti.liqNet : L + ti.liqNet
            crossings += 1
            nextInit = zeroForOne ? tickPrevLe(tgt - 1, ticks) : tickNextGt(tgt, ticks)
        tick  = zeroForOne ? tgt - 1 : tgt
        sqrtP = sqrtNew
        if init && crossings == maxCrossings && rem > 0: stop = CROSSINGS; break
    else if sqrtNew != sqrtP:
        sqrtP = sqrtNew;  tick = getTickAtSqrtRatio(sqrtP)
    // else the price did not move (dust fully taken as fee); the loop ends because rem == 0
stop = rem == 0 ? FILLED : (sqrtP == lim ? LIMIT : stop)
return {out, consumed = S - rem, remaining = rem, proto, hook, sqrtP, tick, L, fg0, fg1, ticks, va, crossings, steps, stop}
```
Notes:
- `sqrtAt(tgt)` uses `minUsable/maxUsable` when no tick exists, which keeps targets within the
  valid range.
- A crossing is always completed when the step lands on an initialized tick (v3 semantics, so
  tick, L and the price are always consistent). The cap check happens *after* the crossing,
  which is why `maxCrossings ≥ 1`.
- Price-limit equality on an initialized tick crosses it, exactly as v3 does.

**Bounding many crossings.** One transaction does at most `maxCrossings ≤ 24` dict writes and
`MAX_STEPS = 48` steps (§15). These are deterministic counts, never `gasConsumed()`, so the getter
reproduces execution exactly.
- Beyond that the swap stops with stop reason CROSSINGS or STEPS.
- With `allowPartial` it commits the filled part and refunds the remainder in the same
  transaction. Otherwise it refunds everything with no state written.
- Larger orders are split **by the SDK** into sequential independent swaps, each with its own
  `get_quote`-derived `minOut` and `sqrtPriceLimitX96`. The SDK sets
  `maxCrossings = quote.crossings + 2`.
- There is no on-chain continuation (§0.3).

Because the Router→Pool hop is `bounce:false`, an out-of-gas Pool transaction would strand the
funds. The Router's value check (`SWAP_BASE_GAS + maxCrossings*CROSS_GAS`) must therefore cover
the worst case for the requested bounds. `gas.spec` asserts this at exactly the minimum value
(§10).

### 6.2 Mint (new position; one NFT per mint)
**Entries.**
- (a) Jetton only: `JettonNotification` + `MintPayload{gramAmount = 0, viaAccount = false}`, for
  ranges where only that token is needed.
- (b) Dual Gram+jetton in one message (native pool, `otherToken == GRAM`): `MintPayload` with
  `gramAmount > 0`, where the Gram rides in `forwardTonAmount`. The Router checks
  `value ≥ gramAmount + MINT_GAS + 2*fwdFee`.
- (c) Gram only: `MintNative`.
- (d) Jetton/jetton in range: two jetton legs with `viaAccount = true`. Each goes
  Router → Pool → `MintAccount(pool, fromUser)`. The second leg triggers `CbMint` (MA → Pool).
  Both legs must carry identical `MintParams` (hash compared); a leg whose params differ from the
  parked one does not pair: `CbMintReject` refunds each leg to its own `refundTo` (code 234,
  §15.8).

The Router builds `PoolMint{…, allowInit = !creationPaused, preset = presets.get(tickSpacing)!!}`.

**Pool `mint(user, owner, a0, a1, tL, tU, sqrtInit, minL, deadline, refundTo, allowInit, preset)`.**
It is total and never throws. Each failure refunds every leg to `refundTo`.
1. Deadline. Then, if not initialized:
   - `sqrtInit == 0` → NOT_INITIALIZED;
   - `!allowInit` → CREATION_PAUSED;
   - `key.ext.initializer != null && user != initializer` → NOT_INITIALIZER;
   - `sqrtInit ∉ [MIN_SQRT_RATIO, MAX_SQRT_RATIO)` → PRICE_OUT_OF_RANGE.

   Otherwise compute in locals the initial state: `sqrtP`, `tick = getTickAtSqrtRatio`,
   `fs` from the preset plus `startTs = lastTs = obsTs = now`, and
   `protocolShareBps = DEFAULT_PROTOCOL_SHARE_BPS`. When already initialized, `sqrtInit` is
   ignored.
2. Ticks: `tL < tU`, both multiples of `tickSpacing`, within `[minUsable, maxUsable]`, else
   BAD_TICKS.
3. `L = liquidityForAmounts(...)` with the fit loop (§4.5). Then `L ≥ max(minL, MIN_POSITION_LIQUIDITY)`,
   else LIQUIDITY_BELOW_MIN.
4. `computeMint` (pure) updates both ticks:
   - if `liqGross` was 0, initialize `fgOut = (t ≤ tick) ? (fg0, fg1) : (0, 0)` and
     `newTicks += 1`;
   - `liqGross += L ≤ maxLiquidityPerTick`;
   - `liqNet += (lower ? L : −L)`;
   - `L_active += L` if `tL ≤ tick < tU`;
   - `fgInside` snapshot (§6.4).

   It fails with TICK_LIMIT if `tickCount + newTicks > MAX_TICKS_PER_POOL`. It fails with
   LOW_GAS if the value left (after any Gram leg) is below
   `newTicks * TICK_RENT_BUFFER + POSITION_DEPLOY_VALUE + (jetton refund legs) * JETTON_PAYOUT_VALUE`.
   The Router's `MINT_GAS` always covers this, so LOW_GAS here only catches a mis-tuned
   constant.
5. `reserve += use` (≤ MAX_COINS, else OVERFLOW). Commit. Emit `ModifyEvent` (and
   `InitializeEvent` if this mint initialized the pool).
6. Actions:
   1. reserve `keep()` (now including the new tick buffers);
   2. deploy `Position(myAddress(), nextPositionId++)` with
      `PositionInit{owner, tL, tU, L, fgInside0, fgInside1, lockedUntil = minLockSecs > 0 ? now + minLockSecs : 0}`,
      value `POSITION_DEPLOY_VALUE`, `bounce:false`;
   3. `HookAfterModify` (if the flag is set);
   4. refund `a − use` legs (jetton legs as `PayTo` with a fixed value);
   5. **last**: the Gram leg remainder, or `JettonExcesses`, to `refundTo`.

A mint never adds to an existing position (deferred). The owner mints a new one.

### 6.3 Decrease liquidity / collect fees (owner → Position → Pool → Position)
1. `U → Pos: PositionDecrease{queryId, liquidityDelta, amount0Min, amount1Min, deadline, recipient?}`
   with value ≥ `DECREASE_GAS`. The Position `require`s, and a bounce returns the value:
   - sender is the owner;
   - `initialized && !busy`;
   - `liquidityDelta ≤ liquidity`;
   - `liquidityDelta == 0 || now ≥ lockedUntil` (LOCKED). **Collect (Δ = 0) is always allowed,
     including on a locked position.**

   It then sets `busy = true` and `pendingQuery = queryId`, keeps `POSITION_MIN_STORAGE`, and
   sends `PoolBurn{index, owner, recipient ?? owner, tL, tU, liquidity, liquidityDelta, fgLast0, fgLast1, mins, deadline}`
   to the pool with **`bounce:true`** and the remaining value.
2. Pool `receive(PoolBurn)`:
   - `require(sender() == contractAddress(initOf Position(myAddress(), index)))`. A throw here is
     safe: no custody moves, and the bounce reaches the sender.
   - Value ≥ `BURN_POOL_GAS` (+ `JETTON_PAYOUT_VALUE` per jetton leg), else
     `Sync{ok=false, LOW_GAS}`.
   - Deadline, else `Sync{ok=false, DEADLINE}`.
   - Pure `computeBurn`:
     - `inside = feeGrowthInside(tL, tU)` (§6.4);
     - `fees_i = mulShr(liquidity, subMod(inside_i, fgLast_i), 128)`;
     - `amt = amountsForLiquidity(.., Δ, up=false)`;
     - ticks: `liqGross −= Δ`, `liqNet ∓= Δ`, and delete a tick whose `liqGross` reaches 0
       (`tickCount −= 1`, which releases its buffer);
     - `L_active −= Δ` if in range.
   - `out_i = amt_i + fees_i` must be at least the mins (else SLIPPAGE) and at most `reserve_i`
     (else MATH_FAILURE; never expected, and covered by the invariant tests).
   - On failure: `PositionSync{ok=false, code}` with all remaining value. No state change.
   - On success:
     1. commit and emit `ModifyEvent`;
     2. reserve `keep()`;
     3. `PositionSync{ok=true, newLiquidity = liquidity − Δ, inside0, inside1}` with fixed
        `POSITION_SYNC_VALUE`, **sent first**;
     4. `HookAfterModify` (if the flag is set);
     5. payouts to `recipient`, the last one with the remaining balance.
3. `Pos receive(PositionSync)`:
   - `require(sender() == pool && busy && msg.queryId == pendingQuery)`;
   - if `ok`: `liquidity = newLiquidity`, `fgLast = inside`;
   - `busy = false`;
   - forward the excess above `keep()` to the owner (`Excesses`).
4. `Pos bounced(PoolBurn)`: `busy = false`. Nothing is read from the bounce body, because the
   Position never decremented anything (state changes only on `Sync ok`).

### 6.4 Fee growth inside (v3 Tick.getFeeGrowthInside, modular)
```
below_i = tick >= tL ? out_i(tL) : subMod(fg_i, out_i(tL))
above_i = tick <  tU ? out_i(tU) : subMod(fg_i, out_i(tU))
inside_i = subMod(subMod(fg_i, below_i), above_i)
```

### 6.5 Position NFT (TEP-62)
- `Transfer{queryId, newOwner, responseDestination, customPayload, forwardAmount, forwardPayload}`
  from the owner. It is refused while `busy`. It sends `OwnershipAssigned` when
  `forwardAmount > 0`, and the excess to `responseDestination`.
- `GetStaticData` answers with `ReportStaticData{queryId, index, collection = pool}`.
- `get_nft_data()` returns `(initialized, index, pool, owner, content)`. `content` is a cell
  holding `(tickLower, tickUpper)`.
- The Pool is the collection:
  - `get_collection_data()` returns `(nextPositionId, content, owner = null)`. The content is an
    off-chain TEP-64 cell `0x01` with an empty string in the MVP.
  - `get_nft_address_by_index(i)`.
  - `get_nft_content(i, individual)` returns `individual` unchanged.

### 6.6 Plugins (compiled in, chosen by the key, immutable, exactly quotable)
| Plugin | Where it is set | Effect |
|---|---|---|
| VOLATILITY | preset `A > 0` | §5.3 variable fee |
| LAUNCH_DECAY | `ext.launchFeePips > 0` | §5.3 launch extra, decaying linearly over `launchDuration` from initialization |
| MIN_LP_LOCK | `ext.minLockSecs > 0` | every new position is locked for `minLockSecs` (anti-JIT); collect is still allowed |
| ORACLE | always on | `tickCumulative`, `obsTs` (§9 `get_observe`) |

### 6.7 Position concurrency rules
- There is one in-flight op per Position (`busy`).
- The Pool answers **every** authenticated `PoolBurn` with exactly one `PositionSync`, or else
  throws before any state change, and the bounce clears `busy`.
- `PositionSync` carries `queryId`; a stale or forged sync is rejected.
- No timeout unlock: the request may still be in flight. Because there is always a reply, the
  lock cannot be permanent. The test suite covers every reply path.
- "Always a reply" also needs the Pool's action phase to never fail (a failed action phase rolls
  back without a bounce). Since §15.7: payout addresses are validated (Router, Position, Pool),
  the success path requires `myBalance() − keep() ≥ BURN_POOL_GAS` after rent (else a funded
  `Sync{ok=false, LOW_GAS}`), the failure path reserves `min(keep, myBalance − value)`, and every
  PoolBurn send carries `SendBounceIfActionFail`.
- Swaps interleaving with a burn are safe: the burn computes from the Pool's state at execution
  time, and the Position's `liquidity` and `fgLast` are its own authoritative records.

### 6.8 Graduation (launchpad entry point)
A **future** launchpad version sends one jetton transfer from the token master's wallet:
`JettonTransfer{amount = jettonLeg, destination = R, forwardTonAmount = gramAmount + GRADUATE_GAS, forwardPayload = GraduatePayload}`.
The payload is one cell, built by hand (§8.2). The live v1 launchpad is not changed.

1. The Router:
   - takes `tokenIn = sender()` (RW(jetton)) and `fromUser` (the transferring owner, i.e. the
     launch master);
   - builds `key = {GRAM, RW(jetton), tickSpacing, ext = KeyExt{initializer: fromUser, launchFeePips, launchDuration, others 0/null}.toCell()}`;
   - checks the value, the deadline and the caps;
   - sends `PoolGraduate`.
2. The Pool:
   - requires `!initialized` (else ALREADY_INITIALIZED, full refund to `refundTo`);
   - requires `fromUser == key.ext.initializer`, true by construction;
   - requires `allowInit`.

   It then computes `sqrtP = sqrtFromAmounts(gram, jetton)` (§4.7) and initializes as in §6.2.
   It mints a **full-range** position `[minUsable, maxUsable]` with
   `owner = feeClaimer, lockedUntil = 0xFFFFFFFF`, and refunds the rounding dust to `refundTo`.
   The launch-decay plugin protects the first `launchDuration` seconds from snipers.
3. **Squatting is impossible.** Only `fromUser == master` can initialize a key whose initializer
   is the master. Others can deploy that pool uninitialized (by swapping into it, which refunds),
   which does not block graduation. They can also create *other* keys, which indexers ignore.
   The canonical key for a launch token is published in `InitializeEvent` (§8.7).
4. The principal is locked forever. The **fees remain claimable** by the `feeClaimer` (a creator
   or treasury contract) via `PositionDecrease{liquidityDelta: 0}`, and the NFT can be
   transferred to move the fee rights.

Full-range liquidity is chosen deliberately: a locked concentrated range could fall out of range
and leave the pool one-sided forever.

### 6.9 Protocol and hook fee collection
- `CollectProtocolFees{queryId, key}` can be sent to the Router by **anyone**, with value
  ≥ `COLLECT_GAS`. The Router sends `PoolCollectProtocol{treasury = self.treasury}` (bounce:true,
  no StateInit; a missing pool bounces and the Router swallows it). The Pool pays
  `protocolFees0/1` to that treasury, zeroes them, and sends the excess to the caller.
- `HookCollectFees{queryId}` goes from `key.ext.hook` directly to the Pool (`require` the sender).
  The Pool pays `hookFees0/1` to the hook.

### 6.10 Admin (strictly capped; v1 §9.7 model)
**Can:**
- `AddFeePreset` for a new `tickSpacing` only (refused if it exists; caps checked);
- `SetProtocolShare(key, bps ≤ 2500)` through Router → `PoolSetProtocolShare` (the Pool re-checks
  the cap);
- `SetCreationPaused` (blocks only *initialization* of new pools; launch and graduation keys
  bypass it, §15.8);
- `SetTreasury`;
- 2-step `TransferAdmin` / `ClaimAdmin`;
- `WithdrawRouterExcess` (Router Gram above `ROUTER_MIN_STORAGE`, to the treasury).

**Cannot:**
- touch reserves, ticks, positions or locked positions;
- pause swaps, mints or withdrawals;
- change an existing pool's preset, launch fee, hook or caps;
- upgrade code;
- rescue jettons.


### 6.11 Direct launch (launchpad entry without a curve, 2026-11-12)
This is the entry for `launch/`, a Clanker / Uniswap-v4-launch style launchpad. The launch master
sends `JettonTransfer{amount = poolAllocation, destination = R, forwardTonAmount = LAUNCH_GAS
(+ DEV_BUY_GAS + devBuy), forwardPayload = LaunchPayload}`. The launchpad mints straight into
RW(jetton) with `from = master`, which is equivalent and saves one hop. `LaunchPayload` and the key
structs live in `shared.tact`, and `launch/` keeps a verbatim copy of that file.

1. **Router** (`launch()`):
   - `key = {GRAM, RW(jetton), tickSpacing, ext = KeyExt{initializer: fromUser, launchFeePips,
     launchDuration, taxRecipient, buyTaxBps, sellTaxBps, rest 0/null}}`;
   - checks the recipients (feeClaimer, refundTo and devReceiver must be std basechain and not the
     Router; otherwise the jettons are refunded to the sender), the deadline, the preset,
     `extFlags`, `sqrtPriceX96 ∈ [MIN, MAX)` and the value;
   - sends `PoolLaunch` with `allowInit = true` (a launch key bypasses `creationPaused`, §15.8).
2. **Pool** (`receive(PoolLaunch)`). Every failure refunds both the jettons and the dev-buy Gram
   to `refundTo`.
   - Checks, in order: deadline; `!initialized`; `allowInit`; `fromUser == ext.initializer`;
     `isNative && taxValid`; price range.
   - `tU = floor(tickAt(sqrtPriceX96) / s) · s` with `minUsable(s) < tU ≤ maxUsable(s)`, else
     BAD_TICKS.
   - `computeMint` at `sqrtAt(tU)`, tick `tU`, over `[minUsable, tU]` with `a0 = 0` and
     `a1 = amount`. Because `tick == tU`, only token1 is used and the active L stays 0; the first
     buy crosses `tU` at zero cost.
   - Gas check: `value − devBuy ≥ MINT_POOL_GAS + newTicks·(TICK_RENT_BUFFER + TICK_INIT_FEE) +
     POSITION_DEPLOY_VALUE (+ DEV_BUY_POOL_GAS + JETTON_PAYOUT_VALUE)`.
   - Commit: initialize (`fs` from the preset, `idxRef = tU / s`), the ticks, `reserve1 += use1`,
     and `protocolFees1 += amount − use1` (rounding dust, < √price units, so no payout hop is
     needed).
   - **Dev buy** in the same transaction: `simulate(ext with launchFeePips = 0, zeroForOne, devBuy,
     limit 0, maxCrossings 2, ref 0, allowPartial false, minDevOut)`, then `commitSwap`. On failure
     it emits `RefundEvent` and returns only the dev Gram (`GramPayout` reason SWAP_REFUND); the
     launch stands. The waiver is safe because this branch runs only in the transaction that
     initializes the pool, so it cannot be replayed.
   - Events: `InitializeEvent{graduation: true}`, `ModifyEvent`, `SwapEvent`, `LaunchEvent`.
   - Sends: `Position(0)` with `lockedUntil = LOCKED_FOREVER` for `feeClaimer`; then the dev jettons
     as the last `PayTo` (its excess goes to refundTo), or the dev Gram refund, or the excess.
3. **Why jetton-only `[minUsable, tU]`.** Gram is token0 and price = jetton/Gram, so a Gram buyer
   lowers the price. A range entirely below the current tick holds only jettons, and every buy is
   filled from it. One range is enough: it covers every price a buyer can reach. Clanker-style
   multiple ranges (several positions with different weights) would cost one PositionInit and two
   ticks each. They can be added as further PoolLaunch-style mints if wanted; they were not built.
4. **Squatting and canonicality** are the same as §6.8. Anyone may send a `LaunchPayload` for any
   jetton they hold, but that builds a key with themselves as initializer.

### 6.12 TAX plugin (2026-11-12)
`KeyExt` gains `taxRecipient: Address?`, `buyTaxBps: uint16` and `sellTaxBps: uint16`.

- **`taxValid(ext, gramPool)`** is the same function in the Router (`extFlags`) and in the Pool
  (`doMint` and `PoolLaunch` initialization). It requires:
  - each tax ≤ `TAX_MAX_BPS` = 1000;
  - `(buy > 0 || sell > 0) == (taxRecipient != null)`;
  - a taxed key has `initializer != null` and a Gram pool.

  The Router additionally requires `taxRecipient` to be basechain and not the Router, and marks
  taxed keys with `TAXED_FLAG` (256) in the `extFlags` result. The jetton entries refuse a taxed
  key unless `otherToken == GRAM`.
- **`simulate`:**
  - `buyTax = zfo && native ? buyTaxBps : 0` and `sellTax = !zfo && native ? sellTaxBps : 0`;
  - `r = amountIn · refBps / BPS`, `x = amountIn · buyTax / BPS`, `S = amountIn − r − x`;
  - on a partial fill (`c < S`, with `k = BPS − refBps − buyTax`): `refFee = min(r, c·refBps/k)`,
    `tax = min(x, c·buyTax/k)` and `refund = amountIn − c − refFee − tax`;
  - on a sell, `tax = out · sellTax / BPS` and `Sim.out = out − tax`;
  - `minOut` is checked against `Sim.out`, and `taxFees + tax ≤ MAX_COINS` is checked too.
- **`commitSwap`:** `taxFees += tax`, and `reserve0 −= grossOut` on a sell. The fee growth is
  unchanged (the tax is outside the LP fee).
- `keep()` includes `taxFees`.
- **Collection:** `CollectTax{queryId, key}` → Router (anyone, value ≥ COLLECT_GAS) →
  `PoolCollectTax{queryId, excessTo}` (bounce:true). The Pool pays
  `GramPayout{REASON_TAX = 14}` to `taxRecipient`, with the remaining value; with nothing to pay,
  the excess goes to the caller.

### 6.12a PLATFORM FEE and direct fee payouts (2026-11-13)
pump.fun-style platform fee, paid in Gram straight to the treasury, plus the creator TAX paid out
automatically.

- **Scope:** one function, `Pool.platformCharged(ext) = native && (PLATFORM_FEE_ALL_GRAM_POOLS ||
  ext.initializer != null)`, mirrored by `Router.platformGas(flags, gramPool)`. The switch
  `PLATFORM_FEE_ALL_GRAM_POOLS` is **false**: launch keys only (direct launch / graduation keys, or
  any key with an initializer) of Gram pools. Plain keys, and hook keys without an initializer, pay
  nothing. Tests read the switch from `constants.tact` (`model.ts platformCharged`).
- **Rate:** `Router.platformBps` (uint16), initially `PLATFORM_FEE_CAP_BPS` = 100 (1%). The admin
  sets it with `SetPlatformFee{queryId, bps}` (`0x4d48001d`), any value in `[0, 100]` (lower or
  raise; never above the code cap). The Router puts the current rate and recipient (`treasury`) into
  every `PoolSwap` and `PoolLaunch` (appended `platformBps: uint16, platformTo: Address`), so a
  change applies to every pool on its next swap. The Pool stores the last rate it saw
  (`Pool.platformBps`, initially the cap; set by `PoolLaunch` and every `PoolSwap` of a charged key).
- **`simulate(…, platBps)`:** taken exactly like the tax, on the Gram side: buy
  `p = amountIn · platBps / BPS` before the swap (`S = amountIn − r − x − p`; on a partial fill
  `k = BPS − refBps − buyTax − platBps`, `plat = min(p, c·platBps/k)`, refunded otherwise); sell
  `plat = grossOut · platBps / BPS`, `Sim.out = grossOut − tax − plat`. `minOut` is net of both.
  Outside the LP fee and fee growth. A getter rate above the cap quotes `BAD_REF_BPS`.
- **Payout (same transaction):** `commitSwap` adds `plat` to `platformFees`. `takePayouts` (before
  `reserveKeep`) moves out `platformFees` when ≥ `PLATFORM_MIN_PAYOUT` (0.01 Gram) and `taxFees`
  when the key is taxed and ≥ `TAX_MIN_PAYOUT` (0.1 Gram), so `keep()` no longer protects them.
  `sendPayouts` then sends `GramPayout{REASON_PLATFORM = 15, amount}` to `platformTo` (value =
  amount) and `GramPayout{REASON_TAX = 14, amount}` to `taxRecipient` (value = amount +
  `TAX_PAYOUT_GAS` 0.04, which the launch master's `taxIn` keeps for its split, so it splits the
  whole amount). Both `SendPayGasSeparately`, `bounce:false`, never the last send (the output is).
  The Gram comes from the swap itself: the buy input, or the sell's gross output that left
  `reserve0`; never other reserves. Dev buys in `PoolLaunch` pay both the same way.
- **Carry:** below the minimum the fee stays in `platformFees`, which is in `keep()` (so
  `reserveForCaller` collect/admin/hook paths and donations can never sweep it) and is added to the
  next payout. Anyone can flush it: `CollectPlatformFees{queryId, key}` (`0x4d48001e`, ≥
  `COLLECT_GAS`) → `PoolCollectPlatform{queryId, treasury, excessTo}` (`0x4d480029`) → the Pool
  pays `GramPayout{15}` to the treasury (`payTwo`, remaining value).
- **Tax below the threshold** accrues as before; `CollectTax` still works.
- **Gas:** `swapGas(…, flags, gramPool)` adds `PAYOUT_MSG_GAS` (0.01) when the key is charged and
  `PAYOUT_MSG_GAS + TAX_PAYOUT_GAS` (0.05) when it is taxed. `extFlags` marks initializer keys with
  `LAUNCH_FLAG` (512). Router getters: `get_platform_fee()`, `get_swap_gas(maxCrossings,
  allowPartial, refBps, ext, gramPool)` (the exact Router minimum, −1 for a bad ext). `PoolLaunch`
  adds the same payout gas to the Pool-side need of a dev buy (the Router's `LAUNCH_GAS` +
  `DEV_BUY_GAS` already cover it; unchanged).
- **Quotes:** `get_quote` / `get_quote_at` use the pool's last-seen rate; `get_quote2(zeroForOne,
  amountIn, sqrtPriceLimitX96, maxCrossings, refBps, allowPartial, platformBps)` takes the Router's
  rate (`get_platform_fee`) and is exact even right after a `SetPlatformFee`. `Quote.platformFee`,
  `SwapEvent.platformFee` (appended last; `amountIn` of a buy includes it, `amountOut` of a sell is
  net of it), `PoolState.platformFees` / `platformBps` (appended).

### 6.13 Fee-on-transfer jettons (policy)
They are not supported, and nothing in the contracts can detect them. The Router credits the
notified amount and assumes a payout of X debits its wallet by exactly X.

- An *honest* FoT wallet notifies what it credited. It stays exactly backed: deposits are booked
  net, and payouts arrive reduced.
- A wallet that notifies more than it credited is a lying or fake jetton. Its deficit is confined
  to its own RW (token id): other pools are unaffected, and the last withdrawals bounce
  (`TRANSFER_BOUNCED`).

`fot.spec` demonstrates both cases. Tax tokens must use §6.12.

### 6.14 Observation and notifying ops (additive, 2026-11-12)
Contracts cannot read another contract's state, and the plain ops report nothing to a contract
owner (a jetton payout uses `forward_ton_amount = 0`, so the recipient's wallet credits it
silently). These additive messages let a contract (a vault, a lending market) use a **plain**
pool: no hook, no extra fee for swappers. Every message above them is unchanged.

**PoolObserve (anyone → Pool, value ≥ `OBSERVE_VALUE` 0.03).** A pure read; the reply
`PoolObservation` goes to the sender, non-bounceable, with the remaining value:
- `initialized`, `sqrtPriceX96`, `tick`, `liquidity` (all 0 before initialization);
- `tickCumulative` extrapolated to `time` = the Pool's `now()` (exactly `get_observe`), so two
  observations give the pool's own TWAP;
- `feeGrowthInside0/1X128` for `[tickLower, tickUpper]` (§6.4) and `rangeOk`. As in v3
  `snapshotCumulativesInside`, the range must be valid and **both ticks initialized**: an
  uninitialized tick has no defined fee-growth-outside, so the inside value is reported (and
  `rangeOk` set) only for a live range, otherwise 0. For a position,
  `fees = L · (inside − fgLast) >> 128` equals what a collect would pay.
- `queryId`, `tickLower`, `tickUpper` and `payload` are echoed.

Below `OBSERVE_VALUE` the Pool throws (a bounceable request bounces). Only the requester ever gets
an observation, so a contract can trust every `PoolObservation` whose sender is the real pool.
The getter `get_pool_observation(tL, tU)` runs the same function.

**PositionDecreaseNotify (owner → Position, value ≥ `DECREASE_NOTIFY_GAS` 0.3).** Same fields and
checks as `PositionDecrease`. The Position sends `PoolBurnNotify` (same fields as `PoolBurn`); the
Pool runs the same burn code (`burnCore`) with two differences:
- it answers `PositionSyncNotify` (the `PositionSync` fields plus `liquidityDelta`, amounts and
  fees), on success and on every refusal;
- every jetton payout leg carries `NOTIFY_FWD_TON` (0.01), so the recipient's wallet sends a
  `JettonNotification` (sender = Router, queryId = the decrease's queryId). The Gram leg is the
  usual `GramPayout`.

The Position applies `PositionSyncNotify` exactly like `PositionSync`, then sends **`BurnReceipt`**
`{queryId, index, ok, code, liquidityDelta, liquidity, amount0, amount1, fees0, fees1, fgInside0,
fgInside1}` to the owner **in place of** its `JettonExcesses`, with the remaining value (at least
`RECEIPT_FLOOR` 0.008, even if rent ate the Position's buffer). If the `PoolBurnNotify` bounces, the
Position sends `BurnReceipt{ok = false, code = BURN_BOUNCED (233)}`. So the owner gets **exactly one
receipt per accepted op, from its own NFT, once the NFT is free**: no pairing of a hook with an
excess, no ordering proof. Deviation from the proposal (vaults §13): the receipt is relayed by the
Position rather than sent by the Pool; this is what makes "result" and "free" one message.

**Notifying mints.** `MintNotifyPayload` (0x4d480005, the `MintPayload` fields without
`viaAccount`) and `MintNativeNotify` (the `MintNative` fields) need `MINT_GAS + MINT_NOTIFY_GAS`
(0.05 more). The Router sends `PoolMintNotify` (the `PoolMint` fields without `viaAccount`). The
Pool runs the same `doMint` and:
- sends **`MintReceipt`** `{queryId, ok, code, owner, index, tickLower, tickUpper, liquidity,
  amount0, amount1 (used), refund0, refund1, fgInside0, fgInside1}` to **`fromUser`** (the
  authenticated payer, never the owner: nobody can make a contract believe it minted), with
  `RECEIPT_VALUE` (0.01), before the refunds (same Pool → payer FIFO channel as a Gram refund);
- refuses with a `MintReceipt{ok = false, code}` and refunds both legs, the jetton ones notified;
- a Router-level refusal of a `MintNotifyPayload` (deadline, bad payload, …) refunds the jetton
  with `NOTIFY_FWD_TON` (the notification is the payer's signal; there is no receipt).

| Constant | Value | Covers |
|---|---|---|
| `OBSERVE_VALUE` | 0.03 | Pool compute 32.5k gas (0.013) + reply forward fee, × 1.5 |
| `NOTIFY_FWD_TON` | 0.01 | the recipient's processing of a notified payout |
| `RECEIPT_VALUE` | 0.01 | `MintReceipt` |
| `RECEIPT_FLOOR` | 0.008 | smallest `BurnReceipt` value |
| `DECREASE_NOTIFY_GAS` | 0.3 | `DECREASE_GAS` + 2 × `NOTIFY_FWD_TON` + the relay |
| `MINT_NOTIFY_GAS` | 0.05 | `RECEIPT_VALUE` + 2 × `NOTIFY_FWD_TON` + margin, on top of `MINT_GAS` |

The Pool burn need grows by `2 × NOTIFY_FWD_TON` on the notifying path; the mint need by
`RECEIPT_VALUE + legs × NOTIFY_FWD_TON`.

---

## 7. Hooks and extensions (TON-async adaptation of v4 hooks)

### 7.1 `KeyExt` (in `PoolKey.ext` as a cell; `null` = a plain pool)
| Field | Type | Validation (Router `validateExt`, inside `try`) |
|---|---|---|
| `hook` | Address? | basechain, ≠ Router. It must be non-null if any hook flag is set or `hookShareBps > 0` |
| `hookFlags` | uint8 | bit0 `AFTER_SWAP` (1), bit1 `AFTER_MODIFY` (2), bit2 `FEE_CONTROL` (4). Bits 3-7 must be 0; bit3 is reserved for the Phase-2 `BEFORE_SWAP_GATE` |
| `hookShareBps` | uint16 | ≤ 2000 |
| `hookFeeMin` / `hookFeeMax` | uint32 | `min ≤ max ≤ MAX_BASE_FEE_PIPS`; both 0 unless `FEE_CONTROL` |
| `initializer` | Address? | basechain |
| `launchFeePips` | uint32 | ≤ 200,000 |
| `launchDuration` | uint32 | `> 0` iff `launchFeePips > 0`; ≤ 3600 |
| `minLockSecs` | uint32 | ≤ 30 days |
| `taxRecipient` | Address? | basechain, ≠ Router; non-null iff a tax is set (§6.12) |
| `buyTaxBps` / `sellTaxBps` | uint16 | each ≤ 1000; taxed ⇒ `initializer` set and Gram pair |

**Canonical encoding.** The Router requires `KeyExt.fromCell(ext).toCell().hash() == ext.hash()`,
so one logical key maps to exactly one pool address. The ext also rejects trailing bits and
refs.

### 7.2 Hook capabilities
| Capability | Mechanism | Can it change a trade? |
|---|---|---|
| `AFTER_SWAP` | Pool → H `HookAfterSwap` (`bounce:false`, `HOOK_NOTIFY_VALUE` paid by the swapper) after commit | No |
| `AFTER_MODIFY` | Pool → H `HookAfterModify` after every mint and burn | No |
| `FEE_CONTROL` | H → Pool `HookSetFee` within the key-declared bounds; applies from the next swap | Only within the visible key bounds |
| hook fee share | `hookShareBps` of every swap fee accrues to `hookFees0/1`; H collects | Visible in the key and in quotes |

The hook's gas is fixed and paid up front. Because notifications are `bounce:false`, a hook that
throws or runs out of gas affects nothing (the TestHook with an odd salt proves it). A hook never
receives pool funds except its own collected fee share.

Phase 2: `BEFORE_SWAP_GATE` (Router → Hook → Pool, where the Pool accepts swaps of gated keys
only from the hook) and `BEFORE_MODIFY` gates. They are reserved in the flags and need explicit
UI opt-in, because the hook holds swap value in transit.

---

## 8. Messages (opcode prefix `0x4d48`)

All amounts are `Int as coins`, `queryId` is `uint64`, deadlines are `uint32`, ticks are
`int24`, `sqrtPriceX96` values are `uint160`, liquidity is `uint128`, fee growth is `uint256`.
Messages larger than 1023 bits are auto-split by Tact; off-chain code uses the generated `storeX`.
Only `GraduatePayload` must fit one cell.

### 8.1 Standard (copied into `messages.tact`)
- TEP-74, from v1: `JettonTransfer 0x0f8a7ea5`, `JettonTransferInternal 0x178d4519`,
  `JettonNotification 0x7362d09c`, `JettonExcesses 0xd53276db`.
- TEP-62: `NftTransfer 0x5fcc3d14 {queryId, newOwner: Address, responseDestination: Address?, customPayload: Cell?, forwardAmount: coins, forwardPayload: Slice as remaining}`,
  `OwnershipAssigned 0x05138d91 {queryId, prevOwner: Address, forwardPayload: Slice as remaining}`,
  `GetStaticData 0x2fcb26a2 {queryId}`,
  `ReportStaticData 0x8b771735 {queryId, index: uint256, collection: Address}`.

### 8.2 Forward payloads (inside `JettonNotification.forwardPayload`)
| Op | Name | Fields |
|---|---|---|
| 0x4d480001 | SwapPayload | otherToken: Address; tickSpacing: uint16; ext: Cell?; minOut: coins; sqrtPriceLimitX96: uint160 (0 = none); maxCrossings: uint8; allowPartial: Bool; deadline; receiver: Address?; refundTo: Address?; referral: Address?; refBps: uint16; fwdTon: coins; fwdPayload: Cell? |
| 0x4d480002 | MintPayload | otherToken: Address; tickSpacing: uint16; ext: Cell?; tickLower; tickUpper; gramAmount: coins (dual native mint); viaAccount: Bool; sqrtPriceInitX96: uint160; minLiquidity: uint128; owner: Address?; refundTo: Address?; deadline |
| 0x4d480003 | GraduatePayload (**one cell, 802 bits**) | gramAmount: coins; tickSpacing: uint16; launchFeePips: uint32; launchDuration: uint32; feeClaimer: Address; refundTo: Address; deadline: uint32 |
| 0x4d480005 | MintNotifyPayload (§6.14) | the MintPayload fields without viaAccount |
| 0x4d480004 | LaunchPayload (`shared.tact`, auto-split) | sqrtPriceX96: uint160; tickSpacing; launchFeePips; launchDuration; deadline; feeClaimer; refundTo; taxRecipient?; buyTaxBps: uint16; sellTaxBps: uint16; devBuy: coins; minDevOut: coins; devReceiver |

### 8.3 User / admin → Router
| Op | Name | Fields |
|---|---|---|
| 0x4d480011 | SwapNative | queryId; amount; otherToken; tickSpacing; ext: Cell?; minOut; sqrtPriceLimitX96; maxCrossings; allowPartial; deadline; receiver?; refundTo?; referral?; refBps; fwdTon; fwdPayload? |
| 0x4d480012 | MintNative | queryId; amount; otherToken; tickSpacing; ext: Cell?; tickLower; tickUpper; sqrtPriceInitX96; minLiquidity; owner?; refundTo?; deadline |
| 0x4d480013 | CollectProtocolFees | queryId; key: PoolKey |
| 0x4d480014 | SetProtocolShare | queryId; key: PoolKey; shareBps: uint16 |
| 0x4d480015 | SetCreationPaused | queryId; paused: Bool |
| 0x4d480016 | SetTreasury | queryId; treasury: Address |
| 0x4d480017 | TransferAdmin | queryId; newAdmin: Address (the current admin may cancel by transferring to itself) |
| 0x4d480018 | ClaimAdmin | queryId |
| 0x4d480019 | WithdrawRouterExcess | queryId |
| 0x4d48001a | AddFeePreset | queryId; tickSpacing: uint16 (1..16384); preset: FeePreset |
| 0x4d48001b | CollectTax | queryId; key: PoolKey (anyone) |
| 0x4d48001c | MintNativeNotify (§6.14) | the MintNative fields |

### 8.4 Router → Pool (`bounce:false` + StateInit, except the admin/collect ops: `bounce:true`, no StateInit)
| Op | Name | Fields |
|---|---|---|
| 0x4d480021 | PoolSwap | queryId; fromUser; zeroForOne: Bool; amountIn; minOut; sqrtPriceLimitX96; maxCrossings: uint8; allowPartial; deadline; receiver; refundTo; referral?; refBps; fwdTon; fwdPayload? |
| 0x4d480022 | PoolMint | queryId; fromUser; amount0; amount1; params: MintParams; viaAccount: Bool; allowInit: Bool; preset: FeePreset |
| 0x4d480023 | PoolGraduate | queryId; fromUser; amount0; amount1; feeClaimer; refundTo; deadline; allowInit; preset: FeePreset |
| 0x4d480024 | PoolSetProtocolShare | queryId; shareBps: uint16; excessTo |
| 0x4d480025 | PoolCollectProtocol | queryId; treasury; excessTo |
| 0x4d480026 | PoolLaunch | queryId; fromUser; amount1; sqrtPriceX96; feeClaimer; refundTo; deadline; devBuy; minDevOut; devReceiver; allowInit; preset |
| 0x4d480027 | PoolCollectTax | queryId; excessTo |
| 0x4d480028 | PoolMintNotify (§6.14) | queryId; fromUser; amount0; amount1; params: MintParams; allowInit; preset |

### 8.5 Pool → Router
| Op | Name | Fields |
|---|---|---|
| 0x4d480031 | PayTo | queryId; key: PoolKey (authenticates the pool); wallet: Address (∈ {token0, token1}, ≠ GRAM); amount; to; excessTo; fwdTon; fwdPayload?; reason: uint8 |

The Router does `require(sender() == contractAddress(initOf Pool(myAddress(), msg.key)))`. The
rest is v1 `PayTo`, including the FWD_DROPPED fallback.

### 8.6 Positions and MintAccount
| Op | Name | Direction | Fields |
|---|---|---|---|
| 0x4d480041 | PositionInit | Pool → Pos | queryId; owner; tickLower; tickUpper; liquidity; fgInside0; fgInside1; lockedUntil: uint32 |
| 0x4d480042 | PositionDecrease | owner → Pos | queryId; liquidityDelta: uint128; amount0Min; amount1Min; deadline; recipient: Address? |
| 0x4d480043 | PoolBurn | Pos → Pool | queryId; index: uint64; owner; recipient; tickLower; tickUpper; liquidity; liquidityDelta; fgLast0; fgLast1; amount0Min; amount1Min; deadline |
| 0x4d480044 | PositionSync | Pool → Pos | queryId; ok: Bool; code: uint16; liquidity; fgInside0; fgInside1 |
| 0x4d480045 | MintAccountDeposit | Pool → MA | queryId; amount0; amount1; params: MintParams; allowInit: Bool; preset: FeePreset (§15) |
| 0x4d480046 | CbMint | MA → Pool | queryId; user; amount0; amount1; params: MintParams; allowInit: Bool; preset: FeePreset (§15) |
| 0x4d480047 | CbMintRefund | MA → Pool | queryId; user; amount0; amount1 |
| 0x4d480048 | MintAccountRefund | user → MA | queryId |
| 0x4d480049 | PositionDecreaseNotify (§6.14) | owner → Pos | the PositionDecrease fields |
| 0x4d48004a | PoolBurnNotify | Pos → Pool | the PoolBurn fields |
| 0x4d48004b | PositionSyncNotify | Pool → Pos | the PositionSync fields; liquidityDelta; amount0; amount1; fees0; fees1 |

### 8.6a Observation and receipts (§6.14)
| Op | Name | Direction | Fields |
|---|---|---|---|
| 0x4d480081 | PoolObserve | anyone → Pool | queryId; tickLower; tickUpper; payload: Cell? |
| 0x4d480082 | PoolObservation | Pool → requester | queryId; initialized; sqrtPriceX96; tick; liquidity; tickCumulative: int64; time: uint32; tickLower; tickUpper; rangeOk; feeGrowthInside0X128; feeGrowthInside1X128; payload |
| 0x4d480083 | BurnReceipt | Pos → owner | queryId; index; ok; code; liquidityDelta; liquidity; amount0; amount1; fees0; fees1; fgInside0; fgInside1 |
| 0x4d480084 | MintReceipt | Pool → payer | queryId; ok; code; owner; index; tickLower; tickUpper; liquidity; amount0; amount1; refund0; refund1; fgInside0; fgInside1 |

### 8.7 Hooks, payouts, events
| Op | Name | Fields |
|---|---|---|
| 0x4d480051 | HookAfterSwap | queryId; fromUser; zeroForOne; amountIn (consumed + refFee); amountOut; sqrtPriceX96; tick; liquidity; feePips (last step) |
| 0x4d480052 | HookAfterModify | queryId; owner; index: uint64; tickLower; tickUpper; liquidityDelta: int129 (signed); amount0; amount1 |
| 0x4d480053 | HookSetFee | queryId; feePips: uint32 |
| 0x4d480054 | HookCollectFees | queryId |
| 0x4d480061 | GramPayout | queryId; reason: uint8; amount; payload: Cell? |
| 0x4d480071 | SwapEvent | fromUser; zeroForOne; amountIn; amountOut; refFee; feeTotal; protocolFee; hookFee; sqrtPriceX96; tick; liquidity; crossings: uint8; steps: uint8; stop: uint8 |
| 0x4d480072 | ModifyEvent | owner; index; tickLower; tickUpper; liquidityDelta: int129; amount0; amount1; fees0; fees1 |
| 0x4d480073 | RefundEvent | queryId; user; code: uint16 |
| 0x4d480074 | InitializeEvent | sqrtPriceX96; tick; initializer: Address?; graduation: Bool (also true for a direct launch) |
| 0x4d480075 | LaunchEvent | key: PoolKey; feeClaimer; tickLower; tickUpper; liquidity; amount1; devIn; devOut |

`SwapEvent` gains a final `tax: coins`. `amountIn` includes the buy tax, and `amountOut` is net of
the sell tax. `Quote` gains `tax`, and `PoolState` gains `taxFees`. `GramPayout.reason` 14 = TAX.

Test-only: `TestMint 0x4d4800e1`, `FakeSend 0x4d4800f1`, `HookCmd 0x4d4800f2 {target, value, bounce, body: Cell}`.

### 8.8 Structs
```
struct PoolKey   { token0: Address; token1: Address; tickSpacing: Int as uint16; ext: Cell? }
struct KeyExt    { hook: Address?; hookFlags: uint8; hookShareBps: uint16; hookFeeMin: uint32; hookFeeMax: uint32;
                   initializer: Address?; launchFeePips: uint32; launchDuration: uint32; minLockSecs: uint32 }   // 720 bits
struct FeePreset { baseFeePips: uint32; varFeeControl: uint32; filterPeriod: uint16; decayPeriod: uint16;
                   reductionBps: uint16; maxVolAcc: uint32 }
struct FeeState  { baseFeePips: uint32; A: uint32; filterPeriod: uint16; decayPeriod: uint16; reductionBps: uint16;
                   maxVolAcc: uint32; volAcc: uint32; volRef: uint32; idxRef: int32; lastTs: uint32;
                   startTs: uint32; protocolShareBps: uint16; hookFeeSet: Bool; hookFeePips: uint32 }
struct TickInfo  { liqGross: uint128; liqNet: int128; fgOut0: uint256; fgOut1: uint256 }   // 768 bits, one cell
struct MintParams{ tickLower: int24; tickUpper: int24; sqrtPriceInitX96: uint160; minLiquidity: uint128;
                   owner: Address; refundTo: Address; deadline: uint32 }
```

---

## 9. Getters (each calls the same pure function as the receiver)

**Pool**
- `get_pool_state(): PoolState`, which returns:
  - the key, `initialized`, `sqrtPriceX96`, `tick`, `liquidity`, `feeGrowth0/1`;
  - `reserve0/1`, `protocolFees0/1`, `hookFees0/1`;
  - `tickCount`, `nextPositionId`, `fs`;
  - `feePipsNow` (the first-step fee for a swap at `now()`).
- `get_quote(zeroForOne, amountIn, sqrtPriceLimitX96, maxCrossings, refBps, allowPartial): Quote`
  and `get_quote_at(…, atTime)`. `Quote` holds:
  - `{amountOut, consumed, refFee, refund, feeTotal, protocolFee, hookFee}`;
  - `{sqrtPriceAfter, tickAfter, crossings, steps, stop}`;
  - `code` (0, or the refund code execution would produce).

  This is §5.2 + `computeSwap` + the §6.1 outcome checks. It is exact for the same state and
  `atTime`.
- `get_mint_quote(tickLower, tickUpper, amount0, amount1, sqrtPriceInitX96): {liquidity, use0, use1, code}`.
- `get_position_amounts(tickLower, tickUpper, liquidity, fgLast0, fgLast1, liquidityDelta): {amount0, amount1, fees0, fees1}`.
- `get_tick(t): TickInfo?`, and `get_ticks(from, count ≤ 64, ascending): map<Int as int24, TickInfo>`
  (a dict walk, used by the SDK for off-chain routing and quoting).
- `get_observe(): {tickCumulative extrapolated to now(), now}`. TWAP = Δcumulative / Δt between
  two samples taken by the consumer.
- `get_position_address(index)`. TEP-62: `get_collection_data`, `get_nft_address_by_index`,
  `get_nft_content`.

**Router**
- `get_router_data(): {admin, pendingAdmin, treasury, creationPaused}`.
- `get_preset(tickSpacing): FeePreset?`.
- `get_pool_address(tokenA, tokenB, tickSpacing, ext: Cell?)`, which sorts the tokens.
- `get_graduation_pool_address(jettonWalletOfRouter, tickSpacing, initializer, launchFeePips, launchDuration)`.
- `get_mint_account_address(pool, user)`.
- `get_payload_fee(payload)` and `get_gram_token()`.

**Position**
- `get_position_data(): {pool, index, owner, tickLower, tickUpper, liquidity, fgLast0, fgLast1, lockedUntil, busy}`.
- `get_nft_data()`.

**MintAccount**
- `get_mint_account_data()`.

Getter cost: a 32-crossing quote is about 550k gas, which is within liteserver get-method limits.
The SDK calls `get_quote_at(now + 10 s)`, sets `minOut = quote.amountOut × (1 − slippage)` and
passes `sqrtPriceLimitX96` as a second guard.

---

## 10. Gas budget (estimates; `gas.spec` must measure and assert every constant ≥ 1.5× measured)

Basis: 400 nanoGram per gas unit, a 1M gas cap per transaction, cell create about 500 gas, cell
load about 100 gas. A dict set at depth about 10-12 costs about 6-7k gas. The Pool compute limit is
`min(value/gasPrice, 1M)`, so the attached value **is** the budget.

| Flow (Pool tx unless noted) | Estimate | Constant that pays |
|---|---|---|
| Fixed swap overhead (parse, refs, commit, event, 2-3 sends) | 40-60k | SWAP_BASE_GAS |
| One initialized-tick crossing (lookup 1.5k + parse 0.3k + sqrtAt 1.2k + step 1.5k + flip/write 7k + misc 0.5k) | about 12k | CROSS_GAS (0.008 = 20k) |
| One checkpoint or non-crossing step (no dict write) | about 3-5k | part of SWAP_BASE_GAS (64 × 5k = 320k ≈ 0.128) |
| Swap with 0-2 crossings | 60-85k (≈0.03 Gram) | |
| Swap with 8 crossings | about 160k | |
| Worst case: 32 crossings + 32 checkpoints | 60k + 384k + 160k ≈ 600k (< 1M) | 0.2 + 32 × 0.008 = 0.456 Gram → 1M gas limit |
| Router hop (parse, key build, initOf) | 15-25k | |
| Router → Pool StateInit forward fee (Pool about 20 KB, Position code included) | about 0.012 Gram | SWAP_BASE_GAS |
| Mint (2 tick writes, L math, Position deploy) | 50-70k | MINT_GAS |
| Decrease or collect: Position 5-8k, Pool about 50k (0 tick writes on a pure collect), Sync about 5k | | DECREASE_GAS / BURN_POOL_GAS |
| Graduation (init + full-range mint) | about 70k | GRADUATE_GAS |

`gas.spec` measures:
- 0/1/8/32 crossings over tick maps with 10 and 1000 entries;
- 64 checkpoint steps;
- every flow at exactly the minimum value.

If the 32-crossing worst case is above 650k gas, lower `MAX_CROSSINGS_CAP` to 24 and/or
`MAX_STEPS` to 48, and record the change in §15.

**Storage rent.**
- A tick is about 2 cells (≈ 0.0006 Gram/yr), covered by `TICK_RENT_BUFFER`.
- A Position is about 1-2 KB (≈ 0.002 Gram/yr), covered by `POSITION_DEPLOY_VALUE`.
- `MAX_TICKS_PER_POOL = 8192` keeps the Pool below about 20k cells, far from the 65,536 limit.
  This matters because exceeding the limit would fail the action phase on a `bounce:false` path.

---

## 11. Authentication, bounce and refund rules

### 11.1 Who may send what
| Receiver | Message | Check |
|---|---|---|
| Router | JettonNotification | none; `sender()` is the token id, basechain, ≠ Router |
| Router | PayTo | `sender() == Pool(myAddress(), msg.key)` address; `wallet ∈ {token0, token1}`, ≠ GRAM (`require`) |
| Router | admin ops | `admin` / `pendingAdmin` |
| Router | CollectProtocolFees | anyone (funds go only to `treasury`) |
| Pool | PoolSwap / PoolMint / PoolGraduate / PoolSetProtocolShare / PoolCollectProtocol | `sender() == router` |
| Pool | PoolBurn | `sender() == Position(myAddress(), msg.index)` |
| Pool | CbMint / CbMintRefund | `sender() == MintAccount(myAddress(), msg.user)` |
| Pool | HookSetFee / HookCollectFees | `sender() == key.ext.hook` (+ the `FEE_CONTROL` flag and bounds for `SetFee`) |
| Position | PositionInit | `sender() == pool && !initialized` |
| Position | PositionSync | `sender() == pool && busy && queryId == pendingQuery` |
| Position | PositionDecrease / NftTransfer | `sender() == owner` |
| MintAccount | MintAccountDeposit | `sender() == pool` |
| MintAccount | MintAccountRefund | `sender() == user` |

### 11.2 Bounce flags
| Hop | bounce | Why |
|---|---|---|
| U → R native entries, U → Pos, H → Pool | wallet default (true) | the receiver may `require`; the value comes back |
| R → P (Swap/Mint/Graduate) | **false** + StateInit | the Pool is total after authentication (v1 D6) |
| R → P (SetProtocolShare/CollectProtocol) | true, no StateInit | a missing pool bounces; the Router swallows it |
| P → R PayTo | false | the Router's PayTo is total |
| R → RW JettonTransfer | true | `bounced<JettonTransfer>` → event 214 (v1) |
| P → Pos PositionInit | false (deploy) | |
| Pos → P PoolBurn | **true** | a Pool throw (auth) or failed action bounces; the Position clears `busy` from its own state |
| P → Pos PositionSync | false | the Position handler is total for an authenticated Sync |
| P ⇄ MA | false | total handlers (v1) |
| P → H notifications | false | hook failures cannot affect the pool |
| any → user / referral / treasury / hook payouts | false | v1 |

Every contract has `bounced(msg: Slice) {}` as a catch-all.

### 11.3 What happens to assets when things go wrong
| Situation | Outcome |
|---|---|
| Bad payload, bad key, deadline, low gas ≥ ROUTER_REFUND_MIN (jetton in) | jettons back to sender/refundTo (v1 rules) |
| Notification value < ROUTER_REFUND_MIN | jettons stay unaccounted in the Router wallet (v1 §6.3; SDK prevents it) |
| Native entry invalid | throw; the bounce returns the Gram |
| Pool swap failure (not initialized, limit, zero out, slippage, partial not allowed, overflow, math) | full refund of `amountIn` to `refundTo` + leftover gas; no state written |
| Partial fill with `allowPartial` | output + refund of unused input + referral on the consumed part only |
| Mint failure (ticks, price, initializer, paused, below min, tick limit, overflow) | every leg refunded to `refundTo` |
| Graduation into an already-initialized key | full refund (both legs) to `refundTo` (the launchpad treasury) |
| PoolBurn failure (deadline, slippage, low gas) | `PositionSync{ok=false}`; the position is unchanged and unlocked; the gas returns to the owner |
| PoolBurn bounce | the Position clears `busy`; nothing changed in the Pool |
| MintAccount stuck with one leg | `MintAccountRefund`, or deposit the other leg |
| Hook throws | nothing (bounce:false); the trade is already committed |

---

## 12. Threats and mitigations

1. **Fake jetton notifications, forged pool or position messages.** These follow v1 §9.1:
   - a token is `sender()`;
   - every internal message is authenticated via `initOf` (§11.1);
   - `PayTo` re-derives the pool from the full `PoolKey`.

   Tests send every op from FakeJettonWallet, plus forged `PositionSync`, `PoolBurn`, `CbMint`
   and `HookSetFee`.
2. **Fee growth wraparound or TVM overflow on a custody path.**
   - All fee growth goes through `addMod`/`subMod`.
   - Every pure computation runs inside `try` on locals, and a throw becomes MATH_FAILURE.
   - Payouts are bounded by the tracked reserves.
   - Results are checked against `MAX_COINS` before any `coins` store.
3. **Rounding drain (wrong ceil/floor in the port).** Defences:
   - an independent BigInt model (`tests/model.ts`) with exact-equality tests against the
     MathHarness;
   - Uniswap reference vectors (`sqrtAt(0) = 2^96`, MIN/MAX ratios, ±1 ticks);
   - an invariant fuzz test: the sum of what every position can withdraw (principal + fees)
     never exceeds `reserve_i`, per token;
   - mint/burn and swap round trips are never profitable.
4. **Tick-spam griefing** (dust positions initializing many ticks so swaps hit the crossing cap).
   - Bounded by `tickSpacing`: even when every spacing is initialized, 24 crossings move the
     price about 15% at spacing 60, 2.4% at spacing 10 and 0.24% at spacing 1 per transaction
     (partial fill + continuation; the SDK must split).
   - A non-refundable `TICK_INIT_FEE` (0.1 Gram) plus the refundable `TICK_RENT_BUFFER` per new
     tick (§15.7), and `MIN_POSITION_LIQUIDITY`.
   - `MAX_TICKS_PER_POOL`, and partial fills with explicit refunds.
5. **Pool-cell-limit DoS.** `MAX_TICKS_PER_POOL` refuses the mint long before the account limit.
6. **JIT liquidity and sandwiches.** `MIN_LP_LOCK` (key-chosen), `minOut` plus
   `sqrtPriceLimitX96`, the deadline checked at the Pool, and the volatility fee, which makes
   sandwich legs more expensive.
7. **Volatility-fee manipulation.** An attacker who wash-trades to raise `va` pays the raised fee
   to LPs, and it is capped at 5%. Quotes take `atTime`; `minOut` bounds the outcome.
8. **Open-pool initialization at a bad price.** Anyone can initialize a non-initializer key. The
   wrong price is arbitraged, as in v3, and the UI shows the price before a mint. Canonical
   launch pools use the initializer gate (§6.8).
9. **Position lock bugs.** These are covered by:
   - the "exactly one Sync or a bounce" rule;
   - the `queryId` match;
   - NFT transfer being refused while `busy`;
   - tests for every Pool reply path (deadline, slippage, low gas, success, forged).
10. **Malicious or broken hook.** It can only:
    - raise fees within the key's visible `[hookFeeMin, hookFeeMax]`;
    - collect its visible share;
    - receive notifications.

    It cannot block swaps or withdrawals in the MVP (no gate). Graduation keys never have a hook.
11. **Out of gas on a `bounce:false` hop.** Every loop is bounded by deterministic counts, the
    Router enforces a value that covers those bounds, and `gas.spec` runs every flow at exactly
    the minimum.
12. **Router as recipient** (v1 §15.1). Refused for receiver, refundTo, referral, owner,
    feeClaimer and hook.
13. **Malicious jetton / lying `fromUser`.** The impact stays in that token's pools. The
    initializer gate trusts the jetton wallet's reported owner, which holds for launchpad tokens.
    The UI checks `master.get_wallet_address(router) == tokenId`.
14. **Quote drift.** `get_quote` is exact for the same state and `atTime`. Interleaved swaps are
    handled by `minOut` and the limit.
15. **TWAP manipulation.** A single accumulator gives TWAP only between consumer-stored samples;
    lenders must use windows ≥ 30 min. A ring buffer is Phase 2.
16. **Admin abuse.** §6.10; all caps are code constants checked in the Pool.
17. **Code immutability and audit surface** (about 3-4× v1). This needs an external review
    before any deployment (outside this team's mandate), small canary pools, and the invariant
    suite.
18. **Code size and forward fees.** About 0.012 Gram per Router→Pool hop for the StateInit.
    Accepted for the MVP; the fix is a masterchain library cell (Phase 2).

---

## 13. MVP scope for the build step

### 13.1 In the MVP (build order = milestones)
1. **M0, probes** (§1.1); record the results in §15.
2. **M1, math.** `math.tact`, `dict.tact`, `fees.tact` and the MathHarness, plus `tests/model.ts`
   (an independent BigInt port of v3 TickMath, SqrtPriceMath, SwapMath and LiquidityMath, mod
   math and the fee model). `math.spec` passes with exact equality before any pool code is
   written.
3. **M2, engine.** `engine.tact`: `computeSwap` (checkpoints, caps, stop reasons), `computeMint`,
   `computeBurn`, `feeGrowthInside`. Tested through the MathHarness against `model.ts` on random
   tick maps.
4. **M3, Router and Pool core:**
   - presets;
   - key validation;
   - swaps in all directions (Gram→J, J→Gram, J→J) with `maxCrossings`, `sqrtPriceLimitX96`,
     `allowPartial`, referral, protocol fee;
   - mints of types (a), (b) and (c);
   - `PayTo`;
   - protocol fee collection and admin;
   - all getters.
5. **M4, Position:** decrease and collect with busy/Sync/bounce, NFT transfer, TEP-62 getters,
   lock.
6. **M5, plugins and hooks:** VOLATILITY, LAUNCH_DECAY, MIN_LP_LOCK, ORACLE, AFTER_SWAP,
   AFTER_MODIFY, FEE_CONTROL, hook fee share and collection, TestHook.
7. **M6, graduation:** `GraduatePayload` (a hand-built cell equal to the generated one),
   initializer gate, full-range locked position with a fee claimer.
8. **M7, MintAccount:** jetton/jetton in-range mints (copy of v1 LpAccount).
9. **M8:** the full test suite (§14) and gas tuning.

### 13.2 Deferred (Phase 2), with notes on why or how
- Exact-out swaps.
- Multi-hop: a Pool-to-Pool `HopSwap` credit. The Router keeps jetton custody, and Gram moves
  with the message. A failed hop refunds in the intermediate token.
- Increasing an existing position (it races with in-flight decreases); mint a new one instead.
- Position close/destroy at L = 0. TEP-64 rich NFT metadata, TEP-66 royalties.
- `BEFORE_SWAP_GATE` and `BEFORE_MODIFY` hooks.
- An oracle ring buffer.
- Limit-order mode (single-tick range positions auto-withdrawn on cross).
- Dropping the StateInit from swap hops (needs a library cell or a bounce-safe design).
- A timelock on protocol-share increases.
- SDK features: order splitting, the Meteora-style shape builder (spot/curve/bid-ask as N range
  positions), routing over `get_ticks`.
- The Locker contract and the launchpad change itself (outside `dex/`).

---

## 14. Test plan (`dex/v2/tests`, sandbox only)

| Spec | Covers |
|---|---|
| `helpers.ts` | v1 fixture adapted: Router, 3 TestJettons, users, fixed chain time, key builders, payload builders, trace parsers (GramPayout, PayTo, RefundEvent, SwapEvent, ModifyEvent, PositionSync), `checkSolvency` per token, `positionsValue` |
| `model.ts` | independent BigInt reference (v3 math, mod-256, fees, computeSwap with checkpoints, mint/burn) |
| `math.spec` | tick↔price at MIN/MAX/0/±1/random; rounding directions; `nextSqrtFromAmount0Up` overflow branch; addMod/subMod edges; `sqrtFromAmounts` |
| `swap.spec` | 3 directions; quote == execution == model; 0/1/8/32 crossings; empty-range jumps; checkpoints; price limit; maxCrossings and MAX_STEPS stops; partial vs full refund; minOut, deadline (Router and Pool side), low gas at exactly the minimum and minimum − 1; referral on a partial fill; NO_LIQUIDITY; not initialized |
| `position.spec` | mint in/below/above range (all entry types); fee accrual across crossings; decrease partial/full; collect only; busy race (two decreases); forged/stale Sync; bounce path; NFT transfer then decrease by the new owner; transfer refused while busy; MIN_LP_LOCK; MintAccount legs, refund, overflow |
| `fees.spec` | volatility growth within one swap, filter/decay periods over time, maxVolAcc, 5% cap, launch decay curve, protocol share change within/above cap |
| `hooks.spec` | AFTER_SWAP/AFTER_MODIFY payloads; throwing hook does not affect swaps; HookSetFee bounds and next-swap effect; hook share accrual and collect; non-hook sender rejected; invalid ext (flags without hook, caps, non-canonical cell) refunded BAD_KEY |
| `graduation.spec` | one-cell payload; price from the ratio; full-range locked position; fee claims by feeClaimer; decrease refused (LOCKED); squatter cannot initialize; deployed-but-uninitialized pool does not block; already initialized → full refund; paused |
| `admin.spec` | presets add-only; 2-step admin; treasury; pause blocks init only (existing pools keep trading/minting/withdrawing); WithdrawRouterExcess cannot touch pool funds; anyone may trigger protocol collect |
| `security.spec` | v1 forged-message matrix applied to all new ops; fake Position/Pool/MintAccount senders; Router as recipient; 2^119 overflow paths; tick spam to MAX_TICKS_PER_POOL; dust-tick griefing bounded by caps |
| `getters.spec` | every getter vs model; TEP-62 collection/item getters; `get_ticks` walk |
| `invariant.spec` | 200 seeded random swap/mint/decrease/collect/transfer ops over 3 pools (one with every plugin); after each op: per-token solvency (Router wallet ≥ Σ reserves + fees + MintAccount pending; native pool balance ≥ keep()); Σ position values ≤ reserves; L == Σ in-range position L; fee growth monotone (mod-aware); tick/liqNet consistency |
| `gas.spec` | printed table; per-crossing and per-step cost on maps of 10 and 1000 ticks; worst case below 650k; every constant ≥ 1.5× measured |

---

## 15. Build log (first build, 2026-11-12)

Status:
- `npx tact --config dex/v2/tact.config.json` compiles all five projects with no errors or warnings.
- `npx jest dex/v2/tests` passes 19/19 (`math.spec` 4, `smoke.spec` 15).

Code sizes: Router 38.0 KB, Pool 29.7 KB, Position 1.6 KB, MintAccount 1.4 KB.

### 15.1 Probe results (M0)
Each probe ran in a throwaway `dex/v2/scratch/` contract, deleted afterwards. All six passed, so
no fallback was needed.

| # | Result |
|---|---|
| P0.1 | **Pass.** The Fift mnemonics are `DICTIGETNEXT` / `DICTIGETPREVEQ` (not `IDICT…`). The body `{ DICTIGETNEXT NULLSWAPIFNOT2 DROP NIP }` works with the natural argument order `(pivot, map, 24)` on a Tact `map<Int as int24, TickInfo>`. It handles negative keys, both ends (`-887220`, `887220`) and the empty map (returns null). No bitmap is needed. |
| P0.2 | **Pass.** `asm MULDIV / MULDIVC / MULRSHIFT` use 513-bit intermediates: `mulDiv(2^255, 2^255-1, 2^255) = 2^255-1`. A result of 2^256 throws code 4, as expected. |
| P0.3 | **Pass.** A struct with a `map` field can be returned from a global `fun` and assigned back to `self.ticks`. |
| P0.4 | **Pass.** `init(router, key: PoolKey)` with `ext: Cell?` gives the same address from `contractAddress(initOf …)`, from the TS `fromInit` and from `myAddress()`. |
| P0.5 | **Pass.** `|` and `>>` on negative Ints are two's complement and arithmetic shift. |
| P0.6 | **Pass.** `try { mulDiv overflow } catch (e)` catches exit code 4. |

### 15.2 Measured gas
Measured as the Pool compute phase in the sandbox (`smoke.spec`).

| Flow | Gas |
|---|---|
| Mint: initialize the pool, 2 new ticks, Position deploy | 104,360 |
| Mint: 2 new ticks, Position deploy | 99,382 |
| Swap Gram→jetton, 0 crossings (1 step + `tickAt`) | 95,811 |
| Swap jetton→Gram, 0 crossings | 101,296 |
| Swap with 4 crossings / 6 steps | 172,464 |
| Swap with 8 crossings / 10 steps | 234,040 |
| Swaps with 1 / 2 / 4 / 8 / 16 / 24 crossings over adjacent ticks (27-tick map) | 102,043 / 119,785 / 155,269 / 226,412 / 369,273 / 511,949 |
| **Per crossing, including its step** | **≈ 17.8k** (spec estimate: 12k) |
| 48 checkpoint-only steps (full-range position, stop STEPS) | 573,600, so **≈ 10.1k per non-crossing step** (spec estimate: 3-5k) |
| **Worst case: 24 crossings + 24 checkpoints on a 308-tick map** | **758,274** |
| Decrease, 0 ticks deleted / 2 ticks deleted | 86,587 / 87,362 |
| Collect only | 67,481 |

Cost of the math primitives, measured as getter gas minus about 1.4k of getter overhead:

| Primitive | Gas |
|---|---|
| `sqrtAt` | 2.8-3.8k (about 2.8k of that is the 19 bit tests) |
| `tickAt` | about 8.4k (once per swap) |
| `swapStep` | about 3k |
| `variableFee` | about 0.3k |

Other observations:
- Moving the fee-state fields out of the step loop (`feeFor` takes hoisted scalars) cut the step
  cost from 11.6k to 10.1k and the crossing cost from 19.3k to 17.8k. The formula is unchanged
  and the getters use the same function.
- The crossing cost barely grows from a 27-tick map to a 308-tick map.
- The sandbox config prices gas at about 66.7 nanoGram. The constants still assume 400
  nanoGram/gas, which is conservative.
- At sandbox prices the Router→Pool StateInit forward fee is about 0.0116 Gram, because the Pool
  code is 29.7 KB.

### 15.3 Deviations from this spec, and why
1. **`MAX_CROSSINGS_CAP` 32 → 24 and `MAX_STEPS` 64 → 48** (the §10 fallback).
   - Measured before the change: 32 crossings cost 701k gas and 64 steps cost 830k. Projected,
     32 crossings + 32 checkpoints would be above 1M gas.
   - Measured at the new bounds: the worst case is 758k gas.
2. **`SWAP_BASE_GAS` 0.2 → 0.35 and `CROSS_GAS` 0.008 → 0.006.** At 400 nanoGram/gas:
   - 48 steps with `maxCrossings = 1` costs 0.229 Gram against a requirement of 0.356 (1.55×);
   - the worst case costs 0.303 Gram against 0.494 (1.63×).

   Both satisfy the "≥ 1.5× measured" rule.
3. **`MintAccountDeposit` and `CbMint` carry `allowInit` and `preset`.** The second leg reaches the
   Pool from the MintAccount, with no Router context, so without them a jetton/jetton via-account
   mint could not initialize the pool. The first leg's values win.
4. **New refund code 232 `BAD_CROSSINGS`.** The Pool re-checks `1 ≤ maxCrossings ≤ cap`, and the
   quote reports the same code.
5. **New constant `MINT_POOL_GAS` (0.08).** It is part of the Pool's mint `LOW_GAS` check.
   **`BURN_POOL_GAS` (0.2) is now the total requirement for a `PoolBurn`**, plus
   `HOOK_NOTIFY_VALUE` for AFTER_MODIFY. It is no longer "+0.07 per jetton leg", because
   `DECREASE_GAS` 0.25 could not cover 0.2 + 0.07. There is at most one non-final jetton leg.
6. **`HookSetFee` requires an initialized pool.** Initialization rebuilds `fs` from the preset and
   would silently drop an earlier hook fee. Similarly, `PoolSetProtocolShare` on an uninitialized
   pool is overwritten by `DEFAULT_PROTOCOL_SHARE_BPS` at initialization (known gap, harmless).
7. **The Pool's `keep()` reserve always uses `ReserveAtMost`.** When balance ≥ keep this is the same
   as `ReserveExact`, and under rent debt it never fails the action phase (§2.2).
8. **A swap into a book that has been empty from the start refunds 223 `NO_LIQUIDITY`** rather than
   208 `ZERO_OUT`.
9. **`computeMint` also caps L at `MAX_U128`** before the fit loop (at most 3 shaves).
10. **Additions:**
    - `Quote.liquidityAfter`;
    - Router getter `get_ext_valid(ext)`, which returns the hook flags or −1;
    - `Position.get_nft_data().content` is a cell `(int24 tickLower, int24 tickUpper)`.
11. **The graduation key's `ext` is always a cell** (the initializer is set), even when
    `launchFeePips = 0`. `get_graduation_pool_address` builds the same cell.

### 15.4 Final constants (differences from §3 only)
| Constant | Value |
|---|---|
| `MAX_CROSSINGS_CAP` | 24 |
| `MAX_STEPS` | 48 |
| `SWAP_BASE_GAS` | 0.35 |
| `CROSS_GAS` | 0.006 |
| `MINT_POOL_GAS` | 0.08 (new) |

Every other value is as in §3.

### 15.5 Known gaps (next steps)
**Test suites.** Only `math.spec` (harness == BigInt model, plus a high-precision tick→price
reference) and `smoke.spec` exist.
- `smoke.spec` covers:
  - mint entries (a), (b), (c) and (d);
  - swaps in all three directions, including multi-crossing swaps, checked as quote == execution
    == model;
  - partial and full refunds;
  - decrease, full exit and collect;
  - graduation (one cell, lock, squat refund, fee claim);
  - hooks (notifications, fee share, `HookSetFee` bounds, `HookCollectFees`, a throwing hook,
    an invalid ext);
  - MintAccount;
  - protocol fee collection;
  - gas.
- Not yet written: the swap / position / fees / hooks / graduation / admin / security / getters
  / invariant suites of §14. That leaves untested:
  - the forged-message matrix;
  - "exactly the minimum value" runs for mint, decrease and graduation;
  - burn deadline and slippage replies;
  - the busy race and bounce path;
  - NFT transfer;
  - MIN_LP_LOCK;
  - MintAccount refund and overflow;
  - the admin ops (they are a copy of v1);
  - a tick map of 8,192 entries (only 308 measured).

**Gas headroom ideas,** which could restore the 32/64 bounds:
- an asm `sqrtAt` (most of its cost is bit-test overhead, not multiplication);
- caching `sqrtAt(tick)` in `TickInfo` (928 bits still fit in one cell; saves about 3k per
  crossing);
- a cheaper `tickAt`.

**Code size.** Pool code is 29.7 KB, so every Router→Pool hop carries about 0.012 Gram of
StateInit forward fees. The fix is a library cell (§13.2).

### 15.6 Test phase (2026-11-12): suites, fixes, observations
New suites in `tests/`: `invariant` (300 seeded ops over 3 pools; the whole pool state, every
tick, every position and a per-party jetton ledger equal the BigInt model after every op; Router
wallets hold exactly what pools owe; everyone exits to dust), `swap`, `position`, `fees`, `hooks`,
`graduation`, `admin`, `security`, `ticklimit` (8192 ticks injected into a real Pool's storage).
`model.ts` gained an independent `PoolSim` (mint, burn, fee growth inside, referral split, outcome
codes). `helpers.ts` gained model comparison, forged-message and step-by-step (`sendMessageIter`)
utilities.

Fixes:
1. **Burn payout to the Router** (`pool.tact`, PoolBurn). `PositionDecrease.recipient == Router`
   stranded the payout in the Router (Gram leg exit 130 there, sweepable by the admin through
   `WithdrawRouterExcess`; jettons unattributed in the Router wallet). Now `Sync{ok=false, 215}`.
2. **"Locked forever" expired in 2106** (`position.tact`). The lock check was `now() >= lockedUntil`
   with `LOCKED_FOREVER = 0xFFFFFFFF`, so a graduation position unlocked at now = 2^32 − 1. The
   sentinel now never opens.
3. **Volatility reference at initialization** (`pool.tact`, doMint). `fs.idxRef` stayed 0, so any
   pool initialized away from tick 0 (every graduation, e.g. tick ≈ 82,944) started with
   va = maxVolAcc: the first swaps within `filterPeriod` paid the maximum variable fee (+19,845 pips
   at spacing 60, +29,400 at 200) and stored volAcc = maxVolAcc, decaying only over `decayPeriod`.
   Now `idxRef = idx(initial tick)` (Meteora: the active bin).

Measured: worst case (24 crossings + 24 checkpoints) on a full 8,192-tick map is 771,774 gas; the
8,192-tick account is ≈ 26k cells counted without deduplication (< 65,536).

Observations (not changed):
- A non-final Gram leg (referral fee, partial refund) of dust size carries `value = amount` only,
  so the recipient wallet's compute phase runs out of gas (−14). It is non-bounceable, so the Gram
  is still credited.
- `reserveKeep()` uses `nativeReserve(keep(), ReserveAtMost)` without subtracting `ctx.value`
  (§2.2 asked for `min(keep, balance − value)`): under rent debt the incoming message value covers
  the debt (pool stays whole, the user's excess shrinks). Only reachable after the storage buffers
  are exhausted.
- `CollectProtocolFees` on a native pool with Gram fees: the caller's leftover gas rides with the
  final Gram leg to the treasury (the caller gets no excess back).
- `MintAccount` overflow (pending > 2^120 − 1) is unreachable with TEP-74 wallets (their balance
  is itself `coins`), and `PRICE_OUT_OF_RANGE` at graduation is unreachable with `coins` amounts.

### 15.7 External review (2026-11-12): verdicts and fixes
Nine findings. Regression tests are in `tests/review.spec.ts` (12 tests); the suite is 114/114
across 12 files.

| # | Sev. | Finding | Verdict | Change |
|---|---|---|---|---|
| 1 | high | PoolBurn action-phase failure (non-std recipient, or rent debt eating the reply budget) leaves the Position busy forever | **Real, fixed** (one extreme residual, below) | `isBasechain` is now a non-throwing std-workchain-0 check. Position requires a std recipient (`PositionDecrease`) and new owner (`NftTransfer`); the Pool refuses a non-std recipient with `Sync{ok=false, 215}`; the Router validates every payload/native address. PoolBurn computes `spare = myBalance() − keep()` (rent and rent debt are already gone) and answers `LOW_GAS` unless `spare ≥ BURN_POOL_GAS (+hook)`; the failure reply reserves `min(keep, myBalance − value)` and sends the remaining balance; all PoolBurn sends (and every `sendToken`) carry `SendBounceIfActionFail` (+16). |
| 2 | med | `MAX_TICKS_PER_POOL` filled with dust positions | **Real, mitigated** | New ticks pay a non-refundable `TICK_INIT_FEE` = 0.1 Gram, kept forever in the pool as `endowment` (part of `keep()`; nobody can withdraw it; it pre-pays storage). Filling 8,192 slots now burns ≥ 819 Gram on top of gas (was ≈ 233 Gram non-recoverable). `MINT_GAS` 0.4 → 0.6, `GRADUATE_GAS` 0.4 → 0.5. A full fix (ticks sharded into separate TickArray contracts, no global cap) is Phase 2. |
| 3 | low | Non-std `otherToken` makes the Router throw on a non-bounceable notification | **Real, fixed** | Non-throwing `isBasechain`; refunds `BAD_TOKEN` / `BAD_RECIPIENT`; native entries `require` the same. |
| 4 | low | Parked MintAccount leg bypasses `SetCreationPaused` | **Real, fixed** | `CbMint.allowInit = stored && completing leg`. |
| 5 | low | Anyone can emit `InitializeEvent{graduation: true}` | **Real, by design; documented** | The event carries `initializer`; a pool is a canonical launch pool only if `initializer` is the known launchpad master (§6.8). A whitelist would add an admin power. |
| 6 | med | Stored `volAcc` ignores the last step | **Real, fixed** | `fs.volAcc` from the final tick (engine and `model.ts`). Six boundary-aligned swaps now pay 3000 → 3981 pips (was 3000 forever). Within one checkpoint step the fee is still the step-start va (by design: ≤ 8 spacings at one rate). |
| 7 | med | Crossing / step caps throttle swaps (spacing 1/10 worst) | **Real, partly fixed** | Checkpoints are skipped while va is pinned and moving away from `idxRef` (identical fee, fewer steps): a spacing-1 swap is no longer cut at 48 × 8 ticks (100 Gram into a 1000/1000 full-range pool now fills in < 10 steps and ends below tick −1,500). Dust-tick throttling remains bounded only by cost (`TICK_INIT_FEE`) and per-tx movement (above); SDKs must use `allowPartial` and split. §12.4 numbers corrected for 24/48. |
| 8 | med | Mint slippage only via `minLiquidity` | **Real, fixed** | `MintParams`, `MintPayload`, `MintNative` gain `sqrtPriceMinX96` / `sqrtPriceMaxX96` (0 = none); `doMint` refunds `SLIPPAGE` outside the band (also guards the MintAccount second leg). |
| 9 | low | JIT liquidity takes the launch-decay fee | **Real, fixed** | Any mint into a key with `launchFeePips > 0` during the launch window gets `lockedUntil ≥ startTs + launchDuration` (collect stays allowed). Plain keys keep no default lock (documented). |

Residual for finding 1 (deferred): if a bounceable PoolBurn arrives at a pool whose rent debt
exceeds the attached value, no compute runs and no bounce can be paid. In the sandbox an idle
jetton/jetton pool answers `LOW_GAS` at 3 and 10 years of rent and withdraws with 3 Gram attached;
on mainnet an account freezes once its debt passes `freeze_due_limit`, and messages to a frozen
account bounce, so the window is narrow. A Position-side recovery would need a Pool-side record of
processed ops (per-position nonce + result), which is a storage/design change left for Phase 2.

Other changes:
- `PoolState.endowment` getter field; `keep()` includes it.
- Tests: helper default mint gas 0.5 → 0.7, graduation 0.5 → 0.6. `patchMaxVolAcc` (test-only
  storage patch) reproduces an admin preset whose `maxVolAcc` never pins, so the 48-step and
  24 + 24 worst-case tests still measure the theoretical bound.
- Measured after the changes: worst case on 8,192 ticks 783,838 gas (was 771,774), 24 + 24 on 308
  ticks 770,338, decrease (Pool) 98.8k (was 86.6k: spare check, address check, endowment cell).
- Rent on a Position: the graduation test now tops the NFT up before jumping 80 years; without it
  the 0.02 Gram buffer would let the Position freeze. See README "remaining gaps".

### 15.8 Direct launch and TAX plugin (2026-11-12)
Built §6.11 (direct launch, used by the new `launch/` project), §6.12 (TAX) and §6.13 (FoT
policy). The definitions of `PoolKey` and `KeyExt` moved to `shared.tact` (no layout change).

| Item | Detail |
|---|---|
| Tests | `npx jest dex/v2/tests` is now 134/134 across 15 suites: `launch` 10, `tax` 8 and `fot` 2 are new. `invariant` now taxes P2 (buy 3%, sell 5%; tax collection is part of the protocol-collect op and of the exit), and it passes with the same dust bound. |
| New constants | `TAX_MAX_BPS` 1000, `TAXED_FLAG` 256, `LAUNCH_GAS` 0.5, `DEV_BUY_GAS` 0.15, `DEV_BUY_POOL_GAS` 0.05, `REASON_TAX` 14, `OP_LAUNCH_PAYLOAD`. |
| Measured (Pool compute) | launch 106,688; launch + dev buy 205,572; taxed launch + dev buy 205,729; TAX overhead per swap +346 (buy) / +378 (sell). |
| Router minimum | The forwarded minimum is 0.5004 Gram (0.6504 with a dev buy). At exactly that value the launch succeeds with no failed transaction. |
| Code size | Router 49.3 KB (was 40.2), Pool 39.3 KB (was 31.6). |
| Unchanged | A 0-tax key behaves exactly like a plain key (the earlier 114 tests pass unchanged, apart from the new KeyExt fields in the test helpers). |
| Deviation | §6.11 asks for "the master transfers to the Router". The launchpad mints straight into RW with `from = master` instead: the notification is identical and one hop is saved. |

### 15.9 Observation, notifying ops and the 90% launch fee (2026-11-12)
Built §6.14 for the vaults project (vaults/DESIGN.md §13 proposal, approved), and raised the
LAUNCH_DECAY cap for strong, short anti-snipe fees. Strictly additive: no existing message, storage
layout or behaviour changed, apart from the launch-fee cap (an intended change).

| Item | Detail |
|---|---|
| New messages | `PoolObserve`/`PoolObservation`, `PositionDecreaseNotify`/`PoolBurnNotify`/`PositionSyncNotify`/`BurnReceipt`, `MintNotifyPayload`/`MintNativeNotify`/`PoolMintNotify`/`MintReceipt` (§8). `shared.tact` is untouched. |
| Refactors (same behaviour) | Pool: `PoolBurn` body moved to `burnCore(msg, notify)`; `payTwo` takes a `fwdTon` (0 for every old caller); `doMint` takes `notify`. Router: `MintNative` body moved to `mintNative(msg, notify)`; `mintJetton` and `refundJetton` take `notify` / `fwdTon` (0 for old callers). Position: decrease body moved to `startBurn`. No storage field added anywhere (the test helper that patches Pool storage still works). |
| Launch fee | `MAX_LAUNCH_FEE_PIPS` 200,000 → **900,000** (90%); `launchDuration` cap unchanged (≤ 3600 s). `feeFor` = min(base + variable, 5%) + launch ≤ 950,000 pips, so `PIPS − fee ≥ 50,000` in `swapStep`: the fee can never reach 100% of the input, and `mulDivC(amountIn, fee, PIPS − fee)` stays bounded (≤ 19 × amountIn). Every fee field that carries pips (`HookAfterSwap.feePips`, `lastFee`) is uint32. The protocol / hook shares are taken from the whole step fee, so the split stays exact. The dev buy in the launch transaction keeps `launchFeePips = 0`. Three old cap-boundary cases changed from 200,001 to 900,001 (`hooks.spec`, `launch.spec`, `graduation.spec`), and the "max valid" key in `hooks.spec` from 200,000 to 900,000. |
| Measured | `PoolObserve` 32,461 gas (pool with 80 ticks) + 0.0002 reply forward fee; `PoolBurnNotify` 104,364; `PositionSyncNotify` relay 10,948; `PoolMintNotify` with 2 new ticks 111,066. |
| Code size | Pool 43.0 KB (was 39.3), Router 53.9 KB (was 49.3), Position 2.3 KB (was 1.6). Every Router → Pool hop carries ≈ 0.0015 Gram more StateInit forward fee. |
| Tests | `notify.spec` (19): model/getter equality of observations over random swaps and time, uninitialized ticks and invalid ranges, uninitialized pool, min-value bounce and pure read, observe gas; burn receipts == model burn (decrease, collect), notified jetton leg, ordering (receipt in the transaction that frees the Position), Pool refusals, bounce path, min value, forged sync, rent-starved Position; mint receipts == model mint (dual, native), notified refunds, Pool and Router refusals, receipts only to the payer. `launchfee.spec` (5): the cap, 90%/15 s decay second by second (getter == model == executed fee), a buy at t0 pays 91–92% with the exact protocol split, normal fee after 15 s, dev buy exempt, ≤ 95% total. |
| Open risks | A notifying op's result can still be lost if a Position is frozen by rent (an op then bounces, which the owner sees as a bounce of its own `PositionDecreaseNotify`); a dropped forward (`CODE_FWD_DROPPED`, only below the documented values) makes a notified payout silent. |

### 15.8 Second review (pre-redeploy, 2026-11-13): fixes

Regression tests in `tests/review.spec.ts` (issue 1-2) and `launch.spec.ts` / `graduation.spec.ts`
(issue 3).

| # | Sev. | Finding | Change |
|---|---|---|---|
| 1 | med | Spare Gram above `keep()` in a pool paid to whoever calls a collect op first | Pool `receive()` adds plain Gram to `endowment` (in `keep()`). `PoolCollectTax`, `PoolCollectProtocol`, `HookCollectFees`, `PoolSetProtocolShare`, `HookSetFee` reserve `max(keep(), balance − value − collectedGram)` (`reserveForCaller`): the caller gets only its value plus what the op pays out, minus gas. |
| 2 | med-low | Forged first MintAccount leg (JettonNotification.sender = victim, via an admin-mintable jetton) hijacks the victim's second leg | `MintAccount` pairs only legs with identical `MintParams` (cell hash). On mismatch it clears and sends `CbMintReject` (new internal op 0x4d48004c, MA → Pool): the parked leg goes to its `refundTo`, the arriving leg to its own; `RefundEvent` code `MINT_MISMATCH` = 234. Clients must send both legs with the same params (the web app does). |
| 3 | low-med | `SetCreationPaused` stranded launches (refund to the launch master) | Router `launch()` and `graduate()` send `allowInit = true`; ordinary new pools are still blocked. |

