// ---------------------------------------------------------------------------
// Config (single source of truth for the SERVER runtime)
//
// Nothing else in the server should hardcode a symbol or a Binance URL. Every
// layer reads what it needs from here, so changing the tracked symbols or the
// upstream endpoints is a one-line edit instead of a search-and-replace.
//
// The symbol pool itself lives in /shared/symbols.js because the browser's
// direct mode needs the exact same list — config re-exposes it for server code.
// ---------------------------------------------------------------------------

import { SYMBOLS } from '../shared/symbols.js';

export default {
  // The fixed pool of symbols the app supports. The runtime watchlist
  // (Phase 5) lets the user subscribe/unsubscribe within this pool.
  symbols: SYMBOLS,

  // Port OUR OWN server listens on (Express + the WebSocket distribution
  // server share this process and port).
  port: Number(process.env.PORT) || 3000,

  // Upstream Binance public market-data endpoints — market data only, no API
  // key required. Only the feed handler (Phase 1) is ever allowed to touch
  // these; downstream layers must not know Binance exists.
  binance: {
    wsBase: 'wss://stream.binance.com:9443/stream',
    restBase: 'https://api.binance.com/api/v3',
  },
};
