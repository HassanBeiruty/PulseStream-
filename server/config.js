// ---------------------------------------------------------------------------
// Config (single source of truth)
//
// Nothing else in the app should hardcode a symbol or a Binance URL. Every
// layer reads what it needs from here, so changing the tracked symbols or the
// upstream endpoints is a one-line edit instead of a search-and-replace.
// ---------------------------------------------------------------------------

module.exports = {
  // The fixed pool of symbols the app supports. The runtime watchlist
  // (Phase 5) lets the user subscribe/unsubscribe within this pool.
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],

  // Port OUR OWN server listens on (Express now; our WebSocket distribution
  // server will share this process in a later phase).
  port: Number(process.env.PORT) || 3000,

  // Upstream Binance public market-data endpoints — market data only, no API
  // key required. Only the feed handler (Phase 1) is ever allowed to touch
  // these; downstream layers must not know Binance exists.
  binance: {
    wsBase: 'wss://stream.binance.com:9443/stream',
    restBase: 'https://api.binance.com/api/v3',
  },
};
