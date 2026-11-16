# DexScreener HTTP adapter

Served by the indexer under `/api/idx/dexscreener/` (code: `src/dex.ts`). Follows the
DexScreener / GeckoTerminal "Integration API v0.1".

| Endpoint | Returns |
|---|---|
| `GET /latest-block` | `{block:{blockNumber, blockTimestamp}}` |
| `GET /asset?id=<master>` | `{asset:{id, name, symbol, decimals, totalSupply?, coinGeckoId?}}` (name/symbol never empty) |
| `GET /pair?id=<pool>` | `{pair:{id, dexKey, asset0Id, asset1Id, createdAtBlockNumber?, createdAtBlockTimestamp?, createdAtTxnId?, creator?, feeBps?}}` |
| `GET /events?fromBlock=&toBlock=` (inclusive) | `{events:[...]}`: swaps `{block, eventType:'swap', txnId, txnIndex, eventIndex, maker, pairId, asset0In+asset1Out \| asset1In+asset0Out, priceNative, reserves}` and joins/exits `{block, eventType:'join'\|'exit', txnId, txnIndex, eventIndex, maker, pairId, amount0, amount1, reserves}` |

## Conventions

- **Block** = masterchain seqno (`mc_block_seqno` of the toncenter v3 transaction). Event
  `blockTimestamp` is the transaction's `now`. `latest-block` is the masterchain block read
  (v3 `/masterchainInfo`) right before a poll round. It is published only after that round
  succeeds, so every event up to it is indexed. `/events` never returns events past it.
- **Pair** = one Marg DEX v2 pool. Asset order follows the on-chain key and never changes:
  `asset0` = token0 = Gram/TON (native id), `asset1` = token1 = the jetton (master address, friendly
  bounceable; the pool key holds the Router's jetton wallet, mapped back to the master).
  `priceNative` = price of asset0 in asset1 = **jettons per TON**: the pool's spot price right after
  the swap (`sqrtPriceX96^2 / 2^192`, times 10^(dec0 - dec1)), up to 24 significant digits and 50
  decimals. A swap whose price rounds to 0 is not served.
- **Native asset**: `{id, name:'Toncoin', symbol:'TON', decimals:9, totalSupply, coinGeckoId:'the-open-network'}`.
- **Native id**: `DEX_NATIVE_ID`, which defaults to the zero address in friendly form
  (`EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c` on mainnet). Confirm this with DexScreener.
- Amounts, prices and reserves are decimal strings normalized by decimals (USDT 6, launch tokens 9,
  Gram 9), at most 50 decimals (truncated).
- `txnId` = transaction hash in hex. `txnIndex` = the transaction's logical time (lt) (TON has no
  in-block index; lt orders a pool's transactions). `eventIndex` = 0, 1, 2… over the transaction's
  SwapEvents and ModifyEvents in emission order (out messages sorted by `created_lt`). Example: a
  launch tx is join (locked position) = 0, dev buy = 1.
- **join / exit** = the pool's `ModifyEvent` (op `0x4d480072`): `liquidityDelta > 0` join, `< 0` exit;
  `maker` = position owner, `amount0/amount1` = the event's principal amounts (an exit's claimed fees
  `fees0/fees1` are not included in them, but do leave the reserves). `liquidityDelta = 0` (fee
  collect) is stored for the reserve replay but not served. The launch's locked position is a join.
- `feeBps` = base fee in pips / 100 (presets: spacing 1, 10, 60 and 200 give 1, 5, 30 and 100 bps).
  The dynamic volatility fee and the launch fee are not included.
- Limits: at most 10,000 blocks per `/events` range and 20,000 events per response (400 beyond either).

## Reserves (every event)

Events carry no reserves, but every change of the pool's `reserve0/reserve1` is one of its events
(pool.tact), so each event stores its signed delta (`d0/d1`):
swap buy `(+amountIn - refFee - tax - protocolFee - hookFee, -amountOut)`, swap sell
`(-(amountOut + tax), +amountIn - refFee - protocolFee - hookFee)`, join `(+amount0, +amount1)`,
exit/collect `(-(amount0 + fees0), -(amount1 + fees1))`. Reserves after each event:

1. **Exact**: replayed forward from zero over the history known complete from the pool's creation
   (all of it once backfill is done, else up to the backfill cursor). Incremental via a checkpoint
   on `pools` (reset when an older event is inserted later).
2. **Snapshot**: newer polled events not covered by 1 are walked backwards from the `get_pool_state`
   read right after the poll round (exact unless the pool traded again in between). Replaced by 1
   once backfill completes.

Reserves are settled before the round's block is published. If none could be computed the pool's
last snapshot is served, so `reserves` is never omitted.

Upgrading from the v1 table (swaps only) drops `dex_events` and backfills every pool again.

## Pools

- **launch**: every direct-launch token's pool (from `tokens`). Spacing and fee come from `get_pool_state`.
- **plain**: Gram/X pools for each jetton in `DEX_PLAIN_ASSETS` × presets {1, 10, 60, 200}. The address
  is computed locally: `Pool.fromInit(DEX_ROUTER, {token0: Gram, token1: master.get_wallet_address(router), spacing, ext: null})`.
  The Router wallet and metadata (v3 `jetton/masters`) are cached in `assets`. Every
  `DEX_PLAIN_CHECK_SEC` (600 s), one batched v3 `accountStates` request checks which plain pools are
  deployed. Only deployed ones are polled.
- **Backfill**: each active pool's history is read once from its first transaction, one pool per round
  and at most 2 pages of 256. It fills `dex_events` (and launch `trades`) and the pair's creation tx/block,
  then replays the reserves.
  A plain pool's first swaps can land up to 10 min after DexScreener has already passed that block.

## Env

| Var | Default |
|---|---|
| `DEX_ROUTER` | Router of the first launch factory |
| `DEX_PLAIN_ASSETS` | USDT, NOT, DOGS, STON masters (comma list) |
| `DEX_PLAIN_CHECK_SEC` | 600 |
| `DEX_NATIVE_ID` | zero address, friendly |
| `DEX_NATIVE_SUPPLY` | 5000000000 |
| `DEX_KEY` | marg |
