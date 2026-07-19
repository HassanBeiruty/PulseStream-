# PulseStream — Live Market Data Terminal

[![CI](https://github.com/HassanBeiruty/PulseStream-/actions/workflows/ci.yml/badge.svg)](https://github.com/HassanBeiruty/PulseStream-/actions/workflows/ci.yml)

A learning project that builds a **multiplexed live market-data hub** on top of Binance's free public WebSocket streams, presented as a **trading-terminal UI** — ticker tape, market watch, live chart with instrument bar (last / session Δ / bid / ask / spread in bps), alert ticket, and a console/alerts blotter. One upstream connection ingests real-time trades and best bid/ask, normalizes them into a single internal schema, and fans them out to many consumers — with self-built 1-minute OHLCV candles, a live watchlist, and price alerts.

> Market data only — no API key, no trading, no money movement. The market runs 24/7 so there's always live data to watch.

**Dual-runtime by design (Phase 7):** the processing core (normalizer, candle aggregator, hub, alert book) lives in [`/shared`](shared/) as isomorphic ESM modules. Locally it runs inside the Node distribution server (**hub mode**); on the static Vercel deploy it runs in the browser (**direct mode**) behind the same `DataFeed` interface — one implementation, two runtimes, zero drift.

---

## Tech stack

**Backend (`/server`)**
- [Node.js](https://nodejs.org/) (>= 18) + [Express](https://expressjs.com/) — HTTP server, health check, and REST backfill endpoint
- [`ws`](https://github.com/websockets/ws) — raw WebSocket library (both the upstream Binance client *and* our own client-facing server), so the protocol is visible rather than hidden behind Socket.IO
- Native `fetch` — REST calls to Binance for historical klines

**Frontend (`/frontend` → builds to `/public`)**
- [React 19](https://react.dev/) — UI
- [Vite](https://vite.dev/) — dev server + bundler
- [Chart.js 4](https://www.chartjs.org/) — live price chart
- [Oxlint](https://oxc.rs/) — linting

**Data source**
- [Binance public market data](https://binance-docs.github.io/apidocs/spot/en/) — `@trade` and `@bookTicker` WebSocket streams + `/klines` REST endpoint (no key required)

---

## Architecture (four layers + an isomorphic core)

Each layer is named with the real industry term and kept in its own module. Nothing downstream of the feed handler ever touches a raw Binance message.

| Layer | File | Responsibility |
|-------|------|----------------|
| **Feed handler** (ingestion) | [server/feedHandler.js](server/feedHandler.js) | Owns the upstream Binance connection. Subscribes to streams, detects a stale/dead connection via heartbeat, reconnects with exponential backoff + jitter. |
| **Normalizer** | [shared/normalizer.js](shared/normalizer.js) | Converts raw Binance shapes into one internal schema (`{ symbol, lastPrice, bestBid, bestAsk, lastTradeTime, source }`). |
| **Candle aggregator** | [shared/candleAggregator.js](shared/candleAggregator.js) | Builds 1-minute OHLCV candles from the raw trade stream in code (not pre-made provider candles). |
| **Hub / pub-sub broker** (distribution) | [shared/hub.js](shared/hub.js) | Holds the current normalized **golden record** per symbol in memory; lets internal consumers subscribe/unsubscribe and pushes updates to them. |
| **WebSocket server** (distribution to frontend) | [server/index.js](server/index.js) | The app's own WebSocket server. Clients send subscribe/unsubscribe; the server relays hub updates, **throttled to ~300ms** per symbol. Also hosts price alerts (via the shared [alert book](shared/alertBook.js)) as hub consumers. |

### Ports & adapters (the frontend's data layer)

The UI consumes one **`DataFeed` port** ([frontend/src/feed/index.js](frontend/src/feed/index.js)) and never a concrete transport. Two adapters fulfil it, selected at build time:

- **`HubSocketFeed`** ([frontend/src/feed/hubSocketFeed.js](frontend/src/feed/hubSocketFeed.js)) — default. A WebSocket to our distribution server; the JSON wire protocol (constants in [shared/protocol.js](shared/protocol.js)) lives in the adapter, not the UI.
- **`DirectBinanceFeed`** ([frontend/src/feed/directBinanceFeed.js](frontend/src/feed/directBinanceFeed.js)) — `VITE_DATA_MODE=direct` (the static Vercel deploy, where no backend exists). A browser-side feed handler pushes raw messages through the **same shared normalizer → candle aggregator → hub → alert book** pipeline the server runs.

---

## Features

**Terminal UI**
- **Ticker tape** — live strip of the whole symbol pool with 24h Δ% (signed + arrowed, colorblind-safe by construction).
- **Market watch** — two-line live rows (last / 24h Δ / bid × ask) with tick-direction flashes, staleness badges, and Watch/× controls that drive **real subscribe/unsubscribe** messages.
- **Instrument bar** — big live last price, 24h Δ, bid/ask, **spread in absolute and basis points**, **session VWAP**, 24h high/low/volume, and the live self-built 1m OHLCV bucket.
- **Live chart** — Chart.js with a **session VWAP benchmark overlay**, backfilled from REST klines on load, then continued from self-built candles.
- **L2 depth ladder** — live top-10 bids/asks with size bars, spread in bps, mid, and **order-book imbalance**, maintained by a self-built snapshot + sequenced-delta sync engine ([shared/orderBook.js](shared/orderBook.js)).
- **Alert ticket** — order-ticket-style panel (▲ Above / ▼ Below sides); triggered alerts toast in-page.
- **Blotter** — bottom tabs: protocol console, paper positions/orders/fills, and active alerts.

**Paper trading (simulated — no real orders, ever)**
- **Order ticket** — BUY/SELL × MARKET/LIMIT with live estimated notional + fee; trades the selected instrument.
- **Simulated execution against live top-of-book** ([shared/oms.js](shared/oms.js)) — market orders fill at the touch (taker), marketable limits fill at the touch with price improvement, resting limits fill at their limit when crossed; **fee in bps** on every fill.
- **Positions & P&L** — signed long/short positions with **average-cost accounting** (including flips through zero), live unrealized P&L marked to last, realized P&L net of fees; header shows total P&L; book persists in localStorage.
- **Blotter tabs** — Console · Positions · Orders (cancelable) · Fills · Alerts.

**Data plumbing**
- **Live prices pushed over WebSocket**, never polled; UI updates **throttled to ~300ms** per symbol.
- **Four upstream streams per symbol** — `@trade` (prints), `@bookTicker` (L1 quotes), `@miniTicker` (24h stats) merged into one golden record, plus `@depth` diffs feeding the L2 order-book engine (Binance's documented sync algorithm: REST snapshot + `U`/`u` sequence validation, gap detection, automatic resync).
- **Runtime schema validation at the feed boundary** ([shared/schema.js](shared/schema.js)) — malformed exchange frames are rejected before they can seed NaN into golden records.
- **Session VWAP** computed inside the ingestion pipeline from real trades ([shared/analytics.js](shared/analytics.js)) — never from throttled UI updates.
- **Connection status** — `live` / `reconnecting` / `stale` (stale = connection open but no fresh data for >10s).
- **Self-built 1m OHLCV candles** — aggregated from the trade stream.
- **Reconnect with exponential backoff + full jitter** — same policy in both runtimes.

**Engineering**
- **Unit-tested shared core** — [Vitest](tests/) (51 tests) covers the normalizer, candle aggregator, hub pub-sub, alert book, VWAP, klines mapping, order-book sync rules (buffering, gaps, resync), schema validation, and the full OMS lifecycle (fills, flips through zero, fees, persistence).
- **Mock-exchange integration test** — runs the real feed handler against a local WebSocket server standing in for Binance, proving message forwarding, reconnect-with-backoff after drops, and the staleness watchdog forcing recovery on silent connections.
- **CI on every push/PR** — GitHub Actions runs tests, lint, and both build modes ([.github/workflows/ci.yml](.github/workflows/ci.yml)).
- **Serverless backfill API** — [api/history.js](api/history.js) proxies Binance klines behind Vercel's edge CDN (`s-maxage` + `stale-while-revalidate`), with a direct-to-Binance fallback in the browser.

Configured symbols: `PAXGUSDT`, `BTCUSDT`, `ETHUSDT` (edit once in [shared/symbols.js](shared/symbols.js)).

---

## Prerequisites

- **Node.js >= 18** (for native `fetch` and `--watch`)
- npm

---

## Running the app

### Quick start (single port — recommended)

The frontend builds into `/public`, which the Node server serves. Everything — UI, REST, and WebSocket — runs on **one port (3000)**.

```bash
# 1. Install backend dependencies
npm install

# 2. Build the frontend into /public
cd frontend
npm install
npm run build
cd ..

# 3. Start the server
npm start
```

Then open **http://localhost:3000**.

> `/public` already contains a pre-built frontend, so if you only want to see it run you can skip step 2 and just `npm install && npm start`.

### Backend dev mode (auto-restart)

```bash
npm run dev        # node --watch server/index.js
```

### Frontend dev mode (hot reload)

For live UI editing, run the Vite dev server alongside the backend. Keep the backend running on port 3000 (`npm start` or `npm run dev`), then in another terminal:

```bash
cd frontend
npm install
npm run dev        # Vite dev server (usually http://localhost:5173)
```

The browser connects its WebSocket directly to the backend on `localhost:3000`. For full chart backfill, use the single-port build above.

### Feed handler demo (no UI)

Watch the raw ingestion + reconnect logic on its own:

```bash
npm run feed:demo
```

---

## NPM scripts

| Location | Script | Does |
|----------|--------|------|
| root | `npm start` | Run the production server (`node server/index.js`) |
| root | `npm run dev` | Run the server with `--watch` auto-restart |
| root | `npm run feed:demo` | Run the standalone feed-handler demo |
| frontend | `npm run dev` | Vite dev server (hot reload) |
| frontend | `npm run build` | Build the frontend into `../public` |
| frontend | `npm run preview` | Preview the production build |
| frontend | `npm run lint` | Run Oxlint |

---

## Project structure

```
.
├── shared/                 # ISOMORPHIC CORE — runs in Node AND the browser (ESM)
│   ├── symbols.js          # Symbol pool (single source of truth)
│   ├── protocol.js         # Wire-protocol constants + throttle policy
│   ├── normalizer.js       # Normalization layer
│   ├── candleAggregator.js # 1m OHLCV aggregation from trades
│   ├── hub.js              # Pub-sub broker (golden records + subscriptions)
│   ├── alertBook.js        # Price-alert registry + trigger-once evaluation
│   ├── oms.js              # Paper-trading OMS (simulated fills, positions, P&L)
│   ├── orderBook.js        # L2 book: snapshot + sequenced-delta sync, gap resync
│   ├── schema.js           # Feed-boundary validation of raw exchange payloads
│   ├── analytics.js        # Session VWAP (volume-weighted average price)
│   ├── klines.js           # Binance klines -> internal candle mapping
│   └── emitter.js          # Minimal dependency-free event emitter
├── server/                 # Backend runtime (Node, ESM)
│   ├── config.js           # Server config (port, Binance URLs; symbols from /shared)
│   ├── feedHandler.js      # Ingestion layer (Binance connection + reconnect)
│   └── index.js            # Express + WebSocket distribution server
├── frontend/               # React + Vite + Chart.js source
│   └── src/
│       ├── feed/           # DataFeed PORT + the two adapters (hub / direct)
│       ├── components/     # TickerTape, MarketWatch, TicketPanel (Trade/Alert), Blotter, PriceChart
│       ├── dataSource.js   # Facade: feed factory + REST helpers
│       └── format.js       # Price/delta/P&L/spread display formatting
├── api/                    # Vercel serverless functions (edge-cached backfill)
├── tests/                  # Vitest unit tests for the shared core
├── .github/workflows/      # CI: tests + lint + both builds on every push
├── scripts/                # Standalone demos (feed, hub)
├── public/                 # Built frontend (served by the Node server)
└── package.json
```

---

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Status + current golden records per symbol |
| `GET` | `/api/history?symbol=BTCUSDT` | 100 historical 1m candles for chart backfill |
| `WS` | `/` | Client distribution feed (`SUBSCRIBE` / `UNSUBSCRIBE` / `SET_ALERT` / `REMOVE_ALERT`) |

---

*Training project — built to practice the architecture and vocabulary of real trading data systems.*
