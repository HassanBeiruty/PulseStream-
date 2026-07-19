import { describe, it, expect, beforeEach } from 'vitest';
import { PaperOMS, positionUnrealized } from '../shared/oms.js';

// End-to-end scenario against deterministic fake ticks: long entry, resting
// limit, partial close, flip through zero to short, cover, fees throughout.
describe('paper OMS', () => {
  let oms;
  const tick = (bid, ask) =>
    oms.onTick({ symbol: 'BTCUSDT', bestBid: bid, bestAsk: ask, lastPrice: bid });

  beforeEach(() => {
    oms = new PaperOMS({ feeBps: 10 }); // 0.10% per fill
  });

  it('fills a market BUY at the ask (taker) and charges the fee', () => {
    tick(100, 101);
    const res = oms.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', qty: 2 });
    expect(res.ok).toBe(true);
    expect(oms.fills[0].price).toBe(101);

    const pos = oms.getState().positions[0];
    expect(pos.qty).toBe(2);
    expect(pos.avgEntry).toBe(101);
    expect(pos.realizedPnl).toBeCloseTo(-0.202, 10); // fee only
  });

  it('rests a non-marketable limit, then fills it at the limit when crossed', () => {
    tick(100, 101);
    oms.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', qty: 2 });
    oms.submit({ symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', qty: 1, limitPrice: 105 });
    expect(oms.getState().openOrders).toHaveLength(1);

    tick(105, 106); // bid reaches the sell limit
    expect(oms.getState().openOrders).toHaveLength(0);

    const pos = oms.getState().positions[0];
    expect(pos.qty).toBe(1);
    expect(pos.avgEntry).toBe(101); // partial close keeps avg entry
    expect(pos.realizedPnl).toBeCloseTo(3.693, 10); // +4 gross − fees
  });

  it('flips through zero: closes the long, opens a short at the fill price', () => {
    tick(100, 101);
    oms.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', qty: 2 });
    oms.submit({ symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', qty: 1, limitPrice: 105 });
    tick(105, 106);
    oms.submit({ symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', qty: 3 }); // 1 closes, 2 open short

    const pos = oms.getState().positions[0];
    expect(pos.qty).toBe(-2);
    expect(pos.avgEntry).toBe(105);
    expect(pos.realizedPnl).toBeCloseTo(7.378, 10);

    // Short unrealized P&L: price falls -> profit
    expect(positionUnrealized(pos, 90)).toBeCloseTo(30, 10);
  });

  it('covers the short flat and lands on the exact realized total net of fees', () => {
    tick(100, 101);
    oms.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', qty: 2 });
    oms.submit({ symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', qty: 1, limitPrice: 105 });
    tick(105, 106);
    oms.submit({ symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', qty: 3 });
    oms.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', qty: 2, limitPrice: 89 });
    tick(87, 88); // ask crosses the buy limit

    const pos = oms.getState().positions[0];
    expect(pos.qty).toBe(0);
    expect(pos.avgEntry).toBe(0);
    expect(pos.realizedPnl).toBeCloseTo(39.2, 10); // 40 gross − 0.8 total fees
    expect(oms.getState().totalRealizedPnl).toBeCloseTo(39.2, 10);
  });

  it('fills a marketable limit at the touch (price improvement), not the limit', () => {
    tick(87, 88);
    oms.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', qty: 1, limitPrice: 200 });
    expect(oms.fills[oms.fills.length - 1].price).toBe(88);
  });

  it('cancels resting orders', () => {
    tick(100, 101);
    const res = oms.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', qty: 1, limitPrice: 1 });
    expect(oms.cancel(res.order.id)).toMatchObject({ status: 'CANCELED' });
    expect(oms.getState().openOrders).toHaveLength(0);
    expect(oms.cancel('nope')).toBeNull();
  });

  it('rejects invalid orders with reasons', () => {
    tick(100, 101);
    expect(oms.submit({ symbol: 'DOGEUSDT', side: 'BUY', type: 'MARKET', qty: 1 }).ok).toBe(false); // no quote
    expect(oms.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', qty: -1 }).ok).toBe(false);
    expect(oms.submit({ symbol: 'BTCUSDT', side: 'HOLD', type: 'MARKET', qty: 1 }).ok).toBe(false);
    expect(oms.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', qty: 1 }).ok).toBe(false); // no limit px
  });

  it('serializes and restores the whole book; rejects garbage', () => {
    tick(100, 101);
    oms.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', qty: 2 });

    const restored = PaperOMS.restore(oms.serialize());
    expect(restored.getState().totalRealizedPnl).toBeCloseTo(oms.getState().totalRealizedPnl, 10);
    expect(restored.getState().fills).toHaveLength(1);
    expect(restored.getState().positions[0].qty).toBe(2);

    expect(PaperOMS.restore('{not json')).toBeNull();
    expect(PaperOMS.restore(null)).toBeNull();
  });
});
