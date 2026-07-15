// ---------------------------------------------------------------------------
// Feed handler (INGESTION layer)
//
// One module per upstream source — here, Binance's combined public WebSocket
// stream. This layer owns the RAW connection and nothing else: it connects,
// subscribes (by encoding the stream names in the URL), parses each frame just
// enough to split it into { stream, data }, watches for a dead connection, and
// reconnects with exponential backoff + jitter.
//
// It knows NOTHING about how the data will be normalized or displayed. It only
// emits raw events; downstream layers (normalizer -> hub -> distribution) are
// the ones that give the data meaning. Keeping that boundary is the whole point
// of calling this a "hub" instead of a relay.
//
// Events emitted:
//   'raw'          ({ stream, data })   one parsed combined-stream message
//   'open'                              upstream socket connected
//   'reconnecting' ({ attempt, delay }) a reconnect has been scheduled
//   'stale'        ({ silentMs })       no data for too long; forcing reconnect
//   'close'        ({ code, reason })   upstream socket closed
//   'error'        (Error)              socket or parse error (non-fatal)
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import config from './config.js';

export class BinanceFeedHandler extends EventEmitter {
  /**
   * @param {object}   [opts]
   * @param {string[]} [opts.symbols]          symbols to subscribe to (default: config.symbols)
   * @param {number}   [opts.baseDelayMs]      first backoff delay (default 1000)
   * @param {number}   [opts.maxDelayMs]       backoff cap (default 30000)
   * @param {number}   [opts.stalenessMs]      silence before we force a reconnect (default 15000)
   */
  constructor(opts = {}) {
    super();
    this.symbols = opts.symbols || config.symbols;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.maxDelayMs = opts.maxDelayMs ?? 30000;
    this.stalenessMs = opts.stalenessMs ?? 15000;

    this.ws = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.stalenessTimer = null;
    this.lastMessageAt = 0;
    this.stopped = false; // set by stop(); prevents auto-reconnect on intentional close
  }

  // Build the combined-stream URL. Binance wants lowercase stream names:
  //   wss://.../stream?streams=btcusdt@trade/btcusdt@bookTicker/ethusdt@trade/...
  buildUrl() {
    const streams = this.symbols
      .flatMap((sym) => {
        const s = sym.toLowerCase();
        return [`${s}@trade`, `${s}@bookTicker`];
      })
      .join('/');
    return `${config.binance.wsBase}?streams=${streams}`;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  connect() {
    const url = this.buildUrl();
    console.log(`[feed] connecting to Binance combined stream (${this.symbols.length} symbols)`);
    console.log(`[feed]   ${url}`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      // A clean connection resets the backoff and (re)arms the staleness watchdog.
      console.log('[feed] connected — upstream stream is live');
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      this.armStalenessWatchdog();
      this.emit('open');
    });

    this.ws.on('message', (buf) => {
      this.lastMessageAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch (err) {
        // Malformed frame — log and skip; never let one bad frame kill the feed.
        this.emit('error', err);
        return;
      }
      // Combined-stream frames look like { stream, data }. Anything else
      // (e.g. a subscription ack) we simply ignore at the ingestion layer.
      if (msg && msg.stream && msg.data) {
        this.emit('raw', { stream: msg.stream, data: msg.data });
      }
    });

    this.ws.on('error', (err) => {
      // 'error' is always followed by 'close', so we only LOG here and let the
      // 'close' handler own the reconnect scheduling (avoids double reconnects).
      console.error(`[feed] socket error: ${err.message}`);
      this.emit('error', err);
    });

    this.ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : '';
      this.clearStalenessWatchdog();
      console.warn(`[feed] connection closed (code=${code}${reason ? `, reason="${reason}"` : ''})`);
      this.emit('close', { code, reason });
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  // --- Staleness / heartbeat -------------------------------------------------
  // The socket can stay "open" while data silently stops (a half-open TCP
  // connection). For liquid symbols, trades arrive many times per second, so a
  // multi-second silence means the feed is effectively dead even though `ws`
  // hasn't fired 'close'. We force a reconnect rather than trust "connected".
  armStalenessWatchdog() {
    this.clearStalenessWatchdog();
    this.stalenessTimer = setInterval(() => {
      const silentMs = Date.now() - this.lastMessageAt;
      if (silentMs > this.stalenessMs) {
        console.warn(`[feed] STALE — no data for ${silentMs}ms (> ${this.stalenessMs}ms); forcing reconnect`);
        this.emit('stale', { silentMs });
        // terminate() (not close()) drops it immediately and triggers 'close',
        // which schedules the backoff reconnect.
        if (this.ws) this.ws.terminate();
      }
    }, Math.max(1000, Math.floor(this.stalenessMs / 3)));
  }

  clearStalenessWatchdog() {
    if (this.stalenessTimer) {
      clearInterval(this.stalenessTimer);
      this.stalenessTimer = null;
    }
  }

  // --- Reconnect with exponential backoff + jitter ---------------------------
  scheduleReconnect() {
    if (this.reconnectTimer) return; // a reconnect is already pending
    this.reconnectAttempts += 1;

    // Exponential: base * 2^(n-1), capped. Then FULL JITTER: pick a random
    // delay in [0, cappedExp] so many clients don't all retry in lockstep
    // (the "thundering herd" problem).
    const cappedExp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (this.reconnectAttempts - 1));
    const delay = Math.round(Math.random() * cappedExp);

    console.warn(
      `[feed] reconnect attempt #${this.reconnectAttempts} scheduled in ${delay}ms ` +
        `(backoff window 0–${cappedExp}ms)`
    );
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // --- Test hook -------------------------------------------------------------
  // Deliberately drop the live connection to exercise the reconnect path
  // ("kill the connection and watch it recover" from the Phase 1 brief).
  simulateDrop() {
    console.log('[feed] (test) forcing a connection drop to exercise reconnect logic');
    if (this.ws) this.ws.terminate();
  }

  // --- Clean shutdown --------------------------------------------------------
  stop() {
    this.stopped = true;
    this.clearStalenessWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
    console.log('[feed] stopped');
  }
}
