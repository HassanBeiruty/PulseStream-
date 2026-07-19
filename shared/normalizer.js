// ---------------------------------------------------------------------------
// Normalizer (NORMALIZATION layer — SHARED, isomorphic)
//
// Converts raw, upstream provider-specific messages (from Binance) into the
// unified internal data schema used by the rest of the application:
//
//   { symbol, lastPrice, bestBid, bestAsk, lastTradeTime, source }
//
// Nothing downstream of the normalizer ever touches raw Binance payloads.
// Runs in the Node hub (hub mode) and in the browser (direct mode) — the
// exact same function, so the two modes can never drift apart.
// ---------------------------------------------------------------------------

/**
 * Normalizes raw messages from Binance streams.
 *
 * @param {string} stream - The name of the upstream stream (e.g. "btcusdt@trade")
 * @param {object} data - The raw JSON data payload from Binance
 * @returns {object|null} The normalized update object, or null if the stream type is unsupported
 */
export function normalize(stream, data) {
  if (!stream || !data) return null;

  const symbol = (data.s || '').toUpperCase();
  if (!symbol) return null;

  if (stream.endsWith('@trade')) {
    return {
      symbol,
      lastPrice: parseFloat(data.p),
      lastTradeTime: data.T,
      quantity: parseFloat(data.q),
      source: 'binance',
    };
  }

  if (stream.endsWith('@bookTicker')) {
    return {
      symbol,
      bestBid: parseFloat(data.b),
      bestAsk: parseFloat(data.a),
      source: 'binance',
    };
  }

  // 24h rolling-window stats (open/high/low/base volume). Deliberately does
  // NOT set lastPrice — the trade stream owns that field.
  if (stream.endsWith('@miniTicker')) {
    return {
      symbol,
      open24h: parseFloat(data.o),
      high24h: parseFloat(data.h),
      low24h: parseFloat(data.l),
      volume24h: parseFloat(data.v),
      source: 'binance',
    };
  }

  return null;
}
