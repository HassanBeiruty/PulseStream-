// ---------------------------------------------------------------------------
// Distribution layer — entry point (Phase 3 WebSocket relay)
//
// This file hosts our Express + WebSocket server. On startup it wires the
// upstream pipeline together in order:
//
//   Feed Handler -> Normalizer -> Candle Aggregator (trades only) -> Hub
//
// The normalizer, candle aggregator, hub, alert book and wire-protocol
// constants all come from /shared (Phase 7): the exact same modules the
// browser runs in direct mode, so the two modes cannot drift apart.
//
// When clients connect to our own WebSocket server, they send
// SUBSCRIBE/UNSUBSCRIBE events. The server registers them to the in-memory Hub
// and relays updates, throttled to THROTTLE_MS.
// ---------------------------------------------------------------------------

import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';

import config from './config.js';
import { BinanceFeedHandler } from './feedHandler.js';
import { normalize } from '../shared/normalizer.js';
import { Hub } from '../shared/hub.js';
import { CandleAggregator } from '../shared/candleAggregator.js';
import { AlertBook } from '../shared/alertBook.js';
import { klinesToCandles } from '../shared/klines.js';
import { ClientMsg, ServerMsg, THROTTLE_MS } from '../shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve the built frontend.
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Lightweight health check — includes current golden records from Hub
const hub = new Hub(config.symbols);
const candleAggregator = new CandleAggregator();

app.get('/health', (req, res) => {
  const records = {};
  for (const sym of config.symbols) {
    records[sym] = hub.getGoldenRecord(sym);
  }
  res.json({ status: 'ok', symbols: config.symbols, records });
});

// REST endpoint to fetch 100 historical 1m klines/candles for chart backfill
app.get('/api/history', async (req, res) => {
  const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();

  // Validation: ensure the requested symbol is configured
  if (!config.symbols.includes(symbol)) {
    return res.status(400).json({ error: `Invalid symbol. Configured symbols are: ${config.symbols.join(', ')}` });
  }

  const url = `${config.binance.restBase}/klines?symbol=${symbol}&interval=1m&limit=100`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Binance API returned status ${response.status}`);
    }
    const data = await response.json();

    // Convert Binance's positional kline arrays to our candle format
    res.json({ symbol, candles: klinesToCandles(data) });
  } catch (err) {
    console.error(`[server] Error fetching history for ${symbol}:`, err.message);
    res.status(500).json({ error: 'Failed to fetch historical market data' });
  }
});

// Initialize and start the upstream Binance Feed Handler
const feed = new BinanceFeedHandler();

// Connect Feed Handler -> Normalizer -> Candle Aggregator -> Hub
feed.on('raw', ({ stream, data }) => {
  const update = normalize(stream, data);
  if (update) {
    // Only @trade updates carry a `quantity`; @bookTicker updates don't. So the
    // presence of `quantity` is how we tell "this is a trade" and feed it to the
    // candle aggregator. The resulting 1m candle rides along on the same update.
    if (update.quantity !== undefined) {
      const activeCandle = candleAggregator.update(update);
      if (activeCandle) {
        update.activeCandle = activeCandle;
      }
    }
    hub.update(update);
  }
});

let upstreamStatus = 'connecting';

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

feed.on('open', () => {
  console.log('[feed] connected to Binance stream');
  upstreamStatus = 'live';
  broadcast({ type: ServerMsg.FEED_STATUS, status: 'live' });
});

feed.on('reconnecting', ({ attempt, delay }) => {
  console.log(`[feed] reconnecting attempt #${attempt} in ${delay}ms`);
  upstreamStatus = 'reconnecting';
  broadcast({ type: ServerMsg.FEED_STATUS, status: 'reconnecting', attempt, delay });
});

feed.on('stale', ({ silentMs }) => {
  console.warn(`[feed] stream stale! No data for ${silentMs}ms`);
  upstreamStatus = 'stale';
  broadcast({ type: ServerMsg.FEED_STATUS, status: 'stale' });
});

feed.on('close', ({ code }) => {
  console.warn(`[feed] stream closed (code=${code})`);
  upstreamStatus = 'reconnecting';
  broadcast({ type: ServerMsg.FEED_STATUS, status: 'reconnecting' });
});

// Start the ingestion layer
feed.start();

// Handle client WebSocket connections (Distribution Layer)
wss.on('connection', (ws) => {
  console.log('[ws-server] Client connected to distribution feed');

  const send = (msg) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  // Send current upstream feed status immediately upon connection
  send({ type: ServerMsg.FEED_STATUS, status: upstreamStatus });

  // Track active symbol subscriptions for this client: Map<string, Function>
  const clientSubscriptions = new Map();
  // Buffer the latest updates to send during the next throttle flush: Map<string, object>
  const pendingUpdates = new Map();
  // Price alerts registered by this client connection (shared AlertBook —
  // identical semantics to the direct-mode adapter, because it IS the same code)
  const alerts = new AlertBook();

  // Setup throttled flush interval for this client
  const flushInterval = setInterval(() => {
    if (pendingUpdates.size > 0) {
      // One UPDATE per symbol that ticked since the last flush (we only kept the
      // latest record per symbol, so fast upstream ticks collapse into one send).
      for (const record of pendingUpdates.values()) {
        send({ type: ServerMsg.UPDATE, data: record });
      }
      pendingUpdates.clear();
    }
  }, THROTTLE_MS);

  // Handle messages from client
  ws.on('message', (messageBuf) => {
    let msg;
    try {
      msg = JSON.parse(messageBuf.toString());
    } catch (err) {
      console.error('[ws-server] malformed client message:', err.message);
      return;
    }

    if (!msg || !msg.type) return;

    const type = msg.type.toUpperCase();

    // REMOVE_ALERT does not require a symbol, check it first
    if (type === ClientMsg.REMOVE_ALERT) {
      const removed = alerts.remove(msg.id);
      if (removed) {
        console.log(`[ws-server] Alert removed: ${removed.symbol} ${removed.condition} ${removed.value}`);
        send({ type: ServerMsg.ALERT_REMOVED, data: { id: msg.id } });
      }
      return;
    }

    const symbol = (msg.symbol || '').toUpperCase();
    if (!symbol) return;

    if (type === ClientMsg.SUBSCRIBE) {
      if (clientSubscriptions.has(symbol)) return; // Already subscribed

      console.log(`[ws-server] Client subscribed to: ${symbol}`);

      // Subscribe to Hub updates for this symbol. Updates are buffered for the
      // throttled flush; alert triggers bypass the throttle and send at once.
      const unsubscribe = hub.subscribe(symbol, (record) => {
        pendingUpdates.set(symbol, record);

        for (const hit of alerts.evaluate(symbol, record.lastPrice)) {
          console.log(`[ws-server] Alert TRIGGERED: ${symbol} price ${hit.price} is ${hit.condition} ${hit.value}`);
          send({
            type: ServerMsg.ALERT_TRIGGERED,
            data: {
              id: hit.id,
              symbol: hit.symbol,
              price: hit.price,
              value: hit.value,
              condition: hit.condition,
            },
          });
        }
      });

      clientSubscriptions.set(symbol, unsubscribe);

      // Send the current golden record state immediately if we have it
      const initialRecord = hub.getGoldenRecord(symbol);
      if (initialRecord) {
        send({ type: ServerMsg.UPDATE, data: initialRecord });
      }
    } else if (type === ClientMsg.UNSUBSCRIBE) {
      const unsubscribe = clientSubscriptions.get(symbol);
      if (unsubscribe) {
        console.log(`[ws-server] Client unsubscribed from: ${symbol}`);
        unsubscribe();
        clientSubscriptions.delete(symbol);
        pendingUpdates.delete(symbol);

        // Cancel alerts for this symbol when unsubscribed from watchlist
        alerts.removeForSymbol(symbol);
      }
    } else if (type === ClientMsg.SET_ALERT) {
      const alert = alerts.set({
        id: msg.id,
        symbol,
        value: msg.value,
        condition: msg.condition,
      });
      if (!alert) return;

      console.log(`[ws-server] Alert registered: ${alert.symbol} ${alert.condition} ${alert.value}`);
      send({ type: ServerMsg.ALERT_CONFIRMED, data: alert });
    }
  });

  // Client disconnected cleanup
  ws.on('close', () => {
    console.log('[ws-server] Client disconnected, clearing subscriptions and alerts');
    clearInterval(flushInterval);
    for (const unsubscribe of clientSubscriptions.values()) {
      unsubscribe();
    }
    clientSubscriptions.clear();
    pendingUpdates.clear();
  });

  ws.on('error', (err) => {
    console.error(`[ws-server] client socket error: ${err.message}`);
  });
});

// Start our combined HTTP + WS server
server.listen(config.port, () => {
  console.log(`[server] Live Market Data Hub running at http://localhost:${config.port}`);
  console.log(`[server] Static files served from ${publicDir}`);
});
