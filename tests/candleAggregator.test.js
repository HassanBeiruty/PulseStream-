import { describe, it, expect } from 'vitest';
import { CandleAggregator } from '../shared/candleAggregator.js';

const MINUTE = 60000;
const T0 = 1784146800000; // exactly on a minute boundary

function trade(price, qty, time) {
  return { symbol: 'BTCUSDT', lastPrice: price, quantity: qty, lastTradeTime: time };
}

describe('candle aggregator', () => {
  it('opens a candle from the first trade of a minute', () => {
    const agg = new CandleAggregator();
    const candle = agg.update(trade(100, 2, T0 + 5000));
    expect(candle).toEqual({ timestamp: T0, open: 100, high: 100, low: 100, close: 100, volume: 2 });
  });

  it('folds same-minute trades into high/low/close/volume', () => {
    const agg = new CandleAggregator();
    agg.update(trade(100, 1, T0 + 1000));
    agg.update(trade(105, 2, T0 + 2000));
    const candle = agg.update(trade(98, 0.5, T0 + 3000));
    expect(candle).toEqual({ timestamp: T0, open: 100, high: 105, low: 98, close: 98, volume: 3.5 });
  });

  it('rolls over to a fresh candle on the next minute', () => {
    const agg = new CandleAggregator();
    agg.update(trade(100, 1, T0 + 1000));
    const next = agg.update(trade(101, 3, T0 + MINUTE + 1000));
    expect(next).toEqual({ timestamp: T0 + MINUTE, open: 101, high: 101, low: 101, close: 101, volume: 3 });
  });

  it('tracks candles per symbol independently', () => {
    const agg = new CandleAggregator();
    agg.update(trade(100, 1, T0));
    agg.update({ symbol: 'ETHUSDT', lastPrice: 2000, quantity: 5, lastTradeTime: T0 });
    expect(agg.getActiveCandle('BTCUSDT').close).toBe(100);
    expect(agg.getActiveCandle('ETHUSDT').close).toBe(2000);
  });

  it('returns copies, not live references', () => {
    const agg = new CandleAggregator();
    const candle = agg.update(trade(100, 1, T0));
    candle.close = 999;
    expect(agg.getActiveCandle('BTCUSDT').close).toBe(100);
  });

  it('ignores invalid trades', () => {
    const agg = new CandleAggregator();
    expect(agg.update(null)).toBeNull();
    expect(agg.update({ symbol: 'BTCUSDT' })).toBeNull();
  });
});
