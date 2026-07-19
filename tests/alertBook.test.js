import { describe, it, expect } from 'vitest';
import { AlertBook } from '../shared/alertBook.js';

describe('alert book', () => {
  it('triggers ABOVE at >= and discards the alert (trigger once)', () => {
    const book = new AlertBook();
    book.set({ id: 'a1', symbol: 'BTCUSDT', value: 65000, condition: 'ABOVE' });

    expect(book.evaluate('BTCUSDT', 64999)).toEqual([]);
    const hits = book.evaluate('BTCUSDT', 65000);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'a1', price: 65000 });
    // Fired once — never again
    expect(book.evaluate('BTCUSDT', 70000)).toEqual([]);
  });

  it('triggers BELOW at <=', () => {
    const book = new AlertBook();
    book.set({ symbol: 'ETHUSDT', value: 1900, condition: 'BELOW' });
    expect(book.evaluate('ETHUSDT', 1901)).toEqual([]);
    expect(book.evaluate('ETHUSDT', 1900)).toHaveLength(1);
  });

  it('only evaluates alerts for the ticking symbol', () => {
    const book = new AlertBook();
    book.set({ symbol: 'BTCUSDT', value: 1, condition: 'ABOVE' });
    expect(book.evaluate('ETHUSDT', 99999)).toEqual([]);
  });

  it('removes by id and by symbol', () => {
    const book = new AlertBook();
    const a = book.set({ symbol: 'BTCUSDT', value: 1, condition: 'ABOVE' });
    book.set({ symbol: 'BTCUSDT', value: 2, condition: 'ABOVE' });
    expect(book.remove(a.id)).toMatchObject({ id: a.id });
    book.removeForSymbol('BTCUSDT');
    expect(book.evaluate('BTCUSDT', 99999)).toEqual([]);
  });

  it('rejects invalid registrations and null prices', () => {
    const book = new AlertBook();
    expect(book.set({ symbol: 'BTCUSDT', value: 'not-a-number' })).toBeNull();
    expect(book.set({ value: 5 })).toBeNull();
    book.set({ symbol: 'BTCUSDT', value: 1, condition: 'ABOVE' });
    expect(book.evaluate('BTCUSDT', null)).toEqual([]);
  });
});
