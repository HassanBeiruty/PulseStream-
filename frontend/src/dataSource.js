// ---------------------------------------------------------------------------
// Data source façade
//
// The single import surface App.jsx uses for market data:
//
//   - createDataFeed() / feedTargetLabel() / DIRECT_MODE  — the DataFeed port
//     and its build-time adapter selection (see feed/index.js for the port
//     definition and the two adapters).
//   - fetchHealth() / fetchHistory()                      — REST concerns.
//   - symbolLabel()                                       — presentation names.
//
// App.jsx never knows which mode it's running in; everything mode-specific is
// resolved here or in the feed adapters.
// ---------------------------------------------------------------------------

import { SYMBOLS, symbolLabel } from '../../shared/symbols.js';
import { klinesToCandles } from '../../shared/klines.js';
import { BINANCE_REST_BASE } from './feed/directBinanceFeed.js';
import { createDataFeed, feedTargetLabel, DIRECT_MODE } from './feed/index.js';

export { createDataFeed, feedTargetLabel, DIRECT_MODE, symbolLabel };

// Replaces GET /health — returns the configured symbol pool
export function fetchHealth() {
  if (DIRECT_MODE) {
    return Promise.resolve({ status: 'ok', symbols: SYMBOLS });
  }
  return fetch('/health').then((res) => res.json());
}

// Replaces GET /api/history — 100 recent 1m candles for chart backfill.
// Direct mode does the same Binance klines call the server does in
// server/index.js, mapped through the SAME shared klinesToCandles module.
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
    .then((data) => ({ symbol: upper, candles: klinesToCandles(data) }));
}
