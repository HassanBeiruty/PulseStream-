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

/**
 * Merge two candle histories by timestamp, ascending. On conflicts the
 * `preferred` list wins (e.g. fresh REST backfill over locally persisted
 * candles, which may have partial volume if the page loaded mid-minute).
 *
 * @param {object[]} base - e.g. candles restored from IndexedDB
 * @param {object[]} preferred - e.g. the REST backfill window
 * @returns {object[]} merged, sorted ascending by timestamp
 */
export function mergeCandleHistories(base, preferred) {
  const byTime = new Map();
  for (const candle of base) byTime.set(candle.timestamp, candle);
  for (const candle of preferred) byTime.set(candle.timestamp, candle);
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}
