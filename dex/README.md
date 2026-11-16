# Marg DEX

A constant-product (x*y=k) AMM on TON, where the native coin is called **Gram**. It is built to
compete with STON.fi v2. The main difference is that **pools hold Gram natively**: there is no
wrapped-TON (pTON) jetton and no extra hop. Jettons sit in the Router's jetton wallets, the same
way STON.fi does it.

> **Status: MVP, sandbox only.** Nothing has been deployed to any network, and the contracts
> have not been audited. Do not put real funds into them. "What is NOT done" below lists what
> mainnet still needs.

`DESIGN.md` is the full specification: flows, message layouts, the threat model, the math, and
the change log in sections 13 to 15.

## What exists

| Contract | File | Role |
|---|---|---|
| `Router` | `contracts/router.tact` | Single entry point. Owns the DEX's jetton wallets and parses swap and deposit payloads. Deploys each pool deterministically per sorted pair on first use. Sends jettons only when an authenticated pool tells it to (`PayTo`). Admin functions live here. |
| `Pool` | `contracts/pool.tact` | One per sorted pair: jetton/jetton, or (GRAM, jetton) with the Gram reserve held in the contract. Handles swaps (exact-in), adding and removing liquidity, and protocol-fee accrual. Also the TEP-74 LP jetton master, with TEP-64 on-chain metadata and TEP-89 wallet discovery. |
| `LpWallet` | `contracts/lp_wallet.tact` | TEP-74 wallet for a pool's LP token. Transfer and burn; a burn with `RemoveParams` sets the minimum outputs and a deadline. |
| `LpAccount` | `contracts/lp_account.tact` | Two-step deposit account, one per (pool, user), like STON.fi's. Holds one side until the other arrives. The owner can refund it. |
| shared | `contracts/messages.tact`, `contracts/constants.tact` | Messages, the fee and gas constants, and the pure math. Getters and receivers call the same math functions, so quotes match execution exactly. |
| mocks (tests only) | `contracts/mocks/` | A plain TEP-74 test jetton, and a fake wallet that forges notifications or rejects transfers. |

**Flows**
- **Swap, exact in**, in all three directions (Gram→jetton, jetton→Gram, jetton→jetton). Every
  swap has `minOut` and `deadline`, an optional `receiver` and `refundTo`, an optional referral,
  and an optional `fwdTon`/`fwdPayload` delivered with the output. Any failure refunds the input
  and emits a `RefundEvent` with a code.
- **Add liquidity**, in three ways: two-step through an LpAccount (one side per message, in any
  order); a dual deposit in one jetton transfer (`ProvideBothPayload`, where the Gram rides as
  the forward value); or native Gram through `ProvideLpNative`. Every deposit has a minimum LP
  out and refunds the unused side. The first deposit locks `MIN_LIQUIDITY` (1000) LP forever.
- **Remove liquidity**: burn LP and get both assets back pro rata. Minimum outputs and the
  deadline are checked, and a failure restores the LP through the bounce.
- **Graduation, for a launchpad**: one jetton transfer carrying `ProvideBothPayload` with
  `lpReceiver` set to the zero address (LP locked forever) and `requireEmpty = true` (refund if
  someone created the pool first). The payload fits in one cell, so it can be built by hand.
- **Admin**: set pool fees within hard caps, pause pool creation, change the treasury, and
  transfer admin in two steps (with cancel). Anyone can trigger fee collection, but fees always
  go to the treasury. Admin can sweep Router gas excess but can never touch pool or LpAccount
  funds.

**Getters**
- Router: `get_pool_address(a, b)`, `get_lp_account_address(a, b, user)`, `get_router_data`,
  `get_gram_token`, and `get_payload_fee(fwdPayload)`, the extra value to attach for an output
  payload.
- Pool: `get_pool_data` (reserves, supply, fees), `get_expected_out(tokenIn, amountIn, refBps)`,
  `get_expected_lp(a0, a1)`, `get_expected_burn(lp)`, `get_lp_account_address(user)`,
  `get_wallet_address(owner)` (the LP wallet), and `get_jetton_data`.

A token is identified by **the Router's own jetton wallet address for it**. Gram is identified
by the zero address, which always sorts first.

## Build and test

Run these from the repository root, `/Users/basedtoni/Tron`. They use the packages already in
the root `node_modules`: Tact 1.6.13, @ton/sandbox 0.45, and jest with ts-jest.

```sh
npx tact --config dex/tact.config.json    # compile to dex/build (wrappers: Router_Router.ts, Router_Pool.ts, ...)
npx jest dex/tests                         # 10 suites, 112 tests, sandbox only
PRINT_FEES=1 npx jest dex/tests/gas.spec.ts   # print per-flow fee tables
```

| Suite | Tests | Covers |
|---|---|---|
| `swap.spec.ts` | 25 | All directions against an independent BigInt model, referrals, every refund code, fwdTon/payload delivery, and the exact minimum gas (minimum − 1 is refused) |
| `liquidity.spec.ts` | 24 | First and later deposits, the MIN_LIQUIDITY lock, unused-side refunds, LpAccount refund, creation pause, burns, LP transfers |
| `admin.spec.ts` | 10 | Fee caps, auth, two-step admin, treasury, sweep safety, fee collection |
| `graduation.spec.ts` | 8 | Hand-built payload, LP locked at zero, `requireEmpty` against squatters, a lying forward amount |
| `security.spec.ts` | 18 | Forged notifications and internal messages, donations, overflow, bounces, dust and griefing |
| `getters.spec.ts` | 6 | Every getter, TEP-64, TEP-89 |
| `invariant.spec.ts` | 1 | 200 seeded random operations. Checks the model, that k and the LP share value never decrease, and exact solvency |
| `gas.spec.ts` | 1 | The measured worst case of each flow against its gas constant |
| `review.spec.ts` | 14 | Regression tests for the external review (DESIGN.md §15) |
| `smoke.spec.ts` | 5 | End-to-end happy paths |

## Fee model

All fees come off the **input** of a swap:

| Fee | Default | Hard cap | Goes to |
|---|---|---|---|
| LP fee | 0.25% (25 bps) | 1% | Stays in the reserves, so LP holders earn it |
| Protocol fee | 0.05% (5 bps) | 0.5% | Accrues in the pool; `CollectProtocolFees` sends it to the treasury |
| Referral fee | 0 (chosen per swap) | 0.1% (10 bps) | Paid immediately to the `referral` address in the swap payload |

The output is `inWithFee * rOut / (rIn * 10000 + inWithFee)`, where
`inWithFee = amountIn * (10000 - lp - protocol - ref)`. It rounds in the pool's favour. Admin
sets fees per pool, and both the Router and the Pool check the caps.

There is **no creator fee** and no launchpad-specific fee in the DEX.

**Gas to attach.** Unused gas always comes back as excess.

| Flow | Minimum value (on top of the amount) |
|---|---|
| Swap | `SWAP_GAS` (0.2) + `fwdTon` + `get_payload_fee(fwdPayload)` + 2 × the inbound forward fee. Add `JETTON_PAYOUT_VALUE` (0.07) when a jetton-in swap pays a referral |
| One-sided deposit | `PROVIDE_GAS` (0.3) + 2 × forward fee |
| Dual deposit / graduation | `gramAmount` + `PROVIDE_BOTH_GAS` (0.25) + 2 × forward fee |
| Burn | `BURN_GAS` (0.25) on the LP wallet |

The constants have 3× to 20× margin over the measured worst cases (see DESIGN.md §14), and they
can be lowered after an audit.

## Integration notes

- A **receiver, refundTo, lpReceiver, referral or treasury** can never be the Router. Such a
  swap or deposit is refunded with code 215, or the message throws `"Invalid recipient"`.
  Multi-hop and zaps therefore need a proper `next`-hop design (Phase 2); they cannot be done by
  sending the output to the Router.
- An output `fwdPayload` may be at most 32 distinct cells. When a payout's value cannot cover
  `fwdTon` and the payload, the jettons are still delivered, without the notification, and code
  216 is emitted.
- A contract that deposits for many users through one-sided provides shares a single LpAccount.
  Such contracts should use `ProvideBothPayload` instead.
- Refund codes (`RefundEvent.code`) are in `contracts/constants.tact`, 201 to 216.

## What is NOT done yet (before mainnet)

**Security and operations**
- **An external audit** of all four contracts, plus a formal review of the gas and bounce paths.
- **Payouts to broken jettons.** If a jetton wallet rejects a valid transfer (a frozen,
  blacklisted or malicious jetton), that payout stays stranded in the Router's wallet; only an
  event (214) records it. A tracked "stranded" ledger with a claim or rescue path is still to be
  designed.
- **Gas config.** The gas constants are fixed. If the network fee config changes, they need a
  Router upgrade path (there is none) or must be derived from the on-chain config.
- **No upgradability or emergency pause for swaps.** Only pool creation can be paused. Admin
  should be a multisig, and a timelock on fee changes is still to be added.
- **Testnet deployment and a mainnet-config fee run**, using a deploy script with the admin and
  treasury set to multisigs. None exists, on purpose.
- **Cheaper Router→Pool messages.** Each one carries the 7.2 KB Pool StateInit, about 40% of a
  swap's fees. The fix is a bounceable `PoolSwap` with refund data in the bounce, or a library
  cell (DESIGN.md §15, finding 4).
- **Jettons with non-standard wallets.** Fee-on-transfer, rebasing, and wallets with stricter
  gas checks than the standard one are only partly exercised by the mocks.

**Product**
- **Routing and multi-hop:** a `next` hop in `SwapPayload`, an off-chain path finder, and zaps.
- **Frontend:** a swap/pool UI with TON Connect, quotes from the getters, slippage and deadline
  settings, and LP positions.
- **SDK:** a TypeScript SDK that builds payloads (`storeSwapPayload` etc. from `dex/build`),
  computes the gas, and parses events.
- **Indexer and API:** pool list, prices, TVL, volume, APR, and history from `SwapEvent`,
  `LiquidityEvent` and `RefundEvent`; token lists and metadata.
- **More pool types:** stable-swap curve and concentrated liquidity.
- **Referral vaults** (accrue instead of paying out per swap) and farming or incentives.
- **Launchpad hook-up:** the launchpad's graduation must send `ProvideBothPayload` to this
  Router. That code lives outside `dex/` and has not been changed here.
