# Project: Live Market Data Hub (Training Project)

## Purpose

This is a learning project for practicing fintech/trading-domain frontend + backend patterns. The goal is **hands-on experience with the architecture and vocabulary used in real trading data systems**, scoped to intermediate level — not a production system, not a real trading app. Prioritize clarity and correctness of each pattern over performance or polish.

Work through this file phase by phase. After finishing a phase, stop, summarize what was built, and wait for confirmation before moving to the next phase. Do not jump ahead to later phases or add stretch features unless explicitly asked.

## Tech stack

- Backend: Node.js + Express + `ws` (plain WebSocket library, not Socket.IO — we want to see the protocol directly)
- Frontend: single self-contained HTML file with vanilla JS + Chart.js (CDN), similar structure to other lesson-style HTML projects already in use — sticky header, clean panel layout, no framework needed
- Data source: Binance public market data API — **no API key required**, free, real WebSocket streams, 24/7 market (docs: https://binance-docs.github.io/apidocs/spot/en/)
- No database for now — everything lives in memory. Persistence is a stretch goal, not in scope.

## Data source details

Use Binance's public endpoints only (market data, not trading/account endpoints — we never need a key):

- WebSocket combined stream: `wss://stream.binance.com:9443/stream?streams=<stream1>/<stream2>/...`
- Streams to use: `<symbol>@trade` (individual trades, real-time) and `<symbol>@bookTicker` (best bid/ask, real-time)
- REST for history: `GET https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=100` (for chart backfill on load)

Symbols to support initially: `BTCUSDT`, `ETHUSDT`, `SOLUSDT`. Keep the symbol list configurable (array in one config file), not hardcoded in multiple places.

## Architecture & terminology (what each piece is called and why it exists)

Build this as four layers. Each layer name below is the real industry term — use these names for the actual files/modules/functions so the vocabulary sticks.

1. **Feed handler** (ingestion layer)
   One module per upstream source. Owns the raw connection to Binance, knows nothing about how the data will be displayed. Responsible for: connecting, subscribing to streams, parsing raw messages, detecting a dead connection via a **heartbeat/staleness check**, and **reconnecting with exponential backoff** when the connection drops.

2. **Normalizer** (normalization layer)
   Converts whatever shape Binance sends into one internal schema your app uses everywhere else, e.g.:
   ```
   { symbol, lastPrice, bestBid, bestAsk, lastTradeTime, source }
   ```
   This is what makes it a "hub" rather than a relay — nothing downstream should ever touch a raw Binance message.

3. **Hub / pub-sub broker** (distribution layer)
   Holds the current normalized state per symbol (the **golden record**) in memory, and lets internal consumers **subscribe**/**unsubscribe** to a symbol. When the normalizer updates a symbol, the hub pushes that update to every current subscriber. This is the multiplexed core — one upstream connection serving many internal consumers.

4. **Distribution to frontend** (WebSocket server)
   Your own WebSocket server (separate from the Binance one) that the browser connects to. The frontend sends subscribe/unsubscribe messages for symbols it cares about (its **watchlist**); the server relays hub updates to connected clients, **throttled** to roughly one UI update per symbol every 250–500ms even if Binance ticks faster than that — the frontend should never re-render on every single tick.

## Required features (in scope — build all of these)

- **Live price ticker** for the configured symbols, updating via WebSocket push, not polling.
- **Connection status indicator** in the UI with three states: live / reconnecting / stale. "Stale" means no update received for a symbol in >10 seconds even though the connection is technically open — don't just trust "connected," check actual data freshness.
- **Self-built 1-minute OHLCV candles**: aggregate the raw `@trade` stream yourself into open/high/low/close/volume buckets per minute, in code — do not just trust a pre-made candle from the provider. This is the most important learning exercise in the project; take your time on it.
- **Live candlestick or line chart** (Chart.js) for one selected symbol, backfilled on page load from the REST klines endpoint, then continuing live from your self-built candles.
- **Watchlist**: user can add/remove a symbol from the small fixed pool above at runtime; this should actually trigger subscribe/unsubscribe messages over the WebSocket, not just hide/show UI elements.
- **Simple price alert**: user sets a threshold price for a symbol; when a tick crosses it, show a visible in-page notification. This is a hub *consumer* — it should subscribe to the hub the same way the UI ticker does, not be wired directly into the feed handler.
- **Reconnect with exponential backoff + jitter** on the Binance connection, with visible console logging of each retry attempt and delay.

## Explicitly out of scope (do not build unless asked)

- No real order execution, no trading logic, no money movement of any kind.
- No second data source / multi-provider normalization yet (mentioned in earlier discussion, but skip it for this pass — single source only).
- No order book depth (Level 2) — best bid/ask (Level 1) only.
- No database/persistence, no auth/login.
- No circuit breaker, no token-bucket rate limiter, no backpressure handling — these are real concepts but add complexity without much learning value at this stage.
- No VWAP or other derived analytics beyond the OHLCV candles.

If a feature isn't listed above, treat it as not in scope for now and ask before adding it.

## Build phases

**Phase 0 — Scaffolding**
Set up the Node/Express project, `package.json`, basic folder structure (`/server`, `/public`), install `ws`, confirm a bare Express server runs and serves a static placeholder HTML page.

**Phase 1 — Feed handler**
Connect to the Binance combined WebSocket stream for the configured symbols, log raw incoming messages to console, confirm trades and bookTicker data are arriving. Add reconnect-with-backoff logic and prove it works (kill the connection deliberately and watch it recover).

**Phase 2 — Normalizer + hub**
Build the normalizer converting raw messages into the internal schema, and the in-memory hub holding current state per symbol with subscribe/unsubscribe support. Add a simple internal test (e.g. a console-logging subscriber) to confirm the hub pushes updates correctly.

**Phase 3 — Frontend WebSocket distribution**
Build the app's own WebSocket server, connect the browser to it, implement subscribe/unsubscribe messages from client to server, and get a live price ticker on the page updating in real time with throttled rendering.

**Phase 4 — Candle aggregation + chart**
Build the 1-minute OHLCV aggregator from the trade stream, wire it into the hub as another piece of normalized state, backfill chart history via REST klines on load, and render the live candlestick/line chart.

**Phase 5 — Watchlist + alerts**
Add the watchlist UI (add/remove symbols, driving real subscribe/unsubscribe calls) and the price alert feature as a hub consumer.

**Phase 6 — Staleness & polish**
Add the live/reconnecting/stale status indicator, tidy up the UI layout, and do a final pass checking that no component talks directly to Binance except the feed handler.

## Working notes for Claude Code

- After each phase, run the server yourself and verify it actually works (check console output, confirm the WebSocket connects, confirm data flows) before declaring the phase done.
- Keep the four layers in separate files/modules — don't let normalization logic creep into the feed handler, and don't let the frontend WebSocket server touch raw Binance messages directly.
- Comment each module briefly with which architectural layer it represents and why, so the code itself reinforces the vocabulary.
- If something in Binance's API doesn't behave as documented here, check current docs rather than guessing.
