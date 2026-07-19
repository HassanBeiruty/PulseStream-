import { describe, it, expect } from 'vitest';
import { normalize } from '../shared/normalizer.js';

describe('normalizer', () => {
  it('maps @trade payloads to the internal schema', () => {
    const update = normalize('btcusdt@trade', {
      s: 'BTCUSDT', p: '65000.10', q: '0.5', T: 1784146817430,
    });
    expect(update).toEqual({
      symbol: 'BTCUSDT',
      lastPrice: 65000.1,
      lastTradeTime: 1784146817430,
      quantity: 0.5,
      source: 'binance',
    });
  });

  it('maps @bookTicker payloads to bid/ask only', () => {
    const update = normalize('ethusdt@bookTicker', { s: 'ETHUSDT', b: '1925.35', a: '1925.36' });
    expect(update).toEqual({
      symbol: 'ETHUSDT',
      bestBid: 1925.35,
      bestAsk: 1925.36,
      source: 'binance',
    });
  });

  it('maps @miniTicker to 24h stats without touching lastPrice', () => {
    const update = normalize('btcusdt@miniTicker', {
      s: 'BTCUSDT', o: '64000', h: '65500', l: '63800', v: '12345.6', c: '65001',
    });
    expect(update).toEqual({
      symbol: 'BTCUSDT',
      open24h: 64000,
      high24h: 65500,
      low24h: 63800,
      volume24h: 12345.6,
      source: 'binance',
    });
    expect(update.lastPrice).toBeUndefined();
  });

  it('returns null for unknown streams and malformed payloads', () => {
    expect(normalize('btcusdt@depth', { s: 'BTCUSDT' })).toBeNull();
    expect(normalize('btcusdt@trade', {})).toBeNull();
    expect(normalize(null, { s: 'BTCUSDT' })).toBeNull();
    expect(normalize('btcusdt@trade', null)).toBeNull();
  });
});
