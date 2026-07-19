import { describe, it, expect } from 'vitest';
import { normalizeCoinbaseTicker, COINBASE_PRODUCTS } from '../shared/coinbaseFeed.js';

describe('coinbase venue normalization', () => {
  it('maps a ticker frame into the internal schema with venue tagging', () => {
    const record = normalizeCoinbaseTicker({
      type: 'ticker',
      product_id: 'BTC-USD',
      price: '64500.55',
      best_bid: '64500.50',
      best_ask: '64500.60',
      time: '2026-07-19T12:00:00.000000Z',
    });
    expect(record.symbol).toBe('BTCUSDT'); // internal symbol, not the venue's
    expect(record.source).toBe('coinbase');
    expect(record.lastPrice).toBe(64500.55);
    expect(record.bestBid).toBe(64500.5);
    expect(record.bestAsk).toBe(64500.6);
    expect(typeof record.lastTradeTime).toBe('number');
  });

  it('rejects non-ticker frames, unknown products, and bad prices', () => {
    expect(normalizeCoinbaseTicker({ type: 'subscriptions' })).toBeNull();
    expect(normalizeCoinbaseTicker({ type: 'ticker', product_id: 'DOGE-USD', price: '1' })).toBeNull();
    expect(normalizeCoinbaseTicker({ type: 'ticker', product_id: 'BTC-USD', price: 'nope' })).toBeNull();
    expect(normalizeCoinbaseTicker(null)).toBeNull();
  });

  it('declares the product mapping (PAXG intentionally absent — not listed)', () => {
    expect(COINBASE_PRODUCTS.BTCUSDT).toBe('BTC-USD');
    expect(COINBASE_PRODUCTS.ETHUSDT).toBe('ETH-USD');
    expect(COINBASE_PRODUCTS.PAXGUSDT).toBeUndefined();
  });
});
