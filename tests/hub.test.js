import { describe, it, expect, vi } from 'vitest';
import { Hub, createEmptyRecord } from '../shared/hub.js';

describe('hub (golden records + pub-sub)', () => {
  it('pre-initializes empty golden records for the injected pool', () => {
    const hub = new Hub(['btcusdt']);
    expect(hub.getGoldenRecord('BTCUSDT')).toEqual(createEmptyRecord('BTCUSDT'));
  });

  it('merges partial updates from independent streams into one record', () => {
    const hub = new Hub(['BTCUSDT']);
    hub.update({ symbol: 'BTCUSDT', lastPrice: 65000, lastTradeTime: 123, source: 'binance' });
    hub.update({ symbol: 'BTCUSDT', bestBid: 64999, bestAsk: 65001, source: 'binance' });

    const record = hub.getGoldenRecord('BTCUSDT');
    expect(record.lastPrice).toBe(65000); // trade fields survive the quote merge
    expect(record.bestBid).toBe(64999);
    expect(record.bestAsk).toBe(65001);
  });

  it('pushes the FULL merged record to subscribers of that symbol only', () => {
    const hub = new Hub(['BTCUSDT', 'ETHUSDT']);
    const btcListener = vi.fn();
    const ethListener = vi.fn();
    hub.subscribe('BTCUSDT', btcListener);
    hub.subscribe('ETHUSDT', ethListener);

    hub.update({ symbol: 'BTCUSDT', lastPrice: 65000 });

    expect(btcListener).toHaveBeenCalledTimes(1);
    expect(btcListener.mock.calls[0][0].lastPrice).toBe(65000);
    expect(ethListener).not.toHaveBeenCalled();
  });

  it('stops pushing after unsubscribe', () => {
    const hub = new Hub(['BTCUSDT']);
    const listener = vi.fn();
    const unsubscribe = hub.subscribe('BTCUSDT', listener);
    unsubscribe();
    hub.update({ symbol: 'BTCUSDT', lastPrice: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('hands out copies so consumers cannot mutate the golden record', () => {
    const hub = new Hub(['BTCUSDT']);
    hub.update({ symbol: 'BTCUSDT', lastPrice: 65000 });
    const record = hub.getGoldenRecord('BTCUSDT');
    record.lastPrice = -1;
    expect(hub.getGoldenRecord('BTCUSDT').lastPrice).toBe(65000);
  });

  it('a throwing subscriber does not break the fan-out to others', () => {
    const hub = new Hub(['BTCUSDT']);
    const bad = vi.fn(() => {
      throw new Error('consumer bug');
    });
    const good = vi.fn();
    hub.subscribe('BTCUSDT', bad);
    hub.subscribe('BTCUSDT', good);
    hub.update({ symbol: 'BTCUSDT', lastPrice: 1 });
    expect(good).toHaveBeenCalledTimes(1);
  });
});
