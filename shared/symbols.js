// ---------------------------------------------------------------------------
// Symbol pool (SHARED — single source of truth)
//
// Isomorphic module: imported by the Node server (server/config.js) AND the
// browser bundle. Before Phase 7 this list was duplicated in server/config.js
// and frontend/src/directFeed.js with a "keep in sync" comment — the classic
// drift hazard this module removes.
//
// PAXGUSDT (PAX Gold) is a gold-backed token — 1 PAXG ≈ 1 troy oz of gold —
// so it's how we surface "gold" while staying on Binance's single public
// feed. Binance has no silver market, so silver is intentionally absent.
// Order here is the display order in the UI AND the default selection
// (the first symbol is charted on load): BTC first, gold second.
// ---------------------------------------------------------------------------

export const SYMBOLS = ['BTCUSDT', 'PAXGUSDT', 'ETHUSDT'];

// Friendly display names for tickers that aren't self-explanatory. This is
// PRESENTATION ONLY: the raw Binance symbol (e.g. "PAXGUSDT") stays the
// identifier used for subscribe/unsubscribe, history, alerts and record keys.
export const SYMBOL_LABELS = {
  PAXGUSDT: 'Gold (PAXG)',
};

export function symbolLabel(symbol) {
  if (!symbol) return symbol;
  return SYMBOL_LABELS[symbol.toUpperCase()] || symbol;
}
