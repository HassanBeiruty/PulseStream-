// ---------------------------------------------------------------------------
// Normalizer (NORMALIZATION layer)
//
// This module converts raw, upstream provider-specific messages (from Binance)
// into a unified internal data schema used by the rest of the application.
//
// Unified schema:
//   { symbol, lastPrice, bestBid, bestAsk, lastTradeTime, source }
//
// By doing this, nothing downstream of the normalizer ever touches raw Binance
// payloads. If we add another data source in the future, we only write a new
// feed handler and normalizer, leaving the hub and distribution servers untouched.
// ---------------------------------------------------------------------------

/**
 * Normalizes raw messages from Binance streams.
 *
 * @param {string} stream - The name of the upstream stream (e.g. "btcusdt@trade")
 * @param {object} data - The raw JSON data payload from Binance
 * @returns {object|null} The normalized update object, or null if the stream type is unsupported
 */
function normalize(stream, data) {
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

  return null;
}

module.exports = { normalize };
