# MARG

**Launchpad + DEX on TON.** Live at [marg.lol](https://marg.lol) (open beta).

Tokens launch straight into a MARG DEX pool in one transaction: no bonding curve, liquidity locked forever, trading from the first block. The DEX itself is a concentrated-liquidity AMM with native TON (Gram) as the quote asset.

| | |
|---|---|
| Website | https://marg.lol |
| X | https://x.com/Marg_lol |
| Telegram | https://t.me/marglolportal · new launches: https://t.me/marglollaunches |

## What's in this repo

| Folder | What it is |
|---|---|
| [`dex/v2`](dex/v2) | **MARG DEX**: Router, Pool, Position (NFT), MintAccount. Tick-based concentrated liquidity, volatility-based fees, native TON, TWAP observations, tax plugin and the launchpad platform fee. See its [README](dex/v2/README.md) and [DESIGN](dex/v2/DESIGN.md). |
| [`launch`](launch) | **Launchpad**: LaunchFactory, LaunchJetton (token + tax splitter + holder rewards + buyback & burn), LaunchWallet, LaunchVault (creator vault). See its [README](launch/README.md). |
| [`fees`](fees) | **FeeConverter**: collects protocol fees and launch-position fees, sells any jettons for TON, and forwards only TON to the treasury. |
| [`vaults`](vaults) | **Managed-liquidity vaults** for TON/USDT on MARG DEX (not deployed yet). See its [README](vaults/README.md). |
| [`web`](web) | The marg.lol app (React + Vite + TonConnect). |
| [`server`](server) | Indexer (token lists, trades, candles, holders, DexScreener/GeckoTerminal HTTP adapter), keeper bot (tax collects, buybacks, escrowed launch fees, holder-reward repairs, Router rent alerts), Telegram buy bot, image upload service, Toncenter method allowlist for the web proxy, nginx config and systemd units. |
| [`scripts`](scripts) | Mainnet deploy script (`deployMargV3.ts`). |

## Launching a token

- **Supply:** 1B, fixed; minting closed, no admin.
- **Liquidity tiers:** Low / Mid / High start market cap (2,600 / 10,000 / 30,000 TON), all on the 0.05% pool fee tier.
- **Dev buy:** optional, executed in the launch transaction itself, so nobody can buy first.
- **Anti-snipe:** optional extra fee on early buys (up to 90%), fading to 0.
- **Creator tax:** optional 1–5% per side, in TON, split between holder rewards, the creator's wallet and automatic buyback & burn. Paid out automatically. Holder rewards start once holders together own 1% of the supply (v4; until then the rewards share goes to the buyback, else the creator's wallet, so holder rewards always come with a buyback or wallet share; a dev buy of 1% gets there at once).
- **Creator vault:** optional, up to 50% of supply, locked 7–365 days, then released all at once or linearly.

## Fees

| Fee | Size | Paid in | Goes to |
|---|---|---|---|
| Launch fee | 0.5 TON per launch | TON | treasury |
| Platform fee (launch tokens) | 1% of every buy and sell, adjustable 0–1% (v4: 0.85–1%, the floor keeps buyback sandwiches unprofitable) | TON, directly in the swap | treasury |
| Creator tax (optional) | 0–5% per side | TON | holders / creator / buyback |
| Pool fee | per tier (0.01–1%) + volatility fee | the token paid in | liquidity providers (10% protocol share → treasury as TON) |

## Mainnet contracts

| Contract | Address |
|---|---|
| DEX Router | `EQBB5XdesZT29M6jlLKfZTOcZEw5Kqez6ntOedoRsbaKp0vZ` |
| Launch factory | `EQChP_pRE50KqE3QvRHwogpoCuIrp1To5sBckCIwNS1J27Ja` |
| Fee converter | `EQCxJIxG80ZaZ8e5cosqTwsTJeiZf7VjjIMbDC45bK3EI91W` |

These are the v4 contracts (this source, git tag `mainnet-v4`). Earlier deployments still exist on chain,
but the app no longer lists them: v3 (git tag `mainnet-v3`; Router `EQB5dkciMSABWKovdVBUs69piI2fBjyn5oqw46wbyRPe5A0H`,
factory `EQD3iwBtAWuoH6Xkr2Bi54pVRB-V6hGdkFD8PGbJWl4sH4O1`, converter `EQDQBf97VzDmmvzz-CdtyNmEJwwxZWvmykPuyx2pQFMdaM6M`)
and v2 (git tag `mainnet-v2`):

| v2 contract | Address |
|---|---|
| DEX Router | `EQDBEgfjO5B2K5hRGT9X1QNN5r7gCdB96xs0vXcS7aVdevpx` |
| Launch factory | `EQD2Uk5We90UtHN3ru2iRNpP44eEa3wsPnsd9zKbn5g2qCxb` |
| Fee converter | `EQAuTS8PGDSv7l8KCQgLVgGQtD2QPVuvfpDOLPbiNCra4z4y` |

The contracts are not upgradeable: nobody, including the admin, can change their code. Admin powers are limited to settings, most of them capped:

- **Router:** platform fee (≤ 1%; v4: 0.85–1%), the protocol share of pool fees (≤ 25%, default 10%, also on existing pools), adding fee presets (add-only, base fee ≤ 2%, new pools only), `SetCreationPaused` (pauses new plain pools created by a mint; graduations and launches are not affected, their payloads create pools anyway), `WithdrawRouterExcess` (Router Gram to the treasury; v3 sweeps down to 0.05 Gram, v4 leaves 0.55), and the treasury (basechain only). Anyone can send a pool's surplus Gram (above its reserves, fees and storage reserve) to the treasury with `SweepPoolSurplus`.
- **Launch factory:** launch tiers, the treasury (new launches only), the launch fee (can only go down), and `WithdrawExcess` (factory Gram above 0.05 to the treasury; this would include the value of a bounced launch setup older than the last 16 launches, which the admin returns to its creator by hand).
- **Fee converter:** the keeper, approved sell routes and the treasury wallet. A convert's `minOut` comes from the keeper or admin.

No admin power reaches LP reserves, positions, locked launch liquidity or pending taxes.

Storage rent (operations): every contract pays rent from its own balance. Keep the Router well above its
0.05 Gram minimum (it holds ~1 Gram, about 20 years of rent) and do not sweep it down with
`WithdrawRouterExcess`. A launch token whose trading has stopped for about two years starts paying rent
from held funds. To restore a live v3 master's reserve, send it a plain transfer of at least the
shortfall (`held() + 0.05 − balance`, about 0.0225 Gram per idle year beyond two; 0.2 Gram covers about
eight idle years; the rest goes to the creator). On v4 masters a plain transfer first tops the rent fund
up to 0.25 Gram and only the rest goes to the creator; a debt already owed is absorbed with the next
message. The app tops up a holder's nearly empty token wallet (0.05 Gram, counting the rent accrued since
its last transaction) before a claim or a sell. Admin roles move only by a two-step handover (nominate, then claim from the new wallet).

**Do not send jettons to the Router address by hand.** The Router only handles jettons that arrive
with a DEX payload (a swap or mint built by the app or an integration) and at least 0.08 Gram of forward
value; anything else stays in the Router's wallet for good, and no admin power can return it.
Integrators: keep `fwdTon = 0` on DEX payouts (as the app does); a payout with a forward value to a
long-idle receiver wallet can bounce into the Router and be lost.

The creator tax and the platform fee are charged on swaps in a token's launch pool. The app trades launch tokens only through that pool and does not open other pools or new positions for them.

## Operating rules

- **Routers ≥ 1 Gram.** Keep the live (v3) and the v4 Router at 1 Gram or more (a plain transfer tops them
  up). After a long dormancy rent would otherwise eat the fixed 0.07 Gram payout of an LP exit. The keeper
  logs an `ALERT` and shows each Router's balance in its `status` line.
- **Keeper repair after gas changes.** After any change of the gas price (config params 20/21), and once a
  day anyway, the keeper scans the wallets of v4 holder-rewards tokens and sends `SyncRewards` to any whose
  master view went stale (a bounced checkpoint). Watch its log for `ALERT … sum(acked) != totalShares`. A
  one-step gas rise of 12x or more while a checkpoint is in flight can leave a wallet stuck for good (see
  launch README, "Lost messages").
- **Separate Toncenter keys.** The web's `/toncenter` proxy (nginx + `server/tc-proxy.mjs`, read methods
  only) uses its own key. The indexer and the keeper each use their own `TONCENTER_API_KEY` from their env
  files, so browser traffic cannot exhaust their rate limits.
- **Fee converter runbook.** Converts are manual: send `ConvertJetton` as the converter admin, with
  `minOut` taken from a fresh quote (`get_quote` on the pool, or its TWAP) minus at most 1%; never a
  placeholder `minOut`, which can be sandwiched (audit L-7). Do not give the converter's keeper role to
  the server's hot keeper wallet (audit R8B-3): a stolen hot key could then convert with a weak `minOut`.
  Leave the keeper role empty, or give it to a separate wallet that is not kept on the server.

## Build and test

```bash
npm install
npm test        # compiles all Tact contracts (dex/v2, launch, vaults, fees) and runs the sandbox tests
```

Web app:

```bash
cd web && npm install && npm run dev
```

Set `VITE_DEX_ROUTER` and `VITE_LAUNCH_FACTORY` (see `web/.env.example`).

## Status

Open beta on mainnet. The contracts have been tested extensively in the TON sandbox (270+ tests, including invariant and adversarial tests) and reviewed internally, but **have not had an external audit yet**. Trading new tokens is risky; only use what you can afford to lose.

## License

[Business Source License 1.1](LICENSE). You may read, audit and test the code and use it for non-production purposes; production use (for example running a competing launchpad or DEX) is not permitted until the **Change Date, 2029-11-16**, when the code becomes available under the **MIT License**.
