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
| [`server`](server) | Indexer (token lists, trades, candles, holders, DexScreener/GeckoTerminal HTTP adapter), keeper bot (tax harvests, buybacks), Telegram buy bot, image upload service, nginx config and systemd units. |
| [`scripts`](scripts) | Mainnet deploy script (`deployMargV3.ts`). |

## Launching a token

- **Supply:** 1B, fixed; minting closed, no admin.
- **Liquidity tiers:** Low / Mid / High start market cap (2,600 / 10,000 / 30,000 TON), all on the 0.05% pool fee tier.
- **Dev buy:** optional, executed in the launch transaction itself, so nobody can buy first.
- **Anti-snipe:** optional extra fee on early buys (up to 90%), fading to 0.
- **Creator tax:** optional 1–5% per side, in TON, split between holder rewards, the creator's wallet and automatic buyback & burn. Paid out automatically.
- **Creator vault:** optional, up to 50% of supply, locked 7–365 days, then released all at once or linearly.

## Fees

| Fee | Size | Paid in | Goes to |
|---|---|---|---|
| Launch fee | 0.5 TON per launch | TON | treasury |
| Platform fee (launch tokens) | 1% of every buy and sell, adjustable 0–1% | TON, directly in the swap | treasury |
| Creator tax (optional) | 0–5% per side | TON | holders / creator / buyback |
| Pool fee | per tier (0.01–1%) + volatility fee | the token paid in | liquidity providers (10% protocol share → treasury as TON) |

## Mainnet contracts

| Contract | Address |
|---|---|
| DEX Router | `EQDBEgfjO5B2K5hRGT9X1QNN5r7gCdB96xs0vXcS7aVdevpx` |
| Launch factory | `EQD2Uk5We90UtHN3ru2iRNpP44eEa3wsPnsd9zKbn5g2qCxb` |
| Fee converter | `EQAuTS8PGDSv7l8KCQgLVgGQtD2QPVuvfpDOLPbiNCra4z4y` |

The contracts are not upgradeable: nobody, including the admin, can change their code. Admin powers are limited to capped settings (platform fee ≤ 1%, launch tiers, treasury, launch fee can only go down).

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
