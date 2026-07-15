# PulseStream — Complete System Documentation

> Read this top to bottom and you will understand **what every part of the system is, what it's called, why it exists, and how the data flows** — from a real Binance trade all the way to a price ticking on the screen. Each concept is explained twice: the **technical** "how it works" and the **business** "why it matters."

---

## Table of contents

1. [What this system is (the one-paragraph version)](#1-what-this-system-is)
2. [The business problem: why a "hub" exists](#2-the-business-problem-why-a-hub-exists)
3. [Trading vocabulary you need first](#3-trading-vocabulary-you-need-first)
4. [The four-layer architecture](#4-the-four-layer-architecture)
5. [Layer 1 — Feed handler (ingestion)](#5-layer-1--feed-handler-ingestion)
6. [Layer 2 — Normalizer (normalization)](#6-layer-2--normalizer-normalization)
7. [Layer 3 — Hub / pub-sub broker (distribution core)](#7-layer-3--hub--pub-sub-broker-distribution-core)
8. [The candle aggregator (OHLCV)](#8-the-candle-aggregator-ohlcv)
9. [Layer 4 — WebSocket distribution server](#9-layer-4--websocket-distribution-server)
10. [The frontend (the consumer)](#10-the-frontend-the-consumer)
11. [End-to-end: the life of one trade](#11-end-to-end-the-life-of-one-trade)
12. [The client ↔ server protocol](#12-the-client--server-protocol)
13. [Key engineering concepts (and the business reason for each)](#13-key-engineering-concepts)
14. [Features mapped to business value](#14-features-mapped-to-business-value)
15. [Master glossary](#15-master-glossary)

---

## 1. What this system is

**Technical:** A Node.js service that opens **one** WebSocket connection to Binance's public market-data feed, converts the raw messages into a single clean internal format, keeps the latest state of each trading symbol in memory, and re-broadcasts those updates to many web browsers over its **own** WebSocket server — adding self-built price candles, a watchlist, and price alerts on top.

**Business:** It's a **market-data distribution hub**. The valuable thing it produces is a *single, clean, reliable, real-time price feed* that many internal users (screens, alert engines, charts) can all consume at once, without each of them having to talk to the exchange directly. In real trading firms this component sits between the exchanges and everything else the firm builds.

---

## 2. The business problem: why a "hub" exists

Imagine 50 traders, 10 dashboards, and 5 automated alert engines all want live BTC prices.

**The naive way:** every one of them opens its own connection to the exchange. Problems:
- The exchange rate-limits or bans you for too many connections.
- 65 different components each parse the raw feed slightly differently → 65 subtly different "prices." In finance, two screens disagreeing on the price is a serious problem.
- If the exchange changes its message format, you have to fix it in 65 places.

**The hub way (what we built):** **one** connection to the exchange, **one** place that decides "this is the current price of BTC" (the *golden record*), and everyone else subscribes to the hub.

| Concept | Technical meaning | Business value |
|---|---|---|
| **Multiplexing** | One upstream connection fans out to many downstream consumers | One exchange connection serves the whole firm; you don't get rate-limited or banned |
| **Single source of truth** | One golden record per symbol | Every screen shows the *same* price — no disputes, no reconciliation |
| **Decoupling** | Only one module knows the exchange's format | Swap exchanges or add a second one without touching the rest of the app |

This is literally why it's called a **hub** and not a **relay**: a relay just forwards bytes; a hub *owns the canonical state* and serves it.

---

## 3. Trading vocabulary you need first

These terms appear everywhere in the code. Learn them once here.

| Term | Technical | Business / plain English |
|---|---|---|
| **Symbol** | An identifier like `BTCUSDT` | "Bitcoin priced in US-dollar-stablecoin." The thing you're tracking. `ETHUSDT` = Ethereum, `PAXGUSDT` = gold-backed token. |
| **Tick** | A single market event (one trade, or one bid/ask change) | The smallest unit of "something just happened in the market." Liquid markets tick many times per second. |
| **Trade** | An executed transaction: someone bought from someone else at a price | Proof of a *real* price — money actually changed hands at this number. |
| **Last price** | The price of the most recent trade | "What's BTC trading at right now?" → this number. |
| **Bid** | The highest price a buyer is currently willing to pay | What you could *sell* into right now. |
| **Ask** (offer) | The lowest price a seller is currently willing to accept | What you'd have to pay to *buy* right now. |
| **Best bid / best ask** | The top of the order book — Level 1 | The current "buy here / sell here" prices. |
| **Spread** | Ask − Bid | The cost of immediacy; how "liquid" a market is. Tight spread = healthy market. |
| **Order book** | The full list of all bids and asks at all prices (Level 2) | We deliberately **don't** use this — only Level 1 (best bid/ask). Out of scope. |
| **OHLCV candle** | Open, High, Low, Close, Volume for a time window | A compressed summary of all the trades in (say) one minute. The unit charts are drawn from. |
| **Klines** | Binance's word for candles | Same thing as OHLCV candles. |
| **Volume** | Total quantity traded in a window | How much actually changed hands — a measure of activity/conviction. |
| **Watchlist** | The set of symbols a user currently cares about | "Only show me BTC and ETH right now." |

---

## 4. The four-layer architecture

> **Phase 7 update:** the normalizer, candle aggregator, hub, and alert logic now live in **`/shared`** as isomorphic ESM modules (the server migrated from CommonJS to ESM to import them). The same modules run inside the Node server (hub mode) *and* inside the browser (direct mode on the static Vercel deploy) behind a `DataFeed` port with two adapters — see `frontend/src/feed/`. File paths in the diagrams below predate that move; the layer names, responsibilities, and data flow are unchanged.

The system is built as four layers, each in its own file, each with a real industry name. **Data only flows one direction**, and each layer only knows about the one below it. This separation is the single most important design idea in the project.

```
        BINANCE (the exchange, upstream)
                  │  raw messages
                  ▼
  ┌─────────────────────────────────┐
  │ 1. FEED HANDLER (ingestion)      │  server/feedHandler.js
  │    owns the raw connection       │  "the only thing allowed to know Binance exists"
  └─────────────────────────────────┘
                  │  emits 'raw' { stream, data }
                  ▼
  ┌─────────────────────────────────┐
  │ 2. NORMALIZER                    │  server/normalizer.js
  │    raw → one internal schema     │  "makes it a hub, not a relay"
  └─────────────────────────────────┘
                  │  normalized update
                  ▼  (trades also pass through the CANDLE AGGREGATOR → server/candleAggregator.js)
  ┌─────────────────────────────────┐
  │ 3. HUB / PUB-SUB BROKER          │  server/hub.js
  │    golden record + subscriptions │  "the single source of truth"
  └─────────────────────────────────┘
                  │  pushes golden record to subscribers
                  ▼
  ┌─────────────────────────────────┐
  │ 4. DISTRIBUTION SERVER (our WS)  │  server/index.js
  │    relays to browsers, throttled │  "one upstream connection, many clients"
  └─────────────────────────────────┘
                  │  throttled UPDATE messages
                  ▼
        BROWSERS (the consumers)        frontend/  (React + Chart.js)
```

**Business value of this shape:** each layer is a replaceable, testable unit. You can add a second exchange by writing only a new feed handler + normalizer. You can change how browsers are served without touching pricing logic. In a real firm this is what lets a 50-person team work on the same system without stepping on each other.

---

## 5. Layer 1 — Feed handler (ingestion)

**File:** [server/feedHandler.js](server/feedHandler.js) · **Class:** `BinanceFeedHandler` (extends Node's `EventEmitter`)

### What it does (technical)
It owns the **single raw WebSocket connection** to Binance and nothing else. Responsibilities:

1. **Build the subscription URL.** Binance's "combined stream" lets you subscribe to many streams in one connection by listing them in the URL:
   ```
   wss://stream.binance.com:9443/stream?streams=btcusdt@trade/btcusdt@bookTicker/ethusdt@trade/...
   ```
   For each symbol it requests two streams: `@trade` (executed trades) and `@bookTicker` (best bid/ask).
2. **Parse just enough.** Each frame arrives as `{ stream, data }`. The handler splits it and emits a `'raw'` event. It does **not** interpret the numbers — that's the normalizer's job.
3. **Detect a dead connection (staleness watchdog).** A TCP socket can stay "open" while data silently stops (a *half-open* connection). For liquid symbols, trades arrive many times per second, so **silence = death**. A timer checks "how long since the last message?" If it exceeds `stalenessMs` (15s), it forcibly `terminate()`s the socket to trigger a reconnect. **It does not trust "connected" — it checks actual data freshness.**
4. **Reconnect with exponential backoff + jitter** (see [§13](#13-key-engineering-concepts)).

### Events it emits
| Event | Payload | Meaning |
|---|---|---|
| `raw` | `{ stream, data }` | One parsed message from Binance |
| `open` | — | Upstream socket connected |
| `reconnecting` | `{ attempt, delay }` | A reconnect was scheduled |
| `stale` | `{ silentMs }` | No data for too long; forcing reconnect |
| `close` | `{ code, reason }` | Upstream socket closed |
| `error` | `Error` | Socket/parse error (non-fatal) |

### Why it matters (business)
This is the firm's **single point of contact with the exchange**. Centralizing it means: only one thing to ban/rate-limit, only one place that breaks if Binance changes its API, and one disciplined place that handles the messy reality of networks (drops, half-open sockets, reconnect storms). The staleness watchdog is the difference between "the screen quietly froze on a stale price and a trader acted on bad data" and "the system noticed within 15 seconds and recovered."

---

## 6. Layer 2 — Normalizer (normalization)

**File:** [server/normalizer.js](server/normalizer.js) · **Function:** `normalize(stream, data)`

### What it does (technical)
Converts Binance's cryptic, provider-specific message shape into **one internal schema** the rest of the app uses everywhere:

```js
// Internal schema (the only shape anything downstream ever sees):
{ symbol, lastPrice, bestBid, bestAsk, lastTradeTime, source }
```

Binance sends terse keys (`s` = symbol, `p` = price, `q` = quantity, `T` = trade time, `b` = best bid, `a` = best ask). The normalizer translates:

- A `@trade` message → `{ symbol, lastPrice, lastTradeTime, quantity, source: 'binance' }`
- A `@bookTicker` message → `{ symbol, bestBid, bestAsk, source: 'binance' }`
- Anything else → `null` (ignored)

### Why it matters (business)
**This is the line that turns a relay into a hub.** Because nothing downstream ever touches a raw Binance payload, the entire rest of the system is *vendor-independent*. If you later add Coinbase or Kraken, you write a new normalizer that outputs the *same* schema, and the hub, the alerts, the charts, and the UI all keep working unchanged. The `source` field records *where* a price came from — essential for auditing and for resolving disagreements if you ever run multiple feeds. (Multi-source is intentionally out of scope here, but the schema is already built for it.)

---

## 7. Layer 3 — Hub / pub-sub broker (distribution core)

**File:** [server/hub.js](server/hub.js) · **Class:** `Hub`

### What it does (technical)
This is the multiplexed core. It holds two things in memory:

- `records` — `Map<symbol, goldenRecord>`: the **current** normalized state of each symbol.
- `subscriptions` — `Map<symbol, Set<callback>>`: who wants to be told when a symbol changes.

Three operations:

| Method | What it does |
|---|---|
| `update(normalizedUpdate)` | Merges the partial update into that symbol's **golden record** (trades fill in `lastPrice`; bookTickers fill in `bestBid`/`bestAsk`), then pushes a **copy** of the full record to every subscriber of that symbol. |
| `subscribe(symbol, cb)` | Registers a callback; returns an `unsubscribe()` function. |
| `getGoldenRecord(symbol)` | Returns a snapshot copy of the current state (used to send a new client the latest price immediately, without waiting for the next tick). |

Two important details:
- **Merge, don't replace.** A trade only knows the price; a bookTicker only knows bid/ask. The hub *merges* each partial update so the golden record always carries the latest of everything.
- **Copy on the way out** (`{ ...record }`). Subscribers receive a copy so they can't accidentally mutate the canonical state. The golden record stays trustworthy.

### Golden record (the key term)
A **golden record** is the authoritative, current, merged truth for one symbol:
```js
{ symbol: 'BTCUSDT', lastPrice: 59842.1, bestBid: 59842.0, bestAsk: 59842.2, lastTradeTime: 1719..., source: 'binance' }
```

### The pub-sub pattern
**Publishers** (the normalizer, via `hub.update`) don't know who's listening. **Subscribers** (browser connections, alert checks) don't know where data comes from. The hub is the broker in the middle. This is the classic **publish/subscribe** decoupling.

### Why it matters (business)
The golden record is **the single source of truth** — the reason every screen agrees on the price. Pub-sub is what lets the system scale: adding a 1,000th consumer costs almost nothing because they all share the same one upstream feed. The hub is exactly the asset a trading firm builds once and reuses across every product.

---

## 8. The candle aggregator (OHLCV)

**File:** [server/candleAggregator.js](server/candleAggregator.js) · **Class:** `CandleAggregator`

> This is the project's flagship learning exercise: **build candles yourself from raw trades** instead of trusting a pre-made candle from the provider.

### What it does (technical)
It turns a stream of individual trades into **1-minute OHLCV buckets**. For each incoming trade:

1. Compute which minute it belongs to:
   `minuteStart = Math.floor(tradeTime / 60000) * 60000` (rounds the timestamp down to the start of its minute).
2. If that minute is **newer** than the current candle → start a fresh candle with `open = high = low = close = price`, `volume = quantity`.
3. If it's the **same** minute → update the running candle:
   - `high = max(high, price)`
   - `low = min(low, price)`
   - `close = price` (always the latest)
   - `volume += quantity` (accumulate)

So a candle answers: *over this minute, where did price start (open), how high did it go (high), how low (low), where did it end (close), and how much traded (volume)?*

### Why build it yourself? (business)
- **Trust & auditability.** If you compute candles from the raw trades you saw, you can *prove* your chart. Pre-made provider candles are a black box you can't reconcile.
- **Flexibility.** Want 5-second candles, or candles in a different timezone, or volume-weighted variants? You can only do that if you own the aggregation logic.
- **It's the foundation of all charting and most analytics.** Almost every technical indicator (moving averages, etc.) is computed from candles, not raw ticks. Owning the candle means owning the analytics layer later.

In this app the active (still-forming) candle rides along on the golden record so the chart can update the current minute live, then "lock in" that bar and start a new one when the minute rolls over.

---

## 9. Layer 4 — WebSocket distribution server

**File:** [server/index.js](server/index.js)

### What it does (technical)
This is the app's **own** server (Express + a `ws` WebSocket server sharing one HTTP server). It wires the layers together and faces the browsers. Responsibilities:

1. **Serve the frontend** — static files from `/public`.
2. **REST endpoints:**
   - `GET /health` → status + current golden records (also how the browser learns the symbol list).
   - `GET /api/history?symbol=BTCUSDT` → fetches 100 historical 1-minute klines from Binance to **backfill** the chart on page load, converting them to our candle shape. (Validates the symbol is configured first.)
3. **Wire the pipeline:** on every `raw` event from the feed handler → `normalize()` it → if it's a trade, run it through the candle aggregator and attach the `activeCandle` → `hub.update()` it.
4. **Handle each browser connection.** When a browser connects, the server:
   - Immediately sends the current upstream feed status.
   - Listens for the client's `SUBSCRIBE` / `UNSUBSCRIBE` / `SET_ALERT` / `REMOVE_ALERT` messages.
   - On `SUBSCRIBE`, it calls `hub.subscribe(symbol, …)`. Incoming golden records are placed into a `pendingUpdates` buffer.
   - **Throttling:** a `setInterval` flushes that buffer **once every 300ms** per client. Even if Binance ticks 50×/second, the browser receives at most ~3–4 updates/second per symbol. (See [§13](#13-key-engineering-concepts).)
   - **Price alerts live here, as hub consumers.** Each alert is checked inside the same subscription callback that feeds the UI — when the golden record's `lastPrice` crosses the threshold, the server sends `ALERT_TRIGGERED` and discards the alert (fires once).
   - On disconnect, it clears the flush interval and unsubscribes everything (no leaks).

### Why it matters (business)
This is the **product surface** — the thing your users actually connect to. Two business-critical behaviors live here:

- **Throttling protects the client and the network.** A trader's browser re-rendering 50×/second would melt the laptop and add zero value (no human reads prices that fast). Throttling to ~300ms keeps the UI smooth and the bandwidth low while still feeling "live." This is a deliberate product decision encoded in code.
- **Alerts as hub consumers, not feed taps.** The alert engine subscribes to the *same golden record* the UI shows. That guarantees an alert fires on exactly the price the user saw — never on some separate, possibly-different raw value. Consistency you can defend.

---

## 10. The frontend (the consumer)

**Files:** [frontend/src/App.jsx](frontend/src/App.jsx) + components (`TickerCard`, `PriceChart`, `ConsolePanel`)

### What it does (technical)
The browser **never talks to Binance.** It is just another hub consumer that speaks the tiny JSON protocol to our distribution server. On load it:

1. `GET /health` to learn the symbol list, then seeds the watchlist and selected symbol.
2. `GET /api/history?symbol=…` to **backfill** the chart with 100 past candles.
3. Opens a WebSocket to our server and `SUBSCRIBE`s to each watchlist symbol.

Then it reacts to server messages:
- `UPDATE` → merge the golden record into local state; the matching **TickerCard** re-renders (and logs whether price ticked up/down).
- `FEED_STATUS` → drive the status badge.
- `ALERT_CONFIRMED` / `ALERT_REMOVED` → maintain the active-alerts list.
- `ALERT_TRIGGERED` → pop a toast notification (auto-dismiss after 6s).

**The chart** ([PriceChart.jsx](frontend/src/components/PriceChart.jsx)) draws the backfilled candles as a line of closes, then on each live `activeCandle`: if it's the same minute, it overwrites the last point; if it's a new minute, it appends a new point (and trims to 100). It calls `chart.update('none')` to redraw without animation for performance.

**Resilience:** if the browser's socket drops, the client waits 3 seconds and reconnects, then re-subscribes to its watchlist and re-registers its alerts — so a refresh or a blip doesn't lose your setup.

### Connection status (technical + business)
The status badge has a meaning beyond "connected":
- **Server status** (`connecting` / `connected` / `disconnected`) = is *my browser* talking to *our* server?
- **Upstream status** (`live` / `reconnecting` / `stale`) = is *our server* getting fresh data from *Binance*?

A trader needs both. "My browser is connected" is worthless if "the upstream feed is stale." Showing **stale** explicitly — connection open but data frozen >10s — is the honest signal that prevents someone trading on a dead price.

---

## 11. End-to-end: the life of one trade

Follow a single BTC trade through the whole system:

1. **Someone buys BTC on Binance.** Binance pushes a `btcusdt@trade` frame into our one WebSocket: `{ stream:"btcusdt@trade", data:{ s:"BTCUSDT", p:"59842.10", q:"0.5", T:1719... } }`.
2. **Feed handler** ([feedHandler.js](server/feedHandler.js)) updates `lastMessageAt` (so the staleness watchdog stays calm), parses the frame, and emits `raw`.
3. **Normalizer** ([normalizer.js](server/normalizer.js)) turns it into `{ symbol:"BTCUSDT", lastPrice:59842.1, lastTradeTime:1719..., quantity:0.5, source:"binance" }`.
4. **Candle aggregator** ([candleAggregator.js](server/candleAggregator.js)) folds it into the current 1-minute candle (updates high/low/close, adds 0.5 to volume) and attaches the `activeCandle`.
5. **Hub** ([hub.js](server/hub.js)) merges it into BTC's **golden record** and pushes a copy to every subscriber of `BTCUSDT`.
6. **Distribution server** ([index.js](server/index.js)) drops the record into each subscribed client's `pendingUpdates` buffer — and checks any price alerts against the new `lastPrice`.
7. **~300ms throttle flush** sends the latest record to the browser as an `UPDATE` message.
8. **Browser** ([App.jsx](frontend/src/App.jsx)) merges it into state → the **TickerCard** shows the new price and the **chart's** current minute moves. If an alert crossed, a toast pops.

One trade, four layers, one clean path. Every other feature is a variation on this.

---

## 12. The client ↔ server protocol

A tiny JSON message protocol over the browser↔server WebSocket.

**Client → server:**
| Message | Meaning |
|---|---|
| `{ type:'SUBSCRIBE', symbol }` | Start receiving updates for a symbol (driven by watchlist toggle) |
| `{ type:'UNSUBSCRIBE', symbol }` | Stop receiving updates (and cancels that symbol's alerts server-side) |
| `{ type:'SET_ALERT', id, symbol, value, condition }` | Register a price alert (`condition` = `ABOVE` or `BELOW`) |
| `{ type:'REMOVE_ALERT', id }` | Cancel an alert |

**Server → client:**
| Message | Meaning |
|---|---|
| `{ type:'UPDATE', data: goldenRecord }` | Latest state for a symbol (throttled) |
| `{ type:'FEED_STATUS', status }` | Upstream health: `live` / `reconnecting` / `stale` |
| `{ type:'ALERT_CONFIRMED', data }` | Your alert is registered |
| `{ type:'ALERT_REMOVED', data }` | Your alert was cancelled |
| `{ type:'ALERT_TRIGGERED', data }` | An alert's condition was met (fires once) |

**Business point:** the watchlist buttons *literally* send `SUBSCRIBE`/`UNSUBSCRIBE` over the wire — they don't just hide a card. Removing a symbol genuinely stops the server from sending its data, which is what saves bandwidth and scales. The UI state and the server subscription are kept honest with each other.

---

## 13. Key engineering concepts

These are the reusable ideas worth carrying to any real-time system.

### Exponential backoff + jitter (reconnect strategy)
**Technical:** When the upstream drops, don't hammer it. Wait `base × 2^(attempt−1)`, capped at 30s (1s, 2s, 4s, 8s … → 30s). Then apply **full jitter**: pick a *random* delay between 0 and that cap.
**Business:** Backoff stops you from DDoSing the exchange (and getting banned) during an outage. Jitter prevents the **thundering herd** — if 10,000 clients all dropped at once and all retried at exactly 4s, they'd stampede the exchange in synchronized waves. Randomizing spreads the load out. This is the difference between "we recovered gracefully" and "we made the outage worse."

### Staleness watchdog (heartbeat / freshness check)
**Technical:** A socket reporting "open" is not proof of life. A timer measures silence; >15s of no data forces a reconnect. The UI separately flags a symbol **stale** if no update in >10s.
**Business:** **Never trust "connected" — verify fresh data.** A frozen-but-connected feed is the most dangerous state in trading: it looks fine and shows a stale price. Detecting it is a safety feature.

### Throttling (rate limiting the UI)
**Technical:** Buffer incoming updates and flush at most once per ~300ms per client.
**Business:** Humans can't read 50 prices/second, and rendering that fast would burn the user's CPU and your bandwidth for zero benefit. Throttling delivers a smooth, "live-enough" experience cheaply. A conscious product/cost decision.

### Multiplexing (one connection, many consumers)
**Technical:** One upstream socket → hub → N downstream subscribers.
**Business:** Linear cost savings and the key to scale: the 1,000th user is nearly free, and you stay under the exchange's connection limits.

### Decoupling via normalization
**Technical:** Only the feed handler + normalizer know the vendor. Everything else speaks the internal schema.
**Business:** Vendor independence. Swap or add exchanges without a rewrite. Protects you from a single provider's outages or pricing changes.

---

## 14. Features mapped to business value

| Feature | What the user sees | Why a business cares |
|---|---|---|
| **Live price ticker** | Prices updating in real time | The core product — current, trustworthy prices, pushed not polled |
| **Connection status (live/reconnecting/stale)** | An honest health badge | Prevents acting on dead data; operational trust |
| **Self-built 1m OHLCV candles** | A clean price chart | Auditable, flexible charting you own end-to-end |
| **Live chart with REST backfill** | History + live continuation on load | Context immediately, no blank screen while you wait for ticks |
| **Watchlist (real subscribe/unsubscribe)** | Add/remove symbols | Users see only what they care about; server saves bandwidth |
| **Price alerts** | "BTC crossed 60,000!" toast | Users don't have to stare at the screen; the system watches for them |
| **Reconnect w/ backoff + jitter** | It just recovers after a blip | Resilience without making outages worse |

---

## 15. Master glossary

| Term | One-line meaning |
|---|---|
| **Feed handler** | The ingestion layer; the only module that talks to the exchange |
| **Normalizer** | Converts vendor messages into one internal schema |
| **Hub / pub-sub broker** | Holds the golden record per symbol and pushes updates to subscribers |
| **Golden record** | The authoritative, current, merged state of one symbol |
| **Candle aggregator** | Builds 1-minute OHLCV bars from raw trades |
| **Distribution server** | Our own WebSocket server that serves browsers, throttled |
| **Multiplexing** | One upstream connection serving many downstream consumers |
| **Pub/sub** | Publishers and subscribers decoupled by a broker in the middle |
| **Golden source / source of truth** | The one place everyone agrees the value comes from |
| **OHLCV** | Open, High, Low, Close, Volume — a candle |
| **Klines** | Binance's name for candles |
| **Tick** | One market event (a trade or a quote change) |
| **Bid / Ask** | Best buy price / best sell price (Level 1) |
| **Spread** | Ask − Bid; the cost of immediacy and a liquidity gauge |
| **Last price** | Price of the most recent executed trade |
| **Volume** | Quantity traded in a window |
| **Staleness / heartbeat check** | Detecting a frozen feed by data freshness, not socket state |
| **Exponential backoff** | Reconnect delays that grow geometrically, capped |
| **Jitter** | Randomizing retry timing to avoid a thundering herd |
| **Thundering herd** | Many clients retrying in lockstep and stampeding a recovering server |
| **Throttling** | Capping how often updates are sent to keep the UI/network sane |
| **Watchlist** | The symbols a user is currently subscribed to |
| **Backfill** | Loading historical data so a view isn't empty before live data arrives |

---

*This document describes the system as built in this repository. Each layer is intentionally a separate, replaceable module — the architecture, not just the code, is the lesson.*
