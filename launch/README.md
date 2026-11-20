# Marg direct launch

A launchpad with **no bonding curve**, in the style of Clanker and Uniswap-v4 launches. One
`CreateToken` message deploys a fixed-supply jetton, and the same message chain puts the whole
supply into a Marg DEX v2 pool. That pool starts trading immediately at a fixed starting market
cap. There is no curve phase and no graduation.

Sandbox build only. Nothing has been deployed. The DEX side is `dex/v2` (see its README §Direct
launch, and DESIGN §6.11 to §6.13).

## What it does

| | |
|---|---|
| Supply | 1,000,000,000 tokens with 9 decimals (`10^18` units), minted once. Minting then closes for good and the master has no admin (`get_jetton_data`: `mintable = false`, `adminAddress = null`). |
| Pool | The canonical DEX v2 key is `{GRAM, RW(jetton), tickSpacing, ext{initializer = master, launchFeePips, launchDuration, taxRecipient = master (taxed) or null, buyTaxBps, sellTaxBps}}`. Only the master can initialize it, and it does so exactly once. |
| Liquidity | The whole supply goes into one jetton-only position `[minUsable, tU]`, where `tU` is the start tick floored to the spacing. A Gram buyer moves the price up into that range, so every buy is filled from it. The position is locked forever. Its owner (the fee claimer) is the treasury. |
| Start price | `startMcap / 1e9 tokens`. The default is 2,600 Gram, the current v1 low tier. Because the tick is floored to the spacing, the real start market cap is at most one spacing higher (at most 0.1% for the default spacing 10). The tests measured 2,601.67 Gram. |
| Spacing | Default **10** (the DEX 0.05% base-fee preset) on every tier. The factory accepts the DEX presets 1, 10, 60, 200, but **do not use 1**: large reversing swaps get refused there. |
| Fees | Everything goes to the platform: the **1% platform fee** in Gram on every buy and sell (paid directly to the Router treasury, see [Fees](#fees)), the LP fee of the locked position (claimable by the treasury), the DEX protocol share (10% of every swap fee, also to the treasury), and the launch fee. **There is no creator fee** (only the optional creator tax). |
| Anti-snipe | Optional, **chosen by the creator per launch** (`antiSnipePips`, `antiSnipeDuration`; both 0 = off). The DEX `LAUNCH_DECAY` plugin charges that extra fee at t0, decaying linearly to 0. Factory bounds: fee ≤ 90%, duration 1 s to 1 h, both zero or both non-zero. Example: 90% fading to 0 over 15 s. The admin no longer sets it. The DEX must allow it: a dex/v2 build with `MAX_LAUNCH_FEE_PIPS` below the chosen fee refunds the launch (the current dex/v2 source and build allow 90%). |
| Dev buy | Optional. It is executed **inside the pool's initialization transaction**, so nothing can be ordered before it. The anti-snipe fee is waived for the dev buy. The base fee, the protocol share, the 1% platform fee and any buy tax still apply. |
| Tax tokens | Optional `buyTaxBps` and `sellTaxBps`, each 0 (off) or 1% to 5%. The pool takes the tax in Gram (DEX TAX plugin) and pays it to the token's **master** automatically, inside the swap, as soon as at least 0.1 Gram has accrued. The master splits 100% of it, by percentages fixed at launch, between **holder rewards**, **a tax wallet** and **buyback and burn** (see [Tax split](#tax-split)). It is not a fee-on-transfer jetton: transfers are never taxed. |

## Fees

Per buy or sell of a launch token, all in Gram (the Gram side of the swap):

| Fee | Rate | Where it goes |
|---|---|---|
| Platform fee | 1% (`Router.platformBps`, default 100 bps; the DEX admin can set 0..1% on the live v3 Router, 0.85..1% on v4 (`PLATFORM_FEE_MIN_BPS`, audit R8B-2: the fee stays high enough that sandwiching a buyback does not pay); applies to the next swap) | **directly to the Router treasury in the same transaction** (`GramPayout` reason 15, value = amount). Buy: 1% of the Gram input; sell: 1% of the Gram output (the seller gets `out − sellTax − fee`). Below 0.01 Gram it is carried in the pool and added to the next payout. The dev buy pays it too. |
| LP fee | spacing-10 preset: 0.05% base + variable (≤ 0.49%), + the anti-snipe extra at launch | the locked position (treasury); 10% of it is the DEX protocol share (treasury) |
| Creator tax (optional) | buy and/or sell, 1%..5% | the token's master, **auto-paid inside the swap** (`GramPayout` reason 14, value = amount + 0.04) as soon as the pool's `taxFees` ≥ 0.1 Gram; the master splits it at once (rewards / tax wallet / buyback, which runs when due). Less than 0.1 Gram stays in the pool until the next qualifying swap, `Harvest` or `CollectTax`. |

The platform fee and the tax are both outside the LP fee. Every launch key (an initializer) pays the
platform fee; the swap gas is a bit higher on such keys (`Router.get_swap_gas(maxCrossings,
allowPartial, refBps, ext, true)`: +0.01 Gram for a launch key, +0.06 for a taxed one); unused gas
comes back. Quotes (`get_quote`, `get_quote2`) include `platformFee`, and `SwapEvent.platformFee`
reports it. `LaunchInfo` and the factory getters are unchanged: read the live rate with the Router's
`get_platform_fee()`.

## Contracts (`launch/contracts`)

| File | Contract | Role |
|---|---|---|
| `factory.tact` | `LaunchFactory(admin, treasury, router, launchFee, params)` | Takes `CreateToken`, sends the launch fee to the treasury, and deploys `LaunchJetton(factory, index)`. It also holds the admin powers. |
| `jetton.tact` | `LaunchJetton(factory, index)` | Jetton master (TEP-74, TEP-89 discovery, TEP-64 content cell). It accepts one `LaunchSetup` from the factory and mints the supply into the Router's wallet with a `LaunchPayload`. It stores `LaunchInfo`. For tax tokens it is also the DEX tax recipient, the tax splitter, the holder-rewards tracker and the buyback-and-burn engine. Other Gram it receives (launch excess, refunds) goes to the creator, minus what it holds for holders and the buyback. |
| `jetton.tact` | `LaunchWallet(master, owner, rr, vault)` | Standard TEP-74 wallet with transfer and burn. There is no transfer tax. `rr` is the Router when the token has holder rewards, else null. `vault` is the creator vault when `rr != null` and the token has one, else null (its wallet is not tracked). With rewards on, every balance change sends a checkpoint to the master (see [Holder rewards](#holder-rewards)). |
| `vault.tact` | `LaunchVault(master)` | Optional creator vault, one per token (see [Creator vault](#creator-vault)). Holds `vaultBps` of the supply in its own (untracked) wallet and releases it to the beneficiary after a lock, at once or linearly. No admin, no early withdrawal. |
| `dex_shared.tact` | (structs) | `PoolKey`, `KeyExt` and `LaunchPayload`. This is a **verbatim copy** of `dex/v2/contracts/shared.tact`, because Tact only imports from inside a project root. A test asserts that the two files are byte-identical and serialize identically. Edit both together. |

## Flow

```
creator --CreateToken{content, devBuy, minDevOut, buyTaxBps, sellTaxBps, taxWallet?, rewardsBps, walletBps, buybackBps,
                      antiSnipePips, antiSnipeDuration, startMcap, tickSpacing, vaultBps, vaultLock, vaultVest}--> Factory
  Factory: launchFee -> treasury ("Launch fee"); emit TokenLaunched; deploy Master(index)
  Factory --LaunchSetup{content, info, devBuy, minDevOut, routerValue}--> Master
  Master:  launched = true; totalSupply = 1e18 (the only mint); v = 1e18 * vaultBps / 10000
  (v > 0) Master --VaultSetup{beneficiary = creator, wallet, total = v, start = now, lock, vest}--> Vault (deployed here)
  (v > 0) Master --JettonTransferInternal{v, from = master, no forward}--> the vault's wallet (deployed here, untracked)
  Master --JettonTransferInternal{1e18 - v, from = master, fwd = routerValue, LaunchPayload}--> RW (the Router's wallet; deployed here)
  RW --JettonNotification{1e18, sender = master}--> Router ; RW --excess--> creator
  Router: key = {GRAM, RW, spacing, ext{initializer = master, ...}}; validate; --PoolLaunch--> Pool
  Pool, in ONE transaction:
      initialize at tU = floor(tick(sqrtPrice) / spacing) * spacing
      mint the locked position [minUsable, tU] for the treasury (dust -> protocol fee)
      dev buy (if any): swap devBuy Gram -> jettons for the creator, launch fee waived
      emit InitializeEvent, ModifyEvent, SwapEvent (dev buy), LaunchEvent{key, ...}
      -> Position NFT #0 (owner treasury, locked forever)
      -> PayTo(dev jettons -> creator) through the Router, or the excess Gram -> master -> creator
```

Ordering of the dev buy relative to everything else is guaranteed by construction. The dev buy is
part of the `PoolLaunch` transaction itself, and that is the transaction that sets
`initialized = true`. Any swap that reaches the pool earlier is refunded with `NOT_INITIALIZED`.
Any swap that arrives later sees the price after the dev buy. The tests check that the Pool's
single transaction emits `[InitializeEvent, ModifyEvent, SwapEvent, LaunchEvent]` in that order.

**When a launch fails** (for example the DEX admin paused creation of new pools, the Router
rejects the payload, or the deadline of 600 s passes): `refundTo` is the master itself. The supply
therefore comes back to the master's own wallet, where no code can move it, so it is effectively
burned. The Gram (gas excess and the dev buy) is forwarded to the creator. Nobody ever receives
the supply.

## Messages and opcodes (prefix `0x4d4c`)

| Op | Message | Direction | Fields |
|---|---|---|---|
| `0x4d4c0001` | `CreateToken` | creator → Factory | queryId: uint64; content: Cell (TEP-64); devBuy: coins; minDevOut: coins; buyTaxBps: uint16; sellTaxBps: uint16 (each 0 or 100..500); taxWallet: Address? (null = creator; ignored when walletBps = 0); rewardsBps, walletBps, buybackBps: uint16 (sum 10000 when a tax is on; ignored when untaxed); antiSnipePips: uint32 (≤ 900000); antiSnipeDuration: uint32 (≤ 3600; 0 iff pips is 0); startMcap: coins; tickSpacing: uint16 (both must equal the factory's current `get_factory_data().params`, else the factory throws and the value bounces back); vaultBps: uint16 (0 = no vault, else 1..5000); vaultLock: uint32 (vault: 604800..31536000 s); vaultVest: uint32 (vault: 0..31536000 s; lock and vest are ignored and stored 0 when vaultBps = 0) |
| `0x4d4c0002` | `LaunchSetup` | Factory → Master | queryId; content; info: LaunchInfo; devBuy; minDevOut; routerValue |
| `0x4d4c0010` | `LowerLaunchFee` | admin → Factory | queryId; fee (must be strictly lower) |
| `0x4d4c0011` | `SetLaunchParams` | admin → Factory | queryId; params: LaunchParams{startMcap: coins, tickSpacing: uint16} |
| `0x4d4c0012` | `SetTreasury` | admin → Factory | queryId; treasury |
| `0x4d4c0013` | `TransferAdmin` | admin → Factory | queryId; newAdmin (sending your own address cancels) |
| `0x4d4c0014` | `ClaimAdmin` | pending admin → Factory | queryId |
| `0x4d4c0015` | `WithdrawExcess` | admin → Factory | queryId (sweeps balance above 0.05 Gram to the treasury; this includes the value of a bounced `LaunchSetup` whose creator is no longer among the last 16 pending launches, which the admin then returns by hand, see Admin powers) |
| `0x4d4c0021` | `TokenLaunched` (event) | Factory → external | queryId; index; master; creator; devBuy; buyTaxBps; sellTaxBps; taxWallet?; rewardsBps; walletBps; buybackBps; antiSnipePips; antiSnipeDuration; vaultBps; vaultLock; vaultVest |
| `0x4d4c0040` | `VaultSetup` | Master → Vault (once, at launch) | queryId; beneficiary; wallet; total: coins; start, lock, vest: uint32 |
| `0x4d4c0041` | `ClaimVault` | beneficiary → Vault | queryId (attach ≥ `get_claim_value()` = 0.15 Gram; the rest comes back). Throws when nothing is claimable |
| `0x4d4c0042` | `TransferVaultBeneficiary` | beneficiary → Vault | queryId; newBeneficiary (basechain) |
| `0x4d4c0043` | `VaultClaimed` (event) | Vault → external | queryId; beneficiary; amount; claimed |
| `0x4d4c0030` | `RewardCheckpoint` | Wallet → Master | queryId; delta: int64; owner |
| `0x4d4c0031` | `RewardClaim` | Wallet → Master | queryId; delta; owner; acked; lastAcc: uint256; frac: uint64; owed |
| `0x4d4c0032` | `RewardAck` | Master → Wallet (non-bounceable) | queryId; acc: uint256; delta; claim: Bool; frac: uint64 (claim only); owed: coins (v4, claim only: what is still owed after the payout, normally 0) |
| `0x4d4c0033` | `ClaimRewards` | owner → own Wallet | queryId (attach ≥ `get_reward_values().claim`, priced from the chain's gas price, ~0.01 Gram today; the rest comes back with the rewards) |
| `0x4d4c0034` | `SyncRewards` | anyone → a Wallet (v4; on v3 the owner only) | queryId (attach ≥ the wallet's `get_reward_values().sync`, which includes its recorded storage debt; the caller pays and the rest of its value comes back as `JettonExcesses`): report the balance again and refresh `owed`. The keeper uses it to repair wallets after a gas-price change (audit R7A-1) |
| `0x4d4c0035` | `Harvest` | anyone → Master | queryId. Collects the pool's accrued tax (taxed tokens, any split; tax ≥ 0.1 Gram is already auto-paid in the swaps, so this is for the rest). Caller-paid (v4: always): attach ≥ `get_harvest_value()` = 0.24 Gram (the rest is refunded), ≥ 60 s since the last harvest. The Router's `CollectTax` (anyone, `COLLECT_GAS` 0.2 Gram, the unused part comes back: about 0.08 net) does the same job for less; the keeper uses that. |
| `0x4d4c0036` | `Buyback` | anyone → Master | queryId. Runs a due buyback now (same guards as the automatic run). The caller's whole value is refunded. |
| `0x4d4c0022` | `TaxSplitEvent` (event) | Master → external | amount; rewards; wallet; buyback; extra (non-tax Gram swept with it); rent (v4: taken from the rewards share into the rent fund; amount = rewards + rent + wallet + buyback) |
| `0x4d4c0023` | `BuybackEvent` (event) | Master → external | queryId; amount |
| `0x4d4c0024` | `BurnEvent` (event) | Master → external | amount; totalSupply |

There is no `ResetRewards` message (v4 dropped the idea, see "Lost messages" under v4 changes).

The jetton uses the standard TEP-74 and TEP-89 opcodes (`0x0f8a7ea5`, `0x178d4519`, `0x7362d09c`,
`0x595f07bc`, `0x7bdd97de`, `0xd53276db`, `0x2c76b973`, `0xd1735400`).

DEX side: `LaunchPayload` is `0x4d480004`, `PoolLaunch` is `0x4d480026`, `LaunchEvent` is
`0x4d480075`, `CollectTax` is `0x4d48001b`, and `SwapEvent.tax` is a new field. See the dex/v2
README. The master also sends `SwapNative` (`0x4d480011`) and `CollectTax`, and receives
`GramPayout` (`0x4d480061`). `messages.tact` keeps copies of those three layouts; a test asserts
they serialize byte-identically to the dex/v2 ones.

### Admin powers (capped)

- The launch fee can only go down (`LowerLaunchFee` requires `fee < current`).
- `SetLaunchParams` applies to **new** launches only. Its bounds are: start mcap between 100 Gram
  and 100M Gram, spacing one of the DEX presets 1, 10, 60, 200 (use 10; never 1). A `CreateToken` carries the
  `startMcap` and `tickSpacing` the creator saw; if the admin changed them in between, the launch is
  refused and the value bounces back (the creator re-signs with the new params). The
  anti-snipe fee is no longer an admin parameter: the creator picks it per launch, within code
  bounds.
- `SetTreasury` sets the fee claimer and launch-fee receiver for **new** launches. Existing
  position NFTs keep their owner; the treasury can move them with a TEP-62 transfer.
- Admin transfer takes two steps (`TransferAdmin`, then `ClaimAdmin`).
- `WithdrawExcess` sends the factory's balance above 0.05 Gram to the treasury. The factory remembers
  the creator of only the last 16 launches (`FACTORY_PENDING`); if a `LaunchSetup` bounces after 16
  newer launches (it cannot in practice: the factory checks and funds everything), its whole value stays
  in the factory and `WithdrawExcess` would send it to the treasury with the rest. The admin then
  returns it to the creator by hand (the `LaunchBounced` event names the index and value; audit R7B-7).
- The admin has no power over tokens, pools, positions, taxes, splits, rewards or the buyback after
  a launch. Nobody does: the split and the tax wallet are fixed at launch. The Router address is
  immutable.

## Getters a web app needs

| Contract | Getter | Returns |
|---|---|---|
| Factory | `get_token_address(index)` | master address of launch `index` (0-based; `get_factory_data().nextIndex` = count) |
| Factory | `get_create_value(devBuy)` | exact value to attach to `CreateToken` without a vault; the excess comes back |
| Factory | `get_create_value2(devBuy, hasVault)` | the same, with `VAULT_GAS` (0.13 Gram) added when `hasVault` (vaultBps > 0) |
| Factory | `get_factory_data()` | admin, pendingAdmin, treasury, router, launchFee, params, nextIndex |
| Factory | `get_start_sqrt_price()` | start `sqrtPriceX96` at the current params (before the floor to the spacing) |
| Master | `get_jetton_data()`, `get_wallet_address(owner)` | TEP-74 |
| Master | `get_launch_info()` | creator, router, feeClaimer, tickSpacing, launchFeePips, launchDuration (the anti-snipe fee), sqrtPriceX96, taxRecipient (= master when taxed), buyTaxBps, sellTaxBps, **taxWallet, rewardsBps, walletBps, buybackBps, buybackCap**, createdAt, vaultBps, vaultLock, vaultVest |
| Master | `get_vault_address()` | `LaunchVault(master)`, or null when the token has no vault |
| Vault | `get_vault_data()` | beneficiary, total, claimed, start, lock, vest, unlockedNow, claimableNow |
| Vault | `get_vault_wallet()`, `get_vault_master()`, `get_claim_value()` | the vault's jetton wallet, its master, the minimum `ClaimVault` value |
| Master | `get_tax_data()` | taxIn (Gram split so far), the split, taxWallet, walletPaid, rewardsAccrued, buybackIn |
| Master | `get_rewards_data()` | scale (1e18), acc, totalShares (tracked supply), accrued (total rewards distributed), claimed, carry |
| Master | `get_pending_rewards(acked, lastAcc, frac, owed)` | pending rewards of a holder, from its wallet's `get_reward_state()` |
| Master | `get_harvest_value()` | minimum value of a caller-paid `Harvest` (0.24 Gram) |
| Master | `get_buyback_status()` | balance, nextAllowedAt, nextAmount, wouldRun, harvestDue, nextHarvestAt, nextCallerHarvestAt, cap, spent, burned, count |
| Wallet | `get_reward_state()` | synced, acked, lastAcc, frac, owed, inFlight (zeros when untracked) |
| Wallet | `get_pending_rewards(acc)` | the same pending amount, given the master's `acc` |
| Wallet | `get_tracked()` | false for the Router's wallet, the master's wallet, the creator vault's wallet, and every wallet of a token without holder rewards |
| Master | `get_pool_key()` | the canonical `PoolKey` (token0 = GRAM, token1 = Router wallet, spacing, ext cell) |
| Master | `get_router_wallet()` | the token id on the DEX (`token1`) |
| Router | `get_pool_address(GRAM, token1, spacing, ext)`, or `get_launch_pool_address(token1, spacing, master, launchFeePips, launchDuration, taxRecipient (= master or null), buyTaxBps, sellTaxBps)` | pool address |
| Router | `get_launch_key(...)` (same arguments) | the `PoolKey` |
| Pool | `get_quote(zeroForOne, amountIn, 0, 24, refBps, allowPartial)` | `amountOut` (**net of the sell tax**), `tax`, `feeTotal`, `consumed`, `refund`, price after, `code` (0 = would fill) |
| Pool | `get_pool_state()` | price, tick, reserves, `feePipsNow` (includes the launch-decay extra), `taxFees`, protocol fees |
| Pool | `get_position_address(0)`, Position `get_position_data()` | the locked launch position |

Buying sends `SwapNative{otherToken = token1, ext = key.ext, ...}` to the Router. Selling sends a
jetton transfer to the Router with a `SwapPayload{otherToken = GRAM, ext = key.ext, ...}`. Set
`minOut` from the quote: it is compared with the net amount, after any tax. Buy price in Gram per
token is `2^192 / sqrtPriceX96^2`. Market cap is `1e18 · 2^192 / sqrtPriceX96^2` nanoGram.

**Indexers:** the canonical pool of a launch token is the one whose `LaunchEvent.key` or
`InitializeEvent.initializer` is the token's master, and whose master was deployed by this
factory (`get_token_address(index)`). Anyone holding the token can create **other** keys for it
(with themselves as initializer, including taxed ones). Those pools are real, but they are not the
launch pool, and UIs must not show them as such.

## Creator vault

Optional, chosen per launch in `CreateToken`: `vaultBps` (≤ 5000 = 50%) of the supply is minted to
`LaunchVault(master)` (one per token, deterministic address) instead of the pool. The pool gets the
rest at the **same start price** (`sqrtPriceX96` does not depend on the amount); only its token
depth shrinks. The two mints sum to exactly 1e18.

- **Schedule.** `unlocked(t) = 0` before `start + lock`; then `total` when `vest = 0`, else
  `total * (t - start - lock) / vest`, capped at `total`. `start` is the launch time. Lock is 7 to
  365 days, vest 0 to 365 days (refused otherwise; the CreateToken bounces).
- **Claims.** Only the beneficiary (the creator at launch) sends `ClaimVault`; the vault sends
  `unlocked - claimed` from its wallet to the beneficiary (excess back). Nothing claimable throws.
  A bounced transfer makes the amount claimable again. `TransferVaultBeneficiary` hands the vault
  on. There is no admin and no other way to move the tokens.
- **Rewards.** The vault's wallet is never tracked (the wallets carry the vault address as an init
  parameter), so locked tokens do not dilute holder rewards. Claimed tokens land in the
  beneficiary's normal (tracked) wallet and earn from then on.
- **Gas.** `get_create_value2(devBuy, true)` adds `VAULT_GAS` 0.13 Gram: 0.05 stays in the vault and
  0.03 in its wallet as storage reserves; the rest covers the extra master compute and forward fees.

## Tax split

The DEX pays a pool's whole tax to one `taxRecipient` fixed in the key. For a taxed launch that
recipient is the token's **master**. Why the master and not a separate splitter contract:
- the wallets already know and trust the master, so the rewards checkpoints need no new address
  in every wallet and no extra deployment;
- the master already authenticates wallets (it has the wallet code), which the rewards tracker needs;
- the buyback's tokens land in the master's own wallet, which is excluded from rewards by
  construction, and the burn notification arrives at the master directly.

The payout is **automatic**: every swap that leaves the pool's `taxFees` at ≥ 0.1 Gram
(`TAX_MIN_PAYOUT`) sends the whole accrued tax to the master in that swap's transaction chain
(`GramPayout{reason = TAX, amount}`, value = amount + 0.04 for the split). Tax below 0.1 Gram stays
in the pool until the next such swap, or until anyone triggers it: `CollectTax` to the Router, or
`Harvest` to the master (value = the tax plus the caller's gas leftover). The master then, in the
same transaction:

```
x       = min(amount, value - 0.04)        (a forged payout splits only what it really carries)
rewards = x * rewardsBps / 10000           -> holder-rewards accumulator
wallet  = x * walletBps  / 10000           -> sent to taxWallet now ("Marg tax" comment, non-bounceable)
buyback = x - rewards - wallet             -> buyback bucket (it takes the rounding dust)
extra   = master balance above (0.05 storage + held + 0.04)   (gas leftovers, earlier skims)
          -> buyback bucket if buyback is on, else with the wallet payment, else to rewards
then: run the buyback if it is due
```

If buyback is off, the dust goes to the wallet share (or to rewards if that is off too). `held` is
the Gram the master owes: unclaimed rewards plus the buyback bucket. It never forwards that Gram
anywhere else. Every other Gram path (launch excess, plain transfers) keeps
`0.05 + held` and forwards the rest to the creator.

## Holder rewards

TON jettons are sharded wallets, so rebasing reflections are impossible. Rewards are paid **in
Gram**, with a dividend-per-share accumulator kept in the master, and per-holder state kept in each
holder's own wallet.

```
master: acc += (r * 1e18 + rem) / totalShares     (rem = the remainder, carried to the next accrual)
        if totalShares < 1% of the supply (v4): r goes to the bucket, else the tax wallet (the factory
        refuses holders-only splits, audit R10-1, so nothing is carried)
wallet, on each RewardAck{acc, delta}:
        x     = acked * (acc - lastAcc) + frac
        owed += x / 1e18 ;  frac = x % 1e18
        acked += delta ;    lastAcc = acc
pending = owed + (acked * (acc_now - lastAcc) + frac) / 1e18
```

- **Start threshold (v4, audit R8B-1).** Rewards accrue only once tracked holders together own at
  least 1% of the supply (`REWARD_MIN_SHARES`; the Router's pool wallet does not count), so one dust
  holder cannot take the whole share of the first buys. Until then the rewards share goes to the buyback
  bucket, else to the tax wallet. The factory refuses a holders-only split (holder rewards need a buyback
  or wallet share, audit R10-1), so no carry builds up; the carry path stays only as a fallback
  (released a tenth per accrual). A dev buy of at least 1% of the supply (about 30 Gram on the 2,600 tier) reaches it at
  once. (v3: carried only while `totalShares` is 0.)
- **Checkpoints.** A tracked wallet sends `RewardCheckpoint{delta = balance - synced}` in the
  same transaction as every balance change: transfer out, transfer in, burn. The master adds
  `delta` to `totalShares` and answers `RewardAck{acc}`. Messages between one pair of contracts
  arrive in order, so the acks reach the wallet in the order the master applied the checkpoints.
  The wallet therefore credits each interval at exactly the shares the master was using.
- **Claims.** `ClaimRewards` is allowed only while no checkpoint is in flight (`inFlight = 0`). The
  wallet sends its own state; the master adds what accrued since `lastAcc`, checks
  `claimed + pay ≤ accrued`, and pays `pay` plus the rest of the claim's value to the owner in one
  "Marg holder rewards" message. The wallet zeroes `owed` on the ack. A second claim while one is
  in flight is rejected by the wallet.
- **Not tracked:** the DEX Router's wallet (all pool liquidity, for every key of this token) and the
  master's own wallet (buyback tokens before the burn, a failed launch's supply). Burned tokens
  leave `totalShares` with the burn's checkpoint. A token with `rewardsBps = 0` has no tracked
  wallet at all: no checkpoints, no extra gas, the plain TEP-74 path.
- **Who pays:** the sender. A tracked wallet's `JettonTransfer` needs `2 × (0.03 + forward fee)`
  more when both sides are tracked (one checkpoint when the receiver is the Router, e.g. a sell). A
  receive pays its own checkpoint from the incoming value when that value is large enough. If it is
  not, the wallet stays *under-reported*: it earns on less than it holds until its next checkpoint
  or `SyncRewards`. DEX buys carry enough. Untracked senders (the Router's wallet) keep the old
  TEP-74 requirement, so DEX payouts never fail because of rewards.
- **Bounces.** A checkpoint or claim that bounces is un-done in the wallet (`synced -= delta`) and is
  reported again with the next checkpoint. Acks are non-bounceable.

**What it guarantees** (tested, including 4 seeds × 240 random operations delivered in random
order, keeping only the per-pair ordering TON guarantees):
- **Solvency.** The Gram owed to all holders is at most what was accrued: `Σ acked × Δacc ≤ amount ×
  1e18` at every accrual, and every claim is capped by `claimed + pay ≤ accrued`.
- **Exact in the tracker's view.** Each holder gets `floor(Σ over accruals of shares × r / totalShares)`,
  where `shares` is the holder's checkpointed balance at the moment the master applied the accrual.
  The difference to exact rational arithmetic is under 1 nanoGram per accrual (never more than the
  model plus 1 nanoGram). The floor dust stays in the master.
- **No double claim.** At most one claim is in flight per wallet, `owed` is zeroed only by the
  claim's own ack, and the master never pays more than the wallet's state plus the accrual since.
- **No reward on balance acquired after an accrual.** A receiver's shares count only from the
  master's processing of its checkpoint, which is sent after the tokens arrived.
- **What it does not guarantee.** Between a balance change and the master applying its checkpoint
  (one or two message hops), the master still uses the old balance. In that window a sender
  earns on tokens it already sent, and a receiver does not yet earn on tokens it holds. The *total*
  paid stays exact; only the split between those two holders shifts, for accruals that land
  inside the window. Under-reported wallets earn less than they would, never more.
- **Never-claiming wallets.** Their Gram stays in the master for good (counted in `held`). Pools on
  other DEXes, or any contract that cannot send `ClaimRewards`, accrue rewards they cannot claim.

## Buyback and burn

The bucket buys the token on its own Marg DEX v2 pool and burns what it gets:

```
master --SwapNative{amount, receiver = refundTo = master, fwdTon = 0.08, maxCrossings 24, allowPartial true}--> Router
  -> Pool -> Router -> RW -> master's wallet --JettonNotification--> master --JettonBurn--> master's wallet
  -> JettonBurnNotification -> master: totalSupply -= amount (get_jetton_data shows it), BurnEvent
gas leftovers (excess, burn receipt, refunds) carry queryId 0x4d4cbbbb.... and go back to the bucket
```

It runs **automatically** at the end of every tax payout when it is due, and anyone can call
`Buyback` to run a due one. The guards:

| Guard | Value |
|---|---|
| Interval | at most one buyback per 300 s |
| Cap per buyback | `buybackCap` = 1% of the **start** market cap (26 Gram at the default 2,600) |
| Minimum | 1 Gram (or the cap, if lower), after keeping `BUYBACK_GAS` |
| Crossings | 24 (the DEX cap) with `allowPartial`: dust LP positions on the path cannot make it refund; it swaps what 24 crossings allow, the rest returns to the bucket (partial refund, `spent` reduced). On spacing 10 a capped buyback moves ≤ ~200 ticks, so it crosses ≤ ~20 initialized ticks and always fills (test: 30 dust positions, 14 crossings). |
| Fees | the buyback is a normal buy: it pays the 1% platform fee (to the treasury) and the buy tax, which comes straight back to the master as a tax payout and is split again |
| Gas | 0.85 Gram attached (`BUYBACK_GAS`; the Router minimum on a taxed launch key for 24 crossings with allowPartial = 0.35 + 24 × 0.006 + 0.07 + 0.01 platform payout + 0.05 tax payout = 0.624, + 0.08 for the burn = 0.704, + 2 forward fees: margin 0.146; a test checks it against dex/v2 constants and `get_swap_gas`); the unused part comes back. Measured in the sandbox: the bucket paid 0.137 Gram beyond the amount for an automatic run and 0.158 for a manual run (incl. the 0.03 keeper fee). |
| Caller | refunded in full; `KEEPER_FEE` = 0.03 Gram from the bucket pays the master's compute and the refund |
| minOut | 0 today (see below). A caller-supplied minOut is **not** accepted: anyone could block buybacks with an impossible one. |

**Sandwich bound.** The pool's market cap can never fall below its start market cap (the only
liquidity below the start price is the locked jetton-only position). A 1%-of-start-mcap buyback
therefore moves the price by at most about 2%, and less as the token grows. A front-run + back-run
pays the 1% platform fee and the LP fee twice (each way) plus both taxes, so it loses money. The
test (spacing 10, 1% / 1% tax) measured a 0.63% price impact and a loss of 21.9 Gram for a 500 Gram
sandwich. The platform fee alone (2% round trip) exceeds the ≤ ~2% move of a capped buyback.

**Price guard later.** `buybackMinOut()` is the single place for a price check. When the DEX
`PoolObserve` read message is live, the master can send `PoolObserve`, take the TWAP from
`tickCumulative` in `PoolObservation`, and set `minOut` (or a `sqrtPriceLimitX96`) from it. The
cap could then also scale with the TWAP market cap instead of the start market cap. Not done: it
is not available yet.

**Keeper bot.** Taxes of 0.1 Gram or more are paid out inside the swaps themselves, so the split
and the buyback run without a keeper while the token trades. `Harvest` collects what is left below
the threshold (and runs a due buyback) on a quiet token:

- Once `now ≥ nextCallerHarvestAt` (60 s after the last harvest), send `Harvest` with
  ≥ `get_harvest_value()` (0.24 Gram): the keeper pays the 0.21 Gram `CollectTax` gas and the 0.03
  Gram fee, the rest is refunded. It is worth it only when enough tax waits in the pool (the keeper
  harvests at ≥ 10x its cost). This works for "Holders" and "Wallet" splits too (buybackBps = 0). The
  Router's leftover goes to the bucket (buyback on), else the tax wallet, else the holders. v4: there
  is no bucket-paid harvest any more (`harvestDue` is always false): it let anyone spend the bucket
  hourly with no tax pending.
- If only `wouldRun`, send `Buyback`.
- Anyone can also call the Router's `CollectTax` directly with their own gas.

## Gas and costs (sandbox)

Measured in `launch/tests`:

| Step | Compute gas |
|---|---|
| Factory `CreateToken` | 25,952 (was 22,733 before the split and anti-snipe fields) |
| Master `LaunchSetup` (+ excess forward) | 26,059 (+ 28,935) (was 16,047 + 9,050: larger master storage) |
| Router wallet (internal transfer) | 8,391 |
| Router (`LaunchPayload` → `PoolLaunch`) | 31,864 |
| Pool: launch only | 106,688 (DEX test) |
| Pool: launch + dev buy | 205,572 (DEX test), 220,912 (full chain, 100 Gram) |
| Pool: taxed launch + dev buy | 205,729 |
| Whole chain with dev buy: transaction fees | 0.034 Gram (sandbox gas price; mainnet compute is about 6 times higher) |

Tax split, rewards and buyback (compute gas; the sandbox charges ~66.7 nanoGram per gas, the
constants assume 400 with a 1.5× margin or more):

| Step | Gas | Extra Gram to attach |
|---|---|---|
| Transfer, no rewards (sender / receiver wallet) | 9,818 / 10,362 | none (unchanged) |
| Transfer, rewards on (sender / receiver wallet) | 14,795 / 13,811 | `2 × (0.03 + fwd fee)` |
| … + master checkpoint, ×2 | 32,676 each | (in the above) |
| … + wallet ack, ×2 | 6,225 each | (in the above) |
| Checkpoint round trip at 400 nanoGram/gas | 0.0171 Gram | `CHECKPOINT_VALUE` = 0.03 |
| Transfer chain, total fees (sandbox) | 0.0034 → 0.0096 Gram | |
| Claim: wallet / master / ack | 8,182 / 38,792 / 5,939 | ≥ 0.04 (the rest comes back) |
| Tax payout: split + auto-buyback send (master) | 57,437 | from the payout's value |
| Buyback chain at the master: notification / excess / burn receipt | 32,414 / 22,306 / 29,974 | from the bucket |
| `Buyback` trigger / `Harvest` (master) | 46,580 / 35,690 | refunded; bucket pays 0.03 |

Values to attach (code constants):
- `CreateToken`: `launchFee + devBuy + 0.70 Gram`, plus `0.17 Gram` when `devBuy > 0`. Use
  `get_create_value`.
- The Router requires a forwarded `devBuy + 0.50 Gram` (`LAUNCH_GAS`) plus `0.15 Gram`
  (`DEV_BUY_GAS`) with a dev buy, plus two forward fees. The factory sends `0.55` and `0.17`.
- The Pool's dev-buy check includes the payout gas (0.01 platform, + 0.05 when taxed). At exactly
  `get_create_value2(100 Gram, vault on/off)` the measured Pool margin is 0.207 Gram (untaxed) and
  0.157 Gram (taxed); the Router margin is 0.07 Gram before its 2 forward fees. No factory change
  was needed.
- The measured minimum was 0.5004 Gram (0.6504 with a dev buy). At exactly that minimum the
  launch succeeds with no failed transaction.

Without a dev buy, a launch cost the creator **0.42 Gram on top of the launch fee**. Most of that
stays on-chain as storage:
- 0.2 Gram: the pool's permanent `TICK_INIT_FEE` endowment for 2 ticks;
- 0.04 Gram: the tick rent buffers;
- 0.03 Gram: the Position NFT;
- 0.05 Gram: master storage.

The rest is fees. Unused gas comes back to the creator.

## Build and test

```sh
cd /Users/basedtoni/Tron
npx tact --config dex/v2/tact.config.json     # the DEX (the tests deploy its Router)
npx tact --config launch/tact.config.json     # 3 contracts: LaunchFactory, LaunchJetton, LaunchWallet
npx jest launch/tests                         # 42 tests (launch.spec 14, tax.spec 20, vault.spec 8), about 4 min
```

## Open risks

- **Audit.** This adds a new entry to the DEX Router and Pool (launch and tax) and three new
  contracts. None of it has had an external review.
- **Canonical-pool spoofing.** Pools with another initializer can exist for the same jetton (see
  Indexers above). This is by design on a permissionless DEX.
- **Failed launch.** If the DEX pauses pool creation, or the factory points at a spacing that has
  no preset, launches fail. The supply is stranded in the master's own wallet (burned in effect)
  and the token has no pool. Gram is returned. Check `get_preset` before changing params.
- **Rent.** The locked Position NFT holds 0.02 Gram. An NFT that is never claimed for many years can
  freeze (DEX README gap 2). The treasury should claim periodically or top the NFT up.
- **Tax wallet** is fixed at launch. Its share is sent non-bounceable; a wallet that cannot receive
  Gram loses it.
- **Rewards: the in-flight window.** Rewards follow the *checkpointed* balance (see Holder rewards).
  Accruals that land between a transfer and its checkpoints favour the sender over the receiver.
  Totals stay exact.
- **Rewards: a checkpoint that fails at the master.** The scheme assumes a genuine checkpoint is
  always applied. It can only fail by running out of gas, which `CHECKPOINT_VALUE` (1.75× at
  400 nanoGram/gas) prevents. If one did bounce while a later checkpoint from the same wallet was
  already in flight, that holder's share in `totalShares` could be off by the bounced delta until
  the next checkpoint. Claims stay capped by `accrued`, so the error cannot drain other holders'
  Gram beyond what was accrued, but the last claimers could be short.
- **Rewards: a lost ack.** If a wallet could not process an ack (for example a wallet frozen by
  unpaid rent), its `inFlight` stays above 0 and it can never claim again. Wallets keep a 0.01 Gram
  storage buffer; very old empty wallets should be topped up.
- **Rewards on other DEXes.** Pools of this token on other DEXes, CEX deposit wallets, and other
  contracts are tracked like any holder. Their rewards stay unclaimed in the master.
- **Gas constants** are sized from sandbox gas at 400 nanoGram/gas. Re-measure on testnet before
  any deployment; a too-small `CHECKPOINT_VALUE` would cause the failure above.
- **Buyback price guard.** No TWAP check yet (see Buyback). The guard is the cap (1% of the start
  market cap), the 300 s interval, and the swap fees (the 1% platform fee each way included).
- **Buyback queryId tag.** A launch whose `CreateToken.queryId` has the high 32 bits `0x4d4cbbbb`
  sends its launch excess to the bucket instead of the creator.
- **Tokens sent to the master.** With forward_ton and buyback on, they are burned (counted in
  `burned`). Without forward_ton they sit in the master's untracked wallet for good.
- **Bucket drain by keepers.** v3 only: a due bucket-paid `Harvest` that finds no tax costs the bucket
  about 0.05 Gram (cap 0.24) at most once per hour. v4 has no bucket-paid harvest (always caller-paid).
- **Integrators: long-idle wallets.** A rewards-token wallet idle for more than about 2 years (live v3
  wallets in particular) may owe more rent than its stored balance shows. Before making it claim, send
  or sell, top it up with a plain 0.05 Gram transfer in the same transaction, as the app does (audit C8).
- **Content** is stored as given (TEP-64 cell). The factory does not validate metadata.

## v3 changes

v3 is the current deployment (factory `EQD3iwBt…`); tokens of the v2 factory (git tag `mainnet-v2`) keep
their v2 contracts.

- `LaunchFactory` init takes the DEX Pool code hash and depth (`get_pool_code()`); every master
  derives its own pool address (`get_pool_address()`) and accepts tax payouts only from it.
- The launch fee is held by the master until the launch completes, and refunded with the rest when it
  fails. A bounced `LaunchSetup` is refunded by the factory (event `LaunchBounced`, 0x4d4c0025).
- The master settles the launch fee only on outcomes nobody else can cause: the Pool's launch refund
  reasons (17 refused, 18 dev buy refunded), its own excess, the dev payout's excess, the supply
  coming back, or the timeout.
- Creator, tax wallet and other addresses must be basechain; the tax wallet may not be the vault,
  master, factory or Router. `TakeWalletAddress` answers addr_none for owners that cannot have a wallet.
- Reward message values are priced from the gas config: `get_reward_values()` on the master and the
  wallet, and `get_transfer_fee(destination)` on the wallet. An underfunded reward message bounces.
- No buyback runs before the anti-snipe window has ended (`get_buyback_status().nextAllowedAt`).
- New getter `get_launch_state()` on the master. The fee converter can claim its own holder rewards
  (`ClaimJettonRewards`, 0x4d46000a) and keeps a larger swap margin (`get_convert_value`).

## v4 changes (holder rewards and rent)

v4 keeps the v3 rewards design (per-holder state in each wallet, checkpoint and ack) and hardens it.
A master-side per-holder ledger was tried and dropped: it let dust entries make a holder's reports run
out of gas and could fill the master's state (internal audit round 5).

- **Storage debt.** Every tracked send (transfer, burn, claim) keeps 0.01 Gram in the wallet plus any
  storage debt (`myStorageDue()`), paid from the incoming value; receives do the same. An ack can no
  longer be eaten by a debt from years of inactivity. Acks also carry a 0.002 Gram cushion.
- **Gas-price headroom.** Checkpoint and claim values carry 2x the compute they pay for (the master
  requires 1x and returns the rest with the ack), so a gas-price rise of up to ~3x while one is in
  flight is absorbed. A tracked transfer still fits in the standard 0.05 Gram.
- **Re-sync.** `SyncRewards`, from anyone (the caller pays), reports the wallet's balance again; the
  rest of the caller's value comes back and the wallet keeps its own Gram. A keeper uses it to repair
  wallets after a large gas-price change. Shares are signed (`acked` is never clamped), so a
  bounced checkpoint followed by a re-sync always ends at the wallet's real balance.
- **Transfers never destroy tokens.** A receive whose value cannot pay the notification bounces the
  whole transfer back to the sender, whose wallet returns the transfer's Gram to its owner.
- **Claims** are capped by what is left of the accrued rewards; anything not paid stays owed.
- **Long-idle wallets.** `get_transfer_fee` and `get_reward_values` include the storage debt already
  recorded, but not the rent of an idle period that no transaction has charged yet. On a wallet idle
  for years, a call with exactly those values is refused and bounces (nothing moves); top the wallet
  up first (a plain 0.05 Gram transfer, as the app does) or attach a margin.
- **Lost messages.** A checkpoint ack carries the checkpoint's leftover and a claim ack 4x its compute,
  so both survive a gas-price rise of ~15x while in flight. A wallet whose ack is nevertheless lost
  stays unable to claim (its `inFlight` never returns to 0); nothing is paid twice and other holders
  are not affected. There is deliberately no reset: without per-holder state in the master a reset
  could not know what the master applied, and an internal audit showed it could pay a holder twice.
- **Master rent fund.** Each tax payout first tops `rentFund` up to 0.25 Gram from the rewards share
  (`TaxSplitEvent.rent`; about 10 years of a master's rent); a plain Gram transfer to the master tops it
  up too (the rest goes to the creator). Rent is taken from it, never from
  holders' rewards, the buyback bucket or the launch-fee escrow while it lasts. A claim never takes
  the master below its storage minimum; what cannot be paid stays owed (`RewardAck.owed`).
