# Marg DEX v2: concentrated-liquidity AMM on TON

Marg DEX v2 is a concentrated-liquidity AMM in the class of Uniswap v4 and Meteora DLMM, built for
TON. TON messages are asynchronous, gas per transaction is capped, accounts pay storage rent and
jettons live in per-owner wallets. The native coin is **Gram**.

This is a sandbox build. Nothing here has been deployed, and the code needs an external audit
before mainnet (see [Remaining gaps](#remaining-gaps-before-mainnet)). `DESIGN.md` is the full
spec. Its §15 records what was built, what was measured, every deviation from the spec and every
review fix.

## What was built

| Contract | Role |
|---|---|
| `Router` (`contracts/router.tact`) | The single entry point. It holds every jetton (one Router wallet per jetton is that token's id). It validates keys, gas, deadlines and addresses, deploys `Pool(router, key)` on first use, and moves jettons only when an authenticated Pool sends `PayTo`. Admin powers are capped. |
| `Pool` (`contracts/pool.tact`) | One per `PoolKey`. It runs a Uniswap-v3 tick engine with a Meteora volatility fee. Native pools hold their Gram directly (no wrapped TON). It tracks reserves, protocol and hook fees and a TWAP accumulator, and it is the TEP-62 collection for its positions. |
| `Position` (`contracts/position.tact`) | One TEP-62 NFT per mint. It is the authoritative record of the position's liquidity and fee checkpoint, with one operation in flight at a time. |
| `MintAccount` (`contracts/mint_account.tact`) | Holds the first leg of an in-range jetton/jetton mint until the second leg arrives (a copy of v1's LpAccount). Both legs must carry identical params, otherwise each is refunded to its own `refundTo`. |
| `shared.tact` | `PoolKey`, `KeyExt` and `LaunchPayload`, with no imports. `launch/contracts/dex_shared.tact` is a verbatim copy, and a test checks they match. |
| `engine.tact`, `math.tact`, `fees.tact`, `dict.tact` | Pure functions: v3 TickMath, SqrtPriceMath, SwapMath and LiquidityMath, mod-2^256 fee growth, the swap loop, mint, burn and fees. Receivers and getters call the same code, so a quote equals execution for the same state and time. |
| `mocks/` | Test-only contracts: test jetton, fake wallet, fee-on-transfer jetton (`fot_jetton.tact`), `TestHook`, `MathHarness`. |

Supported flows:
- **Swaps.** Exact-in, in three directions: Gram→jetton, jetton→Gram and jetton→jetton. A swap
  takes `minOut`, `sqrtPriceLimitX96`, `maxCrossings`, `allowPartial` (partial fill plus refund),
  a deadline that the Router and the Pool both check, a referral fee and a forward payload.
- **Mints.** Four entries:
  - Gram only;
  - jetton only;
  - Gram + jetton in one jetton transfer;
  - jetton/jetton through a `MintAccount`.

  A mint can initialize a pool, and it takes `minLiquidity` and a price band.
- **Positions.** Decrease, collect fees, and transfer the NFT. A minimum LP lock is available per
  key.
- **Direct launch** (no bonding curve; see [Direct launch](#direct-launch-no-curve)). One jetton
  transfer from a launch master creates the canonical Gram/jetton pool:
  - it starts at a given price and has no Gram leg;
  - the whole deposit becomes one jetton-only position, locked forever, whose fees stay claimable;
  - an optional dev buy runs inside the same Pool transaction.
- **TAX plugin.** A key can carry a buy tax and a sell tax for Gram pools, each up to 10%, paid to a
  recipient fixed in the key (see [Tax tokens](#tax-tokens-tax-plugin)).
- **Graduation.** One jetton transfer from the launch master seeds a full-range Gram/jetton pool
  at the launch price. The position is locked forever, but its fees stay claimable and the NFT can
  be transferred. A squatter cannot pre-initialize the pool.
- **Hooks and plugins.** Each key fixes these at creation:
  - after-swap and after-modify notifications;
  - a hook-set fee within bounds that the key declares;
  - a hook fee share;
  - a launch-decay anti-snipe fee;
  - a minimum LP lock;
  - a TWAP accumulator.
- **Protocol fee.** Paid to the treasury only, and anyone can trigger the collection.
- **Observation and notifying ops** (additive; see [Contracts on plain pools](#contracts-on-plain-pools-observation-and-receipts)).
  Any contract can read a pool's price, TWAP accumulator and fee growth (`PoolObserve`), and get a
  receipt plus notified jetton payouts for its own mints and decreases. This is what lets the
  Marg vaults run on the canonical plain Gram/USDT pool.

## Architecture compared with Meteora DLMM and Uniswap v4

The design is called "Tick-CL+" (DESIGN §0). Ticks beat bins on TON because of gas:
- A tick engine pays per *position boundary* crossed: about 18k gas per crossing.
- Bins pay per *price increment*, about one dict write per bin. Under the 1M-gas transaction cap,
  that would limit both trade size and position width.

### What matches

| Feature | Source | Here |
|---|---|---|
| Concentrated liquidity with arbitrary ranges, Q64.96 √price, `liquidityNet`, `feeGrowthOutside`, mod-2^256 fee growth | Uniswap v3/v4 | `math.tact` and `engine.tact`, an exact port. An independent BigInt model checks every result for equality. |
| Keyed pools (several pools per pair), with plugins and hook chosen per key and immutable | Uniswap v4 `PoolKey` | `PoolKey{token0, token1, tickSpacing, ext}`. The `KeyExt` cell must be canonical, so one logical key maps to one address. |
| Volatility fee: `va`, `volRef`, `idxRef`, filter and decay periods, `maxVolAcc`, `A·(va·s)²` | Meteora DLMM | `fees.tact`. va is updated per step, with virtual checkpoints every 8 spacings. The value stored is the one for the final bin. |
| Hook-set dynamic fee (`updateDynamicLPFee`) | Uniswap v4 | `HookSetFee` applies from the next swap, within the key's `[hookFeeMin, hookFeeMax]`. |
| LP positions as NFTs | Uniswap v3 | TEP-62 `Position` items, with the Pool as the collection. |
| Liquidity shapes (spot, curve, bid-ask) | Meteora | Built as several range positions by the SDK (not in contracts). |
| Native-coin pools | Uniswap v4 native ETH | Gram is token0 (the zero-hash sentinel) and is held natively by its pool. |

### What is adapted for TON

| EVM / Solana feature | Why it cannot be copied | Adaptation |
|---|---|---|
| Synchronous before/after hooks with return deltas, flash accounting | Cross-contract calls are asynchronous messages. | Hooks are asynchronous notifications sent with `bounce:false` and fixed gas. They cannot block, delay or change a trade. Fee control and fee share are declared in the key and visible in quotes. |
| Singleton PoolManager | One account per pool keeps the state small, and the tick map is a dictionary. | A Router holds jetton custody, and there is one Pool contract per key. Jettons move only on a `PayTo` that the Router authenticates by recomputing the pool address from the full key. |
| Unbounded tick walks | Each transaction is capped at 1M gas. | At most 24 crossings and 48 steps per swap, and the swap loop stops once it has used the gas the user paid for (`swapGasStop(maxCrossings)`, at most 650k; stop reason 5, `STOP_GAS`), so a swap can never run out of gas in the Pool. When a swap stops early, `allowPartial` fills part and refunds the rest. The Router requires gas for the user's own worst case. |
| Tick bitmap | Dictionaries support next-key lookups. | `DICTIGETNEXT` / `DICTIGETPREVEQ` run directly on the tick map. |
| `balanceOf` settlement | Jettons sit in per-owner wallets, and a contract only hears about them through `transfer_notification` from its own wallet. | Reserves are tracked in storage. The token is the sending wallet. Every failure is an explicit refund. |
| Storage costs gas once | TON charges storage rent continuously. | Each pool keeps a buffer (`keep()`): a base amount, 0.02 Gram per tick (refundable), and a permanent endowment of 0.1 Gram per tick ever created. |
| Bin arrays paid by the creator (Meteora) | One pool account has a cell limit of about 65k. | `MAX_TICKS_PER_POOL = 8192`, about 26.5k cells. New ticks pay `TICK_INIT_FEE`. |

### What is deferred (Phase 2)

- Exact-out swaps and multi-hop (Pool-to-Pool hop credits).
- Increasing an existing position (mint a new one instead).
- `BEFORE_SWAP` and `BEFORE_MODIFY` gating hooks.
- An oracle ring buffer. Only a single TWAP accumulator exists today.
- Limit-order mode.
- Ticks sharded into separate contracts, which would remove the per-pool tick cap.
- A library cell for the Pool code, to cut the StateInit forward fee and storage rent.
- A Position recovery path for one extreme rent case (see gaps).
- SDK work: order splitting, shape builder, routing.

## Build and test

```sh
cd /Users/basedtoni/Tron
npx tact --config dex/v2/tact.config.json      # 6 projects, no errors or warnings
npx jest dex/v2/tests                          # 158 tests in 17 suites, about 4 min
PRINT_FEES=1 npx jest dex/v2/tests/smoke.spec.ts   # print the per-transaction fee tables
```

Tests run in the sandbox only (`@ton/sandbox`). There are no wallets and no network.

| Suite | Covers |
|---|---|
| `math` | The `MathHarness` against the BigInt model (`model.ts`) and Uniswap reference vectors. |
| `smoke` | Every entry end to end, plus the gas tables. |
| `swap` | Three directions with quote == execution == model, crossings, limits, caps, partial fills, referral, deadlines, and gas at exactly the minimum. |
| `position` | Mint entries and edges, the minimum mint gas, every Pool reply path, the busy race, bounce, NFT transfer, the lock, MintAccount. |
| `fees` | Volatility filter and decay, caps, launch decay, protocol share. |
| `hooks` | Notifications, the hook fee bounds and share, a throwing hook, 19 invalid keys. |
| `graduation` | The hand-built payload, the lock, fee claims, squatting, refunds, minimum gas. |
| `launch` | Direct launch: init at the floored tick, the jetton-only locked position, buys up and sells down against the model, launch decay, the dev buy in the init transaction, init twice or by others, squatting, 16 bad-input refunds, the fee claim, a taxed launch, 40 random swaps against the model, gas at the minimum. |
| `platform` | Platform fee on spacing-10 launch keys: buy/sell pay exactly 1% of the Gram side to the treasury in the same transaction, quote (`get_quote`, `get_quote2`) == execution, partial fills, plain/no-initializer keys pay nothing, sub-minimum carry and payout, `CollectPlatformFees`, carry never swept by other ops, `SetPlatformFee` (admin only, ≤ 100, lower and raise, applies at once), treasury change, tax auto-payout at the threshold, the Router gas minimum. |
| `tax` | TAX validity and caps (Router and Pool), the Gram-pair rule, exact buy, sell and partial-fill tax against the model, `minOut` net of the tax, `CollectTax`, 0-tax key == plain key, gas overhead. |
| `fot` | Fee-on-transfer jettons: honest ones stay exactly backed; a lying wallet's deficit stays inside its own token. |
| `admin` | Each admin power and its cap. |
| `security` | Forged messages to every handler, fake jettons, bounces, 2^119 amounts, tick spam. |
| `ticklimit` | 8,192 ticks injected into a real Pool: the `TICK_LIMIT` refund and the worst-case gas. |
| `invariant` | 300 seeded random operations over 3 pools (P2 is taxed: buy 3%, sell 5%). After every operation it checks the full pool state against the model, a per-party jetton ledger, solvency, and withdrawable ≤ reserves. Everyone then exits, leaving ≤ 63 units of dust. |
| `review` | Regression tests for the nine external-review findings (DESIGN §15.7). |
| `notify` | §6.14: observations == model and getters over random swaps and time (TWAP accumulator, fee growth inside, uninitialized ticks), min-value bounce, pure read, gas; burn and mint receipts == model, notified payouts, refusals, bounce path, ordering, forged syncs, a rent-starved Position. |
| `launchfee` | The 90% launch-fee cap: 90% over 15 s second by second, a buy at t0, the normal fee after 15 s, the exempt dev buy, total ≤ 95%. |

## Fee model

Per swap step, on the input (v3 style):

```
fee = min(base + ceil(A · (va · tickSpacing)² / 1e14), 5%) + launchExtra(t)
  base        = preset base fee, or the hook-set fee (FEE_CONTROL) within the key's bounds (≤ 2%)
  va          = min(maxVolAcc, volRef + |idxRef − floor(tick / spacing)| · 10 000)     (Meteora)
  launchExtra = launchFeePips · (startTs + launchDuration − t) / launchDuration          (≤ 90%, ≤ 1 h)
split: protocol share (default 10%, ≤ 25%) → treasury
       hook share (≤ 20%, fixed in the key) → hook
       remainder → LPs through feeGrowthInside
referral: ≤ 0.1% of the input, taken before the swap and charged only on the filled part
tax (TAX plugin, Gram pools): buyTax on the Gram input (like the referral, filled part only),
       sellTax on the Gram output; outside the LP fee; accrues in taxFees for taxRecipient
```

| Preset (`tickSpacing`) | Base | A | Filter / decay | Reduction | maxVolAcc | Maximum variable fee |
|---|---|---|---|---|---|---|
| 1 | 0.01% | 400,000 | 10 s / 120 s | 50% | 350,000 | +0.049% |
| 10 | 0.05% | 40,000 | 30 s / 600 s | 50% | 350,000 | +0.49% |
| 60 | 0.30% | 4,500 | 30 s / 600 s | 50% | 350,000 | +1.98% |
| 200 | 1.00% | 600 | 30 s / 600 s | 50% | 350,000 | +2.94% |

- Presets are add-only.
- An existing key's preset, launch fee, hook and caps can never change.
- Hard caps are code constants:
  - base fee 2%;
  - base + variable fee 5%;
  - launch extra 90%, for at most 1 h (e.g. 90% fading to 0 over 15 s). With the 5% dynamic cap
    the total is at most 95% of the input: it can never reach 100%;
  - protocol share 25%;
  - hook share 20%;
  - referral fee 0.1%.
- Mint-side charges:
  - `TICK_RENT_BUFFER`, 0.02 Gram per new tick, refundable;
  - `TICK_INIT_FEE`, 0.1 Gram per new tick, non-refundable and kept as the pool's storage
    endowment.
- **Admin powers:** add a preset, set the protocol share (≤ 25%), pause *initialization* of new
  pools, set the treasury, two-step admin transfer, and sweep Router Gram above its own storage
  buffer to the treasury. The admin cannot touch reserves, positions, swaps or withdrawals.

## Gas (sandbox, Pool compute phase)

| Flow | Gas |
|---|---|
| Mint: initialize the pool + 2 new ticks + Position deploy | 107,414 |
| Mint: 2 new ticks + Position deploy | 102,791 |
| Swap Gram→jetton / jetton→Gram, 0 crossings | 98,925 / 104,702 |
| Swap with 1 / 2 / 4 / 8 / 16 / 24 crossings | 105k / 123k / 159k / 231k / 375k / 519k (≈ 18.0k per crossing) |
| 48 checkpoint-only steps (non-pinning preset) | 585,904 (≈ 10.3k per step) |
| Worst case, 24 crossings + 24 checkpoints, 308 ticks | 770,338 |
| Worst case on a full 8,192-tick map | **783,838** (under 1M; the map is ≈ 26.5k cells, under 65,536) |
| Worst-case swap at the Router's exact minimum value (0.644 Gram attached) | 780,760 |
| Decrease (Pool side), deleting 0 / 2 ticks | 98,823 / 99,598 |
| Direct launch: initialize + 2 new ticks + Position deploy | 106,688 |
| Direct launch + dev buy (1 crossing) / taxed | 205,572 / 205,729 |
| Swap buy / sell on a 0-tax ext key / taxed key (TAX overhead) | 112,592 / 118,092 → 112,938 / 118,470 (+346 / +378) |
| `PoolObserve` (pool with 80 ticks) | 32,461 |
| Notifying decrease, Pool side / Position relay | 104,364 / 10,948 |
| Notifying mint, 2 new ticks | 111,066 |

The gas constants assume 400 nanoGram per gas. The sandbox prices gas at about 66.7, so the
constants are conservative:

| Constant | Value |
|---|---|
| `SWAP_BASE_GAS` | 0.35 |
| `CROSS_GAS` | 0.006 |
| `MINT_GAS` | 0.6 |
| `GRADUATE_GAS` | 0.5 |
| `LAUNCH_GAS` (+ `DEV_BUY_GAS` 0.15 with a dev buy) | 0.5 |
| `DECREASE_GAS` | 0.25 |
| `BURN_POOL_GAS` | 0.2 |

Each Router→Pool hop also carries about 0.012 Gram of StateInit forward fee, because the Pool code
is 31.6 KB.

Per-transaction price movement when every tick spacing is initialized (dust spam) is bounded by
24 crossings:

| Spacing | Maximum move per transaction |
|---|---|
| 60 | ≈ 15% |
| 10 | ≈ 2.4% |
| 1 | ≈ 0.24% |

Larger trades fill partially and continue in another transaction, so SDKs must split orders.
Without spam, 48 steps are no longer a limit once the volatility fee is pinned.

## Contracts on plain pools: observation and receipts

Before this, a contract could only learn a pool's state by being its hook (DESIGN §7), which
fragments liquidity into a hook key and charges every swapper the 0.01 Gram notification. The
additive messages of DESIGN §6.14 remove that need:

| Message | Who | What comes back |
|---|---|---|
| `PoolObserve{queryId, tickLower, tickUpper, payload}` (≥ 0.03 Gram) | anyone → Pool | `PoolObservation` to the sender: spot price, tick, active liquidity, `tickCumulative` at the Pool's `now()`, and the fee growth inside the range (v3 rule: only when both ticks are initialized, flag `rangeOk`). A pure read. Below 0.03 Gram the request bounces. |
| `PositionDecreaseNotify` (≥ 0.3 Gram) | owner → Position | One `BurnReceipt{ok, code, amounts, fees, new liquidity, new fee checkpoint}` from the NFT once it is free (also for refusals and bounces). Jetton legs carry 0.01 Gram forward, so the recipient's wallet notifies. |
| `MintNotifyPayload` / `MintNativeNotify` (`MINT_GAS` + 0.05) | payer → Router | One `MintReceipt{ok, code, index, liquidity, used, refunds, fee checkpoint}` to the payer (never to a third-party owner); jetton refunds notified. |

The plain messages are unchanged: plain swappers and LPs pay exactly what they paid before.

## Direct launch (no curve)

This is the entry the `launch/` launchpad uses (README there, DESIGN §6.11). A launch master sends
a jetton transfer to the Router with `LaunchPayload` (`0x4d480004`) and `forwardTonAmount =
LAUNCH_GAS (+ DEV_BUY_GAS + devBuy)`. The payload fields are:

| Field | Meaning |
|---|---|
| `sqrtPriceX96` | start price |
| `tickSpacing` | must be a DEX preset |
| `launchFeePips`, `launchDuration` | LAUNCH_DECAY plugin of the key |
| `deadline` | |
| `feeClaimer` | owner of the locked position |
| `refundTo` | receives refunds and the Gram excess |
| `taxRecipient?`, `buyTaxBps`, `sellTaxBps` | TAX plugin of the key |
| `devBuy`, `minDevOut`, `devReceiver` | optional dev buy |

The steps:

1. **Router.** The key is `{GRAM, RW(jetton), tickSpacing, ext{initializer = the transfer's sender,
   launchFeePips, launchDuration, taxRecipient, buyTaxBps, sellTaxBps}}`. The Router validates the
   recipients, deadline, preset, ext, price range and gas. On any failure it refunds the jettons
   (`refundTo`, or the sender on a bad recipient). On success it sends `PoolLaunch` (`0x4d480026`).
2. **Pool**, one transaction:
   - It requires `!initialized`, `allowInit`, `fromUser == ext.initializer`, a Gram pool, a valid
     tax and a price inside `[MIN, MAX)`.
   - `tU = floor(tick(sqrtPriceX96) / spacing) · spacing` must lie in `(minUsable, maxUsable]`.
   - It initializes at `sqrtAt(tU)`, so the start market cap is at most one spacing above the one
     requested.
   - It mints **one jetton-only position `[minUsable, tU]`** with owner `feeClaimer` and
     `lockedUntil = 0xFFFFFFFF`. Fees stay claimable with `PositionDecrease{0}`, the same lock
     semantics as graduation. The deposit's rounding dust (fewer than √price units) is booked as
     `protocolFees1`, so it needs no payout hop.
   - The range sits entirely on the jetton side. Gram buyers move the price into it at once; the
     first buy crosses `tU` at zero cost. Sellers can only sell back what was bought, because
     there is no liquidity above `tU`.
   - **Dev buy:** the first swap the pool ever sees, in the same transaction. The anti-snipe extra
     is waived; the base fee, protocol share and buy tax apply. If it fails (`minDevOut`), only the
     dev buy is refunded (`RefundEvent`, `GramPayout` reason 2) and the launch stands.
   - Events, in order: `InitializeEvent{graduation: true, initializer}`, `ModifyEvent`,
     `SwapEvent` (dev buy), `LaunchEvent` (`0x4d480075`: key, feeClaimer, tickLower, tickUpper,
     liquidity, amount1, devIn, devOut).
   - Any failure refunds the jettons and the dev-buy Gram to `refundTo` with a `RefundEvent`:
     `DEADLINE`, `ALREADY_INITIALIZED`, `CREATION_PAUSED`, `NOT_INITIALIZER`, `BAD_KEY`,
     `PRICE_OUT_OF_RANGE`, `BAD_TICKS`, `LIQUIDITY_BELOW_MIN`, `LOW_GAS` or `MATH_FAILURE`.
3. **Squatting** is impossible, as with graduation. Only the initializer can initialize the key. A
   pool that someone deployed uninitialized does not block the launch. Anyone else who sends a
   `LaunchPayload` creates their own key. Indexers must treat as canonical only the key whose
   `initializer` is the token's master.

Router getters:
- `get_launch_key(token1, spacing, initializer, launchFeePips, launchDuration, taxRecipient, buyTaxBps, sellTaxBps)`;
- `get_launch_pool_address(...)`, with the same arguments.

## Tax tokens (TAX plugin)

`KeyExt` gains `taxRecipient: Address?`, `buyTaxBps: uint16` and `sellTaxBps: uint16`. The cell is
now 1,017 bits and still one cell. Like every ext field, these are immutable per key.

- **Rules**, enforced by the Router (`extFlags`) and again by the Pool at initialization:
  - each tax is ≤ `TAX_MAX_BPS` (1000 = 10%);
  - `taxRecipient` is non-null iff some tax is non-zero; it must be basechain and must not be the
    Router;
  - a taxed key needs an `initializer`, so only that address can create the pool (nobody can
    create a taxed pool *in someone else's name*);
  - only Gram pairs may be taxed. Jetton entries with `otherToken ≠ GRAM` refuse `BAD_KEY`, and the
    Pool refuses to initialize a taxed jetton/jetton key.
- **Mechanics.** The tax is always taken in Gram, on top of the LP and volatility fee and the
  protocol share. It never touches fee growth.
  - Buy (Gram in, `zeroForOne`): `tax = amountIn · buyTaxBps / 1e4` before the swap. On a partial
    fill it is charged on the filled part only, like the referral.
  - Sell (Gram out): `tax = out · sellTaxBps / 1e4`, and the receiver gets `out − tax`.
  - `minOut`, `Quote.amountOut` and `SwapEvent.amountOut` are all **net** of the sell tax.
  - `Quote.tax` and `SwapEvent.tax` report the tax. `SwapEvent.amountIn` (and the hook's
    `amountIn`) includes the buy tax.
- **Payout.** The tax accrues in `Pool.taxFees` (part of `keep()`, shown by `get_pool_state`).
  As soon as it reaches `TAX_MIN_PAYOUT` (0.1 Gram), the swap that crosses it pays the whole
  `taxFees` to `taxRecipient` in the same transaction: `GramPayout{reason 14, amount}` with value
  `amount + TAX_PAYOUT_GAS` (0.04, what the launch master keeps for its split). Below the threshold
  anyone can still send `CollectTax{queryId, key}` (`0x4d48001b`, value ≥ `COLLECT_GAS`); the
  Router forwards `PoolCollectTax` (`0x4d480027`), and the Pool pays `GramPayout{reason 14}`.
- A 0/0 key behaves exactly like a plain key; this is tested.
- Gas overhead: +346 on a buy, +378 on a sell.

## Platform fee

A pump.fun-style fee on **launch keys** (`ext.initializer != null`: direct-launch and graduation
keys) of Gram pools. Plain keys and hook keys without an initializer pay nothing. The scope is one
switch, `PLATFORM_FEE_ALL_GRAM_POOLS` (false; true would charge every Gram pool), read by
`Pool.platformCharged()` and `Router.platformGas()` only.

- **Rate.** One global `platformBps` in the Router: initially 100 (1%), the code cap
  `PLATFORM_FEE_CAP_BPS`. The admin sets it anywhere in `[0, 100]` with `SetPlatformFee{queryId,
  bps}` (`0x4d48001d`). The Router passes the rate and the recipient (its `treasury`) in every
  `PoolSwap` / `PoolLaunch`, so a change applies to every launch pool on its next swap.
- **Charged like the tax, on the Gram side.** Buy: `amountIn · bps / 1e4` of the Gram input,
  before the swap (filled part only on a partial fill). Sell: `out · bps / 1e4` of the Gram
  output; the receiver gets `out − sellTax − fee`. Outside the LP fee. Dev buys pay it too.
- **Paid directly.** In the same swap transaction the pool sends `GramPayout{reason 15
  (PLATFORM), amount}` (value = amount, `bounce:false`) to the treasury. Below
  `PLATFORM_MIN_PAYOUT` (0.01 Gram) it is carried in `Pool.platformFees` (part of `keep()`, so no
  other payout can sweep it) and added to the next payout. Anyone can flush the carry with
  `CollectPlatformFees{queryId, key}` (`0x4d48001e`, ≥ `COLLECT_GAS`), always to the treasury.
- **Quotes.** `Quote.platformFee`; `get_quote` / `get_quote_at` use the rate the pool last saw.
  For an exact quote right after a rate change use `get_quote2(zeroForOne, amountIn,
  sqrtPriceLimitX96, maxCrossings, refBps, allowPartial, platformBps)` with the Router's
  `get_platform_fee()`.
- **Events.** `SwapEvent.platformFee` (appended as the last field; the old fields and order are
  unchanged). `PoolState.platformFees` and `platformBps` are appended.
- **Gas.** `swapGas = SWAP_BASE_GAS + maxCrossings · CROSS_GAS + (allowPartial ? JETTON_PAYOUT_VALUE
  : 0) + (referral ? JETTON_PAYOUT_VALUE : 0) + (AFTER_SWAP hook ? HOOK_NOTIFY_VALUE : 0) +
  (charged ? PAYOUT_MSG_GAS : 0) + (taxed ? PAYOUT_MSG_GAS + TAX_PAYOUT_GAS : 0)`, with
  `PAYOUT_MSG_GAS` 0.01 and `TAX_PAYOUT_GAS` 0.04: a launch key +0.01, a taxed launch key +0.06.
  `get_ext_valid` now also returns `LAUNCH_FLAG` (512) for initializer keys, and
  `get_swap_gas(maxCrossings, allowPartial, refBps, ext, gramPool)` returns the Router's exact
  minimum (add `fwdTon`, `get_payload_fee` and 2 forward fees).

**Fee-on-transfer jettons are not supported.** The Router credits the amount in the wallet's
notification and assumes a payout of X costs its wallet exactly X. A FoT jetton whose wallet
notifies what it actually credited stays exactly backed: the deposit is booked net, and receivers
simply get less (`fot.spec`). A wallet that notifies more than it credited is indistinguishable
from a fake jetton. The Router cannot detect it, because it cannot read balances synchronously.
The resulting deficit is confined to that token's Router wallet: other tokens' pools are
unaffected, and the last withdrawals of that token bounce (`TRANSFER_BOUNCED`). Taxed tokens must
use the TAX plugin, never transfer fees.

## Remaining gaps before mainnet

1. **External audit.** The audit surface is about 3-4 times v1. The bounded loops, the
   asynchronous refund paths and the rent handling need an independent review. Launch with small
   canary pools.
2. **Storage rent and freezing.** Rent is charged continuously, and an idle account freezes once
   its debt passes `freeze_due_limit`.
   - **Pools.** Estimated mainnet rent for a 31.6 KB Pool is ≈ 0.36 Gram per year (not measured). A
     jetton/jetton pool's buffer covers months. The endowment from `TICK_INIT_FEE` stretches that,
     but an abandoned pool can still freeze. Unfreezing needs the exact frozen state, and Router
     messages carry only the *initial* StateInit.
   - **Positions.** A Position holds only 0.02 Gram. An NFT left idle for about a decade (for
     example a never-claimed graduation position) can freeze.
   - **Mitigations:** a library cell for the code (the largest win), keeper top-ups (pools and
     positions accept plain Gram; a pool books it into its permanent `endowment`), and unfreeze
     tooling.
3. **Rent on non-bounceable hops.** `PoolSwap` and `PoolMint` still reserve `keep()` from the
   user's value. A rent deficit larger than the attached value minus costs would fail the action
   phase and strand that input. This needs years of idleness. PoolBurn already has the
   "spare ≥ need, else a funded refusal" pattern, and it should be applied to the other handlers.
4. **Position recovery (finding 1 residual).** A burn sent to a pool whose rent debt exceeds the
   attached value cannot run or bounce. In practice the account freezes first, and a frozen
   account bounces the burn. A full fix needs a Pool-side per-position nonce and result record.
5. **Tick spam is mitigated, not solved.** Filling the 8,192-tick cap now burns ≥ 819 Gram, and
   throttling a swap with dust ticks near the price costs ≈ 0.1 Gram per tick. The real fix is
   sharded tick storage, plus SDK splitting with `allowPartial`.
6. **Launchpad integration.** Graduation expects a future launchpad version to send the one-cell
   `GraduatePayload`. The live v1 launchpad is unchanged. The new `launch/` launchpad uses the
   direct-launch entry instead. Indexers must treat a pool as the
   canonical launch pool only when `InitializeEvent.initializer` is the known launchpad master: the
   `graduation` flag alone can be produced by anyone (finding 5). Check `initializer` against the
   launch factory's own record of its masters, not just "some launch master":
   `JettonNotification.sender` is forgeable by any admin-mintable jetton (its minter can name any
   sender), so the Router's view of who transferred is only as trustworthy as the jetton.
   Launch and graduation keys bypass `SetCreationPaused` (a refused launch would strand the supply
   in the launch master), so the pause does not stop launch-shaped keys.
7. **No just-in-time (JIT) protection on plain keys.** Only keys with `minLockSecs`, or with an
   active launch window, lock new liquidity. Consider a default lock for canonical pools.
8. **Product gaps.** Exact-out, multi-hop, position increase, gated hooks, an oracle ring buffer,
   and an SDK with order splitting and quote-based price bands (`sqrtPriceMin/MaxX96` on mints).
9. **Code size.** Router 55.3 KB and Pool 44.7 KB (53.9 / 43.0 before the §15.8 fixes; 49.3 / 39.3 before the observation and
   notifying ops of §6.14; 40.2 KB and 31.6 KB before the launch
   entry and the TAX plugin. This drives forward fees: each Router→Pool hop carries the Pool
   StateInit, about 0.015 Gram. It also drives rent. A library cell fixes both.
10. **Tax recipient and non-canonical keys.** The tax recipient is fixed per key, and payouts are
    non-bounceable `GramPayout`s. Anyone may create a taxed key for any jetton, with themselves as
    initializer. Such a pool is real, but it is not the token's canonical pool, and UIs must check
    the initializer.
11. **Notifying ops.** A receipt can still be lost if the Position is frozen by rent (the owner then
    sees its `PositionDecreaseNotify` bounce instead), and a notified payout becomes silent if its
    forward is dropped (`FWD_DROPPED`, only below the documented values). Contracts that rely on
    receipts must handle both (the Marg vault does: a bounce is a definite failure, and a payout
    that never arrives only delays a withdrawal until a Poke).
12. **Second review fixes (DESIGN §15.8).** Fixed: spare pool Gram no longer goes to the first
    collect caller (plain Gram joins the endowment; collect/admin/hook ops return only the caller's
    value plus what they pay out); MintAccount legs pair only with identical params (a forged first
    leg cannot redirect a victim's real leg); launch/graduation keys bypass `SetCreationPaused`.
    Residual: a forged leg can still grief a pending two-leg mint (both legs are refunded, the user
    resends); the pause cannot stop anyone from creating launch-shaped keys.

## v3 changes

v3 is the current deployment; v2 (git tag `mainnet-v2`) stays live for its pools.

- **Gas stop.** The swap loop measures `gasConsumed()` and stops at `swapGasStop(maxCrossings)` =
  min(650k, 2/3 of the gas the Router charged for), with stop reason `STOP_GAS` (5). A swap then fills
  partly or is refunded; it never aborts in the Pool.
- **Pool reserve rule.** Every success path reserves `max(balance_before + keep() - k0, owed() +
  POOL_MIN_STORAGE)`, so a caller is never paid Gram the pool did not account for, and storage rent
  is paid from the pool's own buffer, never from a caller's value.
- **`SweepPoolSurplus`** (0x4d48001f, anyone → Router, ≥ `COLLECT_GAS`): sends a pool's Gram above
  `keep()` to the treasury (`GramPayout` reason 16).
- **Launch keys.** On a key with an `initializer`, only the initializer can add liquidity (code 218);
  other mints are refunded.
- **Treasury** must be a basechain address (`init`, `SetTreasury`).
- `CollectTax`, `CollectPlatformFees`, `CollectProtocolFees` and `SweepPoolSurplus` reach the pool
  with a non-bounceable deploy, so a call for a missing pool returns the value to the caller.
- `PoolLaunch` refunds have their own `GramPayout` reasons: 17 (launch refused, only for the
  initializer's own launch) and 18 (launch done, the dev buy could not fill). A refused decrease keeps
  the pool's whole prior balance.
- The volatility reference time only moves when the fee state was refreshed or the price left its bin.
