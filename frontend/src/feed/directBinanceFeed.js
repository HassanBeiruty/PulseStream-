// ---------------------------------------------------------------------------
// Direct Binance adapter (DataFeed port -> Binance public streams, in-browser)
//
// On Vercel the app is a STATIC deploy: there is no long-running Node process,
// so our distribution server cannot run there. This adapter fulfils the same
// DataFeed port as HubSocketFeed, but runs the whole pipeline client-side:
//
//   browser feed handler -> shared normalizer -> shared candle aggregator
//     -> shared Hub -> throttled flush -> port events
//
// Every processing stage is imported from /shared — the EXACT modules the
// Node server runs in hub mode. The only code unique to this file is the
// browser-flavored feed handler (the browser WebSocket API differs enough
// from the `ws` package that sharing it isn't worth the abstraction yet).
//
// Only active when the app is built with VITE_DATA_MODE=direct (see index.js).
// ---------------------------------------------------------------------------

import { Emitter } from '../../../shared/emitter.js';
import { normalize } from '../../../shared/normalizer.js';
import { CandleAggregator } from '../../../shared/candleAggregator.js';
import { VwapCalculator } from '../../../shared/analytics.js';
import { Hub } from '../../../shared/hub.js';
import { AlertBook } from '../../../shared/alertBook.js';
import { OrderBookManager } from '../../../shared/orderBook.js';
import { THROTTLE_MS } from '../../../shared/protocol.js';

// Binance's dedicated public market-data endpoints — no API key, CORS-enabled,
// recommended by Binance docs for browser/market-data-only consumers.
export const BINANCE_REST_BASE = 'https://data-api.binance.vision/api/v3';
const BINANCE_WS_BASE = 'wss://data-stream.binance.vision/stream';

const STALE_AFTER_MS = 10000; // no upstream data for >10s => stale
const STALE_CHECK_MS = 2000;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

export class DirectBinanceFeed {
  /**
   * @param {string[]} symbols - the full symbol pool to ingest
   */
  constructor(symbols) {
    this.symbols = symbols.map((s) => s.toUpperCase());
    this.emitter = new Emitter();

    // The same layer objects the server wires up in server/index.js
    this.hub = new Hub(this.symbols);
    this.candleAggregator = new CandleAggregator();
    this.vwap = new VwapCalculator();
    this.alerts = new AlertBook();

    // L2 order books: same shared sync engine as the server, browser fetch
    this.pendingBooks = new Map(); // symbol -> latest book view since last flush
    this.bookManager = new OrderBookManager({
      fetchSnapshot: async (symbol) => {
        const res = await fetch(`${BINANCE_REST_BASE}/depth?symbol=${symbol}&limit=100`);
        if (!res.ok) throw new Error(`depth snapshot returned ${res.status}`);
        return res.json();
      },
      onBook: (view) => {
        if (this.hubSubscriptions.has(view.symbol)) {
          this.pendingBooks.set(view.symbol, view);
        }
      },
    });

    // Per-consumer state (this adapter IS the "client connection")
    this.hubSubscriptions = new Map(); // symbol -> hub unsubscribe fn
    this.pendingUpdates = new Map(); // symbol -> latest record since last flush

    // Feed-handler state
    this.upstream = null;
    this.upstreamStatus = 'connecting';
    this.lastMessageAt = 0;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.flushInterval = null;
    this.staleInterval = null;
    this.opened = false;
    this.closedByClient = false;

    // Telemetry (Phase 10): per-second counters emitted as 'metrics' events
    this.metrics = { upstream: 0, emitted: 0, conflated: 0, reconnects: 0, startedAt: Date.now() };
    this.metricsInterval = null;
  }

  // --- lifecycle -------------------------------------------------------------

  connect() {
    // Throttled flush: one UPDATE per symbol per interval, like the server
    this.flushInterval = setInterval(() => this.flush(), THROTTLE_MS);

    // Telemetry heartbeat: publish and reset the per-second counters
    this.metricsInterval = setInterval(() => {
      const m = this.metrics;
      this.emitter.emit('metrics', {
        runtime: typeof window === 'undefined' ? 'worker' : 'main-thread',
        mode: 'direct',
        upstreamPerSec: m.upstream,
        emittedPerSec: m.emitted,
        conflatedPerSec: m.conflated,
        reconnects: m.reconnects,
        startedAt: m.startedAt,
      });
      m.upstream = 0;
      m.emitted = 0;
      m.conflated = 0;
    }, 1000);

    // Staleness watchdog: the socket can stay "open" while data silently
    // stops (half-open TCP — common after a backgrounded tab or network
    // blip). Freshness is what counts, not "connected" — so like the server's
    // feed handler, we don't just REPORT stale, we force a reconnect: close()
    // fires onclose, which schedules the backoff reconnect. Without this the
    // page freezes until a manual refresh.
    this.staleInterval = setInterval(() => {
      if (
        this.upstream &&
        this.upstream.readyState === WebSocket.OPEN &&
        this.lastMessageAt > 0 &&
        Date.now() - this.lastMessageAt > STALE_AFTER_MS &&
        this.upstreamStatus !== 'stale'
      ) {
        this.setUpstreamStatus('stale');
        console.warn('[direct-feed] STALE — no data for >10s; forcing reconnect');
        try {
          this.upstream.close();
        } catch {
          /* already closing */
        }
      }
    }, STALE_CHECK_MS);

    this.connectUpstream();
  }

  close() {
    this.closedByClient = true;
    clearInterval(this.flushInterval);
    clearInterval(this.staleInterval);
    clearInterval(this.metricsInterval);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.upstream) {
      try {
        this.upstream.close();
      } catch {
        /* already closed */
      }
    }
    for (const unsubscribe of this.hubSubscriptions.values()) unsubscribe();
    this.hubSubscriptions.clear();
    this.pendingUpdates.clear();

    // Real sockets fire their close event asynchronously after close(); the
    // port mirrors that so consumers can rely on one ordering in both modes.
    const wasOpen = this.opened;
    this.opened = false;
    setTimeout(() => {
      if (wasOpen) this.emitter.emit('close');
    }, 0);
  }

  isOpen() {
    return this.opened && !this.closedByClient;
  }

  on(event, callback) {
    return this.emitter.on(event, callback);
  }

  // --- feed handler: raw Binance connection with reconnect + backoff ---------

  connectUpstream() {
    // Subscribe to the whole pool up front (trade + bookTicker per symbol) and
    // filter per-consumer downstream — exactly how the server's feed handler
    // ingests everything while the hub filters per subscriber.
    const streams = this.symbols
      .flatMap((s) => [
        `${s.toLowerCase()}@trade`,
        `${s.toLowerCase()}@bookTicker`,
        `${s.toLowerCase()}@miniTicker`,
        `${s.toLowerCase()}@depth`,
      ])
      .join('/');

    const ws = new WebSocket(`${BINANCE_WS_BASE}?streams=${streams}`);
    this.upstream = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();

      if (!this.opened) {
        // First successful upstream connection: report "open" through the
        // port, which prompts the app to send its subscriptions.
        this.opened = true;
        this.emitter.emit('open');
      }
      this.setUpstreamStatus('live');
    };

    ws.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      this.metrics.upstream += 1;
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
      this.scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('[direct-feed] Binance stream error', err);
      this.emitter.emit('error', err);
    };
  }

  // Exponential backoff with FULL jitter — the same policy as the server's
  // feed handler, so both modes teach the same reconnect vocabulary.
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    this.metrics.reconnects += 1;

    const cappedExp = Math.min(
      MAX_RECONNECT_DELAY_MS,
      BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1)
    );
    const delay = Math.round(Math.random() * cappedExp);

    console.warn(
      `[direct-feed] Binance stream closed; reconnect attempt #${this.reconnectAttempts} in ${delay}ms ` +
        `(backoff window 0–${cappedExp}ms)`
    );
    this.setUpstreamStatus('reconnecting', {
      attempt: this.reconnectAttempts,
      delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectUpstream();
    }, delay);
  }

  setUpstreamStatus(status, extra = {}) {
    this.upstreamStatus = status;
    if (this.opened) {
      this.emitter.emit('feedStatus', { status, ...extra });
    }
  }

  // --- pipeline: normalizer -> candle aggregator -> hub ----------------------

  ingest(stream, data) {
    // @depth diffs bypass the normalizer: they feed the order-book engine raw
    if (stream.endsWith('@depth')) {
      if (data && data.s) this.bookManager.handleDiff(data.s, data);
      return;
    }

    const update = normalize(stream, data);
    if (!update) return;

    // Only @trade updates carry a `quantity`. The resulting 1m candle and
    // session VWAP ride along on the same update — mirroring server/index.js.
    if (update.quantity !== undefined) {
      const activeCandle = this.candleAggregator.update(update);
      if (activeCandle) {
        update.activeCandle = activeCandle;
      }
      const sessionVwap = this.vwap.update(update);
      if (sessionVwap !== null) {
        update.sessionVwap = sessionVwap;
      }
    }
    this.hub.update(update); // hub notifies this adapter's subscriptions below
  }

  flush() {
    if (this.pendingUpdates.size > 0) {
      for (const record of this.pendingUpdates.values()) {
        this.emitter.emit('update', record);
        this.metrics.emitted += 1;
      }
      this.pendingUpdates.clear();
    }
    if (this.pendingBooks.size > 0) {
      for (const view of this.pendingBooks.values()) {
        this.emitter.emit('book', view);
        this.metrics.emitted += 1;
      }
      this.pendingBooks.clear();
    }
  }

  // --- port methods (mirror the server's per-client handler) -----------------

  subscribe(symbol) {
    const sym = (symbol || '').toUpperCase();
    if (!sym || this.hubSubscriptions.has(sym)) return;

    // Subscribe to Hub updates. Updates buffer for the throttled flush;
    // alert triggers bypass the throttle — same policy as the server.
    const unsubscribe = this.hub.subscribe(sym, (record) => {
      // Conflation: overwriting an unsent pending record = one dropped
      // intermediate update (the telemetry HUD counts these)
      if (this.pendingUpdates.has(sym)) this.metrics.conflated += 1;
      this.pendingUpdates.set(sym, record);

      for (const hit of this.alerts.evaluate(sym, record.lastPrice)) {
        this.emitter.emit('alertTriggered', {
          id: hit.id,
          symbol: hit.symbol,
          price: hit.price,
          value: hit.value,
          condition: hit.condition,
        });
      }
    });
    this.hubSubscriptions.set(sym, unsubscribe);

    // Send the current golden record immediately, matching the server's
    // behaviour on SUBSCRIBE.
    const initialRecord = this.hub.getGoldenRecord(sym);
    if (initialRecord) {
      this.emitter.emit('update', initialRecord);
    }
    // And the current L2 book, if its engine is already synced
    const book = this.bookManager.books.get(sym);
    if (book && book.synced) {
      this.bookManager.publish(book);
    }
  }

  unsubscribe(symbol) {
    const sym = (symbol || '').toUpperCase();
    const unsubscribe = this.hubSubscriptions.get(sym);
    if (!unsubscribe) return;
    unsubscribe();
    this.hubSubscriptions.delete(sym);
    this.pendingUpdates.delete(sym);
    this.pendingBooks.delete(sym);
    this.alerts.removeForSymbol(sym);
  }

  setAlert({ id, symbol, value, condition }) {
    const alert = this.alerts.set({ id, symbol, value, condition });
    if (alert) {
      this.emitter.emit('alertConfirmed', alert);
    }
  }

  removeAlert(id) {
    const removed = this.alerts.remove(id);
    if (removed) {
      this.emitter.emit('alertRemoved', { id });
    }
  }
}
