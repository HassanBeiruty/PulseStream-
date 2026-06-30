# PulseStream — Live Market Data Hub

A learning project that builds a **multiplexed live market-data hub** on top of Binance's free public WebSocket streams. One upstream connection ingests real-time trades and best bid/ask, normalizes them into a single internal schema, and fans them out to many browser clients — with self-built 1-minute OHLCV candles, a live chart, a watchlist, and price alerts.

> Market data only — no API key, no trading, no money movement. The market runs 24/7 so there's always live data to watch.

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

## Architecture (four layers)

Each layer is named with the real industry term and kept in its own module. Nothing downstream of the feed handler ever touches a raw Binance message.

| Layer | File | Responsibility |
|-------|------|----------------|
| **Feed handler** (ingestion) | [server/feedHandler.js](server/feedHandler.js) | Owns the upstream Binance connection. Subscribes to streams, detects a stale/dead connection via heartbeat, reconnects with exponential backoff + jitter. |
| **Normalizer** | [server/normalizer.js](server/normalizer.js) | Converts raw Binance shapes into one internal schema (`{ symbol, lastPrice, bestBid, bestAsk, lastTradeTime, source }`). |
| **Hub / pub-sub broker** (distribution) | [server/hub.js](server/hub.js) | Holds the current normalized **golden record** per symbol in memory; lets internal consumers subscribe/unsubscribe and pushes updates to them. |
| **WebSocket server** (distribution to frontend) | [server/index.js](server/index.js) | The app's own WebSocket server. Clients send subscribe/unsubscribe; the server relays hub updates, **throttled to ~300ms** per symbol. Also hosts price alerts as hub consumers. |

Plus [server/candleAggregator.js](server/candleAggregator.js) — builds 1-minute OHLCV candles from the raw trade stream in code (not pre-made provider candles).

---

## Features

- **Live price ticker** — pushed over WebSocket, never polled.
- **Connection status** — `live` / `reconnecting` / `stale` (stale = connection open but no fresh data for >10s).
- **Self-built 1m OHLCV candles** — aggregated from the trade stream.
- **Live chart** — Chart.js, backfilled from REST klines on load, then continued from self-built candles.
- **Watchlist** — add/remove symbols at runtime, driving real subscribe/unsubscribe messages.
- **Price alerts** — set a threshold; an in-page notification fires when a tick crosses it.
- **Reconnect with exponential backoff + jitter** — with console logging of each retry.

Configured symbols: `BTCUSDT`, `ETHUSDT`, `SOLUSDT` (edit in [server/config.js](server/config.js)).

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
├── server/                 # Backend — the four-layer hub
│   ├── config.js           # Single source of truth (symbols, ports, Binance URLs)
│   ├── feedHandler.js      # Ingestion layer (Binance connection + reconnect)
│   ├── normalizer.js       # Normalization layer
│   ├── hub.js              # Pub-sub broker (golden records + subscriptions)
│   ├── candleAggregator.js # 1m OHLCV aggregation from trades
│   └── index.js            # Express + WebSocket distribution server
├── scripts/                # Standalone demos (feed, hub)
├── frontend/               # React + Vite + Chart.js source
├── public/                 # Built frontend (served by the Node server)
├── package.json
└── CLAUDE.md               # Project brief / build phases
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
