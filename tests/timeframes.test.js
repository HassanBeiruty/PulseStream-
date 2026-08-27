import { describe, it, expect } from 'vitest';
import {
  TIMEFRAMES,
  DEFAULT_TIMEFRAME,
  getTimeframe,
  isTimeframe,
  resolveTimeframe,
  bucketStart,
  foldCandle,
} from '../shared/timeframes.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('timeframe catalog', () => {
  it('exposes ids that double as Binance kline intervals', () => {
    expect(TIMEFRAMES.map((tf) => tf.id)).toEqual([
      '1m', '3m', '5m', '15m', '30m',
      '1h', '2h', '4h', '6h', '12h',
      '1d', '3d',
      '1w'
    ]);
  });

  it('never asks Binance for more than its 1000-candle cap', () => {
    for (const tf of TIMEFRAMES) {
      expect(tf.limit).toBeGreaterThan(0);
      expect(tf.limit).toBeLessThanOrEqual(1000);
    }
  });

  it('recognises configured windows and rejects anything else', () => {
    expect(isTimeframe('4h')).toBe(true);
    expect(isTimeframe('4H')).toBe(true); // case-insensitive
    expect(isTimeframe('3m')).toBe(true);
    expect(isTimeframe('30m')).toBe(true);
    expect(isTimeframe('2m')).toBe(false);
    expect(isTimeframe(undefined)).toBe(false);
    expect(getTimeframe('nope')).toBeNull();
  });

  it('resolves unknown input to the default window instead of null', () => {
    expect(resolveTimeframe('nope').id).toBe(DEFAULT_TIMEFRAME);
    expect(resolveTimeframe('1d').id).toBe('1d');
  });
});

describe('bucketStart', () => {
  it('floors to the bucket grid when no anchor is given', () => {
    const ts = Date.UTC(2026, 0, 5, 13, 47, 30);
    expect(bucketStart(ts, MINUTE)).toBe(Date.UTC(2026, 0, 5, 13, 47));
    expect(bucketStart(ts, 15 * MINUTE)).toBe(Date.UTC(2026, 0, 5, 13, 45));
    expect(bucketStart(ts, 4 * HOUR)).toBe(Date.UTC(2026, 0, 5, 12));
  });

  it('aligns weekly buckets to the exchange grid via the anchor', () => {
    // 2026-01-05 is a Monday — Binance opens its weekly candle there, while a
    // naive floor(ts / week) lands on a Thursday (the epoch's weekday).
    const monday = Date.UTC(2026, 0, 5);
    const week = 7 * DAY;
    expect(bucketStart(Date.UTC(2026, 0, 9, 18), week, monday)).toBe(monday);
    expect(bucketStart(Date.UTC(2026, 0, 12), week, monday)).toBe(monday + week);
    expect(new Date(bucketStart(Date.UTC(2026, 0, 9, 18), week)).getUTCDay()).not.toBe(1);
  });

  it('keeps timestamps before the anchor on the same grid', () => {
    const anchor = Date.UTC(2026, 0, 5);
    expect(bucketStart(anchor - 1, DAY, anchor)).toBe(anchor - DAY);
  });
});

describe('foldCandle (1m candles -> a wider live bar)', () => {
  const candle = (timestamp, open, high, low, close, volume) => ({
    timestamp, open, high, low, close, volume,
  });

  it('starts a new bucket from the first candle', () => {
    const first = candle(1000, 10, 12, 9, 11, 5);
    expect(foldCandle(null, first)).toEqual(first);
    expect(foldCandle(null, first)).not.toBe(first); // copied, not aliased
  });

  it('keeps the bucket open/timestamp, widens high/low, advances close', () => {
    const base = candle(1000, 10, 12, 9, 11, 5);
    const next = candle(1060, 11, 15, 10, 14, 3);
    expect(foldCandle(base, next)).toEqual(candle(1000, 10, 15, 9, 14, 8));
  });

  it('lowers the bucket low when the newer candle trades down', () => {
    const base = candle(1000, 10, 12, 9, 11, 5);
    const next = candle(1060, 11, 11, 7, 8, 2);
    expect(foldCandle(base, next)).toEqual(candle(1000, 10, 12, 7, 8, 7));
  });

  it('treats a missing volume as zero rather than NaN', () => {
    const base = candle(1000, 10, 12, 9, 11, 5);
    expect(foldCandle(base, { timestamp: 1060, open: 11, high: 11, low: 11, close: 11 }).volume).toBe(5);
  });

  it('folds a run of minutes into one bucket in order', () => {
    const minutes = [
      candle(0, 100, 105, 99, 104, 1),
      candle(MINUTE, 104, 110, 103, 107, 2),
      candle(2 * MINUTE, 107, 108, 95, 96, 4),
    ];
    const bar = minutes.reduce((acc, m) => foldCandle(acc, m), null);
    expect(bar).toEqual(candle(0, 100, 110, 95, 96, 7));
  });
});
