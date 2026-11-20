# Marg liquidity vaults: design

Managed concentrated-liquidity vaults (Kamino / Arrakis / Charm-style) on top of Marg DEX v2.
First target: **Gram/USDT**. Sandbox build only; nothing here is deployed.

Version 2 (2026-11-12), audit fixes 2026-11-20. Version 1 ran on its own hook key and proved
silent USDT with a balance probe; its §13 proposed a small additive DEX change. That change was
approved and built (dex/v2 DESIGN §6.14), and the vault was reworked on top of it. §14 is the
build log of both versions; §14.6 lists the open risks; §14.7 the fixes of the internal audit's
vault findings (`pitch/audit-v3-2026-11-18.md`). The DEX it runs on is the current build in
`dex/v2/contracts` ("v4"); `dex_types.tact` was re-checked against it (§14.7).

---

## 0. What the vault learns, and from whom

A TON contract cannot read another contract's state. Everything the vault knows about the DEX
comes in a message, and every such message is authenticated by its sender:

| What the vault needs | DEX message (dex/v2 §6.14) | Authentication |
|---|---|---|
| Spot price, tick | `PoolObservation` (answer to the vault's own `PoolObserve`) | sender = the canonical pool (hot-path check). The pool only ever answers the requester, so every observation the vault receives is one it asked for. |
| TWAP | `PoolObservation.tickCumulative` (the pool's own accumulator at the pool's `now()`) at two times: a stored anchor and a fresh observation | same |
| Uncollected fees of a live position | `PoolObservation.feeGrowthInside0/1X128` for the position's range, against the position's fee checkpoint | same |
| Result of its own mint (NFT index, L, amounts used, refunds, fee checkpoint) | `MintReceipt` | sender = pool; sent only to the payer (`fromUser`), and only the vault can pay as the vault |
| Result of a decrease / collect (principal, fees, new L, new checkpoint) | `BurnReceipt`, from the Position NFT once it is free. Every decrease and collect of the vault (also a withdrawer's) pays the vault itself | sender = that op's Position (hot set of the vault's NFT addresses, then the op's cached NFT address) |
| Gram arriving | `GramPayout{queryId, amount}` | sender = pool |
| USDT arriving | `JettonNotification` from the vault's own USDT wallet with `sender = Router` (every DEX payout to the vault is notified: the vault only uses notifying ops) | sender = our wallet (hot-path check) |

**Consequences.**
- The vault runs on the **canonical plain key** `{GRAM, RW(USDT), spacing, ext = null}`: no hook,
  no initializer. Swappers pay the plain-pool price (no 0.01 Gram notification) and never touch a
  vault. Any number of vaults (strategies) can share the key: each owns its own NFTs, and every
  receipt, observation and payout goes only to the op's owner / payer / recipient.
- No balance probe and no `Recognize`: USDT is credited only when our wallet notifies it, so the
  strict solvency invariant `idle1 + fee1 + pendU ≤ wallet balance` holds by construction.
- Uncollected fees are part of NAV.

---

## 1. Contracts

| Contract | Role |
|---|---|
| `Vault` (`contracts/vault.tact`) | One per (canonical key, strategy, salt). TEP-74 share master, owner of up to a few Position NFTs (slot 0 = base, slot 1 = limit, ≥ 2 only after an abort), holder of idle Gram and of the vault's USDT wallet. |
| `VaultWallet` (`contracts/vault.tact`) | TEP-74 share wallet, copied from `launch/contracts/jetton.tact` (`LaunchWallet`). Change: a bounced burn returns the attached Gram to the owner. |
| `vault_math.tact` | Verbatim copy of the v3 math needed (TickMath, SqrtPriceMath, LiquidityMath, `subMod`). A test checks it against dex/v2's `MathHarness`. |
| `dex_types.tact` | Copies of the dex/v2 messages the vault sends or receives (same opcodes and layouts; a test checks the serialisations byte for byte). |
| `mocks/vault_math_harness.tact` | Test only: getters over the copied math. |

The DEX is used as built: the real `Router`, `Pool` and `Position`, and dex/v2's mock jetton as USDT.

---

## 2. Identity, setup and trust

`init(admin, router, usdtMaster, poolCodeHash, positionCodeHash, spacing, salt)`. The address
commits to the Router, the USDT master and the **hashes** of the DEX Pool and Position code; `salt`
lets several vaults (strategies) exist for the same key.

Setup (admin, once):
1. `VaultSetup{poolCode, positionCode, content}`: both code hashes are checked, the Position code
   is stored, and the USDT master is asked (TEP-89) for the vault's USDT wallet and the Router's
   (`RW(USDT)`, the DEX token id).
2. `TakeWalletAddress` × 2 (sender = master). The vault builds the canonical key and computes
   `pool = contractAddress(StateInit{poolCode, 0b0 · router · key})` (checked by a test against
   `Router.get_pool_address(GRAM, RW, spacing, null)`).

Open (admin, once): a USDT transfer with `OpenPayload{gramAmount, sqrtPriceInitX96, receiver}`.
`sqrtPriceInitX96` is the price the admin expects. The vault observes the pool:
- initialized: the spot must be within `maxDeviation` ticks of the expected price (else the open
  is refused and the seed stays idle for a retry); the seed's base range is minted at the spot;
- not initialized (or not even deployed: the observation bounces): the seed mint initializes the
  canonical pool at the admin's price.
The mint carries the DEX price band `expected ± maxDeviation`. The vault is IDLE once the mint's
receipt is in and its refunds have arrived.

---

## 3. State

```
hot:   pool, wallet (our USDT wallet), router, posKeys (hashes of our NFT addresses), cold cell
cold:  phase SETUP | OPENING | IDLE | REBALANCING
       supply        share supply (incl. DEAD_SHARES and queued-but-unpaid withdrawals)
       idle0, idle1  holders' Gram / USDT that really arrived
       exp0, exp1    signed: Σ op.r = what the DEX still owes per its receipts (< 0: arrived early)
       owe0, owe1    performance fee inside exp (taken from the arrivals)
       fee0, fee1    performance fee that arrived (treasury's, not holders')
       due0, due1    owed to withdrawers by their user decreases (inside idle / exp, not NAV)
       opGas         gas held by user-decrease ops to forward the withdrawer's legs
       pendG, pendU  Gram (amount + gas) / USDT of deposits waiting for their observation
       positions     slot -> {index, tL, tU, L, reserved, busy (op q), uf0, uf1 (fees at the last
                     observation), oRound, NFT address}
       fgs           slot -> the Position's fee checkpoint (fgLast)
       ops           queryId -> {kind, ctx, slot, index, done, ok, dL, a0, a1, r0, r1, f0, f1, …,
                     at (sent), g (held gas), u0, u1 (still to forward to the withdrawer), ref (re-sync)}
       deps          round -> pending deposit {from, receiver, a0, a1, minShares, gas, need, epoch, at}
       orc           last observation (spot, pool time, tickCumulative) + 3 TWAP anchors
       rnd, spotRound, epoch, seq
       reb, queue / worker / wdl / wtry, strategy, roles, lastRebalance, baseCenter
```

Solvency invariants (asserted after every random operation):
- `idle1 + fee1 + pendU ≤ USDT wallet balance` (credits only on notification);
- `idle0 + fee0 + heldGas ≤ Gram balance` (`heldGas` includes pending deposits and `opGas`);
- every tracked position's `L` and checkpoint equal the NFT's (copied from its receipts).

---

## 4. Deposits

### 4.1 Entries
- **Gram only:** `DepositNative{queryId, amount, minShares, receiver?}`, value ≥ amount +
  `DEPOSIT_GAS` (0.35). Refusals at entry `throw` (the bounce returns the Gram).
- **USDT (+ Gram):** USDT transfer with `forwardTonAmount ≥ gramAmount + DEPOSIT_GAS` and
  `DepositPayload{gramAmount, minShares, receiver?}`. Refusals refund both legs.

Accepted at entry only when quiescent: phase IDLE, not paused, supply > 0, no withdrawal running,
no position op in flight, at most `MAX_SLOTS` (3) live positions.

### 4.2 Asynchronous pricing on the deposit's own observation
An accepted deposit is parked in `deps` (its funds in `pendG` / `pendU`, outside NAV) and starts an
**observation round**: one `PoolObserve` per live position (its range), or one price-only request.
The round's requests are sent *after* the deposit arrived, so the observation cannot predate it.
When the round's last reply arrives (pool → vault is FIFO, so the round's replies are the latest
data), the deposit is priced. It is refunded unless:
- the vault is still IDLE / not paused, and `epoch` is unchanged (no position changed and no op
  was sent since the round started: withdrawals and rebalances take priority, a pending deposit
  never blocks them);
- the spot came from this round, and the pool's time is at most `MAX_OBS_AGE` (120 s) old;
- every live position's fees were read in this round;
- the TWAP is ready and `|spot − TWAP| ≤ maxDeviation`;
- `shares ≥ minShares` (and > 0).

```
value(x0, x1, √P) = x0·P + x1                                 (token1 units, × 2^64)
NAV(t, √P) = value(idle + exp − owe − due)
           + Σ_slots value(amountsForLiquidity(L − reserved, t, √P))
           + Σ_slots value(uf − uf·perfFeeBps/10000)           (uncollected fees, net of the perf fee)
shares = min( value(dep, √P_twap)·supply / NAV(twap, √P_twap),
              value(dep, √P_spot)·supply / NAV(spot, √P_spot) )
```
`uf_i = L · (feeGrowthInside_i − fgLast_i) >> 128`, from the observation and the checkpoint. A
checkpoint newer than the observation would wrap mod 2^256; such a reading counts as 0 (and the
epoch check refuses the deposit anyway).

### 4.3 First deposit and inflation
- Only the admin's open can be first; it needs ≥ 10 USDT of value and mints `DEAD_SHARES` (10^6)
  that nobody owns, plus the seed shares (1 share ≈ 1 USDT).
- The only donations the vault counts are DEX payouts to it (e.g. a swap output with
  `receiver = vault`): they raise the share price. Supply is ≥ 10^10 units after opening, and every
  deposit takes `minShares`. Tests cover a 1,000,000-USDT donation and a front-run.

---

## 5. Withdrawals (pro-rata, in kind, price-free)

### 5.1 Flow
The owner burns shares on their `VaultWallet` (`JettonBurn`, value ≥ `WITHDRAW_GAS` 1.8, mostly
refunded; at least min(0.1 share, supply/10⁶) shares). The recipient (`responseDestination`, else the
owner) must be a basechain address other than the vault, the Router, the Pool, the USDT master,
the vault's USDT wallet and the Router's USDT wallet. The vault queues `{recipient, shares, budget}`
(FIFO, ≤ 64; a refusal throws and the wallet restores the shares and the Gram). One withdrawal runs
at a time (the worker):
1. **Collect** every live position (`PositionDecreaseNotify`, ΔL = 0, recipient = vault). Fees go
   to the vault; their perf fee is booked.
2. Wait until the collects' receipts are in and their payouts have **arrived** (each op's `r ≤ 0`),
   or `PAYOUT_WAIT` (600 s) has passed (then any event or a `Poke` proceeds; a payout that never
   arrives only delays one withdrawal, it can never block withdrawals).
3. **Pay**: `g = idle0·s/S` Gram, `u = idle1·s/S` USDT now; `dL_i = L_i·s/S` of every position is
   reserved and decreased **to the vault** (`PositionDecreaseNotify`, recipient = vault, mins 0;
   `USER_PAY_GAS` is held by the op); `supply −= s`.
4. Each user decrease's receipt books its gross like a collect (perf fee on its fees) and owes the
   withdrawer `amount + (fees − perf)·dL/(L + dL)`: his principal and only his liquidity's share of
   the fees earned since the collect (`due`). Each leg is forwarded as soon as it has arrived (Gram
   as `VaultPayout{reason 1}`, USDT as a transfer whose excess returns the unused held gas).
5. Done when every user decrease's receipt is ok. A refused decrease (`BurnReceipt{ok = false}` or
   a bounce) is resent from the withdrawal's budget (a `Poke` tops it up); after `MAX_UDEC_TRIES` (3)
   refusals of one slot the **terminal path** runs: the reserved liquidity goes back to the holders
   and the withdrawer gets new shares worth it, priced like a deposit (min of the TWAP and spot
   quotes at the last observation). The worker never loops.

The withdrawer therefore receives his share of the fees accrued up to the collect and of those
earned on his liquidity until it left. Since the DEX always pays the vault, the Pool can never
refuse a user decrease for its recipient (the audit's H-1), and never pays a withdrawer the other
holders' fees (H-2). Removing liquidity at a manipulated price hands the LP the attacker's trades,
so `mins = 0` is safe; no price is used at all (except on the terminal path).

### 5.2 Withdrawals during a rebalance: queued
Withdrawals never wait on deposits. During a rebalance they wait in the queue (gas prepaid) and
start when it ends or is aborted (anyone, after 30 min). After an abort the queue starts as soon
as the aborted rebalance's in-flight ops have freed the positions (every op result kicks the
worker, audit L-1).

---

## 6. Inflows and the performance fee (no probe)

Every DEX payout to the vault is explicit: Gram as `GramPayout`, USDT as a notification from our
own wallet with `sender = Router` (the vault only uses notifying ops, which pay jettons with
`forward_ton_amount = NOTIFY_FWD_TON`). Receipts announce amounts; arrivals credit them:

```
receipt (ok, recipient = vault):  r += gross; exp += gross; perf = fees·bps/10000
                                  part of gross already arrived (r was < 0): its perf is taken from idle now
                                  the rest of perf -> f (owe)
arrival A for op q:               r −= A; exp −= A; t = min(A, f): fee += t, idle += A − t
arrival without an op:            idle += A (surplus for the holders, no perf fee)
user decrease receipt (ok):       as a collect, plus u = principal + pro-rata net fees; due += u
leg arrived (done, r ≤ 0, u > 0):  idle −= u, due −= u, forwarded to the withdrawer
op removed when done and r ≤ 0:   exp −= r (an over-arrival is recognised as surplus)
mint sent:                        idle −= a; r = a; exp += a   (owed back as position or refund)
mint receipt ok:                  r −= used; exp −= used; slot recorded with L and checkpoint
```
NAV is consistent at every moment, whatever the order of receipt and payouts (a payout that
overtakes its receipt is tested). Payouts carry the op's `queryId`; anyone can send the vault a
payout with a chosen `queryId` (a swap with `receiver = vault`), but it is real value: it can only
make an op settle earlier (the late real payout is then surplus), never be counted twice or
create value (tested in `async` and the random suite).

---

## 7. Rebalance

### 7.1 Who and when
`Rebalance{queryId}` from the keeper or the admin (only the admin when `keeper == null`: no
permissionless rebalance spam, audit L-2), value ≥ `REBALANCE_GAS` (3.5, most refunded). Synchronous checks (throw): keeper, phase IDLE, no withdrawal running, no op
unresolved or in flight, value, `MIN_REBALANCE_INTERVAL` (60 s). Then the vault enters REBALANCING
(deposits refused, withdrawals queued) and sends **its own observation**. On the reply it is
refused (event `RebalanceEvent{stage 5, code}`, keeper refunded) unless:
- the observation is fresh, the TWAP is ready and `|spot − TWAP| ≤ maxDeviation`;
- and the spot is outside the base range, or `|spot − baseCenter| ≥ threshold`, or the cooldown
  passed.

### 7.2 Steps
```
OBSERVE  the round above; TWAP t̄ fixed for the new ranges
CLOSE    every slot with L > 0: PositionDecreaseNotify{ΔL = L, recipient = vault}
SETTLE   all close receipts in and every close's payouts arrived
MINT     base [floorS(t̄ − W), floorS(t̄ + W) + s] with the largest balanced pair at t̄;
         limit: the leftover token, single-sided, just beyond the deviation band;
         both: DEX price band [max(t̄ − maxDev, spot − maxDev/4), min(t̄ + maxDev, spot + maxDev/4)]
         around the rebalance's own observed spot, minLiquidity 99% of the band's worst case
SETTLE   mint receipts in and refunds arrived
IDLE     lastRebalance = now; keeper refund; the withdrawal worker starts
```
No swap to the target ratio (the limit range deploys the leftovers, Charm-style). Fees of both
tokens are compounded on every rebalance; no keeper claim is needed.

Between CLOSE and MINT the vault's liquidity is out of the pool (if it is the main LP, the pool is
empty) and the price can be moved for free. The Pool enforces the mint's price band when the mint
executes, so the narrow band (±maxDeviation/4 around the spot the rebalance observed, 25 ticks by
default) bounds what such a move can do; a mint outside it is refused and refunded to idle (the
next rebalance redeploys it), never executed at a moved price (audit L-3).

### 7.3 Abort
`AbortRebalance` (anyone) after `REBALANCE_TIMEOUT` (30 min): IDLE, keeper refunded. Op records
stay; late receipts and payouts reconcile on arrival (a late mint lands in a free slot ≥ 2). Ops
of an aborted rebalance never hold up the next one (each rebalance and withdrawal only waits for
the ops it sent).

---

## 8. Oracle (TWAP from the pool's accumulator)

- Every `PoolObservation` (any round: deposits, rebalances, `Poke`) updates the spot cache
  `{tick, √P, pool time, tickCumulative}` if it is newer, and pushes an **anchor**
  `(tickCumulative, pool time)` when the newest anchor is at least `twapWindow/2` old (3 anchors).
  Uninitialized observations never become anchors.
- `TWAP = floor((cum_spot − cum_A) / (t_spot − t_A))` for the newest anchor at least `twapWindow`
  older than the spot. All values are the pool's own: the TWAP is the pool's exact time-weighted
  tick between two real observations; a swap can move it only by holding the price for the window.
- Readiness needs an anchor ≥ W old: after a quiet period the keeper (or anyone) `Poke`s, waits W,
  then rebalances. A very old anchor only lengthens the window (harder to manipulate, slower to
  follow); with the deviation guard that means refusals, never a mispricing.
- Freshness: price decisions are taken only on the deciding operation's own round, with pool time
  ≤ 120 s old. A forged observation is refused at the hot-path pool check; a delayed real one is
  refused as stale.

---

## 9. Fees and admin

- **Performance fee:** `perfFeeBps` (default 1000 = 10%, hard cap 2000) of collected LP fees of
  both tokens, booked from the receipts' `fees` and taken from the arrivals. `CollectFees` (anyone)
  pays the treasury. No management fee.
- **Admin powers (all capped):** lower / raise the performance fee within the cap, set the keeper
  (null = permissionless), set the treasury, pause new deposits, set strategy parameters inside hard
  caps, two-step admin transfer. **No admin path touches idle funds, positions, the queue or
  withdrawals.**

| Parameter | Default | Hard cap |
|---|---|---|
| baseHalfWidth (ticks) | 1200 (≈ ±12%) | [spacing, 50 000], multiple of spacing |
| limitWidth (ticks) | 1200 | [spacing, 50 000], multiple of spacing |
| threshold (ticks from base center) | 600 | [spacing, baseHalfWidth] |
| cooldown (s) | 86 400 | [3 600, 30 days] |
| twapWindow (s) | 1 800 | [300, 86 400] |
| maxDeviation (ticks) | 100 (≈ 1%) | [1, 500] |
| perfFeeBps | 1000 | ≤ 2000 |

---

## 10. Gas

DEX conventions: constants ≥ 1.5× the measured cost at 400 nanoGram/gas (six times today's
mainnet price, 66.67 nanoGram/gas); every vault transaction measures < 240k gas (limit 1M); bounceable entries
`require` their value; every multi-step flow is prepaid by its initiator, held (`heldGas`) and the
unused part refunded; budgeted handlers charge their exact compute (`getComputeFee(gasConsumed() +
20k)`). DEX replies are accepted on the **hot path** right after the sender check (pool, our
wallet, or one of our NFTs), so a result can never be lost to an out-of-gas handler.

| Constant | Value | Covers |
|---|---|---|
| `DEPOSIT_GAS` | 0.35 | entry + ≤ 3 observations (0.04 each) + pricing + share wallet (or refund) |
| `OBS_VALUE` | 0.04 | one `PoolObserve` (DEX minimum 0.03) |
| `POS_OP_VALUE` | 0.32 | one `PositionDecreaseNotify` (DEX minimum 0.3) |
| `MINT_FWD` / `MINT_NATIVE_GAS` | 0.72 | DEX `MINT_GAS` + `MINT_NOTIFY_GAS` = 0.65 + margin |
| `WITHDRAW_GAS` | 1.8 | 2 positions × (collect + decrease + `USER_PAY_GAS`) + idle payouts + compute |
| `USER_PAY_GAS` | 0.16 | held per user decrease: the USDT forward (0.08) + its compute ×1.5; the rest is returned |
| `RECOVER_GAS` | 0.5 | `Recover`: compute + re-sync collects (`POS_OP_VALUE` each); the rest is refunded |
| `REBALANCE_GAS` | 3.5 | observation + 2 closes + 2 mints (+ DEX tick fees) |
| `POKE_GAS` | 0.1 | one observation + compute |
| `VAULT_MIN_STORAGE` | 0.5 | rent buffer |

Measured values: §14.4.

---

## 11. Failure handling (every handler is total once it holds funds)

| Situation | Outcome |
|---|---|
| Native deposit refused at entry | throw → the bounce returns the Gram |
| Deposit refused at pricing (oracle, minShares, vault changed meanwhile) | both legs refunded (`VaultPayout{reason 4}` + USDT transfer), `DepositRefusedEvent` |
| Burn refused (queue full, low gas, bad recipient) | throw → the wallet restores the shares and forwards the Gram |
| `BurnReceipt{ok = false}` (Pool refusal) or `bounced<PositionDecreaseNotify>` | definite failure; a user decrease is resent (terminal path after 3), a collect is skipped (fees stay in the position), a close keeps the position |
| `MintReceipt{ok = false}` | the slot stays empty; refunds arrive as payouts |
| `bounced<MintNativeNotify>` / a bounced USDT mint transfer | both legs restored from the op record |
| Router-level refusal of the vault's jetton mint | USDT refunded notified; the Gram leg comes back in the wallet's excess and is matched to the op (an excess ≥ `r0` + `MINT_FWD`/2) |
| A DEX reply lost for good (the vault's handler failed, a message dropped) | `Recover` (§11.1) |
| `bounced<PoolObserve>` (pool not deployed) | the round gets its reply without data (open: initialize; deposit / rebalance: refused) |
| Payout that never arrives | rebalance: settle waits → abort after 30 min; withdrawal: proceeds after `PAYOUT_WAIT` (the money, if it ever comes, is surplus) |
| Forged observation / receipt / payout | refused or ignored at the hot sender check |
| Payout with our `queryId` from a third party (swap to the vault) | real value: settles an op early at most; counted once |

### 11.1 Recover (audit M-1)

`Recover{queryId}` (anyone, value ≥ `RECOVER_GAS` 0.5, unused part refunded; at most 4 items per
call; refused when nothing is stale):

| Stale state | After | Resolution |
|---|---|---|
| Pending deposit (its observation never came back) | `DEP_TIMEOUT` 600 s | both legs refunded (`DepositRefusedEvent{code 6}`); a late reply finds no deposit |
| Position op (close / collect / user decrease) without receipt; the NFT is busy for the vault | `RECOVERY_DELAY` 25 h = op deadline + 1 h: the lost op can no longer execute | the vault sends a fresh collect (`K_SYNC`, ΔL = 0). Nothing else touched the NFT since, so its receipt tells whether the lost op ran: ran → what arrived for it is its result (a user decrease forwards all of it to the withdrawer); did not run → it failed (a user decrease is retried) |
| Mint without receipt | 25 h (past its DEX deadline) | marked failed (unblocks rebalances); the record stays, so a late refund (USDT, Gram excess, bounce) is matched |
| Finished op whose payout never arrived | 25 h after it was sent (or after a mint was marked failed) | written off (`exp`, `owe`, `due`); a later arrival is surplus |
| Re-sync without answer | 25 h | dropped; the lost op can be re-synced again |

---

## 12. Decisions and alternatives

1. **Canonical plain pool, not a hook key** (v2). Liquidity is not fragmented, swappers pay
   nothing extra, many strategies per key. Cost: the vault must ask for every price (async
   deposits) instead of being told.
2. **Asynchronous deposits on their own observation.** A cached price would allow stale-price
   arbitrage; a fresh round per deposit costs ~0.05–0.1 Gram and one round trip.
3. **Collect before paying a withdrawal** (new in v2, because fees are now in NAV): a depositor
   pays for accrued fees, so a withdrawer must receive them.
4. **Deposits never block withdrawals or rebalances**: a deposit is refunded if anything changed
   while its observation was in flight.
5. **No swap to ratio** (unchanged): base + limit positions deploy the leftovers.
6. **Withdrawals through the vault** (changed by the audit fixes; was "straight from the Pool to
   the user"): the Pool pays the vault, the vault forwards. It costs one more hop and a held
   `USER_PAY_GAS`, and the vault holds a withdrawer's principal for one transaction (or until its
   leg arrives, booked in `due`). In exchange the Pool can never refuse a user decrease for its
   recipient and the fees are split pro-rata (§5.1).

---

## 13. DEX change used (dex/v2 §6.14, built)

`PoolObserve` → `PoolObservation`; `PositionDecreaseNotify` → `BurnReceipt` (relayed by the
Position once free; notified jetton payouts); `MintNotifyPayload` / `MintNativeNotify` →
`MintReceipt` to the payer (notified jetton refunds). The proposal had the Pool send the burn
receipt; the built version has the Position relay it, which merges "result" and "NFT free" into
one message and removes the version-1 sentinel protocol.

---

## 14. Build log

### 14.1 Version 1 (hook key, 2026-11-12, superseded)
The vault was the hook (`AFTER_SWAP | AFTER_MODIFY`) and initializer of its own key, kept its own
tick accumulator from swap hooks, matched mint/burn hooks to ops, proved silent USDT with a balance
probe (`Recognize`, keeper `claim1`), and used sentinel collects to prove the order of a Position
excess and a Pool hook. 39 tests; self-review findings F1–F11 (§14.5 of that version). Dead in v2:
hook handlers, probe, `Recognize`, `claim1`, sentinels, hints.

### 14.2 Version 2: what changed and why
1. Canonical plain key; the pool address is computed for `ext = null`. The vault no longer
   initializes the pool unless nobody has.
2. Oracle from `PoolObservation` (pool accumulator) instead of hooks (§8). Deposits became
   asynchronous (§4.2). Rebalance price checks moved to the rebalance's own observation; refusals
   are events, not throws (`Not needed`, `Price deviation` used to be exit codes).
3. NAV includes uncollected fees (§4.2); withdrawals collect first (§5.1).
4. Results from receipts; inflows from explicit payouts with signed per-op accounting (§6). The
   probe, `Recognize`, `claim1`, sentinels and hints are removed.
5. Hot fields: `pool`, `wallet`, `router`, `posKeys`. Version 1's hot oracle is gone (no swap hook).
6. Tact 1.6 quirk: a mutating extension call with a single struct argument of more than 16 fields
   emits a FunC tensor cast that does not compile; such helpers take scalars instead.

### 14.3 Self-review (adversarial pass on v2) — fixed
| # | Finding | Fix |
|---|---|---|
| G1 | A USDT payout with no op (or before its op is found) was processed without accepting gas; at 37.7k gas it exceeded the 0.01 forward value, so a real payout could be lost (USDT unaccounted). | DEX-routed notifications (`sender = Router`) are accepted on the hot path (hot `router` field). |
| G2 | The BurnReceipt pre-accept path (cold load + op lookup + address check) cost 30.7k gas against a 0.019 receipt: under 1.6× margin, and a rent-starved Position sends less. | Hot `posKeys` set: 4.2k gas before accept. DEX side: the Position keeps `RECEIPT_FLOOR` (0.008) for the receipt even when rent ate its buffer. |
| G3 | Ops of an aborted rebalance (or an earlier withdrawal) whose payouts never arrived kept "in flight" forever and would block every later settle. | Each rebalance / withdrawal waits only for ops sent since its start (`since`). |
| G4 | `JettonExcesses` with a live `queryId` from anyone accepted gas and was charged to the op's budget (drainable by dust). | Excesses are never accepted; they credit their value if they can run on it. |
| G5 | A deposit with > 3 live positions could leave too little gas to deploy the share wallet, which bounces after the deposit was credited. | `MAX_SLOTS` 3 (covered by `DEPOSIT_GAS`) and an explicit refusal when the remaining gas cannot pay the share mint. |
| G6 | A payout that overtakes its receipt (cross-shard) must not double-count or lose the perf fee. | Signed `r` / `exp`, perf on early arrivals taken at receipt; tested (`async`). |
| G7 | A withdrawal could wait forever for a collected-fee payout that never arrives. | `PAYOUT_WAIT` + `Poke`; tested. |
| G8 | A stale real observation (delayed) or a forged one could price a deposit. | Spot must be from the deposit's own round, pool time ≤ 120 s; hot pool check; both tested. |

### 14.4 Measured gas (sandbox; `PRINT_GAS=1 npx jest vaults/tests/gas.spec.ts`)
After the audit fixes (2026-11-20). Gram at 400 nanoGram/gas (the sizing price) and at today's
mainnet 66.67 nanoGram/gas.
| Flow | Vault gas | at 400 / 66.67 nG/gas | Paid by |
|---|---|---|---|
| Swap by someone else | 0 | 0 | — (no hook) |
| Deposit entry Gram / USDT / both | 80k / 98k / 98k | ≤ 0.039 / 0.0065 | depositor (0.35) |
| Deposit pricing (observation reply → shares) | 134k | 0.054 / 0.0089 | the deposit's gas |
| Withdraw: burn notification / largest tx (BurnReceipt) | 119k / 196k | 0.048 / 0.078 · 0.008 / 0.013 | withdrawer; 7 vault txs with one position; **net user cost ≈ 0.19 Gram** (sandbox) |
| Withdraw: USDT arrival → forwarded to the user | 111k | 0.044 / 0.0074 | `USER_PAY_GAS` held by the op (compute part 0.07) |
| Rebalance: start / observation → closes / last arrival → mints | 86k / 96k / 233k | 0.035 / 0.038 / 0.093 | keeper budget; 28 txs; **keeper net ≈ 1.21 Gram**, mostly the DEX's `TICK_INIT_FEE` |
| MintReceipt / GramPayout (max) | 108k / 119k | ≤ 0.048 | op budget |
| BurnReceipt pre-accept (non-NFT sender) | 4.2k | 0.0017 | the message's own value |
| USDT arrival without op (accepted) | 50k | 0.020 / 0.0033 | free buffer (the sender paid a DEX swap + the USDT) |
| Poke / CollectFees | 60k / 60k | 0.024 | 0.1 / 0.15 |
| Recover: stale deposit / lost decrease re-synced (max vault tx of the flow) | 89k / 221k | 0.036 / 0.089 | the caller (0.5) |

Every vault transaction is below 240k gas (limit 1M). The vault's free gas buffer does not shrink
over a rebalance (asserted). Code: Vault 109.3 KB (85.2 KB before the audit fixes; v1 61.6 KB),
VaultWallet 1.1 KB.

### 14.5 Tests
`npx jest vaults/tests -i`: 14 suites, 55 tests (math 4, smoke 1, deposit 7, withdraw 6,
rebalance 9, security 9, async 4, multi 2, invariant 1, gas 1, audit4-recipient 1,
audit4-feeskim 1, fixes 9, lifecycle 1). New for v2: two vaults on one key, a plain swapper
paying no hook fee, forged and stale observations, NAV including uncollected fees, payouts
overtaking receipts, a never-arriving fee payout. New with the audit fixes: the audit's two PoCs as
regressions, the H-1 terminal path, `Recover` for each lost-reply state (with the late messages
delivered afterwards), the queue kick after an abort, the minimum withdrawal and keeper-only
rebalances, the mint price band, and a full lifecycle with per-token conservation checks. The
random suite runs 220 operations per seed (with DEX donations and pokes).

### 14.6 Open risks (not fixed; documented)
1. **Deposits need quiet.** A deposit is refunded if a withdrawal, rebalance or late op touches the
   positions while its observation is in flight (seconds). Withdrawals have priority by design.
2. **A payout that never arrives** (only below documented DEX values, or a dropped forward) stays in
   `exp` (in NAV, not paid to withdrawers) until it arrives or `Recover` writes it off (25 h); a
   rebalance stalls until abort. For a user decrease, the withdrawer loses a leg that never arrives
   (as before, when the Pool paid him directly).
3. **Withdrawals are serialized** (one at a time, ~3 DEX round trips each, queue of 64). A stream of
   withdrawals delays rebalances and refunds deposits.
4. **Forfeits:** withdrawers forfeit their share of amounts still in flight (`exp`) and of
   overflow positions (slots ≥ 2, only after an abort); a failed collect leaves that slot's fees to
   the remaining holders.
5. **TWAP liveness:** anchors exist only where someone observed. After a quiet period a keeper
   must `Poke` and wait one window before rebalancing.
6. **A Position NFT that never answers** (DEX rent gaps, a frozen account) blocks the withdrawal
   worker; `Recover` re-syncs only once the NFT answers again.
7. **Rent:** a 109 KB code cell plus state ≈ 1 Gram/yr (estimated); nothing refills the buffer
   automatically. Anyone can top up with a plain transfer; a library cell would cut it.
8. **Real USDT wallet:** the vault relies on the jetton wallet notifying transfers with
   `forward_ton_amount > 0` (TEP-74). Tether's admin can freeze a wallet.
9. **Keeper economics:** a rebalance costs ≈ 1.2 Gram, mostly DEX tick fees; the vault pays
   keepers nothing. With `keeper == null` only the admin can rebalance.
10. **Lost receipt of a mint that ran** (only if the vault's own handler failed): `Recover` marks
    it failed; the NFT exists, owned by the vault, but is no longer tracked (its value is lost to
    the holders). A lost receipt of a position op is resolved exactly (re-sync).
11. **Terminal path pricing:** compensation shares for a refused user decrease use the last
    observation (min of TWAP and spot quotes), not a fresh one. Reachable only if the DEX refuses
    the vault's own decrease three times (recipient = vault, mins 0, deadline 24 h: rent or a DEX
    fault), never by a withdrawer.
12. **L-3 residual:** between close and mint the price can still be moved within ±maxDeviation/4
    (25 ticks) of the observed spot at no cost when the vault is the only LP; the cost to the
    holders is bounded by that band (16× less than with the former ±maxDeviation band). A real move
    beyond it makes the mint refuse; the funds wait idle for the next rebalance.
13. Not audited externally.

### 14.7 Audit fixes (internal audit v3, 2026-11-18; fixed 2026-11-20)
| # | Finding | Fix | Test |
|---|---|---|---|
| H-1 | A withdrawal with recipient = Router / Pool made the Pool refuse the user decrease (215) forever; the worker looped and the vault froze. | (a) The recipient is checked at the request: basechain and not the vault, Router, Pool, USDT master, the vault's or the Router's USDT wallet (the burn bounces: shares and Gram restored). (b) Every decrease pays the vault (recipient = vault), which forwards: the Pool can no longer refuse it for its recipient. (c) Terminal path: after 3 refusals of a slot's user decrease, its liquidity goes back to the holders and the withdrawer gets shares worth it; never an endless retry. | `audit4-recipient`, `fixes` "H-1 terminal path" |
| H-2 | The user decrease paid the whole position's fees since the collect to the withdrawer. | The decrease pays the vault; the receipt's fees are booked like a collect (perf fee, holders) and the withdrawer is owed only `(fees − perf)·dL/(L + dL)` on top of his principal (`due`), forwarded when it has arrived. | `audit4-feeskim` (exact amounts), `withdraw`, `invariant` |
| M-1 | No escape when a DEX reply is lost: pending deposits, an unresolved mint or a busy position blocked the vault. | `Recover` (§11.1): time-based, anyone, paid; each state ends consistent; late messages are matched or are surplus. Ops and deposits carry their send time. Mint bounces and a Router-level refusal's Gram excess are matched also after a recovery (former open risk 9). | `fixes` "M-1" (4 scenarios + refusals), `gas` |
| L-1 | Queued withdrawals were not started after an aborted rebalance. | Every op result (also of an aborted rebalance, a mint receipt or a bounce) runs `afterOp`: the rebalance pump and the worker kick. | `fixes` "L-1" |
| L-2 | Anyone could spam `Rebalance` while keeper = null; 32 dust burns filled the queue. | `Rebalance` from the keeper or the admin only (null keeper = admin only). Minimum withdrawal min(0.1 share, supply/10⁶); queue 64. | `fixes` "L-2", `rebalance` |
| L-3 | Pool liquidity is 0 between close and mint; the spot could be moved up to `maxDeviation` for the mint. | The mint's DEX price band is now ±maxDeviation/4 around the rebalance's own observed spot (inside TWAP ± maxDeviation), enforced by the Pool at execution. | `fixes` "L-3" (band in the sent mints) |

**DEX "v4" check.** `dex_types.tact` matches `dex/v2/contracts/messages.tact` (opcodes, field
order and widths of `PoolObserve`, `PoolObservation`, `PositionDecreaseNotify`, `BurnReceipt`,
`MintNotifyPayload`, `MintNativeNotify`, `MintReceipt`, `GramPayout`, `PoolKey`; the `math` suite
checks the serialisations against the dex/v2 build) and the constants it copies
(`OBSERVE_VALUE`, `DECREASE_NOTIFY_GAS`, `MINT_GAS`, `MINT_NOTIFY_GAS`, `MIN_POSITION_LIQUIDITY`)
are unchanged. v4's `payFees` only changes protocol / tax / platform fee collection; position
decreases still pay through `payTwo` with notified jetton legs, so the vault's inflow rules (§6)
hold. `PoolSweepSurplus`, `PROTOCOL_COLLECT_GAS` and the platform-fee floor do not touch the vault.
The Pool's `CODE_BAD_RECIPIENT` rule (Router / Pool refused) is what made H-1 possible; the vault now
never asks the DEX to pay anyone but itself.
