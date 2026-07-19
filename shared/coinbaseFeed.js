// ---------------------------------------------------------------------------
// Coinbase venue feed (Phase 13 — SHARED, isomorphic via global WebSocket)
//
// A second upstream source, proving the normalization layer's whole reason to
// exist: a completely different exchange protocol (subscribe message instead
// of URL streams, "BTC-USD" instead of "BTCUSDT", per-message `type` field)
// lands in the SAME internal record shape, tagged source: 'coinbase'.
//
// Uses the global WebSocket API — available in every browser AND Node >= 22 —
// so one class serves both runtimes. Cross-venue caveat: Coinbase quotes
// against USD while Binance quotes against USDT, so the displayed arbitrage
// spread includes the USDT/USD basis — a real subtlety worth knowing.
//
// Emits (via callbacks): onUpdate(record), onStatus(status)
// Same resilience patterns as the Binance handlers: exponential backoff with
// full jitter, staleness watchdog, per-symbol throttled flush.
// ---------------------------------------------------------------------------

import { Emitter } from './emitter.js';

const COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com';

// Internal symbol -> Coinbase product id. PAXG is not listed on Coinbase —
// the cross-venue panel shows it as unavailable.
export const COINBASE_PRODUCTS = {
  BTCUSDT: 'BTC-USD',
  ETHUSDT: 'ETH-USD',
};

/** Coinbase 'ticker' frame -> internal venue record (pure; unit-tested). */
export function normalizeCoinbaseTicker(msg) {
  if (!msg || msg.type !== 'ticker' || typeof msg.product_id !== 'string') return null;
  const symbol = Object.keys(COINBASE_PRODUCTS).find(
    (sym) => COINBASE_PRODUCTS[sym] === msg.product_id
  );
  if (!symbol) return null;
  const lastPrice = parseFloat(msg.price);
  const bestBid = parseFloat(msg.best_bid);
  const bestAsk = parseFloat(msg.best_ask);
  if (Number.isNaN(lastPrice)) return null;
  return {
    symbol,
    venue: 'coinbase',
    lastPrice,
    bestBid: Number.isNaN(bestBid) ? null : bestBid,
    bestAsk: Number.isNaN(bestAsk) ? null : bestAsk,
    lastTradeTime: msg.time ? Date.parse(msg.time) : null,
    source: 'coinbase',
  };
}

export class CoinbaseFeed {
  /** @param {string[]} symbols - internal symbols; unlisted ones are skipped */
  constructor(symbols) {
    this.products = symbols
      .map((s) => COINBASE_PRODUCTS[s.toUpperCase()])
      .filter(Boolean);
    this.emitter = new Emitter();
    this.ws = null;
    this.pending = new Map(); // symbol -> latest record since last flush
    this.flushInterval = null;
    this.staleInterval = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.lastMessageAt = 0;
    this.closed = false;
  }

  on(event, callback) {
    return this.emitter.on(event, callback);
  }

  connect() {
    if (this.products.length === 0) return;
    this.flushInterval = setInterval(() => {
      for (const record of this.pending.values()) {
        this.emitter.emit('update', record);
      }
      this.pending.clear();
    }, 500);

    this.staleInterval = setInterval(() => {
      if (
        this.ws &&
        this.ws.readyState === WebSocket.OPEN &&
        this.lastMessageAt > 0 &&
        Date.now() - this.lastMessageAt > 30000
      ) {
        console.warn('[coinbase-feed] stale >30s; forcing reconnect');
        try {
          this.ws.close();
        } catch {
          /* already closing */
        }
      }
    }, 5000);

    this.connectUpstream();
  }

  connectUpstream() {
    const ws = new WebSocket(COINBASE_WS);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      // Coinbase subscribes via a MESSAGE, not the URL — a protocol
      // difference the normalizer hides from everything downstream
      ws.send(
        JSON.stringify({ type: 'subscribe', channels: [{ name: 'ticker', product_ids: this.products }] })
      );
      this.emitter.emit('status', 'live');
    };

    ws.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const record = normalizeCoinbaseTicker(msg);
      if (record) this.pending.set(record.symbol, record);
    };

    ws.onclose = () => {
      if (this.closed) return;
      this.reconnectAttempts += 1;
      const cappedExp = Math.min(30000, 1000 * 2 ** (this.reconnectAttempts - 1));
      const delay = Math.round(Math.random() * cappedExp);
      console.warn(`[coinbase-feed] closed; reconnect #${this.reconnectAttempts} in ${delay}ms`);
      this.emitter.emit('status', 'reconnecting');
      this.reconnectTimer = setTimeout(() => this.connectUpstream(), delay);
    };

    ws.onerror = () => {
      /* onclose owns reconnection */
    };
  }

  close() {
    this.closed = true;
    clearInterval(this.flushInterval);
    clearInterval(this.staleInterval);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
    }
  }
}
