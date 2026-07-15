// ---------------------------------------------------------------------------
// Klines mapping (SHARED, isomorphic)
//
// Converts Binance's positional kline arrays into our internal candle shape.
// Binance klines come back as arrays:
//   [ openTime, open, high, low, close, volume, closeTime, ... ]
// with prices as STRINGS — this is the one place that shape is known.
// Used by the server's /api/history endpoint (hub mode) and by the browser's
// direct-mode backfill.
// ---------------------------------------------------------------------------

/**
 * @param {Array[]} raw - raw kline rows from Binance's /klines endpoint
 * @returns {object[]} candles as { timestamp, open, high, low, close, volume }
 */
export function klinesToCandles(raw) {
  return raw.map((kline) => ({
    timestamp: kline[0],
    open: parseFloat(kline[1]),
    high: parseFloat(kline[2]),
    low: parseFloat(kline[3]),
    close: parseFloat(kline[4]),
    volume: parseFloat(kline[5]),
  }));
}
