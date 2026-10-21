# Papertrade API: integration guide

A complete, self-contained guide to reading data from and trading on **Papertrade**
(`https://exchange.papertrade.xyz`), written so that a developer or an LLM with no other context can build
on it.

> **Papertrade has no public or documented API.** Everything here was reverse-engineered from its web app's
> JavaScript and network traffic, and checked against the live service. It can change without notice: it
> already did once (see [§13](#13-api-drift-what-has-changed-and-how-to-detect-it)). Build defensively:
> validate shapes, fail loudly on surprises, and re-verify before relying on anything that moves money.
>
> **Papertrade collateral is real USDC on HyperEVM.** "Paper" is the protocol's name, not a sandbox.

**Last verified against the live service: 2026-10-17.**

| Mark | Meaning |
|---|---|
| ✓ | Called and checked against live data |
| ◐ | Read from the web app's code, consistent with live behaviour, but not exercised end to end |
| ✗ | Seen in the app's code only; never called |

A working TypeScript implementation of most of this lives in this repository (see
[§14](#14-reference-implementation-in-this-repo)). Copy from it rather than re-deriving.

---

## Contents

1. [How Papertrade works (the parts that matter for integrating)](#1-how-papertrade-works)
2. [Hosts, chain and contracts](#2-hosts-chain-and-contracts)
3. [Units and encoding](#3-units-and-encoding)
4. [Access rules and gotchas](#4-access-rules-and-gotchas)
5. [Market terms: `GET /state/trading`](#5-market-terms-get-statetrading)
6. [Account state: the live wallet stream (SSE)](#6-account-state-the-live-wallet-stream-sse)
7. [Other REST endpoints](#7-other-rest-endpoints)
8. [The realtime socket (Centrifugo)](#8-the-realtime-socket-centrifugo)
9. [Prices, PnL, fees and equity](#9-prices-pnl-fees-and-equity)
10. [Trading: signed intents](#10-trading-signed-intents)
11. [The execution queue and how long orders wait](#11-the-execution-queue-and-how-long-orders-wait)
12. [Copy-paste code](#12-copy-paste-code)
13. [API drift: what has changed and how to detect it](#13-api-drift-what-has-changed-and-how-to-detect-it)
14. [Reference implementation in this repo](#14-reference-implementation-in-this-repo)
15. [Safety checklist](#15-safety-checklist)

---

## 1. How Papertrade works

- **Perpetual futures on BTC and ETH**, up to 1000× leverage, positions up to $10M notional. Each position is
  self-contained (isolated margin): you can't add or remove margin, only close it in full or get liquidated.
- **Price is the Hyperliquid order-book mid.** Opens and closes execute at the midpoint of Hyperliquid's best
  bid and ask (BBO) in the block they land in. There is no spread, slippage, funding or notional fee.
- **The protocol's cut comes only from winning closes:** a tiny deadband, an "asymmetric impact" haircut on
  the gain, then a 2% win fee. Losses pay nothing extra ([§9](#9-prices-pnl-fees-and-equity)).
- **The counterparty is an LP pool ("the house").** When the LP can't pay a winner, the payout waits in a
  FIFO payout queue until losses refill it. That's a delay, not a haircut.
- **Every write is a signed message (an "intent")**, sent to Papertrade's server, which queues it. A
  **relayer** batches queued intents into HyperEVM transactions. Users never pay gas. Execution is
  asynchronous: an accepted intent may fill seconds or minutes later, or expire ([§11](#11-the-execution-queue-and-how-long-orders-wait)).
- **Session keys:** the master wallet signs once to authorize a local key for 30 days. That key then signs
  opens and closes without wallet prompts ([§10.6](#106-session-keys)).
- **PAPER token:** closing a losing position mints PAPER. Staked PAPER earns a share of fees, paid in USDC.

---

## 2. Hosts, chain and contracts

| What | Where |
|---|---|
| REST + account stream | `https://exchange.papertrade.xyz` |
| Realtime socket (Centrifugo) | `wss://stream.papertrade.xyz/connection/websocket`. **Not** on `exchange.`, where the same path is 404 |
| Docs (human, no API reference) | `https://docs.papertrade.xyz` |
| Price source | Hyperliquid: `wss://api.hyperliquid.xyz/ws`, `https://api.hyperliquid.xyz/info` |
| Chain | HyperEVM mainnet, chain id **999**, RPC `https://rpc.hyperliquid.xyz/evm` |

| Contract | Address |
|---|---|
| Exchange (positions, session keys, withdrawals) | `0x6cd5661646289fb6e65ea5c032310fded797d0a2` |
| PAPER token | `0xe40f17915daa230324030003a197cdaef2261c0e` |
| PAPER staking | `0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016` |
| Collateral (USDC, 6 decimals onchain) | `0x6b9e773128f453f5c2c60935ee2de2cbc5390a24` |
| Deposit proxy factory | `0x1629b7d46bef6e13ff754174fc9f32dea309b38f` |

Instruments: `0` = BTC (`priceScale` 10), `1` = ETH (`priceScale` 100). Read them from `/state/trading`
rather than hard-coding.

One useful onchain read ✓: `exchange.winFeeRate()` (selector `0x48ee5e08`) returns the win fee as a WAD
(currently `0x470de4df820000` = `0.02e18`, i.e. 2%).

```bash
curl -s https://rpc.hyperliquid.xyz/evm -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x6cd5661646289fb6e65ea5c032310fded797d0a2","data":"0x48ee5e08"},"latest"]}'
```

---

## 3. Units and encoding

- **USD amounts, margins and PAPER** are 18-decimal fixed-point integers (WAD), sent as **decimal strings**:
  `"1000000000000000000000"` = 1000. Use `BigInt`. JavaScript `Number` loses precision.
- **Prices** are integers scaled by the instrument's `priceScale`: BTC `815575` = 81,557.5; ETH `253385` =
  2,533.85. To convert a Hyperliquid price string, move the decimal point (see `toRawPrice` in
  [§12.4](#124-valuation)).
- **Open interest and its caps** are in the **asset's own units** as WAD (BTC, not USD).
- **Times** are milliseconds unless noted. Intent `deadline`s and session-key `expiry` are **unix seconds**.
  Position `openedAtMs` is a block time, so it has whole-second resolution.
- **Notional** = `margin × leverage`.
- **Addresses** are compared lowercase everywhere. Send them lowercase.
- Many structures arrive as **positional tuples** (arrays), not objects. The field order is given for each.

---

## 4. Access rules and gotchas

These cost real debugging time. Read them before writing code.

1. **No auth for reads.** Every account is public by address.
2. **Origin check (REST).** `/state/*` and `/query/*` return **400** when the request has an `Origin` header
   other than `https://exchange.papertrade.xyz`. Server-side code that sends no `Origin` (curl, Node `fetch`)
   works. Consequences:
   - **A web page on another origin cannot call the REST API.** It's not CORS: the server rejects the request.
     Put a small server-side proxy in front (this repo's dashboard does), or, in a browser extension, rewrite
     the `Origin` header with `declarativeNetRequest`.
   - Exception ✓: the account stream `/state/user/live` sends `Access-Control-Allow-Origin: *` and works
     from any page.
3. **Cloudflare.** HTML pages (e.g. `/trade/btc`) return 404 to plain curl. The JSON endpoints don't.
4. **Rate limits are per IP.** A 429 comes with `Retry-After`. The app also sends an optional
   `X-Papertrade-Build` header.
5. **Opening account streams is rate-limited** ✓: about 20 `/state/user/live` connections in a quick burst,
   then 429 with `Retry-After: 1`. Open them about one per second. This limit is on opening rate, not on how
   many stay open.
6. **A browser-style `EventSource` gives up for good on an HTTP error** such as that 429. `readyState`
   becomes `CLOSED` and it never retries. Reconnect yourself, with backoff.
7. **Streams die silently.** A socket can stop delivering without firing `close`, and the Centrifugo server
   can drop or error a subscription while still sending pings. Use watchdogs: no frames for 45s → reconnect;
   no data on a busy channel for N seconds → reconnect ([§8](#8-the-realtime-socket-centrifugo)).
8. **Query endpoints validate parameters strictly.** Any unexpected parameter or value returns
   `400 {"error":"path and query must contain only this route's parameters, with valid values"}`.
   - Example: the history endpoints only accept `limit=75`.
   - **Parameters must also be in alphabetical order** ✓: `?cursor=…&filter=all&limit=75` works, and
     `?limit=75&filter=all&cursor=…` is refused. The web app sorts them (`URLSearchParams.sort()`), so do the
     same. This bites on page 2 of any cursor-paged history.
9. **Node.js:** Node 20.18+ has `WebSocket` and `EventSource` behind
   `--experimental-websocket --experimental-eventsource`; Node 22+ has them by default.

---

## 5. Market terms: `GET /state/trading`

✓ The market rules and the instrument table. Poll it about once a minute at most; it changes rarely.

```jsonc
{
  "schemaVersion": 1,
  "indexedThroughBlock": 48752950,
  "tradingPaused": false,
  "minimumTradeSizeRaw": "10000000000000000000",       // minimum margin per open: $10
  "minimumOpenNotionalRaw": "1000000000000000000000",  // minimum notional per open: $1,000
  "accRewardPerShareRaw": "…",                         // PAPER staking accumulator (1e27-scaled, see §9.6)
  "instruments": [[ /* 23-field tuple */ ], …],
  "intakeControls": [1792181740343271, "1000000000000000000000", []],
  "maximumLeverage": 0,                                // global cap over every market; 0 = no cap
  "minimumLeverage": 0                                 // global floor; 0 = no floor
}
```

**`intakeControls`** = `[revision, minimumPaperStakeRaw, pausedActions[]]`. `pausedActions` lists intent
actions the relayer currently refuses (`"openPosition"`, `"closePositions"`, `"paperStake"`, …).
Before about 2026-10-16 this field was called `intake` and was
`[revision, minimumPaperStakeRaw, maximumNetOpenInterestRaw, pausedActions[]]`. Accept either.

**Instrument tuple** (23 fields; reject anything else):

| # | Field | # | Field |
|---|---|---|---|
| 0 | `id` (number) | 12 | `rateMultiplier` (WAD) |
| 1 | `symbol` ("BTC") | 13 | `positionMultiplier` (WAD) |
| 2 | `assetIndex` (Hyperliquid asset index) | 14 | `maxLeverage` (number, currently 1000) |
| 3 | `priceScale` (string, "10") | 15 | `maxPositionNotional` (WAD, $10M) |
| 4 | `active` | 16 | `bustBuffer` (WAD) |
| 5 | `paused` | 17 | `baseRate` (WAD, 0.1e18 = 10%) |
| 6 | `terminal` (settled; marks at the frozen mid) | 18 | `referenceNotional` (WAD, $100k) |
| 7 | `retired` | 19 | `longOi` (asset units, WAD) |
| 8 | `closeOnly` | 20 | `shortOi` |
| 9 | `frozenBid` (raw price or null) | 21 | `longCap` |
| 10 | `frozenAsk` (raw price or null) | 22 | `shortCap` |
| 11 | `pausedAt` (ms or null) | | |

Derived rules:

- A market accepts new positions when `active && !paused && !terminal && !closeOnly`, `tradingPaused` is false,
  and `"openPosition"` is not in `pausedActions`.
- **Effective leverage range** (as the web app computes it):
  `max = maximumLeverage > 0 ? min(inst.maxLeverage, maximumLeverage) : inst.maxLeverage`,
  `min = maximumLeverage > 0 ? min(minimumLeverage, maximumLeverage) : minimumLeverage` (and at least 1).
- **Open-interest room** per side, in asset units: `longCap − longOi`, `shortCap − shortOi` (floored at 0).
  Multiply by the mark for USD; the web app does `room × markRaw / priceScaleRaw`. A cap of `0` or `2^128 − 1`
  means that side has **no cap**. An open whose notional (margin × leverage) exceeds the room is refused.
  The web app also warns "near OI cap" when the room left after the order is at most max(room / 20, $1,000).
  The caps move: they were seen to change by several million USD within minutes, so re-read before relying on them.
- An open needs `margin ≥ minimumTradeSize`, `margin × leverage ≥ minimumOpenNotional`, and
  `margin × leverage ≤ maxPositionNotional`.

---

## 6. Account state: the live wallet stream (SSE)

✓ `GET /state/user/live?wallet=0x…` (lowercase address) is a **Server-Sent Events** stream of one account's
full state. It's the right way to read an account: one long-lived connection, pushed updates, no polling.
CORS-open.

### 6.1 Events

| `event:` | `data:` |
|---|---|
| (comment) | `: connected` on open |
| `liveness` | `{"heartbeatIntervalMs": 10000}` |
| `heartbeat` | `null`, every ~10s |
| `wallet` | The first one is a **snapshot**. Later ones are **patches** (they contain `baseAccountRevision`). |

### 6.2 Snapshot

```jsonc
{
  "address": "0x…",
  "accountRevision": 1,
  "indexedThroughBlock": 48752950,
  "indexedThroughTimestamp": 1792210394,          // unix seconds the indexer has reached
  "walletRevision": 48752670,
  "queueRevision": "722",
  "balance": "…", "queued": "…", "locked": "…", "consumableDebt": "0",
  "funds": { "reservedBalance": "0", "reservedQueued": "0", "availableBalance": "…", "availableQueued": "0" },
  "sessionKeys": [["0xkey…", "1794233378"]],       // [address, expiry unix seconds]
  "paper": { "balance": "…", "staked": "…", "pendingBase": "…", "rewardDebt": "…" },
  "lifetime": { "depositedRaw", "withdrawnRaw", "realizedPnlRaw", "feesPaidRaw", "tradedNotionalRaw", "paperRewardsClaimedRaw" },
  "openPositions": [[ /* position tuple */ ], …],
  "operations": [[ /* operation tuple */ ], …]     // intents accepted but not yet executed
}
```

**Tuples:**

| Tuple | Fields, in order |
|---|---|
| open position | `[positionId, instrumentId, isLong, useDebt, entryPriceRaw, marginRaw, leverage, bustPriceRaw, openedAtMs, intentId]` |
| operation (queued intent) | `[intentId, action, instrumentId, isLong, useDebt, amountRaw, leverage, acceptedAtMs, deadline, closePositionIds]` (fields that don't apply to the action are `null`; `amountRaw` is the margin for opens, PAPER for stake/unstake) |
| closed position (patches only) | `[positionId, instrumentId, isLong, marginRaw, leverage, liquidated, netPnlRaw, paperMintedRaw]` |
| intent outcome (patches only) | `[intentId, "succeeded" \| "failed" \| "expired" \| "cancelled" \| "unknown"]` |

### 6.3 Patches

A patch carries:
- `address`, `accountRevision`, `baseAccountRevision`;
- `state`: any subset of the snapshot's scalar fields (`balance`, `funds`, `sessionKeys`, `paper`, …);
- `lifetime?`;
- `addedPositions` and `removedPositionIds`;
- `addedOperations` and `removedOperationIds`;
- `closedPositions?` and `intentOutcomes?`.

**Apply a patch only if `baseAccountRevision === yourState.accountRevision`.** Otherwise you missed one, so
reconnect and you'll get a fresh snapshot. Algorithm:

1. Merge `state` into your scalars; replace `lifetime` if present.
2. Remove `removedPositionIds`, append `addedPositions`. Do the same for operations.
3. Set `accountRevision`.
4. Surface `closedPositions` and `intentOutcomes` as events. **They exist only in patches**, so anything that
   happened while you were disconnected is not replayed. Use the `lifetime` counters or the history endpoints
   for totals.

### 6.4 Reconnecting

- On `error`, if `readyState === CLOSED` (e.g. after a 429), reconnect yourself with exponential backoff and
  jitter (1s, 2s, 4s, … up to 60s). Reset the backoff after a successful `wallet` event.
- Watchdog: if no event (heartbeat included) arrives for 45s, close and reconnect.
- A fresh connection always starts with a snapshot, so reconnecting is always safe.

A full client is in [§12.2](#122-account-stream-with-patches-and-reconnects).

---

## 7. Other REST endpoints

All `GET`, base `https://exchange.papertrade.xyz`, server-side only (Origin rule). `{addr}` is lowercase.

| | Endpoint | Returns |
|---|---|---|
| ✓ | `/query/protocol/summary` | TVL, margin, LP, fees, open-position count, PAPER supply / staked / emission parameters. `fees.lifetime` = USDC paid to stakers since launch. |
| ✓ | `/query/protocol/history?interval=1m\|1d` | Stats series (`columns.{tvl, stakingRewards, volume, volumeBtc, volumeEth, traderPnl, users, liquidation, trades, paperSupply, paperStaked, paperRevenue}`) and `totals`. `traderPnl` is cumulative **net** trader PnL (not gross losses); `liquidation` is liquidated notional. No gross-loss total is published. |
| ✓ | `/query/protocol/market-stats` | `{ok, markets: {"0": {volume_24h}}}` |
| ✓ | `/state/house/current` | House fund, live. `head` = `[timeMs, lpBalance, traderOpenPnl, queueDebt, btcLong, btcShort, ethLong, ethShort]` in USD (plain numbers, not WAD); `heads.{1000,60000,3600000,86400000}` hold the same as column series (`lp`, `pnl`, `q`, `bl`, `bs`, `el`, `es`). Open House PnL = −`traderOpenPnl`; House Funds = LP + Open House PnL − Queue Debt; net OI = long − short (the house carries the opposite). |
| ✓ | `/query/notices` | `{notices: []}` |
| ✓ | `/query/markets/{id}/price-history?fromMs=&intervalMs=&toMs=` | Price ticks. Only the app's exact parameter sets are accepted, e.g. `intervalMs=125` over a 60-second window aligned to whole minutes. |
| ✓ | `/query/accounts/{addr}/portfolio-history?range=1h\|1d\|1w\|all` | Equity history |
| ✓ | `/query/accounts/{addr}/staking?limit=75[&cursor=…]` | PAPER staking history, newest first (see below) |
| ✓ | `/query/accounts/{addr}/queue-ring` | The account's payout-queue state |
| ✓ | `/query/accounts/{addr}/leaderboard-badges` | Badges |
| ◐ | `/query/accounts/{addr}/queue-balances?limit=75[&cursor=…]` | `{items: [{nodeId, amount, enqueuedAtMs, enqueuedTxHash, position, amountAhead}], nextCursor}` |
| ✗ | `/query/accounts/{addr}/funding` | Deposits and withdrawals |
| ✓ | `/query/accounts/{addr}/trades?[cursor=…&][filter=all&]limit=75` | Closed and liquidated positions, newest first: `{items: [{timestampMs, txHash, positionId, instrumentId, symbol, priceScaleRaw, isLong, entryPriceRaw, exitPriceRaw, marginRaw, leverage, openedAtMs, kind: "PositionClosed" \| "Liquidated", adjustedPnlRaw, userPaidFeeRaw, paperMintedRaw, …}], nextCursor}`. Net PnL = `adjustedPnlRaw − userPaidFeeRaw` (the fee is 2% of a win). Parameters sorted alphabetically. |
| ◐ | `/query/accounts/{addr}/{cashflows\|queue}?…limit=75` | Deposits/withdrawals and queue history (cursor-paged like trades) |
| ✓ | `/queue-rank/accounts/{addr}` | `{ok, queueRevision, entries: [{intentId, position}]}`: each of the account's queued intents and its place in the execution queue (`position` is a decimal string, 1 = next). No query parameters accepted. An intent drops out once it's handed to the chain. |
| ✗ | `/state/house/delta?coin=`, `/query/protocol/queue-summary`, `/query/protocol/paper/activity`, `/state/protocol/position-topology`, `/query/markets/{id}/liquidation-map?…` | As named |
| ✗ | `/state/leaderboard/accounts?window=24h&sortKey=totalWindowedPnl&sortDir=desc&page=0&pageSize=25&q=` | Leaderboard |
| ✗ | `/state/leaderboard/positions?window=`, `/state/leaderboard/accounts/{addr}?window=`, `/query/leaderboard/name/{addr}` | Leaderboard detail |

**Staking history** ✓:

```jsonc
{ "items": [ { "timestampMs": 1792062512000, "txHash": "0x…", "amountRaw": "3717754275225275961402", "kind": "staked" }, … ],
  "nextCursor": null }
```

- `kind` is `"staked"`, `"unstaked"` or `"claimed"`. **`claimed` amounts are USDC rewards; the others are PAPER.**
- Page with `&cursor=<nextCursor>` until `nextCursor` is `null` (stop if it repeats). `limit` must be exactly 75.
- Σ`staked` − Σ`unstaked` equals the account's current `paper.staked`, and Σ`claimed` equals
  `lifetime.paperRewardsClaimedRaw`. Both checked ✓.

---

## 8. The realtime socket (Centrifugo)

✓ `wss://stream.papertrade.xyz/connection/websocket` runs Centrifugo (OSS v6), JSON protocol. No token and no
`Origin` header needed. The host comes from the page's `<meta name="papertrade-stream-origin">`.

**Protocol:**

```text
→ {"id":1,"connect":{"name":"js"}}
← {"id":1,"connect":{"client":"…","version":"6.9.4 OSS","ping":20,"pong":true}}
→ {"id":2,"subscribe":{"channel":"pressure:current"}}
← {"id":2,"subscribe":{"recoverable":true,"epoch":"…","publications":[{"data":{…}}]}}   // latest, if the channel keeps one
← {"push":{"channel":"pressure:current","pub":{"data":{…}}}}                            // each new publication
← {}            // ping: answer with {} or the server drops you
```

- One WebSocket frame can hold several replies, separated by newlines. Split before `JSON.parse`.
- Restart on any reply with `error` (e.g. `{"id":2,"error":{"code":107,"message":"bad request"}}` for an
  unknown channel), on a push with `disconnect`, or on a push with `unsubscribe` for your channel.
- Watchdogs: restart if no frame at all for 45s, or (per channel) no data for too long.

| Channel | Data |
|---|---|
| `pressure:current` ✓ | `{queueRevision, snapshot}`, several times a second |
| `public:trades` ✓ | every fill, batched per block. Live only: nothing is replayed on subscribe. |
| `trading:current` ◐ | trading-state updates (same family as `/state/trading`) |

### 8.1 `pressure:current`: queue and chain load

```jsonc
{ "queueRevision": "d669…:98719",
  "snapshot": {
    "schemaVersion": 1, "ok": true, "stale": false, "ts": 1792072413905, "source": "relayer-postgres",
    "blockGasLimit": "3000000", "totalQueuedGas": "388400000", "totalSubmittedGas": "0", "totalPendingGas": "388400000",
    "saturationPct": 0, "pendingCount": 1220, "activeIntents": 1220, "submittedIntents": 0, "queuedIntents": 1220,
    "chain": {
      "ok": true, "stale": false, "source": "state-postgres",
      "latestBlockNumber": 48612669, "latestBlockTimestampMs": 1792072413000, "latestBlockGasUsed": "2752242", "latestBlockGasLimit": "3000000", "latestBlockUsagePct": 91.7,
      "blocks": [ { "number": 48612665, "timestampMs": 1792072409000, "gasUsed": "1395731", "papertradeGasUsed": "703617",
                    "gasLimit": "3000000", "baseFeePerGas": "311468403", "usagePct": 46.5, "transactionCount": 4, "kind": "ordinary" }, … ] } } }
```

**The "Status" tab on Papertrade's trade page** computes exactly this ✓:

| Shown | Formula |
|---|---|
| Needed blocks | `ceil((totalSubmittedGas + totalQueuedGas) / blockGasLimit)` |
| Congestion | needed ≤ 1 → `LOW`, ≤ 5 → `MEDIUM`, else `HIGH` |
| Pending Tx | `pendingCount` |
| Avg Tx/Block | mean of `chain.blocks[].transactionCount` (the last ~5 blocks) |
| Time To Clear | `pendingCount ? max(3, neededBlocks) : 0` seconds (HyperEVM makes ~1 block/s) |
| Unavailable | when `!ok`, `stale`, or the snapshot's `ts` is more than 5s old |

### 8.2 `public:trades`: every fill

```jsonc
[ { "seq": 48607058000028, "ts": 1792066894000, "wallet": "0x…", "instrument": "BTC", "instrumentId": 0,
    "instrumentTerminal": false, "side": "long", "leverage": 1000, "notionalUsd": 60500,
    "entry": 80983.5, "exit": null, "intentId": null, "positionId": 775019, "kind": "open", "pnlUsd": null }, … ]
```

- `kind` is `open`, `close` or `liq`. Prices here are plain numbers, not raw integers. `intentId` is null.
- **It carries the execution time only, not the submission time.** To measure queue waits, see
  [§11](#11-the-execution-queue-and-how-long-orders-wait).

---

## 9. Prices, PnL, fees and equity

All of this matches the Papertrade UI to the cent (checked ✓ on every position of a live account). The
integer algorithm mirrors the web app's `valuation` module; use integer (`BigInt`) arithmetic exactly as
written.

### 9.1 Mark price

The mark is the **Hyperliquid BBO midpoint**. Subscribe on Hyperliquid's socket:

```json
{"method":"subscribe","subscription":{"type":"bbo","coin":"BTC"}}
```

Messages look like `{"channel":"bbo","data":{"coin":"BTC","time":…,"bbo":[{"px":"81455","sz":…,"n":…},{"px":"81456",…}]}}`.
Convert the bid and ask to raw prices with `priceScale`, then `midRaw = (bidRaw + askRaw) / 2n` (integer
division). For a one-off read, `POST https://api.hyperliquid.xyz/info` with `{"type":"l2Book","coin":"BTC"}`
and take `levels[0][0].px` (bid) and `levels[1][0].px` (ask). For a `terminal` market, use
`(frozenBid + frozenAsk) / 2n` instead.

### 9.2 Unrealized PnL (what the contract settles)

From the docs page "Asymmetric impact PnL", a winning close goes through three steps:

1. **Deadband:** the gain is measured as if the exit were `entry / 50000` (0.2 bps) less favourable. A smaller
   win becomes zero.
2. **Impact haircut:** the remaining gain is multiplied by
   `scale = (1 − baseRate) / (1 + 1/(m · rateMultiplier) + referenceNotional / (10⁶ · m · positionMultiplier))`,
   where `m = |exit − entry| / entry` after the deadband. It's harshest on small moves and never keeps more
   than `1 − baseRate` (90%). On BTC, a 1% move keeps ~88% of the raw gain and a 0.1% move ~74% (checked ✓).
3. **Win fee:** `winFeeRate` (2%) of the scaled gain comes off.

Losses are linear (`notional × move / entry`) and capped at the margin. Nothing extra is taken.

Exact integer form (`adjustedPnl`, before the win fee):

```ts
const WAD = 10n ** 18n, MAX = 10n ** 36n, HUGE = (1n << 256n) - 1n;
function adjustedPnl(p, inst, markRaw) {          // all fields BigInt except leverage (number)
  const entry = p.entryPriceRaw, threshold = entry / 50_000n;
  let exit = markRaw;
  if (p.isLong) { if (markRaw > entry + threshold) exit = markRaw - threshold; else if (markRaw > entry) exit = entry; }
  else          { if (markRaw + threshold < entry) exit = markRaw + threshold; else if (markRaw < entry) exit = entry; }
  const move = p.isLong ? exit - entry : entry - exit;
  const raw = (p.marginRaw * BigInt(p.leverage) * move) / entry;
  if (raw <= 0n) return raw < -p.marginRaw ? -p.marginRaw : raw;           // losses: linear, capped at margin
  const absMove = exit > entry ? exit - entry : entry - exit;
  if (absMove === 0n) return 0n;
  const ratio = (absMove * WAD) / entry;
  const rateTerm = (ratio * inst.rateMultiplierRaw) / WAD;
  const b = rateTerm > 0n ? MAX / rateTerm : HUGE;
  const sizeTerm = (1_000_000n * ratio * inst.positionMultiplierRaw) / WAD;
  const s = sizeTerm > 0n ? (inst.referenceNotionalRaw * WAD) / sizeTerm : HUGE;
  if (b > MAX || s > MAX) return 0n;
  const factor = ((WAD - inst.baseRateRaw) * WAD) / (WAD + b + s);
  return (raw * factor) / WAD;
}
```

### 9.3 What closing now would pay

`payout = pnl <= 0 ? pnl : pnl − pnl × winFeeRate / 1e18`. This is what the Papertrade positions table shows
as PnL.

**Cost of closing a winner**, compared with the raw linear move:
- `rawPnl = notional × (mark − entry) / entry` (signed for side);
- `haircut = rawPnl − adjustedPnl`;
- `fee = adjustedPnl − payout`.

### 9.4 Equity (as the web app computes it)

```text
reserved = balance + queued − availableBalance − availableQueued
equity   = availableBalance + availableQueued + Σ position margin + max(0, reserved) + Σ adjustedPnl   (pre-fee)
```

### 9.5 Risk %

How far price has moved from entry toward the bust price:
`room = |entry − bust|`, `adverse = isLong ? entry − mark : mark − entry`, and
`risk = adverse ≤ 0 ? 0 : adverse ≥ room ? 100 : adverse / room × 100`.
Crossing `bustPriceRaw` triggers liquidation, which forfeits the whole margin.

### 9.6 Claimable staking rewards (USDC)

`pendingBase + max(0, staked × accRewardPerShareRaw / 1e27 − rewardDebt)`. Note **1e27**, not 1e36:
`accRewardPerShareRaw` comes from `/state/trading`, the rest from the account's `paper` object (checked ✓
against the UI).

---

## 10. Trading: signed intents

The formats below are byte-for-byte what the web app sends. **Confirmed live on 2026-10-17** from this
repo's Chrome extension (outside Papertrade's web app):
- ✓ `registerSessionKey`, signed by a Rabby + Ledger master wallet. The key became active.
- ✓ `openPosition`, signed by that session key: a $10 × 100 BTC order, which filled.

`closePositions`, staking, withdrawals and cancels use the same scheme but haven't been sent live yet. Test
anything new with a minimum-size order first.

### 10.1 Submitting

```http
POST https://exchange.papertrade.xyz/intents
Content-Type: application/json

{ "action": "openPosition", "signed": { …message fields…, "v": "27", "r": "0x…", "s": "0x…" } }
```

Wire format of `signed`:
- every integer is a **decimal string**;
- addresses and `bytes`/`bytes32` values are lowercase strings;
- bools stay JSON bools;
- `uint256[]` is an array of strings;
- `v` is `"27"` or `"28"` (27 + yParity), and `r` and `s` are lowercase hex.

Response: `{"intentId":"0x…","action":"openPosition","state":"queued","queueRevision":"579"}`. `state` is
`queued`, `prepared` or `confirmed`. Acceptance is **not** execution ([§10.8](#108-following-an-intent-to-its-outcome)).

### 10.2 Actions, types and signers

`user` is **always the master wallet**, even when a session key signs.

| `action` | EIP-712 primary type | Domain | Signed by | Fields (in type order) |
|---|---|---|---|---|
| `registerSessionKey` ✓ | `RegisterSessionKey` | exchange | master wallet | `user address, key address, expiry uint64 (unix s), feeAddress address (0x000…0), nonce uint256, deadline uint64` |
| `openPosition` ✓ | `OpenPosition` | exchange | session key | `user address, instrumentId uint32, isLong bool, size uint128 (margin, WAD), leverage uint32, useDebt bool, nonce uint256, deadline uint64` |
| `closePositions` | `Close` | exchange | session key | `user address, positionIds uint256[] (1–12, full close only), nonce uint256, deadline uint64` |
| `withdrawToCore` | `WithdrawToCore` | exchange | master wallet | `user address, amount uint256, nonce uint256, deadline uint64` (the body also carries a `withdrawal` route object; ✗ untested) |
| `paperStake` | `Stake` | paperStaking | master wallet | `user address, amount uint256, nonce uint256, deadline uint64` |
| `paperUnstake` | `Unstake` | paperStaking | master wallet | `user address, amount uint256, nonce uint256, deadline uint64` |
| `paperClaim` | `Claim` | paperStaking | master wallet | `user address, nonce uint256, deadline uint64` |
| (cancel, see 10.9) | `CancelIntent` | cancellation | session key | `user address, intentId bytes32, deadline uint256` |

Note: `size` in `OpenPosition` is the **margin**, not the notional.

### 10.3 Domains

All domains use `chainId: 999`.

| Domain | `name` | `version` | `verifyingContract` | Checked |
|---|---|---|---|---|
| exchange | `"String"` (literally the word String) | `"1"` | exchange `0x6cd5…d0a2` | ✓ not exposed onchain, but live registrations and orders signed with it are accepted |
| paperStaking | `"PaperStaking"` | `"1"` | staking `0xaad6…f016` | ✓ matches the contract's `DOMAIN_SEPARATOR()` |
| cancellation | `"PaperTrade Intent Cancel"` | `"2"` | exchange | ◐ |

### 10.4 Nonces and deadlines

- **Deadline:** the app uses `floor(now / 1000) + 3600` (one hour). Expired intents are dropped.
- **Nonces are chosen by the client.** The app keeps one counter per (account, scope): scope `session` for
  exchange-domain intents, `paper` for staking. A new counter starts at a **random 24-bit value × 256** and
  increments on every use. **Persist your counters** so a restart never reuses one. Starting at a random
  value avoids colliding with the nonces the user's browser hands out for the same account.

### 10.5 Intent id

```text
intentId = keccak256( keccak256(utf8("papertrade:intent-id:v2")) ‖ eip712Digest ‖ signerAddress )
```

This is a 32 + 32 + 20 byte concatenation, where `signerAddress` is the lowercase address recovered from the
signature. The server echoes the id back. If yours differs, use the server's and treat it as a sign your
derivation drifted.

### 10.6 Session keys

1. Generate a local keypair and keep the private key secret (file mode 0600, never committed).
2. Have the **master wallet** sign `RegisterSessionKey` with:
   - `user` = master;
   - `key` = session address;
   - `expiry` = now + 30 days (unix seconds);
   - `feeAddress` = `0x0000000000000000000000000000000000000000`;
   - a `session` nonce, and the one-hour deadline.

   The master wallet can sign in-process, or externally: produce the typed data, sign it with
   `eth_signTypedData_v4` in any wallet, and paste back the signature.
3. `POST /intents` with `action: "registerSessionKey"`. It takes effect once executed. Confirm in the
   account stream: `sessionKeys` lists active keys with their expiry.
4. Opens and closes are then signed by the session key.

Registration needs a deposit on the account (`noDeposit` otherwise), and accounts have a session-key limit
(`sessionKeyLimit`).

### 10.7 Errors

A refusal is a non-2xx response with `{ error | code, reason? }`.

| Codes |
|---|
| `invalid_intent`, `deadline_expired`, `unauthorized_intent`, `intent_conflict`, `intent_not_found`, `admission_rejected`, `below_minimum_paper_stake`, `below_minimum_withdrawal`, `invalid_onward`, `intake_action_paused`, `rate_limited` |

`admission_rejected` reasons: `tradingPaused`, `marketPaused`, `inactiveInstrument`, `belowMinimum`,
`belowMinimumNotional`, `leverageTooHigh`, `positionTooLarge`, `openInterest`, `funding`, `noOpenPositions`,
`paperBalance`, `stakedBalance`, `sessionKeyLimit`, `noDeposit`, `noRewards`, `alreadyQueued`.

**A network error or timeout is not a refusal:** the intent may still have been accepted. Don't re-send a
close blindly. Watch the account stream first.

### 10.8 Following an intent to its outcome

Use the account stream:
- The intent appears in `operations` (with `acceptedAtMs`) while queued.
- **Filled open:** a position whose `intentId` matches appears (`openedAtMs` is the fill block), and the
  operation is removed.
- **Executed close:** the positions disappear and a patch carries `closedPositions`
  (`netPnlRaw`, `paperMintedRaw`, `liquidated`).
- **Not executed:** a patch carries `intentOutcomes` with `expired`, `failed` or `cancelled`.

### 10.9 Cancelling a queued intent

◐ `POST /intents/{intentId}/cancel`, body = the signed `CancelIntent` fields **without** `intentId`
(`{user, deadline, v, r, s}`), signed by the session key on the cancellation domain. Response:
`{intentId, action, state}`. Read from the web app; our signatures verify offline, not yet sent live.

What's cancellable (the web app's rule):
- The intent is still `queued` (not yet handed to the chain).
- It's not a `closePositions` covering more than one position.
- Its action allows it: `openPosition`, `closePositions`, `paperStake`, `paperUnstake`, `paperClaim` and
  `paperDistribute` can be cancelled; `registerSessionKey` and `withdrawToCore` can't.

The web app also refuses to cancel when the session key expires within about an hour (61 minutes).

Several `openPosition` and `closePositions` intents can be pending at once. Withdrawals, unstakes, claims and
session-key registrations allow only one pending at a time.

---

## 11. The execution queue and how long orders wait

Accepted intents wait in the relayer's queue and execute in batches. In practice:

- The relayer **prioritises larger notional** (the web app itself tells users "Larger notional, higher
  priority").
- **How to measure a real wait** ✓: follow a wallet's account stream. A queued open shows up in `operations`
  with `acceptedAtMs`. When it fills, a position with the same `intentId` appears with `openedAtMs`. The wait
  is `openedAtMs − acceptedAtMs` (clamp at 0, since `openedAtMs` is whole seconds). `public:trades` alone can't
  tell you this, because it has no submission time.
- **How to sample the market:** take wallet addresses from `public:trades`, follow the most recently active
  ~15 (opening at most one stream per ~1.5s, see the rate limit in [§4](#4-access-rules-and-gotchas)), and record
  `(notional, wait, outcome)` for their orders. Rotate out wallets idle for a minute or more.
- **Observed in October 2026** (one session, under heavy load: ~1,200 pending, congestion HIGH):
  - orders of $25k+ filled in a median ~4s;
  - a $5k–$10k band waited a median ~1–2 minutes, dominated by bots submitting many identical orders at once;
  - orders under $5k still often filled within seconds.

  Treat this as an example, not a rule. Measure live.
- Queue depth right now: `pressure:current` ([§8.1](#81-pressurecurrent-queue-and-chain-load)).

---

## 12. Copy-paste code

TypeScript for Node ≥ 20.18 (run with `--experimental-websocket --experimental-eventsource`) or a browser
(REST calls need a proxy, see [§4](#4-access-rules-and-gotchas)). Only signing needs a dependency:
[`viem`](https://viem.sh).

### 12.1 Market terms

```ts
const API = 'https://exchange.papertrade.xyz';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(API + path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Papertrade ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function fetchTrading() {
  const d = await getJson<any>('/state/trading');
  const instruments: Record<number, any> = {};
  for (const t of d.instruments) {
    if (t.length !== 23) throw new Error(`Unexpected instrument tuple (${t.length} fields): the API changed`);
    const [id, symbol, , priceScale, active, paused, terminal, , closeOnly, frozenBid, frozenAsk, , rateMul, posMul,
      maxLeverage, maxPosition, bustBuffer, baseRate, refNotional, longOi, shortOi, longCap, shortCap] = t;
    const big = (v: string | null) => (v === null ? null : BigInt(v));
    instruments[id] = {
      id, symbol, active, paused, terminal, closeOnly, maxLeverage,
      priceScale: BigInt(priceScale), frozenBidRaw: big(frozenBid), frozenAskRaw: big(frozenAsk),
      rateMultiplierRaw: BigInt(rateMul), positionMultiplierRaw: BigInt(posMul),
      maxPositionNotionalRaw: BigInt(maxPosition), bustBufferRaw: BigInt(bustBuffer), baseRateRaw: BigInt(baseRate),
      referenceNotionalRaw: BigInt(refNotional), longOiRaw: BigInt(longOi), shortOiRaw: BigInt(shortOi),
      longCapRaw: BigInt(longCap), shortCapRaw: BigInt(shortCap),
    };
  }
  return {
    tradingPaused: d.tradingPaused as boolean,
    minimumTradeSizeRaw: BigInt(d.minimumTradeSizeRaw),
    minimumOpenNotionalRaw: BigInt(d.minimumOpenNotionalRaw),
    accRewardPerShareRaw: BigInt(d.accRewardPerShareRaw),
    // `intakeControls` = [revision, minimumPaperStake, pausedActions]; older builds sent `intake` with an extra slot.
    minimumPaperStakeRaw: BigInt(d.intakeControls?.[1] ?? d.intake?.[1] ?? '0'),
    pausedActions: (d.intakeControls?.[2] ?? d.intake?.[3] ?? []) as string[],
    maximumLeverage: (d.maximumLeverage ?? 0) as number,
    minimumLeverage: (d.minimumLeverage ?? 0) as number,
    instruments,
  };
}
```

### 12.2 Account stream with patches and reconnects

```ts
type Tuple = any[];

export function watchWallet(address: string, onWallet: (w: any) => void, onEvents?: (e: any) => void) {
  let es: EventSource | null = null, wallet: any = null, stopped = false, attempt = 0, lastEventAt = Date.now();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const reconnect = (ms: number) => { es?.close(); es = null; clearTimeout(retry); if (!stopped) retry = setTimeout(connect, ms); };
  const backoff = () => Math.min(60_000, 1000 * 2 ** attempt++) + Math.random() * 1000;
  const watchdog = setInterval(() => { if (es && Date.now() - lastEventAt > 45_000) reconnect(backoff()); }, 5_000);

  const pos = (t: Tuple) => ({ positionId: BigInt(t[0]), instrumentId: t[1], isLong: t[2], useDebt: t[3], entryPriceRaw: BigInt(t[4]),
    marginRaw: BigInt(t[5]), leverage: t[6], bustPriceRaw: BigInt(t[7]), openedAtMs: t[8], intentId: t[9] });
  const op = (t: Tuple) => ({ intentId: t[0], action: t[1], instrumentId: t[2], isLong: t[3], amountRaw: t[5] === null ? null : BigInt(t[5]),
    leverage: t[6], acceptedAtMs: t[7], deadline: BigInt(t[8]), positionIds: t[9]?.map(BigInt) ?? null });

  function connect() {
    wallet = null; lastEventAt = Date.now();
    const source = new EventSource(`${API}/state/user/live?wallet=${address.toLowerCase()}`);
    es = source;
    source.onerror = () => { if (source === es && source.readyState === 2 /* CLOSED, e.g. after a 429 */) reconnect(backoff()); };
    for (const ev of ['heartbeat', 'liveness']) source.addEventListener(ev, () => (lastEventAt = Date.now()));
    source.addEventListener('wallet', (e) => {
      lastEventAt = Date.now(); attempt = 0;
      const m = JSON.parse((e as MessageEvent).data);
      if (!('baseAccountRevision' in m)) {                       // snapshot
        wallet = { ...m, positions: m.openPositions.map(pos), operations: (m.operations ?? []).map(op) };
      } else {                                                   // patch
        if (!wallet || m.baseAccountRevision !== wallet.accountRevision) return reconnect(0);
        Object.assign(wallet, m.state ?? {});
        if (m.lifetime) wallet.lifetime = m.lifetime;
        const gone = new Set(m.removedPositionIds);
        wallet.positions = wallet.positions.filter((p: any) => !gone.has(String(p.positionId))).concat(m.addedPositions.map(pos));
        const goneOps = new Set(m.removedOperationIds);
        wallet.operations = wallet.operations.filter((o: any) => !goneOps.has(o.intentId)).concat((m.addedOperations ?? []).map(op));
        wallet.accountRevision = m.accountRevision;
        if (m.closedPositions?.length || m.intentOutcomes?.length) onEvents?.({ closedPositions: m.closedPositions ?? [], intentOutcomes: m.intentOutcomes ?? [] });
      }
      onWallet(wallet);
    });
  }

  connect();
  return () => { stopped = true; clearTimeout(retry); clearInterval(watchdog); es?.close(); };
}
```

(Scalar fields stay as raw strings here. Convert with `BigInt` where you do arithmetic.)

### 12.3 Realtime socket

```ts
const STREAM = 'wss://stream.papertrade.xyz/connection/websocket';

export function watchStream(channel: string, onData: (data: any) => void, dataSilentMs = 0) {
  let ws: WebSocket | null = null, stopped = false, attempt = 0, lastFrame = Date.now(), lastData = Date.now();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const restart = () => {
    if (stopped) return;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch {} }
    ws = null; clearTimeout(retry);
    retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
  };
  const watchdog = setInterval(() => {
    if (!ws) return;
    if (Date.now() - lastFrame > 45_000 || (dataSilentMs && Date.now() - lastData > dataSilentMs)) restart();
  }, 5_000);
  const deliver = (d: any) => { lastData = Date.now(); attempt = 0; onData(d); };

  function connect() {
    lastFrame = lastData = Date.now();
    const sock = new WebSocket(STREAM);
    ws = sock;
    sock.onopen = () => {
      sock.send(JSON.stringify({ id: 1, connect: { name: 'js' } }));
      sock.send(JSON.stringify({ id: 2, subscribe: { channel } }));
    };
    sock.onmessage = (e) => {
      lastFrame = Date.now();
      for (const line of String(e.data).split('\n')) {
        if (!line) continue;
        const m = JSON.parse(line);
        if (!Object.keys(m).length) sock.send('{}');                                    // ping → pong
        else if (m.error || m.push?.disconnect || (m.push?.channel === channel && m.push.unsubscribe)) return restart();
        else if (m.id === 2) for (const p of m.subscribe?.publications ?? []) deliver(p.data);
        else if (m.push?.channel === channel && m.push.pub) deliver(m.push.pub.data);
      }
    };
    sock.onclose = sock.onerror = () => { if (ws === sock) restart(); };
  }

  connect();
  return () => { stopped = true; clearTimeout(retry); clearInterval(watchdog); ws?.close(); };
}

// e.g. watchStream('pressure:current', (d) => console.log(d.snapshot.pendingCount), 15_000);
//      watchStream('public:trades', (fills) => fills.forEach((f: any) => console.log(f.kind, f.notionalUsd)), 300_000);
```

### 12.4 Valuation

`adjustedPnl` is in [§9.2](#92-unrealized-pnl-what-the-contract-settles). The rest:

```ts
/** "81455.5" at priceScale 10n → 814555n. */
export function toRawPrice(px: string, scale: bigint): bigint {
  const [int = '', frac = ''] = px.split('.');
  return (BigInt(int + frac) * scale) / 10n ** BigInt(frac.length);
}
export const payoutPnl = (pnl: bigint, winFeeRate: bigint) => (pnl <= 0n ? pnl : pnl - (pnl * winFeeRate) / 10n ** 18n);
export function rawPnl(p: any, markRaw: bigint): bigint {
  const move = p.isLong ? markRaw - p.entryPriceRaw : p.entryPriceRaw - markRaw;
  const pnl = (p.marginRaw * BigInt(p.leverage) * move) / p.entryPriceRaw;
  return pnl < -p.marginRaw ? -p.marginRaw : pnl;
}
export async function fetchWinFeeRate(): Promise<bigint> {
  const res = await fetch('https://rpc.hyperliquid.xyz/evm', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x6cd5661646289fb6e65ea5c032310fded797d0a2', data: '0x48ee5e08' }, 'latest'] }) });
  return BigInt((await res.json()).result);
}
```

### 12.5 Signing and submitting

```ts
import { concat, hashTypedData, keccak256, parseSignature, recoverAddress, stringToBytes, type Hex } from 'viem';
import { privateKeyToAccount, type LocalAccount } from 'viem/accounts';

const DOMAINS = {
  exchange: { name: 'String', version: '1', chainId: 999, verifyingContract: '0x6cd5661646289fb6e65ea5c032310fded797d0a2' },
  paper: { name: 'PaperStaking', version: '1', chainId: 999, verifyingContract: '0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016' },
} as const;
const TYPES = {
  RegisterSessionKey: [{ name: 'user', type: 'address' }, { name: 'key', type: 'address' }, { name: 'expiry', type: 'uint64' },
    { name: 'feeAddress', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }],
  OpenPosition: [{ name: 'user', type: 'address' }, { name: 'instrumentId', type: 'uint32' }, { name: 'isLong', type: 'bool' },
    { name: 'size', type: 'uint128' }, { name: 'leverage', type: 'uint32' }, { name: 'useDebt', type: 'bool' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }],
  Close: [{ name: 'user', type: 'address' }, { name: 'positionIds', type: 'uint256[]' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }],
  Stake: [{ name: 'user', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }],
  Claim: [{ name: 'user', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }],
} as const;
const ROUTE = { RegisterSessionKey: ['registerSessionKey', 'exchange'], OpenPosition: ['openPosition', 'exchange'],
  Close: ['closePositions', 'exchange'], Stake: ['paperStake', 'paper'], Claim: ['paperClaim', 'paper'] } as const;
const TAG = keccak256(stringToBytes('papertrade:intent-id:v2'));

export async function signIntent(type: keyof typeof TYPES, message: Record<string, any>, signer: LocalAccount) {
  const td = { domain: DOMAINS[ROUTE[type][1]], types: { [type]: TYPES[type] }, primaryType: type, message } as any;
  const signature = await signer.signTypedData(td);
  const digest = hashTypedData(td);
  const recovered = (await recoverAddress({ hash: digest, signature })).toLowerCase();
  const { r, s, yParity } = parseSignature(signature);
  const signed: Record<string, any> = {};
  for (const { name, type: t } of TYPES[type]) {
    const v = message[name];
    signed[name] = Array.isArray(v) ? v.map(String) : typeof v === 'boolean' ? v : t === 'address' ? String(v).toLowerCase() : String(v);
  }
  return {
    action: ROUTE[type][0],
    intentId: keccak256(concat([TAG, digest, recovered as Hex])),
    body: { action: ROUTE[type][0], signed: { ...signed, v: String(27 + (yParity ?? 0)), r: r.toLowerCase(), s: s.toLowerCase() } },
  };
}

export async function submit(body: unknown) {
  const res = await fetch('https://exchange.papertrade.xyz/intents', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(35_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error || json.ok === false) throw Object.assign(new Error(json.code ?? json.error ?? res.status), { status: res.status, body: json });
  return json as { intentId: string; action: string; state: string; queueRevision?: string };
}

// Example: open a $1,000-notional BTC long at 100x ($10 margin, the minimum), signed by a registered session key.
// const session = privateKeyToAccount(SESSION_PRIVATE_KEY);
// const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
// const { body } = await signIntent('OpenPosition', { user: MASTER, instrumentId: 0n, isLong: true, size: 10n * 10n ** 18n,
//   leverage: 100n, useDebt: false, nonce: nextNonce('session'), deadline }, session);
// console.log(await submit(body));
```

`nextNonce(scope)` must return a persisted, strictly increasing counter that starts at a random
24-bit value × 256 ([§10.4](#104-nonces-and-deadlines)).

---

## 13. API drift: what has changed and how to detect it

**Known changes:**

| When (approx.) | Change |
|---|---|
| 2026-10-16 | `/state/trading`: `intake` (4-tuple, with `maximumNetOpenInterestRaw`) became `intakeControls: [revision, minimumPaperStakeRaw, pausedActions[]]`; added global `maximumLeverage` / `minimumLeverage` (0 = none). Clients reading only `intake` silently lose the paused-actions list and the minimum stake (which is 1,000 PAPER). |

**Guard against drift:**
- Assert tuple lengths (23 for instruments) and required keys, and fail loudly instead of defaulting.
- Treat an unknown `/state/trading` shape as "trading paused" in anything that trades.
- Re-check the PnL math against the Papertrade UI after any suspected change: open
  `https://exchange.papertrade.xyz/portfolio?view=<address>` and compare positions.

**How to re-derive anything from the web app** (when something breaks):
1. Load `https://exchange.papertrade.xyz/trade/btc` in a real browser. The app is Vite-built, with chunks
   under `/assets/*.js`.
2. Collect script URLs with `performance.getEntriesByType('resource')` and `fetch` each. Search for:
   - `/intents`, `RegisterSessionKey` (signing);
   - `profitThresholdDivisor` (config: contracts, chain id, instruments);
   - `valuation` (PnL);
   - `useChainPressure` / `pressure:current` (queue);
   - `intakeControls` (trading-terms schema);
   - `papertrade-stream-origin` (socket host).
3. Watch the Network panel for which endpoints a page calls (e.g. the Staking tab calls
   `/query/accounts/{addr}/staking?limit=75`).
4. Content-hashed chunk names change when their code changes. A new hash on `valuation-*.js` or
   `typed-data-*.js` is a cue to diff the PnL math or the signing types.

---

## 13b. Hyperliquid positions (used by the extension's Hyperliquid tab)

Hyperliquid's public info API, `POST https://api.hyperliquid.xyz/info`, CORS-open, no signature:
- `{"type":"clearinghouseState","user":addr}` → `{marginSummary{accountValue,totalNtlPos,totalRawUsd,totalMarginUsed},
  crossMarginSummary, withdrawable, assetPositions[{type, position{coin, szi (signed size), leverage{type,value},
  entryPx, positionValue, unrealizedPnl, returnOnEquity, liquidationPx, marginUsed, maxLeverage,
  cumFunding{allTime,sinceOpen,sinceChange}}}], time}`. The mark is `positionValue ÷ |szi|`. `cumFunding` is
  funding **paid** (negative = received).
- `{"type":"subAccounts","user":master}` → `[{name, subAccountUser, master, clearinghouseState, spotState}]`, so one
  call covers every subaccount's positions. A Papertrade wallet is the same address on Hyperliquid.
- `{"type":"frontendOpenOrders","user":addr}` → `[{coin, side ("B" buy / "A" sell), limitPx, sz, origSz, oid, timestamp,
  orderType ("Limit", "Stop Market", …), tif, reduceOnly, isTrigger, triggerPx, triggerCondition, isPositionTpsl,
  children, cloid}]`. Per account: query each subaccount's address separately.

## 14. Reference implementation in this repo

The repo is the Paperbox Chrome extension; everything below runs in the browser.

| File | What it has |
|---|---|
| `src/intents.ts` | EIP-712 domains and types, wire encoding, intent id, builders for open / close / register session key / cancel |
| `src/background.ts` | Session-key generation and encrypted storage (AES-GCM, non-extractable key in IndexedDB), registration flow, signing opens, closes and cancels after re-checking every field, preparing and checking wallet-signed stakes |
| `src/content.js` | Market terms, account stream (patches, reconnect, watchdog), pressure socket, Hyperliquid BBO marks, all valuation math (haircut, win fee, bust risk), queue ranks, OI headroom, batch guards, the full-screen dashboard |
| `src/bridge.js` | Finding the wallet through EIP-6963 and relaying signature requests from the page |

`Stake` and `Claim` are built in `src/intents.ts` (`stakeMessage`, `claimMessage`) and signed by the master
wallet through `src/bridge.js`; `Unstake` is documented (section 10) but not implemented here. Total PAPER supply
and total staked come from `/query/protocol/summary` (`paper.supply`, `paper.staked`, 18 decimals).

---

## 15. Safety checklist

Before anything that signs:

- Default to a dry run that logs what it would send. Make live trading an explicit opt-in.
- Never hold the master wallet's private key in a long-running process if you can avoid it. Trade with a
  session key; sign registration and staking externally or briefly.
- Persist nonces. Never re-send an intent whose submission timed out until the account stream shows it
  didn't land.
- Respect `pausedActions`, `tradingPaused`, market flags, the leverage range, the minimums and the
  open-interest room, and refuse to trade when `/state/trading` looks unfamiliar.
- Stopping a process leaves positions open and unwatched. Provide a "close everything" path.
- Test with the minimum size ($10 margin, $1,000 notional) before anything larger.
