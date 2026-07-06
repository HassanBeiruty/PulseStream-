// ---------------------------------------------------------------------------
// Direct feed adapter (STATIC-DEPLOYMENT fallback)
//
// On Vercel the app is deployed as a static site: there is no long-running
// Node process, so our Express + WebSocket distribution server
// (server/index.js) cannot run there. This class is a drop-in stand-in for the
// browser's WebSocket that speaks the exact same JSON protocol the
// distribution server speaks:
//
//   client -> "server": { type: 'SUBSCRIBE' | 'UNSUBSCRIBE', symbol }
//                       { type: 'SET_ALERT' | 'REMOVE_ALERT', ... }
//   "server" -> client: { type: 'UPDATE', data: goldenRecord }
//                       { type: 'FEED_STATUS', status }
//                       { type: 'ALERT_CONFIRMED' | 'ALERT_REMOVED' | 'ALERT_TRIGGERED', data }
//
// ...but sources everything directly from Binance's public market-data
// streams in the browser. It compresses the whole backend pipeline
// (feed handler -> normalizer -> candle aggregator -> hub -> throttled relay)
// into one client-side class, mirroring the server modules' logic.
//
// Local development still uses the real server; this file is only active when
// the app is built with VITE_DATA_MODE=direct (see dataSource.js).
// ---------------------------------------------------------------------------

// Fixed symbol pool. In server mode this comes from server/config.js via
// /health; direct mode has no server, so the pool is repeated here.
export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

// Binance's dedicated public market-data endpoints — no API key, CORS-enabled,
// recommended by Binance docs for browser/market-data-only consumers.
export const BINANCE_REST_BASE = 'https://data-api.binance.vision/api/v3';
const BINANCE_WS_BASE = 'wss://data-stream.binance.vision/stream';

const THROTTLE_MS = 300; // same per-client flush interval as server/index.js
const STALE_AFTER_MS = 10000; // no upstream data for >10s => stale
const STALE_CHECK_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30000;

export class DirectFeedSocket {
  constructor() {
    // Public WebSocket-like surface used by App.jsx
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    // Internal state — the same shapes the backend layers keep
    this.records = new Map(); // symbol -> golden record (hub)
    this.candles = new Map(); // symbol -> active 1m candle (candle aggregator)
    this.subscriptions = new Set(); // symbols this "client" subscribed to
    this.pendingUpdates = new Map(); // symbol -> latest record since last flush
    this.alerts = []; // registered price alerts
    this.upstream = null; // raw Binance WebSocket (feed handler)
    this.upstreamStatus = 'connecting';
    this.lastMessageAt = 0;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.closedByClient = false;

    // Throttled flush: one UPDATE per symbol per interval, like the server
    this.flushInterval = setInterval(() => this.flush(), THROTTLE_MS);

    // Heartbeat/staleness check, like the feed handler's
    this.staleInterval = setInterval(() => {
      if (
        this.upstream &&
        this.upstream.readyState === 1 &&
        this.lastMessageAt > 0 &&
        Date.now() - this.lastMessageAt > STALE_AFTER_MS &&
        this.upstreamStatus !== 'stale'
      ) {
        this.setUpstreamStatus('stale');
      }
    }, STALE_CHECK_MS);

    this.connectUpstream();
  }

  // --- Feed handler: raw Binance connection with reconnect + backoff --------

  connectUpstream() {
    // Subscribe to the whole pool up front (trade + bookTicker per symbol) and
    // filter per-consumer downstream — exactly how the server's feed handler
    // ingests everything while the hub filters per subscriber.
    const streams = SYMBOLS.flatMap((s) => [
      `${s.toLowerCase()}@trade`,
      `${s.toLowerCase()}@bookTicker`,
    ]).join('/');

    const ws = new WebSocket(`${BINANCE_WS_BASE}?streams=${streams}`);
    this.upstream = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();

      if (this.readyState === 0) {
        // First successful upstream connection: report "open" to the app,
        // which then sends its SUBSCRIBE messages (handled in send()).
        this.readyState = 1; // OPEN
        if (this.onopen) this.onopen();
      }
      this.setUpstreamStatus('live');
    };

    ws.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      if (this.upstreamStatus === 'stale') this.setUpstreamStatus('live');

      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      // Combined-stream payloads look like { stream, data }; anything else
      // (e.g. subscription acks) is ignored.
      if (msg && msg.stream && msg.data) {
        this.ingest(msg.stream, msg.data);
      }
    };

    ws.onclose = () => {
      if (this.closedByClient) return;
      this.reconnectAttempt += 1;
      const backoff = Math.min(
        MAX_RECONNECT_DELAY_MS,
        1000 * 2 ** (this.reconnectAttempt - 1)
      );
      const delay = Math.round(backoff / 2 + Math.random() * (backoff / 2)); // jitter
      console.warn(
        `[direct-feed] Binance stream closed; reconnect attempt #${this.reconnectAttempt} in ${delay}ms`
      );
      this.setUpstreamStatus('reconnecting');
      this.reconnectTimer = setTimeout(() => this.connectUpstream(), delay);
    };

    ws.onerror = (err) => {
      console.error('[direct-feed] Binance stream error', err);
    };
  }

  setUpstreamStatus(status) {
    this.upstreamStatus = status;
    this.emit({ type: 'FEED_STATUS', status });
  }

  // --- Normalizer + candle aggregator + hub update ---------------------------

  ingest(stream, data) {
    // Normalizer: raw Binance payload -> internal schema (see server/normalizer.js)
    const symbol = (data.s || '').toUpperCase();
    if (!symbol) return;

    let update = null;
    if (stream.endsWith('@trade')) {
      update = {
        symbol,
        lastPrice: parseFloat(data.p),
        lastTradeTime: data.T,
        quantity: parseFloat(data.q),
        source: 'binance',
      };
    } else if (stream.endsWith('@bookTicker')) {
      update = {
        symbol,
        bestBid: parseFloat(data.b),
        bestAsk: parseFloat(data.a),
        source: 'binance',
      };
    }
    if (!update) return;

    // Candle aggregator: fold trades into the active 1m OHLCV bucket
    // (see server/candleAggregator.js)
    if (update.quantity !== undefined) {
      const minuteStart = Math.floor(update.lastTradeTime / 60000) * 60000;
      let candle = this.candles.get(symbol);
      if (!candle || minuteStart > candle.timestamp) {
        candle = {
          timestamp: minuteStart,
          open: update.lastPrice,
          high: update.lastPrice,
          low: update.lastPrice,
          close: update.lastPrice,
          volume: update.quantity,
        };
      } else {
        candle.high = Math.max(candle.high, update.lastPrice);
        candle.low = Math.min(candle.low, update.lastPrice);
        candle.close = update.lastPrice;
        candle.volume += update.quantity;
      }
      this.candles.set(symbol, candle);
      update.activeCandle = { ...candle };
    }

    // Hub: merge into the symbol's golden record
    const record = { ...(this.records.get(symbol) || {}), ...update };
    this.records.set(symbol, record);

    // Distribution: buffer for the throttled flush + check alerts, but only
    // for symbols this consumer subscribed to (the hub only notifies subscribers)
    if (this.subscriptions.has(symbol)) {
      this.pendingUpdates.set(symbol, record);
      this.checkAlerts(symbol, record.lastPrice);
    }
  }

  checkAlerts(symbol, price) {
    if (price === null || price === undefined) return;
    for (let i = this.alerts.length - 1; i >= 0; i--) {
      const alert = this.alerts[i];
      if (alert.symbol !== symbol) continue;
      const triggered =
        (alert.condition === 'ABOVE' && price >= alert.value) ||
        (alert.condition === 'BELOW' && price <= alert.value);
      if (triggered) {
        this.emit({
          type: 'ALERT_TRIGGERED',
          data: {
            id: alert.id,
            symbol: alert.symbol,
            price,
            value: alert.value,
            condition: alert.condition,
          },
        });
        this.alerts.splice(i, 1); // trigger once, then discard
      }
    }
  }

  flush() {
    if (this.pendingUpdates.size === 0) return;
    for (const record of this.pendingUpdates.values()) {
      this.emit({ type: 'UPDATE', data: record });
    }
    this.pendingUpdates.clear();
  }

  // Deliver a protocol message to the app, exactly as if it arrived over a wire
  emit(msg) {
    if (this.readyState !== 1 || !this.onmessage) return;
    this.onmessage({ data: JSON.stringify(msg) });
  }

  // --- WebSocket-like client API (what App.jsx calls) ------------------------

  send(payload) {
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (!msg || !msg.type) return;

    const type = msg.type.toUpperCase();

    if (type === 'REMOVE_ALERT') {
      const index = this.alerts.findIndex((a) => a.id === msg.id);
      if (index !== -1) {
        this.alerts.splice(index, 1);
        this.emit({ type: 'ALERT_REMOVED', data: { id: msg.id } });
      }
      return;
    }

    const symbol = (msg.symbol || '').toUpperCase();
    if (!symbol) return;

    if (type === 'SUBSCRIBE') {
      if (this.subscriptions.has(symbol)) return;
      this.subscriptions.add(symbol);
      // Send the current golden record immediately if we already have one,
      // matching the server's behaviour on SUBSCRIBE
      const record = this.records.get(symbol);
      if (record) this.emit({ type: 'UPDATE', data: record });
    } else if (type === 'UNSUBSCRIBE') {
      this.subscriptions.delete(symbol);
      this.pendingUpdates.delete(symbol);
      for (let i = this.alerts.length - 1; i >= 0; i--) {
        if (this.alerts[i].symbol === symbol) this.alerts.splice(i, 1);
      }
    } else if (type === 'SET_ALERT') {
      const value = parseFloat(msg.value);
      if (isNaN(value)) return;
      const condition = (msg.condition || 'ABOVE').toUpperCase();
      const id = msg.id || Math.random().toString(36).substring(2, 9);
      this.alerts.push({ id, symbol, value, condition });
      this.emit({ type: 'ALERT_CONFIRMED', data: { id, symbol, value, condition } });
    }
  }

  close() {
    this.closedByClient = true;
    this.readyState = 3; // CLOSED
    clearInterval(this.flushInterval);
    clearInterval(this.staleInterval);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.upstream) {
      try {
        this.upstream.close();
      } catch {
        /* already closed */
      }
    }
    // Real WebSockets fire onclose asynchronously after close(); mirror that.
    setTimeout(() => {
      if (this.onclose) this.onclose();
    }, 0);
  }
}
