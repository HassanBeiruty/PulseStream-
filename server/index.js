// ---------------------------------------------------------------------------
// Distribution layer — entry point (Phase 3 WebSocket relay)
//
// This file hosts our Express + WebSocket server. On startup it wires the
// upstream pipeline together in order:
//
//   Feed Handler -> Normalizer -> Candle Aggregator (trades only) -> Hub
//
// When clients connect to our own WebSocket server, they send
// SUBSCRIBE/UNSUBSCRIBE events. The server registers them to the in-memory Hub
// and relays updates, throttled to 300ms.
// ---------------------------------------------------------------------------

const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');

const config = require('./config');
const { BinanceFeedHandler } = require('./feedHandler');
const { normalize } = require('./normalizer');
const Hub = require('./hub');
const CandleAggregator = require('./candleAggregator');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve the self-contained vanilla-JS frontend.
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Lightweight health check — includes current golden records from Hub
const hub = new Hub();
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
    
    // Convert Binance format to our normalized candle format
    const candles = data.map(kline => ({
      timestamp: kline[0],
      open: parseFloat(kline[1]),
      high: parseFloat(kline[2]),
      low: parseFloat(kline[3]),
      close: parseFloat(kline[4]),
      volume: parseFloat(kline[5])
    }));

    res.json({ symbol, candles });
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
  broadcast({ type: 'FEED_STATUS', status: 'live' });
});

feed.on('reconnecting', ({ attempt, delay }) => {
  console.log(`[feed] reconnecting attempt #${attempt} in ${delay}ms`);
  upstreamStatus = 'reconnecting';
  broadcast({ type: 'FEED_STATUS', status: 'reconnecting', attempt, delay });
});

feed.on('stale', ({ silentMs }) => {
  console.warn(`[feed] stream stale! No data for ${silentMs}ms`);
  upstreamStatus = 'stale';
  broadcast({ type: 'FEED_STATUS', status: 'stale' });
});

feed.on('close', ({ code, reason }) => {
  console.warn(`[feed] stream closed (code=${code})`);
  upstreamStatus = 'reconnecting';
  broadcast({ type: 'FEED_STATUS', status: 'reconnecting' });
});

// Start the ingestion layer
feed.start();

// Handle client WebSocket connections (Distribution Layer)
wss.on('connection', (ws) => {
  console.log('[ws-server] Client connected to distribution feed');
  
  // Send current upstream feed status immediately upon connection
  ws.send(JSON.stringify({ type: 'FEED_STATUS', status: upstreamStatus }));

  // Track active symbol subscriptions for this client: Map<string, Function>
  const clientSubscriptions = new Map();
  // Buffer the latest updates to send during the next throttle flush: Map<string, object>
  const pendingUpdates = new Map();
  // Track registered price alerts for this client connection: Array<object>
  const clientAlerts = [];

  // Setup throttled flush interval (once every 300ms) for this client
  const flushInterval = setInterval(() => {
    if (pendingUpdates.size > 0) {
      // One UPDATE per symbol that ticked since the last flush (we only kept the
      // latest record per symbol, so fast upstream ticks collapse into one send).
      for (const record of pendingUpdates.values()) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'UPDATE', data: record }));
        }
      }
      pendingUpdates.clear();
    }
  }, 300);

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
    if (type === 'REMOVE_ALERT') {
      const alertId = msg.id;
      const index = clientAlerts.findIndex((a) => a.id === alertId);
      if (index !== -1) {
        const removed = clientAlerts.splice(index, 1)[0];
        console.log(`[ws-server] Alert removed: ${removed.symbol} ${removed.condition} ${removed.value}`);
        ws.send(JSON.stringify({ type: 'ALERT_REMOVED', data: { id: alertId } }));
      }
      return;
    }

    const symbol = (msg.symbol || '').toUpperCase();
    if (!symbol) return;

    if (type === 'SUBSCRIBE') {
      if (clientSubscriptions.has(symbol)) return; // Already subscribed

      console.log(`[ws-server] Client subscribed to: ${symbol}`);

      // Subscribe to Hub updates for this symbol
      const unsubscribe = hub.subscribe(symbol, (record) => {
        pendingUpdates.set(symbol, record);

        // Check if any alerts are met for this symbol
        const price = record.lastPrice;
        if (price !== null && price !== undefined) {
          for (let i = clientAlerts.length - 1; i >= 0; i--) {
            const alert = clientAlerts[i];
            if (alert.symbol === symbol) {
              let triggered = false;
              if (alert.condition === 'ABOVE' && price >= alert.value) {
                triggered = true;
              } else if (alert.condition === 'BELOW' && price <= alert.value) {
                triggered = true;
              }

              if (triggered) {
                console.log(`[ws-server] Alert TRIGGERED: ${symbol} price ${price} is ${alert.condition} ${alert.value}`);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: 'ALERT_TRIGGERED',
                      data: {
                        id: alert.id,
                        symbol: alert.symbol,
                        price,
                        value: alert.value,
                        condition: alert.condition,
                      },
                    })
                  );
                }
                // Trigger once, then discard
                clientAlerts.splice(i, 1);
              }
            }
          }
        }
      });

      clientSubscriptions.set(symbol, unsubscribe);

      // Send the current golden record state immediately if we have it
      const initialRecord = hub.getGoldenRecord(symbol);
      if (initialRecord) {
        ws.send(JSON.stringify({ type: 'UPDATE', data: initialRecord }));
      }
    } else if (type === 'UNSUBSCRIBE') {
      const unsubscribe = clientSubscriptions.get(symbol);
      if (unsubscribe) {
        console.log(`[ws-server] Client unsubscribed from: ${symbol}`);
        unsubscribe();
        clientSubscriptions.delete(symbol);
        pendingUpdates.delete(symbol);

        // Cancel alerts for this symbol when unsubscribed from watchlist
        for (let i = clientAlerts.length - 1; i >= 0; i--) {
          if (clientAlerts[i].symbol === symbol) {
            clientAlerts.splice(i, 1);
          }
        }
      }
    } else if (type === 'SET_ALERT') {
      const value = parseFloat(msg.value);
      const condition = (msg.condition || 'ABOVE').toUpperCase();
      const alertId = msg.id || Math.random().toString(36).substring(2, 9);

      if (isNaN(value)) return;

      console.log(`[ws-server] Alert registered: ${symbol} ${condition} ${value}`);
      clientAlerts.push({ id: alertId, symbol, value, condition });

      ws.send(
        JSON.stringify({
          type: 'ALERT_CONFIRMED',
          data: { id: alertId, symbol, value, condition },
        })
      );
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
    clientAlerts.length = 0;
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

