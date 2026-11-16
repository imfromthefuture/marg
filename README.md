# Tron Launchpad

Pump.fun-style token launchpad on TON. Tokens trade on a bonding curve and graduate to a STON.fi v2 pool automatically.

## How it works

- **Factory** (`contracts/factory.tact`): creators call `CreateToken`, and the factory deploys a `TokenMaster`. The admin can change curve params and the launch fee for new launches (`UpdateParams`, platform fee hard-capped at 2%). The admin can also lower the platform fee on a token that's already live (`AdminLowerPlatformFee`), down to 0 but never back up.
- **TokenMaster** (`contracts/master.tact`): a TEP-74 jetton master with a constant-product curve on virtual reserves.
  - Buy: send `Buy`. The master mints tokens to your wallet and refunds any unused TON.
  - Sell: send `Sell` to your own jetton wallet. The wallet forwards it to the master, which burns the tokens and pays out TON. If the sell fails (slippage, curve closed), the tokens come back.
  - Fees: 1% to the platform plus 0–1% to the creator, charged on every curve trade. They accrue in the master, and anyone can call `ClaimFees` to pay them out. The creator can only lower their fee.
  - Graduation: once 25k TON has been raised, the curve closes. The remaining supply (~100M) and the raised TON go to STON.fi v2 via `provide_lp`, and the LP tokens go to the burn address.
- **TokenWallet** (`contracts/wallet.tact`): a standard jetton wallet with no transfer tax, plus the `Sell` op.

Default params (`scripts/params.ts`): 1B supply, $5k start mcap at Gram = $1.63, graduation at 25k Gram with 900M sold. That puts the graduation mcap at about 250k Gram (~$407k).

## Commands

```bash
npm install
npm test            # compiles Tact and runs the sandbox tests
FORK=1 npx jest stonfi-fork --forceExit   # graduation against real STON.fi v2 contracts forked from mainnet (needs network)
ROUTER=… PTON_WALLET=… TREASURY=… npx blueprint run deployFactory --testnet
FACTORY=… METADATA_URL=… CREATOR_FEE_BPS=50 DEV_BUY=10 npx blueprint run createToken --testnet
```

## Web app (`web/`)

React + Vite + TonConnect. It reads straight from the contracts through Toncenter, with no backend.

- **Tokens**: latest launches with market cap and graduation progress
- **Launch**: name, ticker, description, image, creator fee slider (0–1%) and an optional dev buy. Metadata is stored on-chain (TEP-64).
- **Token page**: stats, buy/sell with live quotes from the contract and slippage protection, your balance, and fee payout. Creators can lower their fee and the admin can lower the platform fee. After graduation it links to STON.fi with your referral fee attached.

```bash
cd web && cp .env.example .env   # set VITE_FACTORY (+ VITE_TONCENTER_KEY, VITE_REFERRAL_ADDRESS)
npm install && npm run dev
```

Token images are uploaded to our own server: `server/upload.mjs` is a dependency-free Node service that accepts PNG/JPG/WEBP/GIF up to 5 MB. It checks file type by the actual bytes and stores each file under its hash. nginx rate-limits uploads to 6 per minute per IP and serves the files from `/u/`.

### Live: http://tron.168-119-180-71.nip.io

The VPS layout:
- `/var/www/tron-web`: the static build. Redeploy with `rsync -az --delete web/dist/ root@168.119.180.71:/var/www/tron-web/`.
- `/opt/tron-upload`: the upload service, run by systemd as `tron-upload` under its own unprivileged user.
- `/var/www/tron-uploads`: uploaded images.
- `/etc/nginx/sites-available/tron`: the nginx site (from `server/nginx-tron.conf`).

For production, host `web/dist` and edit `public/tonconnect-manifest.json` with your real domain and icon. Wallets refuse to connect if the manifest URL isn't publicly reachable.

Not built yet: price chart and trade history. Both need an indexer that reads the master's transactions.

## Mainnet

The factory is at `EQCEUWUHjh8P75KEieTKLEQj14fTG3ftvGALkJeRN617OMqq`. It was deployed on 2026-11-12.

**Liquidity tiers.** Creators pick one at launch (`CreateToken.tier`). Every tier is shaped like pump.fun: about a 15x climb from launch to graduation, about 793M tokens sold on the curve, and the STON.fi pool opens at the curve's final price with the remaining 207M tokens. The tiers are defined in `scripts/params.ts` (`tierParams`):

| Tier | Raise (Gram side of the pool) | Start market cap | Graduation market cap |
|---|---|---|---|
| 0 Low | 8,000 Gram | 2.6k Gram | 38.7k Gram |
| 1 Mid | 25,000 Gram | 8.2k Gram | 121k Gram |
| 2 High | 60,000 Gram | 19.7k Gram | 290k Gram |

The admin can retune a tier for new launches with `UpdateParams{tier, params}`.

**Fees.** 1% platform fee only, with no creator fee. The admin can lower it per token.

**DEX settings.** STON.fi v2.2 router `EQCiypoBWNIEPlarBp04UePyEj5zH0ZDHxuRNqJ1WQx3FCY-`, with LP sent to the burn address.

**Mainnet test.** `scripts/mainnetFullTest.ts` passed 27/27 checks on this factory: every function, plus a real graduation into the STON.fi pool `EQD-P6wTvDGvnGiO3nRBMFauz_knvH4z7g3yXJ1A3ibWb95M` with 99.99% of the LP burned. It then switched all three tiers to production.

**Ownership.** `scripts/handOver.ts` moved the admin and treasury to the owner's wallet `UQDTilNL039U_aNPmGhoW4xoG7JjY52o6Xt0W1nTwaPkKA_F`. The test tokens MTA and MTB are hidden through `HIDE_TOKENS`.

**Retired factories.** `EQD8HJSy…` (creator fee) and `EQD8Vhr_…` (single curve, no tiers) are no longer used. The owner's wallet is admin of both.

## Indexer (`server/indexer/`)

Every curve buy and sell emits a `Trade` event (external out message, op `0x6b1a2c21`) with the trader, amounts and the reserves after the trade. The indexer:

- finds new tokens through the factory getters;
- reads all token transactions from toncenter v3 in batches of 50 accounts;
- stores trades in SQLite;
- serves the API under `/api/idx/`: `tokens`, `trades`, `token/<addr>`, `token/<addr>/trades`, `token/<addr>/candles?tf=60|300|900|3600|21600|86400`, `token/<addr>/holders`, `status`.

Holders come from toncenter's jetton index. If that index is unavailable, they are counted from net curve trades.

- Build: `cd server/indexer && npm run build` bundles `dist/indexer.js`, with only `better-sqlite3` external.
- Test: `npx jest indexer` feeds sandbox transactions through it.
- On the VPS it runs as systemd `tron-indexer` with `/opt/tron-indexer` as its code, `/var/lib/tron-indexer/indexer.db` as its database, and env `NETWORK` and `FACTORY`.
- Optional: put `TONCENTER_API_KEY=...` in `/etc/tron-indexer.env` for about 10 requests/s instead of 1.

## Testnet

`npx blueprint run testnetGraduation --testnet --mnemonic` uses the wallet in `.env`. It deploys a factory with a 1.5 TON graduation target, launches a token, buys until it graduates, and checks the pool on STON.fi's testnet router (`kQALh-JB…Wk0v`). It needs about 2.5 testnet TON.

## Before mainnet

- `tests/stonfi-fork.spec.ts` runs graduation against the real mainnet STON.fi v2.2 router (`EQCiypoB…FCY-`), loaded into the sandbox through Toncenter. It passes: the pool gets 24,999.39 TON + 99,999,999 tokens, 99.99% of the LP goes to the burn address (STON.fi locks the rest), and every transaction succeeds. Set `TONCENTER_API_KEY` to make it faster.
- Pick the router for mainnet from `https://api.ston.fi/v1/routers` (v2, `ConstantProduct`, `pool_creation_enabled: true`), and use the `pton_wallet_address` listed for that router.
- If `provide_lp` fails, the refunds go to the treasury, and the liquidity then has to be added manually.
- Get an audit.
- Platform income after graduation comes from STON.fi's referral fee (up to 1%) on swaps through the Mini App. That's set in the SDK swap call (`referralAddress`, `referralValue`), not in these contracts.
