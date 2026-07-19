import { describe, it, expect } from 'vitest';
import {
  isValidTrade,
  isValidBookTicker,
  isValidMiniTicker,
  isValidDepthUpdate,
} from '../shared/schema.js';
import { normalize } from '../shared/normalizer.js';

describe('feed-boundary schema validation', () => {
  it('accepts well-formed payloads', () => {
    expect(isValidTrade({ s: 'BTCUSDT', p: '65000.1', q: '0.5', T: 1784146817430 })).toBe(true);
    expect(isValidBookTicker({ s: 'BTCUSDT', b: '64999', a: '65001' })).toBe(true);
    expect(isValidMiniTicker({ s: 'BTCUSDT', o: '64000', h: '65500', l: '63800', v: '123.4' })).toBe(true);
    expect(isValidDepthUpdate({ s: 'BTCUSDT', U: 100, u: 105, b: [], a: [] })).toBe(true);
  });

  it('rejects missing / non-numeric / wrong-typed fields', () => {
    expect(isValidTrade({ s: 'BTCUSDT', p: 'abc', q: '1', T: 1 })).toBe(false);
    expect(isValidTrade({ s: 'BTCUSDT', p: '1', q: '1' })).toBe(false); // no T
    expect(isValidTrade({ s: '', p: '1', q: '1', T: 1 })).toBe(false);
    expect(isValidBookTicker({ s: 'X', b: '1' })).toBe(false); // no ask
    expect(isValidMiniTicker({ s: 'X', o: '1', h: '2', l: 'nope', v: '3' })).toBe(false);
    expect(isValidDepthUpdate({ s: 'X', U: 10, u: 5, b: [], a: [] })).toBe(false); // u < U
    expect(isValidDepthUpdate({ s: 'X', U: 1, u: 2, b: {}, a: [] })).toBe(false);
    expect(isValidTrade(null)).toBe(false);
  });

  it('normalize() drops invalid payloads instead of producing NaN records', () => {
    expect(normalize('btcusdt@trade', { s: 'BTCUSDT', p: 'garbage', q: '1', T: 1 })).toBeNull();
    expect(normalize('btcusdt@bookTicker', { s: 'BTCUSDT', b: '1' })).toBeNull();
    expect(normalize('btcusdt@miniTicker', { s: 'BTCUSDT' })).toBeNull();
  });
});
