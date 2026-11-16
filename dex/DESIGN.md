# Marg DEX: design (MVP)

A constant-product AMM on TON (the native coin is **Gram**). It competes with STON.fi v2 and
differs from it in one main way: **Gram is held natively by the pool.** There is no wrapped-TON
jetton and no pTON hop. Jettons are held by the Router's jetton wallets, the same way STON.fi
does it.

Target toolchain: Tact 1.6.13, @ton/sandbox 0.45, jest + ts-jest. Everything lives under `dex/`.

---

## 0. Layout and build

```
dex/
  DESIGN.md
  tact.config.json            # projects below, output ./dex/build
  contracts/
    messages.tact             # every message/struct in this doc (standard jetton ones copied, NOT imported from ../contracts)
    constants.tact            # global consts + small pure helpers (sortKey, gram(), fee math)
    router.tact               # contract Router   (imports pool.tact)
    pool.tact                 # contract Pool     (imports lp_wallet.tact, lp_account.tact)
    lp_wallet.tact            # contract LpWallet (TEP-74 wallet for the pool's LP jetton)
    lp_account.tact           # contract LpAccount (pending one-sided deposits)
    mocks/test_jetton.tact    # TestJettonMaster + TestJettonWallet (plain TEP-74, owner-mintable), tests only
    mocks/fake_wallet.tact    # FakeJettonWallet: sends arbitrary JettonNotification / forged messages, tests only
  build/                      # generated
  tests/
    helpers.ts                # fixture: chain, router, 2 test jettons, wallet lookups, gas printing
    swap.spec.ts  liquidity.spec.ts  graduation.spec.ts  admin.spec.ts  security.spec.ts  getters.spec.ts
```

`dex/tact.config.json` (paths are resolved relative to the config file, i.e. `dex/`; confirmed
on the first compile):
```json
{ "projects": [
  { "name": "Router",    "path": "./contracts/router.tact",          "output": "./build", "options": { "debug": false, "external": false } },
  { "name": "TestJetton","path": "./contracts/mocks/test_jetton.tact","output": "./build", "options": { "debug": false, "external": false } },
  { "name": "Fake",      "path": "./contracts/mocks/fake_wallet.tact","output": "./build", "options": { "debug": false, "external": false } }
] }
```
Compile with `cd /Users/basedtoni/Tron && npx tact --config dex/tact.config.json`.
Test with `npx jest dex/tests`.
The Router project emits `Router_Router.ts`, `Router_Pool.ts`, `Router_LpWallet.ts` and
`Router_LpAccount.ts`, the same way the launchpad gets `Factory_TokenMaster.ts`.

Tact facts checked against 1.6.13 with a scratch compile:
- `const GRAM: Address = address("0:00…00");` works.
- `try { … } catch (e) { … }` works.
- `sqrt()` exists in the stdlib.
- `bounced(msg: Slice)` works as a catch-all.
- A message larger than 1023 bits is split automatically: the fields that do not fit go into a
  ref cell. Off-chain code must use the generated `storeX` helpers. Anything built by hand (the
  launchpad) must use a payload that fits in a single cell. `ProvideBothPayload` is designed to
  fit (847 bits).

---

## 1. Key decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | **A token is identified by the Router's jetton wallet address for that token.** Gram is identified by the sentinel `GRAM = 0:0000…0000` (hash 0). | The Router never needs the jetton's wallet code. The trust anchor is `sender()` of a `JettonNotification`. A forged notification can only create or credit a pool keyed by the forger's own address, and no honest pool contains that address. STON.fi uses the same approach. |
| D2 | **A pair is sorted by the 256-bit account id** (`parseStdAddress(a.asSlice()).address`). `token0 < token1`. Both must be basechain. | Every pair maps to one deterministic address `contractAddress(initOf Pool(router, token0, token1))`. GRAM has hash 0, so it is always `token0`. A native pool is therefore `(GRAM, jettonWallet)`, and `isNative = token0 == GRAM`. |
| D3 | **The Router holds jettons. A native pool holds its own Gram reserve.** The Router holds no Gram between transactions: every Router handler forwards the whole incoming value. | Pool balances never mix in the Router. Gram payouts go directly pool → user with no hop. Admin can sweep Router dust without touching user funds. |
| D4 | **Reserves are tracked in storage, never derived from balances.** | Donations (direct transfers) cannot change the price or the share value. This removes the first-depositor inflation attack. |
| D5 | **Router → Pool messages always carry the Pool StateInit** (deploy-or-call). | A swap into a pair that does not exist deploys an empty pool, which then refunds. Bounces are never relied on to return assets (bounced bodies are truncated to 224 bits, which is too small to hold a refund address). |
| D6 | **After custody, handlers are total.** Once assets have entered a DEX contract, no handler on the asset path throws after authentication. Every business failure becomes an explicit refund message. | A throw on `JettonNotification` loses the jettons, because the notification is non-bounceable. A throw on an internal hop with `bounce:false` strands value. See §6. |
| D7 | **Two-step liquidity through `LpAccount(pool, user)`** for one side at a time, plus a **one-message dual deposit** (jetton transfer whose `forwardTonAmount` carries the Gram leg) that skips the LpAccount. | One-sided deposit matches STON.fi's UX. The dual deposit is the atomic graduation path for the launchpad, and any user can also use it. |
| D8 | **The unused side is refunded.** A deposit uses the ratio-optimal amounts and returns the excess. STON.fi v1 donates the excess to the pool. | Prevents depositors from accidentally losing funds. |
| D9 | **Fees are taken from the input.** The LP fee stays in the reserves. The protocol fee accrues in pool storage and is collected to the treasury. The referral fee is paid immediately to the referral address. | `get_expected_out` is exact. k never decreases. No vault contract is needed in the MVP. |
| D10 | **Fees are stored per pool.** Defaults are 25 bps (LP) and 5 bps (protocol), set in `Pool.init`. Admin changes them per pool through Router → Pool. Hard caps are code constants checked in both Router and Pool. The referral bps is chosen in the swap payload and capped at 10 bps. | Getters are exact. The admin cannot exceed the caps. |
| D11 | **The LP jetton master is the Pool itself** (TEP-74 + TEP-89). LP wallets are `LpWallet(pool, owner)`. A burn notification carries `customPayload` (min amounts, deadline). | Same model as STON.fi. Removing liquidity is just "burn LP". |
| D12 | **No upgradability, no swap pause, no withdrawal pause, no jetton rescue.** | Limits admin abuse (§9.7). A new version means a new Router. |
| D13 | **`MIN_LIQUIDITY = 1000` is locked on the first deposit.** It is counted in `totalSupply` but never minted to a wallet. | Once a pool exists, `totalSupply` never returns to 0, so "pool exists" ⇔ `totalSupply > 0`. This makes the pause on pool creation enforceable. |

---

## 2. Contracts and storage

### 2.1 Router: `contract Router` (one per deployment, the single entry point)
```
admin:           Address
pendingAdmin:    Address?         // 2-step admin transfer
treasury:        Address          // receives protocol fees and Router dust
creationPaused:  Bool             // blocks FIRST liquidity of any new pool
init(admin: Address, treasury: Address)
```
The Router only reads its storage on asset paths. Admin messages are the only writes.
Responsibilities:
- Parse jetton notifications and native entry messages.
- Validate gas, deadline and token ids.
- Forward to the right Pool.
- Execute `PayTo` jetton transfers that an authenticated Pool commands.

### 2.2 Pool: `contract Pool` (one per sorted pair; also the LP jetton master)
```
router:            Address
token0:            Address        // GRAM sentinel or Router's jetton wallet
token1:            Address
reserve0:          Int as coins
reserve1:          Int as coins
totalSupply:       Int as coins   // LP, includes MIN_LIQUIDITY that is never minted
lpFeeBps:          Int as uint16  // init: DEFAULT_LP_FEE_BPS (25)
protocolFeeBps:    Int as uint16  // init: DEFAULT_PROTOCOL_FEE_BPS (5)
protocolFee0:      Int as coins   // accrued, not part of reserves
protocolFee1:      Int as coins
init(router: Address, token0: Address, token1: Address)
```
Derived values:
- `isNative = token0 == GRAM`.
- Gram the pool must keep:
  `keep() = POOL_MIN_STORAGE + (isNative ? reserve0 + protocolFee0 : 0)`.

### 2.3 LpAccount: `contract LpAccount` (one per (pool, depositor))
```
pool:      Address
user:      Address
pending0:  Int as coins           // if pool is native, this Gram is held natively by THIS contract
pending1:  Int as coins           // jetton amounts are only bookkeeping; tokens stay in Router wallets
init(pool: Address, user: Address)
```
Gram it keeps: `keep() = LP_ACCOUNT_MIN_STORAGE + (isNativePending ? pending0 : 0)`.
The Pool tells it whether the pool is native by sending a flag in `LpAccountDeposit`. Store that
flag as `native: Bool`, or simply have the Pool always send Gram for side 0 when the pool is
native. The rule is that pending Gram is always physically held by the LpAccount.

### 2.4 LpWallet: `contract LpWallet` (TEP-74 wallet of the LP jetton)
```
pool:    Address  (master)
owner:   Address
balance: Int as coins
init(pool: Address, owner: Address)
```
This is a copy of `contracts/wallet.tact` (the launchpad's TokenWallet) with these changes:
- No `Sell`.
- `JettonBurn` forwards `customPayload` inside `LpBurnNotification`.
- Bounced handlers for `JettonTransferInternal` and `LpBurnNotification`.
- `get_wallet_data`.

### 2.5 Mocks (tests only)
- **TestJettonMaster / TestJettonWallet**: a plain TEP-74 jetton. The owner mints with
  `Mint{to, amount}`. It implements `ProvideWalletAddress` and `get_wallet_address`. The wallet is
  the launchpad wallet without `Sell`.
- **FakeJettonWallet**: an owner-controlled contract that sends a `JettonNotification` (any
  amount, any `sender`, any payload) to the Router, and can send raw `PayTo`, `CbAddLiquidity`,
  `LpBurnNotification` and similar messages to any target. It is used to test spoofing.

---

## 3. Constants (in `constants.tact`)

| Name | Value | Note |
|------|-------|------|
| `BPS` | 10000 | |
| `DEFAULT_LP_FEE_BPS` | 25 | 0.25% |
| `DEFAULT_PROTOCOL_FEE_BPS` | 5 | 0.05% |
| `MAX_LP_FEE_BPS` | 100 | hard cap 1% |
| `MAX_PROTOCOL_FEE_BPS` | 50 | hard cap 0.5% |
| `MAX_REF_FEE_BPS` | 10 | hard cap 0.1% |
| `MIN_LIQUIDITY` | 1000 | locked forever |
| `MAX_COINS` | 2^120 − 1 | the largest `coins` value; reserves and supply must stay ≤ this |
| `ROUTER_MIN_STORAGE` | 0.05 Gram | |
| `POOL_MIN_STORAGE` | 0.05 Gram | buffer for rent, outside the reserves |
| `LP_ACCOUNT_MIN_STORAGE` | 0.01 Gram | |
| `LP_WALLET_MIN_STORAGE` / `LP_WALLET_GAS` | 0.01 / 0.015 Gram | same as `wallet.tact` |
| `GAS_ROUTER` | 0.01 | one Router compute step |
| `GAS_POOL` | 0.03 | one Pool compute step |
| `GAS_LP_ACCOUNT` | 0.015 | |
| `LP_MINT_VALUE` | 0.05 | fixed value attached to an LP mint (wallet deploy + excess) |
| `JETTON_PAYOUT_VALUE` | 0.07 | fixed value of one Pool→Router `PayTo` (Router compute + transfer + internal + excess) |
| `SWAP_GAS` | 0.2 | minimum for any swap (covers the worst case: an empty pool is deployed, keeps its storage, and refunds a jetton) |
| `PROVIDE_GAS` | 0.3 | minimum for each one-sided deposit (either side might complete the pair, then pay for the mint and the refund of the unused side) |
| `PROVIDE_BOTH_GAS` | 0.25 | dual deposit / graduation |
| `BURN_GAS` | 0.25 | attached to `JettonBurn` on the LpWallet. The Pool checks `BURN_POOL_GAS = 0.2`. |
| `LP_ACCOUNT_REFUND_GAS` | 0.2 | |
| `COLLECT_GAS` | 0.2 | |
| `ADMIN_GAS` | 0.05 | |
| `ROUTER_REFUND_MIN` | 0.08 | below this the Router cannot afford to send jettons back (see §6.3) |

The gas numbers are starting points. Tests must print `printTransactionFees` for every flow and
assert success when exactly the minimum is attached. Tune the constants to about 1.5× the
observed cost. Gas checks use `>=` on `context().value`. Native entries add `amount`, and every
flow adds the user's `fwdTon`.

Helpers:
- `inline fun gram(): Address`
- `fun sortKey(a: Address): Int { return parseStdAddress(a.asSlice()).address; }`
- `fun isqrt(n)`: wrap the stdlib `sqrt`, then adjust with `while (s*s > n) { s -= 1 }` and
  `while ((s+1)*(s+1) <= n) { s += 1 }` so the result is guaranteed to be the floor.

---

## 4. Messages

Opcode prefix `0x4d47____` ("MG"). All amounts are `Int as coins`, `queryId` is `uint64`,
deadlines are `uint32` unix time, and bps fields are `uint16`.

### 4.1 Standard (copied into `dex/contracts/messages.tact`)
| Op | Name | Fields |
|----|------|--------|
| 0x0f8a7ea5 | JettonTransfer | queryId, amount, destination: Address, responseDestination: Address?, customPayload: Cell?, forwardTonAmount, forwardPayload: Slice as remaining |
| 0x178d4519 | JettonTransferInternal | queryId, amount, sender: Address, responseDestination: Address?, forwardTonAmount, forwardPayload: Slice as remaining |
| 0x7362d09c | JettonNotification | queryId, amount, sender: Address, forwardPayload: Slice as remaining |
| 0x595f07bc | JettonBurn | queryId, amount, responseDestination: Address?, customPayload: Cell? |
| 0x7bdd97de | **LpBurnNotification** | queryId, amount, sender: Address, responseDestination: Address?, customPayload: Cell? *(the standard burn_notification layout plus a trailing Maybe ^Cell; do not also define `JettonBurnNotification` in this compilation, because the opcode would clash)* |
| 0xd53276db | JettonExcesses | queryId |
| 0x2c76b973 | ProvideWalletAddress | queryId, ownerAddress: Address, includeAddress: Bool |
| 0xd1735400 | TakeWalletAddress | queryId, walletAddress: Address, ownerAddress: Cell? |

### 4.2 Forward payloads (inside `JettonNotification.forwardPayload`)
`forwardPayload` is an Either: bit 0 means the payload is inline, bit 1 means it is in a ref.
Declare the payloads as `message` types so that `X.fromSlice()` checks the opcode.

| Op | Name | Fields |
|----|------|--------|
| 0x4d470001 | SwapPayload | askToken: Address, minOut, deadline, receiver: Address?, refundTo: Address?, referral: Address?, refBps: uint16, fwdTon, fwdPayload: Cell? |
| 0x4d470002 | ProvideLpPayload | otherToken: Address, minLpOut, deadline, lpReceiver: Address?, refundTo: Address? |
| 0x4d470003 | ProvideBothPayload | gramAmount, minLpOut, deadline, lpReceiver: Address, refundTo: Address, requireEmpty: Bool *(fits one cell, so the launchpad can build it by hand)* |

Defaults: `receiver`, `refundTo` and `lpReceiver` fall back to `fromUser`. `refundTo` also
receives all excess gas.

### 4.3 User / admin → Router
| Op | Name | Fields | Who |
|----|------|--------|-----|
| 0x4d470011 | SwapNative | queryId, amount, askToken: Address, minOut, deadline, receiver: Address?, refundTo: Address?, referral: Address?, refBps, fwdTon, fwdPayload: Cell? | anyone (value ≥ amount + SWAP_GAS + fwdTon) |
| 0x4d470012 | ProvideLpNative | queryId, amount, otherToken: Address, minLpOut, deadline, lpReceiver: Address?, refundTo: Address? | anyone (value ≥ amount + PROVIDE_GAS) |
| 0x4d470013 | CollectProtocolFees | queryId, tokenA: Address, tokenB: Address | anyone (fees always go to the treasury) |
| 0x4d470014 | SetPoolFees | queryId, tokenA, tokenB, lpFeeBps, protocolFeeBps | admin |
| 0x4d470015 | SetCreationPaused | queryId, paused: Bool | admin |
| 0x4d470016 | SetTreasury | queryId, treasury: Address | admin |
| 0x4d470017 | TransferAdmin | queryId, newAdmin: Address | admin (sets pendingAdmin) |
| 0x4d470018 | ClaimAdmin | queryId | pendingAdmin |
| 0x4d470019 | WithdrawRouterExcess | queryId | admin (sweeps balance above ROUTER_MIN_STORAGE to the treasury) |
| (empty) | `receive()` | | anyone, top-up |

### 4.4 Router → Pool (always `bounce:false` with StateInit, except admin/collect)
| Op | Name | Fields |
|----|------|--------|
| 0x4d470021 | PoolSwap | queryId, fromUser, inIsToken0: Bool, amountIn, minOut, deadline, receiver: Address, refundTo: Address, referral: Address?, refBps, fwdTon, fwdPayload: Cell? |
| 0x4d470022 | PoolProvide | queryId, user, amount0, amount1, minLpOut, deadline, lpReceiver: Address, refundTo: Address, allowCreate: Bool, requireEmpty: Bool |
| 0x4d470023 | PoolSetFees | queryId, lpFeeBps, protocolFeeBps, excessTo: Address *(no StateInit, bounce:true)* |
| 0x4d470024 | PoolCollectFees | queryId, treasury: Address, excessTo: Address *(no StateInit, bounce:true)* |

### 4.5 Pool → Router
| Op | Name | Fields |
|----|------|--------|
| 0x4d470031 | PayTo | queryId, token0, token1, wallet: Address, amount, to: Address, excessTo: Address, fwdTon, fwdPayload: Cell?, reason: uint8 |

### 4.6 Pool ⇄ LpAccount, user → LpAccount
| Op | Name | Fields |
|----|------|--------|
| 0x4d470041 | LpAccountDeposit (Pool→LpA) | queryId, amount0, amount1, minLpOut, lpReceiver, refundTo, allowCreate: Bool, isNative: Bool |
| 0x4d470042 | CbAddLiquidity (LpA→Pool) | queryId, user, amount0, amount1, minLpOut, lpReceiver, refundTo, allowCreate: Bool |
| 0x4d470043 | CbRefund (LpA→Pool) | queryId, user, amount0, amount1 |
| 0x4d470044 | LpAccountRefund (user→LpA) | queryId |

### 4.7 Payouts and events
| Op | Name | Fields | Use |
|----|------|--------|-----|
| 0x4d470051 | GramPayout | queryId, reason: uint8, amount, payload: Cell? | body of every Gram payout from a Pool or LpAccount (value = amount + leftover gas when it is the last send) |
| 0xd53276db | JettonExcesses | queryId | leftover gas only |
| 0x4d470061 | SwapEvent (emit) | fromUser, inIsToken0, amountIn, amountOut, protocolFee, refFee, reserve0, reserve1 | indexer |
| 0x4d470062 | LiquidityEvent (emit) | user, isAdd: Bool, amount0, amount1, lp, reserve0, reserve1, totalSupply | indexer |
| 0x4d470063 | RefundEvent (emit) | queryId, user, code: uint16 | indexer / debugging |

**`reason` (uint8):** 1 SWAP_OUT, 2 SWAP_REFUND, 3 PROVIDE_REFUND, 4 LP_EXCESS (the unused side),
5 BURN_OUT, 6 REFERRAL, 7 PROTOCOL_FEE, 8 LP_ACCOUNT_REFUND, 9 INVALID_REFUND (Router-level).

**Refund codes (uint16, used in RefundEvent):** 201 DEADLINE, 202 SLIPPAGE, 203 EMPTY_POOL,
204 LOW_GAS, 205 BAD_PAYLOAD, 206 SAME_TOKEN, 207 CREATION_PAUSED, 208 ZERO_OUT, 209 OVERFLOW,
210 LP_BELOW_MIN, 211 POOL_NOT_EMPTY, 212 BAD_REF_BPS, 213 BAD_TOKEN (not basechain).

**`require` messages** (these only appear in throwing contexts, never on custody paths):
`"Not router"`, `"Not pool"`, `"Not admin"`, `"Not pending admin"`, `"Not LP account"`,
`"Not LP wallet"`, `"Not owner"`, `"Fee above cap"`, `"Insufficient TON attached"`,
`"Deadline"`, `"Slippage"`, `"Same token"`, `"Invalid amount"`.

---

## 5. Flows

Notation: `U` = user wallet, `UW(T)` = U's jetton wallet for T, `RW(T)` = the Router's jetton
wallet for T (= the token id), `R` = Router, `P` = Pool, `LpA` = LpAccount, `LW` = LpWallet.

### 5.0 Common Router routine for a jetton notification
1. `tokenIn = sender()`. Parse `forwardPayload` **inside `try`, with only local assignment**: no
   state writes and no sends inside the `try`. Read the Either bit; if it is 1, `loadRef()`.
   Then try each `XPayload.fromSlice()` in turn.
2. Validation failures send the jettons back to `msg.sender` using
   `refundJetton(tokenIn, amount, to = msg.sender, code)`. The failures are:
   - parse failure;
   - unknown op;
   - `tokenIn` not basechain;
   - `otherToken == tokenIn`;
   - `now() > deadline`;
   - not enough value.

   `refundJetton` sends a `JettonTransfer` to `RW(tokenIn)` with `value 0`,
   `mode SendRemainingValue`, `responseDestination = msg.sender` and `forwardTonAmount 0`.
   If `ctx.value < ROUTER_REFUND_MIN` there is nothing that can pay for the refund. The Router
   emits RefundEvent(LOW_GAS) and keeps the jettons, which stay unaccounted in its wallet
   (§9.5). It must **never `require`** in this receiver.
3. Compute `(t0, t1) = sort(tokenIn, otherToken)` and
   `poolInit = initOf Pool(myAddress(), t0, t1)`. Send to `contractAddress(poolInit)` with
   `init = poolInit`, `bounce:false`, `mode SendRemainingValue`.

Router value handling for every forward:
`nativeReserve(max(myBalance() - ctx.value, ROUTER_MIN_STORAGE), ReserveAtMost)`, followed by a
`SendRemainingBalance` send. This is the "keep what we had" pattern from `wallet.tact`. It
cannot spend the Router's own buffer, and it forwards everything else.

### 5.1 Swap Gram → jetton (native in)
1. `U → R`: `SwapNative{amount, askToken = RW(T), minOut, deadline, …}` with
   `value ≥ amount + SWAP_GAS + fwdTon`. The Router **may `require`** here, because the message
   is bounceable from a wallet and a throw bounces the Gram back. It checks:
   - value;
   - `amount > 0`;
   - `askToken != GRAM`;
   - `askToken` is basechain;
   - deadline;
   - `refBps ≤ MAX_REF_FEE_BPS`.
2. `R → P(GRAM, T)`: `PoolSwap{fromUser = U, inIsToken0 = true, amountIn = amount, …}`. The value
   is everything (≥ amount + gas).
3. P: `require(sender() == router)`. Then, without throwing:
   - If the deadline has passed, or `reserve0 == 0 || reserve1 == 0`, or `out == 0`, or
     `out < minOut`, or the new reserve would be above `MAX_COINS`, then
     **refund**: `nativeReserve(keep(), ReserveExact)` and send all the rest to `refundTo` as
     `GramPayout{SWAP_REFUND, amountIn}`. Emit RefundEvent.
   - Otherwise, compute the fees and `out` (§7) and apply:
     - `reserve0 += amountIn - protocolFee - refFee`;
     - `protocolFee0 += protocolFee`;
     - `reserve1 -= out`.

     Then send, in this order:
     1. `nativeReserve(keep(), ReserveExact)`;
     2. if `refFee > 0`: Gram `refFee` to `referral` (`SendPayGasSeparately`, body
        `GramPayout{REFERRAL}`);
     3. `PayTo{wallet = token1, amount = out, to = receiver, excessTo = refundTo, fwdTon, fwdPayload, reason = SWAP_OUT}`
        to the Router with `SendRemainingBalance`.

     Emit SwapEvent.
4. R: authenticate `PayTo` (§6.1), then send `JettonTransfer{amount = out, destination = receiver, responseDestination = excessTo, forwardTonAmount = fwdTon, forwardPayload = fwdPayload ? (1 + ref) : (0)}`
   to `RW(T)` with `SendRemainingValue` and `bounce:true`.
5. `RW(T) → UW'(T)`: internal transfer. The receiver gets the tokens and an optional
   notification, and `excessTo` gets the leftover gas.

### 5.2 Swap jetton → Gram
1. `U → UW(T)`: `JettonTransfer{amount, destination = R, responseDestination = U, forwardTonAmount ≥ SWAP_GAS (+ JETTON_PAYOUT_VALUE if referral), forwardPayload = SwapPayload{askToken = GRAM, …}}`.
   The user attaches about forwardTonAmount + 0.06.
2. `UW → RW(T) → R`: `JettonNotification{amount, sender = U}` with value = forwardTonAmount.
3. R: the §5.0 routine with `fromUser = U` and `refundTo` defaulting to U. Checks:
   - `askToken == GRAM`, which is allowed (it is not equal to tokenIn);
   - value ≥ `SWAP_GAS + (referral ? JETTON_PAYOUT_VALUE : 0)`.

   Then `R → P(GRAM, T)`: `PoolSwap{inIsToken0 = false, …}`.
4. P: the same validation. On failure it sends a refund `PayTo{wallet = token1, amount = amountIn, to = refundTo, reason = SWAP_REFUND}`
   with all the remaining balance after the reserve. On success:
   - `reserve1 += amountIn - pf - rf`, `protocolFee1 += pf`, `reserve0 -= out`;
   - `nativeReserve(keep())`;
   - if `rf > 0`: `PayTo{wallet = token1, amount = rf, to = referral, reason = REFERRAL}` with
     the fixed value `JETTON_PAYOUT_VALUE` (`SendPayGasSeparately`);
   - Gram `GramPayout{SWAP_OUT, out, payload = fwdPayload}` to `receiver` with
     `SendRemainingBalance` (the value is `out` plus the leftover gas).

   Note that `fwdTon` is meaningless for a Gram output: the whole value goes to the receiver.

### 5.3 Swap jetton A → jetton B
This is the same as 5.2, with `askToken = RW(B)` and pool `P(sort(RW(A), RW(B)))`. The output is
paid as `PayTo{wallet = RW(B)}` with the remaining balance, and the referral is paid in A as a
fixed-value `PayTo`.
Required forward: `SWAP_GAS + fwdTon (+ JETTON_PAYOUT_VALUE if referral)`.
Multi-hop routing is out of scope for the MVP (§11).

### 5.4 Add liquidity, two-step (any pair)
For each side `X ∈ {jetton A, jetton B or Gram}`:
1. The side arrives:
   - jetton: `JettonTransfer` to R with `ProvideLpPayload{otherToken, minLpOut, deadline, lpReceiver?, refundTo?}` and forwardTonAmount ≥ `PROVIDE_GAS`;
   - Gram: `U → R: ProvideLpNative{amount, otherToken, …}` with value ≥ `amount + PROVIDE_GAS`.
2. R: validation (§5.0 for jettons, `require` for native), then
   `R → P: PoolProvide{user = U, amount0/amount1 (one of them 0), minLpOut, deadline, lpReceiver, refundTo, allowCreate = !creationPaused, requireEmpty = false}`.
3. P: `require(sender() == router)`. Refund on any of:
   - deadline passed (DEADLINE);
   - `totalSupply == 0 && !allowCreate` (CREATION_PAUSED);
   - overflow.

   The refund pays each non-zero side back with `payOut`. Otherwise:
   `P → LpAccount(P, U)` with StateInit and `bounce:false`:
   `LpAccountDeposit{amount0, amount1, minLpOut, lpReceiver, refundTo, allowCreate}`. The value
   is all of it, which includes the Gram leg for a native side 0.
4. LpA: `require(sender() == pool)`. Add the amounts to `pending0` and `pending1`. Then:
   - **If both pending amounts are > 0:** take `a0 = pending0` and `a1 = pending1`, zero both
     pending amounts first, then do `nativeReserve(LP_ACCOUNT_MIN_STORAGE, ReserveExact)` and
     send `CbAddLiquidity{user, a0, a1, minLpOut, lpReceiver, refundTo, allowCreate}` to P with
     `SendRemainingBalance`. The value carries `a0` Gram when the pool is native. The
     `minLpOut`, `lpReceiver`, `refundTo` and `allowCreate` used are those of the message that
     completes the pair.
   - **Otherwise:** `nativeReserve(LP_ACCOUNT_MIN_STORAGE + pendingGram, ReserveExact)` and send
     the leftover gas to `refundTo` as `JettonExcesses`.
5. P on `CbAddLiquidity`:
   `require(sender() == contractAddress(initOf LpAccount(myAddress(), msg.user)))`.
   Then run `addLiquidity(a0, a1, …)` (§5.6).

`LpAccountRefund` (only `user` may send it, value ≥ `LP_ACCOUNT_REFUND_GAS`):
1. LpA zeroes the pending amounts.
2. LpA sends `CbRefund{user, p0, p1}` to P with the remaining balance above its storage, which
   carries the Gram.
3. P authenticates the LpAccount and runs `payOut` for each non-zero side to `user` with reason
   LP_ACCOUNT_REFUND.

### 5.5 Add liquidity, one message: dual deposit (jetton + Gram)
1. `U → UW(T)`: `JettonTransfer{amount = t, destination = R, forwardTonAmount = g + PROVIDE_BOTH_GAS, forwardPayload = ProvideBothPayload{gramAmount = g, minLpOut, deadline, lpReceiver, refundTo, requireEmpty}}`.
2. R receives a `JettonNotification` whose value is ≥ `g + PROVIDE_BOTH_GAS`. A smaller value
   means a jetton refund (LOW_GAS). The pool is `P(GRAM, RW(T))`, and the Router sends
   `PoolProvide{amount0 = g, amount1 = t, …, allowCreate = !creationPaused, requireEmpty}`.
3. P: the same checks as in 5.4, plus `requireEmpty && totalSupply > 0`, which refunds with
   POOL_NOT_EMPTY. **Both amounts are > 0, so P calls `addLiquidity` directly** and no LpAccount
   is involved.

Security note: the Gram leg travels through the user's own jetton wallet and the Router's jetton
wallet as forward value. The Router credits only `ctx.value`, which is what actually arrived.
A malicious jetton can at most steal its own user's forward Gram.

### 5.6 `addLiquidity(a0, a1, minLpOut, lpReceiver, refundTo, allowCreate, requireEmpty)` (Pool)
**Case 1: first deposit** (`totalSupply == 0`).
- Refund with CREATION_PAUSED if `!allowCreate`.
- Compute `liq = isqrt(a0 * a1)`. Refund with LP_BELOW_MIN if `liq <= MIN_LIQUIDITY`.
- Set `use0 = a0`, `use1 = a1`, `minted = liq - MIN_LIQUIDITY`, `totalSupply = liq`.

**Case 2: existing pool.**
- Refund with POOL_NOT_EMPTY if `requireEmpty`.
- `lp0 = a0 * S / r0`, `lp1 = a1 * S / r1`.
- If `lp0 <= lp1`: `use0 = a0`, `use1 = min(a1, ceil(a0 * r1 / r0))`.
- Otherwise: `use1 = a1`, `use0 = min(a0, ceil(a1 * r0 / r1))`.
- `minted = min(use0 * S / r0, use1 * S / r1)` (floor).
- `totalSupply += minted`.

**Checks, all of which refund both full amounts:**
- `minted == 0` (LP_BELOW_MIN);
- `minted < minLpOut` (SLIPPAGE);
- any new reserve or `totalSupply > MAX_COINS` (OVERFLOW).

**Effects:** `reserve0 += use0`, `reserve1 += use1`.

**Sends, in order:**
1. `nativeReserve(keep(), ReserveExact)`.
2. Mint: deploy `LpWallet(P, lpReceiver)` with
   `JettonTransferInternal{amount = minted, sender = P, responseDestination = refundTo, forwardTonAmount = 0}`,
   value `LP_MINT_VALUE`, `bounce:true`.
3. The unused jetton side, if any: `PayTo{reason = LP_EXCESS}` with the fixed
   `JETTON_PAYOUT_VALUE`.
4. Final: send the remaining balance to `refundTo` as
   `GramPayout{LP_EXCESS, unusedGram}` when the pool is native and Gram is unused, otherwise as
   `JettonExcesses`.

Emit LiquidityEvent.
In a jetton/jetton pool both sides can be partly unused only by rounding. Only one side is ever
reduced, because `use_i = a_i` for the limiting side.

### 5.7 Remove liquidity (burn LP)
1. `U → LW(P, U)`: `JettonBurn{amount, responseDestination, customPayload = RemoveParams{min0, min1, deadline}}`
   with value ≥ `BURN_GAS`. `RemoveParams` is a struct cell: `min0: coins`, `min1: coins`,
   `deadline: uint32`. If it is null, the mins are 0 and there is no deadline.
2. LW: the owner check, the balance check and the value check (as in `wallet.tact`). Then
   `balance -= amount`, followed by
   `LpBurnNotification{amount, sender = U, responseDestination, customPayload}` to P with
   `SendRemainingValue` and `bounce:true`.
3. P: `require(sender() == contractAddress(initOf LpWallet(myAddress(), msg.sender)))`.
   **This path may `require`.** A throw bounces the notification, LW's
   `bounced<LpBurnNotification>` restores the balance (`queryId` and `amount` fit in the 224
   bits), and the Gram comes back. It checks:
   - value ≥ `BURN_POOL_GAS`;
   - `amount > 0`;
   - deadline;
   - `out0 = amount * r0 / S` and `out1 = amount * r1 / S` (floor), with `out0 >= min0` and
     `out1 >= min1`, else `"Slippage"`;
   - `out0 + out1 > 0`.

   Effects: `reserve0 -= out0`, `reserve1 -= out1`, `totalSupply -= amount`.
   Sends:
   1. `nativeReserve(keep())`;
   2. the jetton leg(s) as `PayTo{reason = BURN_OUT, to = U, excessTo = responseDestination ?: U}`.
      For a jetton/jetton pool the first one goes with the fixed `JETTON_PAYOUT_VALUE`.
   3. the last leg with `SendRemainingBalance`. In a native pool that is the Gram
      `GramPayout{BURN_OUT, out0}` to U, which carries the leftover gas.

   Emit LiquidityEvent.
4. `MIN_LIQUIDITY` is never owned, so `S - amount ≥ MIN_LIQUIDITY` always holds and the reserves
   stay ≥ 1 (because of the floor).

### 5.8 Graduation (launchpad)
This is the dual deposit from 5.5, sent by a jetton **master** instead of a user wallet. The
launchpad's `TokenMaster.graduate()` would need these changes (not in this task; `contracts/`
belongs to someone else):
- Mint the pool tokens directly into the Router's wallet:
  `deploy(initOf TokenWallet(master, ROUTER))` with
  `JettonTransferInternal{amount = poolTokens, sender = master, responseDestination = treasury, forwardTonAmount = poolGram + PROVIDE_BOTH_GAS, forwardPayload = 1 + ref(ProvideBothPayload{gramAmount = poolGram, minLpOut = 1, deadline = now()+3600, lpReceiver = BURN (0:000…), refundTo = treasury, requireEmpty = true})}`,
  with value `poolGram + PROVIDE_BOTH_GAS + 0.05`.
- Only one message is needed. The STON.fi pTON leg goes away.
- `fromUser` is the master. The LP is minted to `LpWallet(P, 0:000…)`, which is permanently
  locked. Any refund goes to the treasury.

`requireEmpty = true` is what makes this safe against pre-graduation pool squatting (§9.3).
Alternative: `requireEmpty = false` with `minLpOut ≈ 0.99 · (isqrt(g·t) − 1000)`. A skewed
squatter pool then fails the slippage check, and the deposit is refunded to the treasury.

Router getter for the launchpad: `get_pool_address(GRAM, routerWalletOf(T))`. The launchpad can
compute `routerWalletOf(T)` itself, since it knows its own wallet code.

### 5.9 Protocol fee collection
1. Anyone sends `R: CollectProtocolFees{tokenA, tokenB}` with value ≥ `COLLECT_GAS`.
2. R sorts the pair and sends `PoolCollectFees{treasury = self.treasury, excessTo = sender()}`
   (no StateInit, `bounce:true`).
3. P (`require` router): `f0 = protocolFee0` and `f1 = protocolFee1`, then zero them **before**
   sending. Then `nativeReserve(keep())` and `payOut(token0, f0, treasury, PROTOCOL_FEE)` and
   `payOut(token1, f1, treasury, PROTOCOL_FEE)`: the jetton legs are `PayTo`s, the Gram leg is
   sent directly, and the last leg takes the remaining balance (or `JettonExcesses` goes to
   `excessTo` if both fees are 0).

### 5.10 Admin
All admin messages are checked with `require(sender() == admin, "Not admin")` and
`value ≥ ADMIN_GAS`. Leftover gas is refunded to the sender (the `refundRemaining` pattern from
master.tact).
- `SetPoolFees`: the Router requires `lp ≤ MAX_LP_FEE_BPS` and
  `protocol ≤ MAX_PROTOCOL_FEE_BPS`, sorts the pair, and sends `PoolSetFees` (no StateInit,
  `bounce:true`). The Pool requires the router and **re-checks the caps**, then stores the fees
  and refunds the excess to `excessTo`.
- `SetCreationPaused`: sets the flag. It only affects the `allowCreate` flag on future
  `PoolProvide` messages.
- `SetTreasury`: affects future collections only.
- `TransferAdmin` sets `pendingAdmin`. `ClaimAdmin` from `pendingAdmin` sets
  `admin = pendingAdmin` and clears `pendingAdmin`. The current admin can cancel with
  `TransferAdmin(self)`.
- `WithdrawRouterExcess`: `nativeReserve(ROUTER_MIN_STORAGE, ReserveExact)`, then send the
  remaining balance to the treasury. This is safe because of D3: the Router never holds user Gram
  at rest.

### 5.11 Pool `payOut(isToken0, amount, to, excessTo, reason, fwdTon, fwdPayload, last: Bool)`
- If the token is GRAM: send a `GramPayout`. When `last`, use mode `SendRemainingBalance`.
  Otherwise use `value = amount` with `SendPayGasSeparately`.
- If the token is a jetton: send `PayTo` to the router. When `last`, use the remaining balance.
  Otherwise use `JETTON_PAYOUT_VALUE + fwdTon` with `SendPayGasSeparately`.
- Skip the send when `amount == 0`. Exactly one send per flow is `last`. If every leg is skipped,
  the remaining balance goes to `excessTo` as `JettonExcesses`.
- `nativeReserve(keep(), ReserveExact)` is always the first action, run after the state is
  updated.

---

## 6. Authentication, bounce and refund rules

### 6.1 Who may send what
| Receiver | Message | Check |
|----------|---------|-------|
| Router | JettonNotification | none. `sender()` **is** the token id (D1); must be basechain |
| Router | PayTo | `sender() == contractAddress(initOf Pool(myAddress(), msg.token0, msg.token1))`, `msg.wallet ∈ {token0, token1}`, `msg.wallet != GRAM`. `require`, because a forger only gets a bounce |
| Router | admin ops | `admin` / `pendingAdmin` |
| Pool | PoolSwap / PoolProvide / PoolSetFees / PoolCollectFees | `sender() == router` |
| Pool | CbAddLiquidity / CbRefund | `sender() == contractAddress(initOf LpAccount(myAddress(), msg.user))` |
| Pool | LpBurnNotification | `sender() == contractAddress(initOf LpWallet(myAddress(), msg.sender))` |
| Pool | ProvideWalletAddress | anyone (TEP-89), value ≥ 0.0061 |
| LpAccount | LpAccountDeposit | `sender() == pool` |
| LpAccount | LpAccountRefund | `sender() == user` |
| LpWallet | JettonTransferInternal | from `pool` (mint) or `LpWallet(pool, msg.sender)` (peer) |
| LpWallet | JettonTransfer / JettonBurn | `sender() == owner` |

Authentication failures `require`/throw. A forged message gains nothing. If it came with value,
the bounce returns that value to the forger.

### 6.2 Bounce flags
| Hop | bounce | Reason |
|-----|--------|--------|
| U → R (native entries) | wallet default (true) | the Router may throw; the Gram comes back |
| R → P (PoolSwap / PoolProvide) | **false**, with StateInit | the Pool never throws after authentication (D6); a bounce could not carry refund data anyway |
| R → P (PoolSetFees / PoolCollectFees) | true, no StateInit | a missing pool bounces the gas back; the Router swallows it |
| P → R (PayTo) | false | the Router's PayTo path is total after authentication |
| R → RW (JettonTransfer) | true | standard. `bounced<JettonTransfer>` in the Router emits an event and keeps the Gram. It only happens for a broken or malicious jetton, and affects only that token's pools |
| P → LpA, LpA → P | false (deploy) | total handlers |
| P → LW (mint) | true | `bounced<JettonTransferInternal>`: `totalSupply -= amount`. The reserves stay, so this is a donation to the LPs. It only happens if the gas check was wrong |
| LW → P (LpBurnNotification) | true | the Pool may throw; the LW restores the balance |
| any → user / referral / treasury | false | the recipient may be an uninitialized wallet; the Gram is credited anyway |

Every contract also gets `bounced(msg: Slice) {}` so that an unknown bounce never throws.

### 6.3 What happens to assets when things go wrong
| Situation | Outcome |
|-----------|---------|
| Bad payload, deadline, gas below the flow minimum but ≥ `ROUTER_REFUND_MIN` (jetton in) | the jettons go back to `msg.sender`, along with the remaining gas |
| Jetton notification with value < `ROUTER_REFUND_MIN` | the jettons stay in the Router wallet, unaccounted. This is a user error documented in the SDK and prevented by the UI. There is **no** admin rescue (§9.7) |
| Native entry invalid | throw, and the bounce returns the Gram minus fees |
| Pool-level business failure (slippage, empty pool, paused, overflow, zero out, requireEmpty) | an explicit refund of every deposited leg to `refundTo`, plus the leftover gas |
| Burn failure | the bounce restores the LP balance |
| LpAccount stuck with one side | the user sends `LpAccountRefund`, or deposits the other side |

---

## 7. Math and rounding

```
// Swap, exact input. All integer, positive operands, so "/" is a floor.
totalBps     = lpFeeBps + protocolFeeBps + refBps                 // refBps = 0 if referral == null
protocolFee  = amountIn * protocolFeeBps / BPS                    // floor (user-favoured by < 1 unit)
refFee       = amountIn * refBps / BPS                            // floor
inWithFee    = amountIn * (BPS - totalBps)                        // scaled by BPS
amountOut    = inWithFee * reserveOut / (reserveIn * BPS + inWithFee)   // floor (pool-favoured)
reserveIn'   = reserveIn + amountIn - protocolFee - refFee        // the LP fee stays in the reserves
reserveOut'  = reserveOut - amountOut
```
- k invariant: `reserveIn' * reserveOut' >= reserveIn * reserveOut`. It holds because
  `amountIn - pf - rf >= inWithFee / BPS`. Tests assert this after every swap.
- `amountOut < reserveOut` always holds. `amountOut == 0` triggers a refund (ZERO_OUT).
- Overflow: operands are at most 2^120, so `amountIn * BPS * reserveOut < 2^254`, which is below
  the 257-bit TVM int. Explicitly check `reserveIn' <= MAX_COINS`; above it, refund (OVERFLOW).
  Storing a too-large `coins` value would throw at commit and break D6.
- Add liquidity: the LP minted uses **floor**. First deposit: `floor(isqrt(a0 * a1))`. For later
  deposits the counterpart of the limiting side is rounded **up** when it is at least
  `COARSE_UNITS` (10^6 base units, so the loss is below 1 ppm and no dust refund is needed);
  below that it is rounded **down** and the limiting side rounded up to match ("floor then
  ceil", loss < 1 unit of the limiting side). See §15, finding 3.
- Burn: `out_i = floor(amount * r_i / S)`.
- Round-trip property (to test): add then remove never returns more than was deposited on either
  side. Swap A→B then B→A never returns more than `amountIn`.
- The getters call **the same pure functions** as the receivers (put them in `constants.tact`
  as global `fun`s that return structs), so quotes match execution exactly.

Getter return structs:
- `ExpectedOut{amountOut, protocolFee, refFee}`
- `ExpectedLp{lp, use0, use1}`
- `ExpectedBurn{out0, out1}`

---

## 8. Getters

**Router**
- `get_pool_address(tokenA: Address, tokenB: Address): Address`. The arguments are Router-wallet
  token ids or GRAM; the getter sorts them internally.
- `get_router_data(): RouterData{admin, pendingAdmin, treasury, creationPaused}`.
- `get_gram_token(): Address`, which returns the sentinel.
- `get_lp_account_address(tokenA, tokenB, user): Address`.

Clients find a token id by calling the jetton master's `get_wallet_address(router)`.

**Pool**
- `get_pool_data(): PoolData{router, token0, token1, reserve0, reserve1, totalSupply, lpFeeBps, protocolFeeBps, protocolFee0, protocolFee1, isNative}`.
- `get_expected_out(tokenIn: Address, amountIn: Int, refBps: Int): ExpectedOut`. It returns 0
  for an empty pool, a wrong token or `refBps > cap`.
- `get_expected_lp(amount0: Int, amount1: Int): ExpectedLp`.
- `get_expected_burn(lpAmount: Int): ExpectedBurn`.
- `get_lp_account_address(user: Address): Address`.
- TEP-74: `get_jetton_data(): JettonData`. The content is on-chain TEP-64 metadata: a dict
  keyed by sha256 with name "Marg DEX LP", symbol "MARG-LP" and decimals "9", built in the
  getter. It also returns mintable = true and admin = null.
- `get_wallet_address(owner): Address`.

**LpAccount**: `get_lp_account_data(): {pool, user, pending0, pending1}`.

**LpWallet**: `get_wallet_data(): JettonWalletData`.

---

## 9. Threats and mitigations

### 9.1 Fake jetton notifications / jetton-wallet spoofing
- **Attack:** a contract sends `JettonNotification{amount = 1e30}` to the Router while pretending
  to be USDT's wallet.
  **Mitigation:** a token is identified by `sender()` (D1). The fake gets its own token id, so it
  can only reach pools `(fake, X)`. Those pools hold only what other people deliberately
  deposited against the fake. A real pool `(GRAM, RW(USDT))` can only be credited by the real
  `RW(USDT)`. Payouts of USDT happen only when an authenticated pool containing `RW(USDT)`
  commands them (§6.1).
- **Attack:** a fake contract sends `PayTo` to the Router claiming to be a pool.
  **Mitigation:** the Router recomputes the pool address from `(token0, token1)` and requires
  `wallet ∈ {token0, token1}`. Tested with FakeJettonWallet.
- **Attack:** forged `CbAddLiquidity`, `CbRefund`, `LpBurnNotification` or `PoolSwap`.
  **Mitigation:** each is authenticated with `contractAddress(initOf …)` (§6.1). Tests send each
  one from FakeJettonWallet and expect a failure with no state change.
- **Attack:** a malicious real jetton (lying wallet code, admin mint, transfer tax).
  **Mitigation:** the impact is contained to the pools that contain that token (per-token
  isolation). The UI must check `master.get_wallet_address(router) == tokenId`. Never trust a
  wallet's own `get_wallet_data().master`.
- **Attack:** a Gram value lie (the payload claims `gramAmount` but less Gram arrives).
  **Mitigation:** the Router checks `ctx.value ≥ amount + gas`. The Pool books only what the
  Router validated, and the Router forwards all of its value.

### 9.2 Reentrancy-like interleaving of async messages
- **Every handler is checks → effects → interactions inside one transaction.** The reserves,
  `totalSupply`, the fees and the pending amounts are updated **before** any outgoing message is
  queued. In-flight payouts have already been deducted. Two swaps, or a swap and a burn, always
  see consistent reserves.
- **Solvency invariant** (assert it in tests by reading the Router wallet balances):
  `RW(T).balance ≥ Σ_pools∋T (reserve + protocolFee) + Σ_LpAccounts pending(T) + in-flight PayTo(T)`.
  For Gram, per pool: `pool.balance ≥ reserve0 + protocolFee0 + POOL_MIN_STORAGE`.
- **LpAccount:** the pending amounts are zeroed before `CbAddLiquidity` or `CbRefund` is sent,
  so a double completion is impossible. A refund racing a second deposit is handled: whichever
  message runs first sees the up-to-date pending amounts.
- **A fee change or pause racing a swap or deposit:** the swap uses the fee at execution time
  (protected by `minOut`), and `allowCreate` reflects the Router state at the moment the Router
  forwarded the message. Both are acceptable and documented.
- **Fee collection racing a treasury change:** the treasury travels in the message and is
  frozen at request time.
- **Price movement between the two sides of a two-step deposit:** `minLpOut` protects against
  it, and the unused side is refunded.

### 9.3 First-depositor, donation and pool-squatting attacks
- **Donation/inflation (ERC-4626 style):** impossible. The reserves live in storage (D4). A
  direct Gram transfer to a Pool only enlarges its storage buffer. A jetton sent to the Router
  with no payload is refunded.
- **Tiny first deposit:** `MIN_LIQUIDITY` is locked, and the first deposit needs
  `isqrt(a0 * a1) > 1000`. `totalSupply` never returns to 0, so the share price cannot be reset.
- **Later depositors:** ratio-optimal usage, refund of the excess, `minLpOut`, and a refund when
  `minted == 0`.
- **Graduation squatting:** before graduation, an attacker who holds curve tokens creates
  `(GRAM, T)` at a skewed price, so the graduation liquidity lands at the attacker's price and
  gets arbitraged. Mitigations:
  - `ProvideBothPayload.requireEmpty = true` refunds the whole deposit to the treasury instead.
    That is a denial of service, not theft.
  - Alternatively, a strict `minLpOut`.
  - Recommended launchpad-side hardening: block transfers of curve tokens to the Router before
    graduation.
  - Phase-2 DEX feature: "balance-then-add", where the Pool first swaps part of the deposit to
    move the price to the deposit ratio, then adds.

### 9.4 Rounding drain
- Every output is a floor, every required input is a ceil, and the fees are a floor of the input
  while the LP fee is applied through the `inWithFee` product. k never decreases.
- `amountOut == 0` and `minted == 0` both refund. A pool can never be drained by dust swaps; at
  most the protocol fee rounds to 0 on dust trades, which costs the protocol, not the LPs.
- After a burn the reserves stay ≥ 1, so there is no division by zero (§5.7.4).
- Tests: 200 alternating 1-unit swaps never decrease k; add/remove round trips never profit;
  fuzz with random amounts.

### 9.5 Griefing with dust and spam
- Swaps into non-existent pairs deploy empty pools. The caller pays for the deploy and the
  storage buffer (`SWAP_GAS` covers it), and the refund follows. Pools are cheap to store, and
  the attacker pays.
- Dust one-sided deposits only go into the attacker's own `LpAccount(P, attacker)`. Nobody can
  write into another user's LpAccount. The Router itself can never be a user: every
  receiver/refundTo/lpReceiver/referral equal to the Router is refused, and a notification
  with `sender == Router` is never routed (§15, finding 1). Integrators that forward deposits
  for many users from one contract share one LpAccount; they must use `ProvideBothPayload`.
- Referral dust payouts are paid for by the swapper who chose them. `refFee == 0` skips the
  payout.
- Large `fwdPayload` cells: the forward fees are paid from the user's value. The Router
  additionally checks `ctx.value ≥ required + 2 * ctx.readForwardFee()`, and payloads are carried
  by ref, never re-serialized.
- Notifications with too little value: no refund is possible, and the jettons stay in the Router
  wallet unaccounted. They cannot affect any pool's accounting, because the pools never read
  wallet balances.
- Rent erosion: the Pool and LpAccount buffers refill automatically. `ReserveExact(keep)` is
  funded by every incoming message's gas, so the only way a pool freezes is decades of zero
  activity. Anyone can top it up with an empty message.
- Throughput: the Router is a single account, the same as STON.fi. It touches no state on hot
  paths, so its compute is small.

### 9.6 Deadline and slippage
- `minOut` (swap), `minLpOut` (add) and `min0`/`min1` (burn) are always enforced. A `minOut` of
  0 is allowed on-chain, but the SDK and UI default to the quote minus the user's slippage.
- The deadline is required (`uint32`) and checked twice: at the Router as an early-out, and at
  the Pool, which is authoritative because messages can be delayed under congestion. On failure
  the assets are refunded; a native entry throws instead.
- The referral bps is capped (`MAX_REF_FEE_BPS`), and `referral == null` forces `refBps = 0`.
  Otherwise a frontend could take up to the cap from its own users, which is visible in the
  quote.

### 9.7 Admin abuse
What the admin **can** do:
- change a pool's fees within the hard caps (LP ≤ 1%, protocol ≤ 0.5%), which are checked in
  both Router and Pool;
- pause pool creation;
- change the treasury;
- transfer admin in two steps;
- sweep Router dust.

What the admin **cannot** do:
- move reserves or LpAccount funds;
- pause swaps or withdrawals;
- upgrade code;
- rescue or move jettons from Router wallets (no such message exists, by design);
- change fees above the caps;
- redirect a referral.

Worst case for users: the fees jump to the caps between a quote and its execution. `minOut`
bounds the loss. A Phase-2 option is a timelock on fee increases.
Key management for the admin (a multisig) is out of scope. Use a multisig wallet as `admin`.

### 9.8 Other
- **Masterchain addresses:** all token ids must be basechain, otherwise refund BAD_TOKEN. This
  keeps the hash-only sort unambiguous.
- **`try/catch` semantics:** the `try` blocks only parse into locals. They never write state or
  queue actions (TVM does not roll back c4/c5 inside the try reliably).
- **Gas config changes on-chain:** the constants carry about a 1.5× margin. Phase 2 can derive
  them with `getComputeFee` / `getForwardFee`.
- **Code immutability:** a bug is permanent. Mitigate with tests, invariants, an audit, and
  small initial caps.

---

## 10. Test plan (`dex/tests`, sandbox only)

Fixture:
- Router deployed by `admin`, with `treasury`;
- two TestJettons A and B minted to alice and bob;
- the token ids resolved via `master.getGetWalletAddress(router)`;
- helpers `swapNative`, `swapJetton`, `provideJetton`, `provideNative`, `provideBoth`, `burnLp`,
  `poolOf(tA, tB)`, `printTransactionFees` for every flow.

Assert after every test: all DEX transactions succeed (no aborted transactions except the
intended ones), and the solvency invariant from §9.2 holds.

1. **Pools:**
   - deterministic address (Router getter == `Pool.fromInit` address);
   - sorted pair independent of argument order;
   - Gram is always token0.
2. **Liquidity:**
   - first deposit (native via ProvideLpNative + jetton, jetton/jetton two-step): LP = isqrt − 1000;
   - second deposit with an unbalanced amount: the excess is refunded and LP equals the getter;
   - `minLpOut` failure refunds both legs;
   - `LpAccountRefund`;
   - dual deposit;
   - creation paused: a new pool's first deposit is refunded, an existing pool still accepts
     deposits.
3. **Swaps**, for each direction (Gram→J, J→Gram, J→J):
   - out == `get_expected_out`;
   - the reserves update correctly;
   - protocol fee accrued;
   - referral paid (and capped: refBps 11 is rejected or refunded);
   - slippage refund;
   - deadline refund;
   - empty-pool refund;
   - low-gas refund;
   - a bad payload refunds the jettons;
   - `fwdPayload` is delivered to the receiver.
4. **Burn:**
   - pro-rata out;
   - mins enforced (the bounce restores the LP balance);
   - a full exit leaves `MIN_LIQUIDITY` and the reserves stay > 0;
   - LP transfer between users, then a burn by the new owner.
5. **Graduation:**
   - a launchpad-like sender (a TestJetton master that mints straight into the Router wallet
     with ProvideBothPayload) creates the pool, and the LP lands in `LpWallet(P, 0:000)`;
   - `requireEmpty` refunds both legs to the treasury when the pool already exists.
6. **Admin:**
   - each admin op and its non-admin rejection;
   - caps;
   - 2-step admin transfer;
   - collect fees to the treasury (Gram and jetton legs);
   - `WithdrawRouterExcess` cannot touch pool funds.
7. **Security:**
   - fake wallet notifications (amount 1e30) cannot move real reserves;
   - forged PayTo, Cb*, LpBurnNotification and PoolSwap all fail;
   - donations do not change the reserves or the quotes;
   - k is monotonic over a fuzz of 200 swaps;
   - round trips do not profit;
   - an overflow refund with a 2^119 + 2^119 deposit.
8. **Getters:** TEP-74 `get_jetton_data` and `get_wallet_address`, TEP-89
   `ProvideWalletAddress` → `TakeWalletAddress` from the Pool, and all expected-value getters.

---

## 11. Out of scope for the MVP (Phase 2)
- Multi-hop swaps (a `next` hop in `SwapPayload`).
- Stable or concentrated pool types.
- Referral vaults (accrue instead of paying immediately).
- Fee timelock.
- Balance-then-add for graduation.
- A Router upgrade path.
- Gas derived from the on-chain config.
- An SDK and UI.

## 12. Suggested work split for the team
1. **messages + constants + LpWallet + LpAccount + mocks.** These are self-contained, and they
   unblock everyone else.
2. **Pool:** the math helpers (§7), the swap/provide/burn/collect handlers, `payOut`, the
   getters, and LP metadata.
3. **Router:** payload parsing with try/catch, the gas checks, the routing, PayTo
   authentication, and admin.
4. **Tests:** the fixture plus §10. This can start against the generated wrappers as soon as
   steps 1 to 3 compile; write the security tests first.

---

## 13. Implementation notes (contracts engineer)

Status: everything in §0 is implemented, compiles cleanly under Tact 1.6.13 with no warnings,
and `dex/tests/smoke.spec.ts` passes. Deviations from the text above, and why:

1. **`LpAccountDeposit.isNative`** (and `LpAccount.isNative`, also returned by
   `get_lp_account_data`). §2.3 left the choice open; an explicit flag keeps `keep()` in the
   LpAccount independent of the pool's token layout.
2. **Router-level jetton refunds go to `refundTo` once the payload has parsed**, and to the
   notification's `sender` only when it has not (BAD_PAYLOAD, BAD_TOKEN with no payload). A
   `ProvideBothPayload` refund goes to its `refundTo` (the treasury for graduation). §5.0 said
   always `msg.sender`; the payload's `refundTo` is the depositor's own choice, so this is safe and
   matches what the Pool does.
3. **Every flow minimum also adds `2 * ctx.readForwardFee()`** (the §9.5 note), in both native
   and jetton entries. Tests asserting "exactly the minimum succeeds" must include it.
4. **Events are emitted before `nativeReserve` and the sends.** An external-out message after a
   `SendRemainingBalance` send cannot pay its fee and would fail the whole action phase.
5. **LpAccount overflow:** if `pending + amount` would exceed `MAX_COINS`, the LpAccount sends
   just that deposit back through `CbRefund` (the Pool pays it to `user`) instead of storing it.
6. **Router bounces:** a single `bounced(msg: Slice) {}` keeps the Gram for every bounce
   (JettonTransfer of a broken jetton, PoolSetFees/PoolCollectFees to a missing pool). No event is
   emitted. The Router also accepts `JettonExcesses` and empty top-ups.
7. **Swap output with no referral address forces `refBps = 0`** in both Router and Pool; a
   `refBps` above the cap is a `require` on `SwapNative` and a BAD_REF_BPS refund on the jetton path.
8. **Pool `addLiquidity` refunds of unused sides:** jetton legs use fixed-value `PayTo`s; the final
   send is the unused Gram (native pool) or `JettonExcesses`, both to `refundTo`.
9. **Test-only messages:** `TestMint` (0x4d4700e1: queryId, to, amount, responseDestination,
   forwardTonAmount, forwardPayload: Cell?) on `TestJettonMaster(owner, salt)`, and `FakeSend`
   (0x4d4700f1: to, value, bounce, body: Cell) on `FakeJettonWallet(owner, salt)`.

Observed costs in the smoke test (sandbox, current mainnet config), for tuning the §3 constants:
- Router→Pool hop with StateInit: about 0.0045 Gram forward fee (Pool code is ~7.2 KB).
- Gram→jetton swap end to end: about 0.011 Gram of fees; jetton→Gram about 0.008.
- Two-step deposit, completing side: about 0.012; dual deposit with an unused-jetton refund: about 0.014.
- Burn (native pool): about 0.006.
So `SWAP_GAS 0.2`, `PROVIDE_GAS 0.3` and the others are well above 1.5× and can be lowered once
the full test suite measures worst cases (referral + fwdTon + pool deploy).

Known gaps (not done by the contracts engineer):
- The full §10 suite (security, admin, fuzz, overflow, exact-minimum gas tests) is not written yet.
- `bounced<JettonTransfer>` in the Router is not distinguished from other bounces.
- The launchpad still needs its `graduate()` changed to send `ProvideBothPayload` (not in `dex/`).

---

## 14. Test suite and fixes (test engineer)

`npx jest dex/tests`: 9 suites, 98 tests, all passing (sandbox only). Shared fixture in
`tests/helpers.ts`: a Router, three TestJettons minted to alice/bob/carol, chain time fixed at
`T0`, flow helpers, trace parsers (GramPayout, PayTo, RefundEvent, SwapEvent), an independent
BigInt model of §7 (`modelSwap`, `modelAdd`, `modelBurn`), and `checkSolvency` (§9.2, exact to
the unit when nothing was donated).

| Spec | Covers |
|------|--------|
| `swap` | all three directions vs the model; reserves/fees; Gram and jetton referral; refBps cap; slippage, deadline (Router and, via `sendMessageIter`, Pool-side in flight), empty pool, zero out, LOW_GAS (incl. exactly `ROUTER_REFUND_MIN` and below it), bad payloads; fwdTon/fwdPayload delivery; **exact-minimum value succeeds and minimum − 1 refunds/throws** (minimum computed from the measured `readForwardFee`) |
| `liquidity` | first deposits (both orders, jetton/jetton), `MIN_LIQUIDITY` lock and LP_BELOW_MIN, unbalanced deposits with unused-side refunds, minLpOut refunds, LpAccountRefund (+ auth/gas), creation pause, burns (pro-rata, mins/deadline/gas bounce restores LP, full exit), LP transfers |
| `graduation` | hand-built `ProvideBothPayload` equals the generated one (one cell), LP locked at the zero address, exact minimum, `requireEmpty` vs a squatter, strict minLpOut, paused/deadline/zero-gram refunds, lying forward amount |
| `admin` | fees within/above caps, non-admin and low gas, missing pool bounce, pause/treasury, 2-step admin with cancel, WithdrawRouterExcess cannot touch pool/LpAccount funds, fee collection (Gram + jetton legs, jetton/jetton at exactly `COLLECT_GAS`, treasury frozen at request time) |
| `security` | 1e30 fake notifications, fake deposit claiming another user, masterchain fake, inline payloads, broken wallet bounce, forged PayTo / PoolSwap / PoolProvide / PoolSetFees / PoolCollectFees / Cb* / LpBurnNotification / LpAccountDeposit / LP mints, donations, round trips, 2^119 + 2^119 overflow (LpAccount, Pool deposit, swap), dust/griefing, 200 alternating tiny swaps |
| `getters` | Router/Pool/LpAccount/LpWallet getters, TEP-64 metadata, TEP-89, expected-value getters vs the model |
| `invariant` | 200 seeded random ops over 3 pools / 3 users: every swap matches the model, k and LP share value never decrease, exact solvency after every op |
| `gas` | measured worst-case cost of each flow vs its constant (asserts ≥ 1.5× margin; prints a table) |

Contract changes made while testing:
1. **Router, 0-amount `JettonNotification`.** It used to answer with a 0-amount refund transfer,
   which stricter wallets reject (the trace then contained a failed transaction and a bounce).
   It now emits `RefundEvent(BAD_PAYLOAD)` and returns the gas to `msg.sender`.
2. **Router `bounced<JettonTransfer>`** now emits `RefundEvent{code: 214 TRANSFER_BOUNCED, user: the wallet}`
   (closes the §13.6 gap); other bounces still fall through to `bounced(Slice)`.
3. **Mock only:** `FakeJettonWallet` with an odd `salt` rejects `JettonTransfer` (a broken jetton).

Measured worst cases (Gram): swaps 0.009–0.013, swap into a missing pool 0.056 incl. the 0.05
buffer, first side creating pool + LpAccount 0.068 incl. buffers, completing deposit 0.014, dual
deposit 0.012 (0.059 when it creates the pool), burns 0.004–0.006 after the LP wallet, collect
0.004, LpAccountRefund 0.0035. Every constant has ≥ 3.4× margin; most have > 20×.
Note: a dust Gram referral (e.g. 1000 nanogram) arrives at a wallet that cannot buy gas with it;
the recipient's transaction is skipped (no-gas) but the value is credited.

---

## 15. External review fixes (lead)

`npx jest dex/tests`: 10 suites, 112 tests, all passing. The new `tests/review.spec.ts` holds the
regression tests; each of them failed before its fix.

1. **High: the Router as a payout recipient.** A swap with `receiver = Router` and a
   `ProvideLpPayload` as `fwdPayload` made the Router's own wallet notify the Router with
   `sender = Router`, parking the jettons in a shared `LpAccount(pool, Router)` that anyone could
   complete (theft) and nobody could refund (native pools: locked). Fixed in `router.tact`:
   - `swapJetton`, `provideJetton`, `provideBoth` refund to the jetton sender with
     `RefundEvent(215 BAD_RECIPIENT)` when receiver/refundTo/referral/lpReceiver is the Router;
   - `SwapNative` and `ProvideLpNative` throw `"Invalid recipient"` (the bounce returns the Gram);
   - a `JettonNotification` with `sender == Router` emits 215 and is never routed;
   - `SetTreasury(Router)` throws `"Invalid recipient"`.
   Multi-hop stays out of scope (§11); it needs its own `next` hop, not a Router receiver.
2. **Medium: payload-carrying hops were under-budgeted, and a bounced payout stranded the output.**
   - The swap minimum now adds `payloadFee(fwdPayload) = PAYLOAD_HOPS (6) * getForwardFee(cells,
     bits)` (5 hops carry the payload after the Router). Exposed as `get_payload_fee(payload)`.
   - Payloads above `MAX_PAYLOAD_CELLS` (32 distinct cells) are refused: BAD_PAYLOAD on the jetton
     path, `"Payload too large"` on `SwapNative`. The reviewer's 1365-cell payload is refunded
     before the pool moves. The fee for a 32-cell payload is about 0.0147 Gram; for a one-cell
     payload about 0.0005-0.0008.
   - `PayTo` never bounces for lack of value: if the value cannot pay `fwdTon + 3 * transfer fee +
     PAYOUT_WALLET_MIN (0.06)`, the Router delivers the jettons **without** fwdTon/payload and
     emits `RefundEvent(216 FWD_DROPPED)`; the unspent value still reaches `excessTo`.
   - Still open: a jetton wallet that rejects a valid transfer (broken, frozen or malicious jetton)
     leaves that payout stranded in the Router's wallet with only a 214 event. See README.
3. **Low: rounding the counterpart up could donate a whole coarse unit.** Fixed with the hybrid
   rule in §7 (`calcAddLiquidity`, mirrored by `modelAdd`). The reviewer's case (1000 Gram /
   10 units, deposit 150 Gram + 2 units) now takes 100 Gram + 1 unit for 316227 LP and refunds the
   rest, instead of taking everything for 474341 LP.
4. **Low: every Router -> Pool message carries the Pool StateInit.** Real (about 40% of a swap's
   fees) but deferred: dropping the StateInit on swaps needs a bounceable PoolSwap whose bounce
   carries enough to refund (or a masterchain library cell for the Pool code). Neither is cheap
   to do safely; it is the first gas optimisation for Phase 2.

