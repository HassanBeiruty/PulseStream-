// ---------------------------------------------------------------------------
// Paper-trading OMS (SHARED, isomorphic — a hub/feed CONSUMER)
//
// A simulated order-management system that executes against LIVE top-of-book
// quotes. No real orders exist anywhere: the exchange never sees this; fills
// are simulated locally against real market prices. The goal is the
// vocabulary — order lifecycle, marketable vs resting limits, fills, fees,
// average entry, realized/unrealized P&L, long/short.
//
// Simulation assumptions (deliberately simple, documented so they can be
// challenged in later phases):
//   - MARKET orders fill in full, immediately, at the touch: BUY at bestAsk,
//     SELL at bestBid (you pay the spread — "taker").
//   - LIMIT orders that are marketable on arrival (BUY limit >= ask,
//     SELL limit <= bid) fill immediately AT the touch (price improvement).
//     Otherwise they REST and fill at their limit price when the opposite
//     side of the book crosses it. No queue position, no partial fills.
//   - A flat fee in basis points of notional is charged on every fill and
//     deducted from realized P&L.
//
// Position accounting is the standard AVERAGE-COST method with signed
// quantities (positive = long, negative = short), including flipping through
// zero (close the old side, open the remainder at the fill price).
//
// Pure JS, no I/O: quotes come in via onTick(record) — golden records from
// the hub/DataFeed — and results go out via Emitter events. Runs identically
// in the browser (both modes) and in Node (tests).
// ---------------------------------------------------------------------------

import { Emitter } from './emitter.js';

const EPSILON = 1e-12; // float dust guard when a close nets to exactly zero

function randomId() {
  return Math.random().toString(36).substring(2, 9);
}

/** Mark-to-market P&L of an open position at the given price. */
export function positionUnrealized(position, markPrice) {
  if (!position || position.qty === 0 || markPrice === null || markPrice === undefined) {
    return 0;
  }
  return position.qty * (markPrice - position.avgEntry);
}

export class PaperOMS {
  /**
   * @param {object} [opts]
   * @param {number} [opts.feeBps] - fee per fill, in basis points of notional (default 10 = 0.10%)
   */
  constructor({ feeBps = 10 } = {}) {
    this.feeBps = feeBps;
    this.emitter = new Emitter();

    this.orders = [];   // every order ever submitted (newest last, capped)
    this.fills = [];    // every fill (newest last, capped)
    this.positions = new Map(); // symbol -> { symbol, qty, avgEntry, realizedPnl }
    this.quotes = new Map();    // symbol -> latest golden record (for execution)
  }

  on(event, callback) {
    return this.emitter.on(event, callback);
  }

  // --- order entry ------------------------------------------------------------

  /**
   * Submit an order. Returns { ok: true, order } or { ok: false, reason }.
   * Emits 'accepted' | 'rejected', then 'filled' if immediately executable,
   * and 'changed' on any state mutation.
   */
  submit({ symbol, side, type, qty, limitPrice } = {}) {
    const sym = (symbol || '').toUpperCase();
    const normSide = (side || '').toUpperCase();
    const normType = (type || 'MARKET').toUpperCase();
    const quantity = parseFloat(qty);
    const limit = normType === 'LIMIT' ? parseFloat(limitPrice) : null;

    let reason = null;
    if (!sym) reason = 'missing symbol';
    else if (normSide !== 'BUY' && normSide !== 'SELL') reason = 'side must be BUY or SELL';
    else if (normType !== 'MARKET' && normType !== 'LIMIT') reason = 'type must be MARKET or LIMIT';
    else if (!Number.isFinite(quantity) || quantity <= 0) reason = 'quantity must be > 0';
    else if (normType === 'LIMIT' && (!Number.isFinite(limit) || limit <= 0)) reason = 'limit price must be > 0';

    const quote = this.quotes.get(sym);
    if (!reason && normType === 'MARKET' && !this.touchPrice(quote, normSide)) {
      reason = `no live quote for ${sym} yet`;
    }

    if (reason) {
      this.emitter.emit('rejected', { reason, request: { symbol: sym, side: normSide, type: normType, qty, limitPrice } });
      return { ok: false, reason };
    }

    const order = {
      id: randomId(),
      symbol: sym,
      side: normSide,
      type: normType,
      qty: quantity,
      limitPrice: limit,
      status: 'OPEN',
      createdAt: Date.now(),
      fillPrice: null,
      filledAt: null,
    };
    this.orders.push(order);
    if (this.orders.length > 200) this.orders.shift();
    this.emitter.emit('accepted', { ...order });

    if (normType === 'MARKET') {
      // Taker: cross the spread at the touch
      this.executeFill(order, this.touchPrice(quote, normSide));
    } else {
      const marketable = this.limitIsMarketable(order, quote);
      if (marketable !== null) {
        // Marketable limit: fills at the (better) touch price immediately
        this.executeFill(order, marketable);
      }
    }

    this.emitter.emit('changed');
    return { ok: true, order: { ...order } };
  }

  /** Cancel a resting order. Returns the canceled order, or null. */
  cancel(orderId) {
    const order = this.orders.find((o) => o.id === orderId && o.status === 'OPEN');
    if (!order) return null;
    order.status = 'CANCELED';
    this.emitter.emit('canceled', { ...order });
    this.emitter.emit('changed');
    return { ...order };
  }

  // --- market data in ----------------------------------------------------------

  /**
   * Feed a golden record in. Updates the quote book and executes any resting
   * limit orders the new top-of-book crosses.
   */
  onTick(record) {
    if (!record || !record.symbol) return;
    const sym = record.symbol.toUpperCase();
    this.quotes.set(sym, record);

    let mutated = false;
    for (const order of this.orders) {
      if (order.status !== 'OPEN' || order.type !== 'LIMIT' || order.symbol !== sym) continue;

      // Resting limit fills AT its limit price when the opposite touch crosses it
      const crossed =
        (order.side === 'BUY' && record.bestAsk !== null && record.bestAsk !== undefined && record.bestAsk <= order.limitPrice) ||
        (order.side === 'SELL' && record.bestBid !== null && record.bestBid !== undefined && record.bestBid >= order.limitPrice);

      if (crossed) {
        this.executeFill(order, order.limitPrice);
        mutated = true;
      }
    }
    if (mutated) this.emitter.emit('changed');
  }

  // --- execution & accounting ---------------------------------------------------

  /** The price a taker pays/receives right now, or null if that side is unquoted. */
  touchPrice(quote, side) {
    if (!quote) return null;
    const px = side === 'BUY' ? quote.bestAsk : quote.bestBid;
    return px === null || px === undefined ? null : px;
  }

  /** Fill price if this limit order is marketable against the quote, else null. */
  limitIsMarketable(order, quote) {
    const touch = this.touchPrice(quote, order.side);
    if (touch === null) return null;
    if (order.side === 'BUY' && order.limitPrice >= touch) return touch;
    if (order.side === 'SELL' && order.limitPrice <= touch) return touch;
    return null;
  }

  executeFill(order, price) {
    const notional = order.qty * price;
    const fee = notional * (this.feeBps / 10000);

    order.status = 'FILLED';
    order.fillPrice = price;
    order.filledAt = Date.now();

    const fill = {
      id: randomId(),
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      price,
      fee,
      ts: order.filledAt,
    };
    this.fills.push(fill);
    if (this.fills.length > 200) this.fills.shift();

    const position = this.applyFillToPosition(fill);
    this.emitter.emit('filled', { order: { ...order }, fill: { ...fill }, position: { ...position } });
  }

  /** Average-cost accounting with signed qty, including flips through zero. */
  applyFillToPosition({ symbol, side, qty, price, fee }) {
    let pos = this.positions.get(symbol);
    if (!pos) {
      pos = { symbol, qty: 0, avgEntry: 0, realizedPnl: 0 };
      this.positions.set(symbol, pos);
    }

    const signedQty = side === 'BUY' ? qty : -qty;

    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signedQty)) {
      // Opening or extending: average the entry price by size
      const totalAbs = Math.abs(pos.qty) + qty;
      pos.avgEntry = (Math.abs(pos.qty) * pos.avgEntry + qty * price) / totalAbs;
      pos.qty += signedQty;
    } else {
      // Reducing, closing, or flipping through zero
      const direction = Math.sign(pos.qty); // +1 long, -1 short
      const closeQty = Math.min(qty, Math.abs(pos.qty));
      pos.realizedPnl += closeQty * (price - pos.avgEntry) * direction;
      pos.qty += signedQty;

      if (Math.abs(pos.qty) < EPSILON) {
        pos.qty = 0;
        pos.avgEntry = 0;
      } else if (Math.sign(pos.qty) !== direction) {
        // Flipped: the remainder is a brand-new position opened at this fill
        pos.avgEntry = price;
      }
      // Partial close on the same side keeps avgEntry unchanged
    }

    pos.realizedPnl -= fee; // fees always reduce realized P&L
    return pos;
  }

  // --- state out -----------------------------------------------------------------

  getState() {
    return {
      feeBps: this.feeBps,
      openOrders: this.orders.filter((o) => o.status === 'OPEN').map((o) => ({ ...o })),
      orders: this.orders.map((o) => ({ ...o })),
      fills: this.fills.map((f) => ({ ...f })),
      positions: [...this.positions.values()].map((p) => ({ ...p })),
      totalRealizedPnl: [...this.positions.values()].reduce((sum, p) => sum + p.realizedPnl, 0),
    };
  }

  // --- persistence -----------------------------------------------------------------

  serialize() {
    return JSON.stringify({
      feeBps: this.feeBps,
      orders: this.orders,
      fills: this.fills,
      positions: [...this.positions.values()],
    });
  }

  /** Rebuild from serialize() output; returns null on bad/corrupt input. */
  static restore(json) {
    try {
      const data = JSON.parse(json);
      if (!data || !Array.isArray(data.orders) || !Array.isArray(data.positions)) return null;
      const oms = new PaperOMS({ feeBps: data.feeBps });
      oms.orders = data.orders;
      oms.fills = Array.isArray(data.fills) ? data.fills : [];
      for (const pos of data.positions) {
        if (pos && pos.symbol) oms.positions.set(pos.symbol, pos);
      }
      return oms;
    } catch {
      return null;
    }
  }
}
