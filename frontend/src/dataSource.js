// ---------------------------------------------------------------------------
// Data source selector
//
// The app has two ways of getting market data, chosen at BUILD time:
//
//   1. Server mode (default, local dev): talk to our own Express + WebSocket
//      distribution server — the full 4-layer hub architecture.
//   2. Direct mode (VITE_DATA_MODE=direct, used for the static Vercel deploy):
//      no backend exists, so the browser talks to Binance's public
//      market-data endpoints directly via DirectFeedSocket, which emulates
//      the distribution server's protocol client-side.
//
// App.jsx only ever calls these three helpers, so it doesn't know or care
// which mode it's running in.
// ---------------------------------------------------------------------------

import { DirectFeedSocket, SYMBOLS, BINANCE_REST_BASE } from './directFeed';

export const DIRECT_MODE = import.meta.env.VITE_DATA_MODE === 'direct';

// Replaces GET /health — returns the configured symbol pool
export function fetchHealth() {
  if (DIRECT_MODE) {
    return Promise.resolve({ status: 'ok', symbols: SYMBOLS });
  }
  return fetch('/health').then((res) => res.json());
}

// Replaces GET /api/history — 100 recent 1m candles for chart backfill.
// Direct mode does the same Binance klines call and format conversion the
// server does in server/index.js.
export function fetchHistory(symbol) {
  if (!DIRECT_MODE) {
    return fetch(`/api/history?symbol=${symbol}`).then((res) => res.json());
  }
  const upper = symbol.toUpperCase();
  const url = `${BINANCE_REST_BASE}/klines?symbol=${upper}&interval=1m&limit=100`;
  return fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`Binance API returned status ${res.status}`);
      return res.json();
    })
    .then((data) => ({
      symbol: upper,
      candles: data.map((kline) => ({
        timestamp: kline[0],
        open: parseFloat(kline[1]),
        high: parseFloat(kline[2]),
        low: parseFloat(kline[3]),
        close: parseFloat(kline[4]),
        volume: parseFloat(kline[5]),
      })),
    }));
}

// Replaces `new WebSocket(...)` — returns something that behaves like a
// WebSocket speaking the distribution server's protocol.
export function createSocket() {
  if (DIRECT_MODE) {
    return new DirectFeedSocket();
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host =
    window.location.hostname === 'localhost' ? 'localhost:3000' : window.location.host;
  return new WebSocket(`${protocol}//${host}`);
}

// Human-readable description of where createSocket() will connect, for logs
export function socketTargetLabel() {
  if (DIRECT_MODE) {
    return 'Binance public stream (direct mode — no backend)';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host =
    window.location.hostname === 'localhost' ? 'localhost:3000' : window.location.host;
  return `${protocol}//${host}`;
}
