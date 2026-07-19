import { describe, it, expect } from 'vitest';
import { klinesToCandles, mergeCandleHistories } from '../shared/klines.js';

describe('klines mapping', () => {
  it('maps positional string arrays to typed candle objects', () => {
    const raw = [
      [1784146800000, '65000.1', '65100.2', '64900.3', '65050.4', '123.45', 1784146859999],
      [1784146860000, '65050.4', '65200.0', '65000.0', '65150.9', '67.89', 1784146919999],
    ];
    expect(klinesToCandles(raw)).toEqual([
      { timestamp: 1784146800000, open: 65000.1, high: 65100.2, low: 64900.3, close: 65050.4, volume: 123.45 },
      { timestamp: 1784146860000, open: 65050.4, high: 65200.0, low: 65000.0, close: 65150.9, volume: 67.89 },
    ]);
  });

  it('maps an empty response to an empty list', () => {
    expect(klinesToCandles([])).toEqual([]);
  });
});

describe('candle history merge (IndexedDB + REST backfill)', () => {
  const candle = (timestamp, close) => ({ timestamp, open: close, high: close, low: close, close, volume: 1 });

  it('unions by timestamp, sorted ascending, preferred list wins conflicts', () => {
    const stored = [candle(1000, 10), candle(2000, 20), candle(3000, 99)];
    const rest = [candle(3000, 30), candle(4000, 40)];
    const merged = mergeCandleHistories(stored, rest);
    expect(merged.map((c) => c.timestamp)).toEqual([1000, 2000, 3000, 4000]);
    expect(merged[2].close).toBe(30); // REST wins the 3000 conflict
  });

  it('handles either side empty', () => {
    expect(mergeCandleHistories([], [candle(1, 1)])).toHaveLength(1);
    expect(mergeCandleHistories([candle(1, 1)], [])).toHaveLength(1);
    expect(mergeCandleHistories([], [])).toEqual([]);
  });
});
