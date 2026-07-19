import { describe, it, expect } from 'vitest';
import { VwapCalculator } from '../shared/analytics.js';

describe('session VWAP', () => {
  it('computes the volume-weighted average, not the simple average', () => {
    const vwap = new VwapCalculator();
    vwap.update({ symbol: 'BTCUSDT', lastPrice: 100, quantity: 1 });
    const result = vwap.update({ symbol: 'BTCUSDT', lastPrice: 200, quantity: 3 });
    // (100*1 + 200*3) / 4 = 175 — a simple average would say 150
    expect(result).toBe(175);
    expect(vwap.get('BTCUSDT')).toBe(175);
  });

  it('tracks symbols independently', () => {
    const vwap = new VwapCalculator();
    vwap.update({ symbol: 'BTCUSDT', lastPrice: 100, quantity: 1 });
    vwap.update({ symbol: 'ETHUSDT', lastPrice: 2000, quantity: 1 });
    expect(vwap.get('BTCUSDT')).toBe(100);
    expect(vwap.get('ETHUSDT')).toBe(2000);
  });

  it('ignores quote-only updates (no quantity) and returns null before any trade', () => {
    const vwap = new VwapCalculator();
    expect(vwap.update({ symbol: 'BTCUSDT', bestBid: 1, bestAsk: 2 })).toBeNull();
    expect(vwap.get('BTCUSDT')).toBeNull();
  });
});
