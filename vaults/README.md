# Marg liquidity vaults

Managed concentrated-liquidity vaults (in the style of Kamino, Arrakis and Charm) on top of
[Marg DEX v2](../dex/v2/README.md). Users deposit Gram, USDT or both, and receive a share jetton.
The vault keeps the liquidity in a base range around the TWAP price and puts leftovers in a
single-sided limit range. It compounds fees on every rebalance, and anyone can always exit in kind.

This is a sandbox build. Nothing has been deployed, and the code needs an external audit before
mainnet. `DESIGN.md` is the specification; its §14 records what changed during the build and
every self-review finding.

## How it works on the canonical pool

A TON contract cannot read another contract's state. The vault uses the additive DEX messages of
[dex/v2 DESIGN §6.14](../dex/v2/DESIGN.md) (DESIGN §0):

| Need | How the vault gets it |
|---|---|
| Spot price and TWAP | `PoolObserve` → `PoolObservation` from the canonical pool: spot and the pool's own `tickCumulative`. The TWAP is the pool's exact time-weighted tick between a stored anchor and a fresh observation. Only the real pool can answer, and it answers only the vault's own requests. |
| Uncollected fees (in NAV) | The same observation's `feeGrowthInside` for each position's range, against the position's fee checkpoint. |
| Results of its mints and burns | `MintReceipt` (sent only to the payer) and `BurnReceipt` (sent by the vault's own NFT once it is free). |
| Gram and USDT coming back | `GramPayout`, and notified USDT transfers (`sender = Router`) from the vault's own wallet. No balance probe. |

The vault's key is the canonical plain key `{GRAM, RW(USDT), spacing, ext = null}`:
- several vaults (strategies, `salt`) can share it, each with its own NFTs and books;
- swappers pay the plain-pool price (no hook notification) and never touch a vault;
- the vault initializes the pool only if nobody has.

## Contracts

| File | Content |
|---|---|
| `contracts/vault.tact` | `Vault`: share master (TEP-74 / TEP-89), owner of up to a few Position NFTs, state machine. Storage is split: the *hot* fields (pool, wallet, router, the NFT address set) are all the pre-accept checks of DEX replies touch; the rest is one *cold* cell. `VaultWallet`: the share wallet (the launchpad's TEP-74 wallet; a refused burn also returns the attached Gram). |
| `contracts/messages.tact` | Vault messages (`0x5641xxxx`), events and getter structs |
| `contracts/dex_types.tact` | Verbatim copies of the DEX / TEP-74 types the vault speaks (checked byte-for-byte by a test) |
| `contracts/vault_math.tact` | Verbatim copy of the v3 math (checked against dex/v2's `MathHarness`) |
| `contracts/mocks/vault_math_harness.tact` | Test-only getters over the copied math |

## Flows

| Flow | Message | Notes |
|---|---|---|
| Setup (admin, once) | `VaultSetup{poolCode, positionCode, content}` | The code hashes must match the init params. The wallets are discovered via TEP-89 and the canonical pool address is computed on-chain. |
| Open (admin, once) | USDT transfer with `OpenPayload{gramAmount, sqrtPriceInitX96}` | Observes the pool: mints the first base range at the pool price (which must be within `maxDeviation` of the admin's), or initializes the pool at the admin's price if nobody has. Mints `DEAD_SHARES` plus the seed shares (≥ 10 USDT of value). |
| Deposit Gram | `DepositNative{amount, minShares, receiver?}`, value ≥ amount + 0.35 | Accepted when the vault is quiet, then priced on its own fresh observation; a refusal refunds. |
| Deposit USDT (+ Gram) | USDT transfer, `forwardTonAmount ≥ gram + 0.35`, `DepositPayload{gramAmount, minShares, receiver?}` | Same; a refusal refunds both legs. |
| Withdraw | `JettonBurn` on your share wallet, value ≥ 1.6 (most is refunded) | FIFO queue. The positions' fees are collected first; you then get `shares/supply` of the idle Gram and USDT, and the same fraction of every position's liquidity straight from the Pool. A refusal restores the shares and the Gram. |
| Rebalance (keeper, or anyone if no keeper) | `Rebalance{}`, value ≥ 3.5 (most is refunded) | Checked on its own observation (TWAP ready, deviation, needed), then closes all positions, settles, mints base + limit around the TWAP. A refusal is a `RebalanceEvent{stage 5, code}` and a refund. |
| Refresh the oracle / unstick (anyone, paid) | `Poke` | An observation (TWAP anchor); proceeds a withdrawal whose fee payout is late; tops up a running budget. |
| Abort a stalled rebalance (anyone) | `AbortRebalance` after 30 min | Late messages still reconcile. |
| Pay the performance fee (anyone) | `CollectFees` | Pays the treasury only. |

**Pricing.** A deposit gets `min(quote at the TWAP, quote at the spot)` on an observation the vault
requested after the deposit arrived. NAV includes the positions' uncollected fees (net of the
performance fee). Deposits are refused unless the spot is within `maxDeviation` ticks of the TWAP
and the TWAP has a full window of history. Withdrawals are in kind and pro-rata: no price at all.

**Mid-rebalance / mid-withdrawal.** Deposits are refused (refunded). Withdrawals are queued with
prepaid gas and run when the rebalance ends (worst case: the 30-minute abort timeout).

**Fees.**
- Performance fee: 10% by default (hard cap 20%) on collected LP fees of both tokens, booked from
  the DEX receipts. No management fee, no keeper claims.
- Admin powers: lower / raise the fee within the cap, set the keeper, set the treasury, pause new
  deposits, change strategy parameters within hard caps, two-step admin transfer. No admin path
  moves funds or blocks withdrawals.

## Build and test

```sh
cd <repo root>
npx tact --config vaults/tact.config.json     # Vault, VaultWallet, VaultMathHarness -> vaults/build
npx jest vaults/tests                         # 43 tests, 10 suites (~5 min)
PRINT_GAS=1 npx jest vaults/tests/gas.spec.ts # gas table
VAULT_SEED=7 npx jest vaults/tests/invariant.spec.ts   # another random seed
```

The tests use the **real** dex/v2 Router, Pool and Position, and dex/v2's mock jetton as USDT with
6 decimals. They import dex/v2's test helpers and model read-only.

| Suite | Covers |
|---|---|
| `math` | The copied v3 math against dex/v2 (300 random vectors per function, `subMod`). Byte-equal serialization of every copied DEX type. Pool, Position and share-wallet addresses derived on-chain; the key is the canonical `ext = null`. Setup refusals. |
| `smoke` | Setup, opening (initializing the canonical pool), deposit, withdrawal and rebalance end to end; swaps never touch the vault. |
| `deposit` | Gram, USDT and both against the BigInt reference model (TWAP from the pool accumulator); NAV including uncollected fees; NAV per share preserved; `minShares`; TWAP not ready; paused; low gas; unknown payloads; forged notifications; share transfers. |
| `withdraw` | Exact pro-rata in kind against the model (fees collected first, perf fee exact); the queue behind a running withdrawal; refusals; withdrawals while paused. |
| `rebalance` | Threshold and out-of-range rebalances; refusals (not needed, not ready, deviation, keeper, gas, too soon); fee compounding of both tokens without claims (exact 10%); deposits and withdrawals mid-rebalance; abort with late reconciliation. |
| `security` | Forged observations, receipts, payouts and excesses; a deposit priced only on its own observation (forged one refused, delayed one refunded); DEX donations are surplus, never fees; a mint made for the vault by someone else; a bounced decrease; first depositor; donation inflation; `minShares` against a front-run; admin caps. |
| `async` | A user decrease that fails at the Pool (retried, paid once); payouts overtaking their receipt (counted once, perf fee once); a never-arriving fee payout (Poke proceeds); deposits priced at min(TWAP, spot). |
| `multi` | Two vaults on one key (independent positions, deposits, withdrawals, fees and rebalances); a plain swapper pays no hook fee and never touches a vault. |
| `invariant` | 220 seeded random operations (deposits, withdrawals, swaps, rebalances, DEX donations, pokes, fee collections, time jumps). After each: solvency, NFT = vault liquidity and checkpoint, nothing in flight, exact shares and payouts against the model, NAV per share non-decreasing for the remaining holders. Finally everyone exits. |
| `gas` | Every handler's compute gas at 400 nanoGram/gas against the value that pays it (≥ 1.5×); user and keeper net costs; the vault's gas buffer must not shrink over a rebalance; pre-accept paths. |

## Gas (sandbox compute gas; Gram at the 400 nanoGram/gas mainnet price)

| Flow | Vault gas | Gram | Paid by |
|---|---|---|---|
| Swap by someone else | 0 | 0 | — (no hook) |
| Deposit: entry / pricing on the observation | 69–86k / 122k | 0.035 / 0.049 | depositor (`DEPOSIT_GAS` 0.35, rest refunded) |
| Withdraw: largest vault tx (BurnReceipt) | 181k | 0.072 | withdrawer; **net user cost ≈ 0.15 Gram** |
| Rebalance: largest vault tx (last arrival → both mints) | 216k | 0.087 | keeper budget; 28 txs; **keeper net ≈ 1.19 Gram**, mostly the DEX's `TICK_INIT_FEE` |
| BurnReceipt pre-accept (hot NFT set) | 4.2k | 0.0017 | the message's own value |

## Limitations and open risks

See DESIGN §14.6. In short:
- deposits are refunded if positions change while their observation is in flight (seconds);
- withdrawals are serialized (one at a time, queue of 32) and collect fees first;
- a DEX payout that never arrives stays in `exp` until it does (a rebalance then needs an abort);
- after a quiet period the TWAP needs a `Poke` and one window before rebalancing;
- rent over years of inactivity (nothing refills the buffer automatically);
- the real USDT wallet's notification behaviour and freeze powers must be checked before mainnet.
