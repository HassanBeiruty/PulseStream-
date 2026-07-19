import { describe, it, expect, vi } from 'vitest';
import { OrderBook, OrderBookManager } from '../shared/orderBook.js';

const diff = (U, u, b = [], a = []) => ({ s: 'BTCUSDT', U, u, b, a });

describe('order book — snapshot + delta sync', () => {
  it('buffers diffs until a snapshot arrives, then drains them in order', () => {
    const book = new OrderBook('BTCUSDT');
    expect(book.applyDiff(diff(101, 102, [['100', '1']]))).toBe('buffered');
    expect(book.applyDiff(diff(103, 104, [['100', '2']]))).toBe('buffered');

    const result = book.applySnapshot({
      lastUpdateId: 100,
      bids: [['99', '5']],
      asks: [['101', '5']],
    });
    expect(result).toBe('synced');
    // Both buffered events applied: 100 level ends at qty 2
    expect(book.bids.get(100)).toBe(2);
    expect(book.lastUpdateId).toBe(104);
  });

  it('drops buffered events already contained in the snapshot (u <= lastUpdateId)', () => {
    const book = new OrderBook('BTCUSDT');
    book.applyDiff(diff(90, 95, [['100', '9']])); // stale (pre-snapshot)
    book.applyDiff(diff(101, 102, [['100', '1']]));
    book.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    expect(book.bids.get(100)).toBe(1); // stale event's qty 9 never applied
  });

  it('detects a sequence gap and resets for resync', () => {
    const book = new OrderBook('BTCUSDT');
    book.applySnapshot({ lastUpdateId: 100, bids: [['99', '1']], asks: [] });
    expect(book.applyDiff(diff(101, 102, [['99', '2']]))).toBe('applied');
    // 105 > 102+1 -> an event was dropped somewhere: the book is now unsafe
    expect(book.applyDiff(diff(105, 106, [['99', '3']]))).toBe('gap');
    expect(book.synced).toBe(false);
    expect(book.buffer).toHaveLength(1); // the gapped event seeds the next sync
  });

  it('gap during snapshot drain reports gap (snapshot too old for the buffer)', () => {
    const book = new OrderBook('BTCUSDT');
    book.applyDiff(diff(205, 210, [['100', '1']])); // far ahead of the snapshot
    const result = book.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    expect(result).toBe('gap');
  });

  it('applies absolute quantities and deletes zero-qty levels', () => {
    const book = new OrderBook('BTCUSDT');
    book.applySnapshot({ lastUpdateId: 100, bids: [['99', '5'], ['98', '3']], asks: [['101', '4']] });
    book.applyDiff(diff(101, 101, [['99', '0'], ['97', '7']], [['101', '1.5']]));
    expect(book.bids.has(99)).toBe(false); // deleted
    expect(book.bids.get(97)).toBe(7); // inserted
    expect(book.asks.get(101)).toBe(1.5); // replaced (absolute, not additive)
  });

  it('ignores already-applied and malformed events', () => {
    const book = new OrderBook('BTCUSDT');
    book.applySnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    expect(book.applyDiff(diff(95, 100))).toBe('ignored'); // u <= lastUpdateId
    expect(book.applyDiff({ s: 'BTCUSDT', U: 5, u: 3, b: [], a: [] })).toBe('ignored'); // u < U
    expect(book.applyDiff(null)).toBe('ignored');
  });

  it('top(n) sorts bids descending and asks ascending; stats compute spread/mid/imbalance', () => {
    const book = new OrderBook('BTCUSDT');
    book.applySnapshot({
      lastUpdateId: 1,
      bids: [['98', '1'], ['100', '3'], ['99', '2']],
      asks: [['103', '1'], ['101', '2'], ['102', '3']],
    });
    const { bids, asks } = book.top(2);
    expect(bids.map((l) => l.price)).toEqual([100, 99]);
    expect(asks.map((l) => l.price)).toEqual([101, 102]);

    const stats = book.stats(3);
    expect(stats.bestBid).toBe(100);
    expect(stats.bestAsk).toBe(101);
    expect(stats.spread).toBe(1);
    expect(stats.mid).toBe(100.5);
    expect(stats.imbalance).toBe(0); // 6 vs 6
  });
});

describe('order book manager — resync driver', () => {
  it('fetches a snapshot when diffs arrive unsynced, then publishes views', async () => {
    const onBook = vi.fn();
    const fetchSnapshot = vi.fn().mockResolvedValue({
      lastUpdateId: 100,
      bids: [['99', '1']],
      asks: [['101', '1']],
    });
    const manager = new OrderBookManager({ fetchSnapshot, onBook, resyncDelayMs: 5 });

    manager.handleDiff('BTCUSDT', diff(101, 102, [['99', '2']]));
    await vi.waitFor(() => expect(onBook).toHaveBeenCalled());

    expect(fetchSnapshot).toHaveBeenCalledWith('BTCUSDT');
    const view = onBook.mock.calls[0][0];
    expect(view.symbol).toBe('BTCUSDT');
    expect(view.bids[0]).toEqual({ price: 99, qty: 2 }); // buffered diff applied over snapshot
    expect(view.bestAsk).toBe(101);
  });

  it('publishes after every applied diff once synced', async () => {
    const onBook = vi.fn();
    const manager = new OrderBookManager({
      fetchSnapshot: vi.fn().mockResolvedValue({ lastUpdateId: 100, bids: [['99', '1']], asks: [['101', '1']] }),
      onBook,
      resyncDelayMs: 5,
    });
    manager.handleDiff('BTCUSDT', diff(101, 102));
    await vi.waitFor(() => expect(onBook).toHaveBeenCalled());

    const before = onBook.mock.calls.length;
    expect(manager.handleDiff('BTCUSDT', diff(103, 104, [['99', '4']]))).toBe('applied');
    expect(onBook.mock.calls.length).toBe(before + 1);
  });

  it('a gap triggers a fresh snapshot fetch and recovery', async () => {
    const onBook = vi.fn();
    const fetchSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ lastUpdateId: 100, bids: [['99', '1']], asks: [['101', '1']] })
      .mockResolvedValueOnce({ lastUpdateId: 200, bids: [['98', '1']], asks: [['102', '1']] });
    const manager = new OrderBookManager({ fetchSnapshot, onBook, resyncDelayMs: 5 });

    manager.handleDiff('BTCUSDT', diff(101, 102));
    await vi.waitFor(() => expect(onBook).toHaveBeenCalled());

    // Dropped events between 102 and 150 -> gap -> resync via second snapshot
    expect(manager.handleDiff('BTCUSDT', diff(150, 151))).toBe('gap');
    await vi.waitFor(() => expect(fetchSnapshot).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(onBook.mock.calls[onBook.mock.calls.length - 1][0].bestBid).toBe(98)
    );
  });
});
