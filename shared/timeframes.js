// ---------------------------------------------------------------------------
// Timeframes (SHARED, isomorphic)
//
// One catalog of the chart windows the app supports, imported by the Node
// server (/api/history), the Vercel serverless function and the browser —
// the same "single source of truth" treatment symbols.js gives the pool.
//
// `id` doubles as the Binance kline `interval` string, so there is no lookup
// table to keep in sync. `limit` is how many candles we backfill per window
// (Binance caps /klines at 1000); `ms` is the bucket width our own live
// aggregation folds self-built 1m candles into.
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const TIMEFRAMES = [
  { id: '1m', label: '1m', ms: MINUTE, limit: 500, group: 'Minutes' },
  { id: '3m', label: '3m', ms: 3 * MINUTE, limit: 500, group: 'Minutes' },
  { id: '5m', label: '5m', ms: 5 * MINUTE, limit: 500, group: 'Minutes' },
  { id: '15m', label: '15m', ms: 15 * MINUTE, limit: 500, group: 'Minutes' },
  { id: '30m', label: '30m', ms: 30 * MINUTE, limit: 500, group: 'Minutes' },
  { id: '1h', label: '1H', ms: HOUR, limit: 500, group: 'Hours' },
  { id: '2h', label: '2H', ms: 2 * HOUR, limit: 500, group: 'Hours' },
  { id: '4h', label: '4H', ms: 4 * HOUR, limit: 500, group: 'Hours' },
  { id: '6h', label: '6H', ms: 6 * HOUR, limit: 500, group: 'Hours' },
  { id: '12h', label: '12H', ms: 12 * HOUR, limit: 500, group: 'Hours' },
  { id: '1d', label: '1D', ms: DAY, limit: 500, group: 'Days' },
  { id: '3d', label: '3D', ms: 3 * DAY, limit: 500, group: 'Days' },
  { id: '1w', label: '1W', ms: 7 * DAY, limit: 300, group: 'Weeks' },
];

export const DEFAULT_TIMEFRAME = '1m';

const BY_ID = new Map(TIMEFRAMES.map((tf) => [tf.id, tf]));

/** @returns {object|null} the timeframe descriptor, or null if unknown. */
export function getTimeframe(id) {
  return BY_ID.get(String(id || '').toLowerCase()) || null;
}

export function isTimeframe(id) {
  return BY_ID.has(String(id || '').toLowerCase());
}

/** Same as getTimeframe but never null — falls back to the default window. */
export function resolveTimeframe(id) {
  return getTimeframe(id) || BY_ID.get(DEFAULT_TIMEFRAME);
}

/**
 * Start of the bucket a timestamp belongs to.
 *
 * Naive `floor(ts / tfMs) * tfMs` only lines up with the exchange's own grid
 * when the epoch happens to be aligned to it — true for minutes/hours/days,
 * FALSE for weeks (1970-01-01 was a Thursday, Binance weeks open Monday).
 * Passing `anchor` (the open time of a candle we got from Binance) pins our
 * grid to theirs for every window.
 *
 * @param {number} ts - event time (ms)
 * @param {number} tfMs - bucket width (ms)
 * @param {number} [anchor] - a known-good bucket open time from the exchange
 */
export function bucketStart(ts, tfMs, anchor = 0) {
  if (!anchor) return Math.floor(ts / tfMs) * tfMs;
  const delta = ts - anchor;
  return anchor + Math.floor(delta / tfMs) * tfMs;
}

/**
 * Fold one candle into the partially-built candle of a wider bucket — how a
 * stream of self-built 1m candles becomes a live 4H or 1D bar. Open is kept
 * from the bucket, close always advances, high/low widen, volume accumulates.
 *
 * The caller is responsible for passing a candle whose volume is the NEW
 * volume only: when the backfilled bucket already covers part of the live
 * minute, double counting would inflate the bar.
 *
 * @param {object|null} base - partial bucket candle (null starts a new one)
 * @param {object} candle - the finer-grained candle to merge in
 */
export function foldCandle(base, candle) {
  if (!base) return { ...candle };
  return {
    timestamp: base.timestamp,
    open: base.open,
    high: Math.max(base.high, candle.high),
    low: Math.min(base.low, candle.low),
    close: candle.close,
    volume: base.volume + (candle.volume || 0),
  };
}
