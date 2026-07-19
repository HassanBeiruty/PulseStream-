// ---------------------------------------------------------------------------
// Derived analytics (SHARED, isomorphic)
//
// Session VWAP — Volume-Weighted Average Price — the benchmark price traders
// compare executions against: VWAP = Σ(price × qty) / Σ(qty) over the session.
// Trading above session VWAP = paying up; selling above it = beating the
// benchmark. It only accumulates from REAL trades (the @trade stream), never
// from quotes, so it must sit inside the ingestion pipeline (like the candle
// aggregator), not downstream of the throttled UI feed.
//
// "Session" here = since this process/page started ingesting. Both runtimes
// run this exact module: the Node hub in hub mode, the browser in direct mode.
// ---------------------------------------------------------------------------

export class VwapCalculator {
  constructor() {
    this.state = new Map(); // symbol -> { cumPV, cumVol }
  }

  /**
   * Fold one normalized TRADE into the running VWAP.
   *
   * @param {object} trade - normalized update with lastPrice + quantity
   * @returns {number|null} the updated session VWAP for the symbol
   */
  update(trade) {
    if (
      !trade ||
      !trade.symbol ||
      trade.lastPrice === undefined ||
      trade.lastPrice === null ||
      !trade.quantity
    ) {
      return null;
    }

    const sym = trade.symbol.toUpperCase();
    let s = this.state.get(sym);
    if (!s) {
      s = { cumPV: 0, cumVol: 0 };
      this.state.set(sym, s);
    }

    s.cumPV += trade.lastPrice * trade.quantity;
    s.cumVol += trade.quantity;

    return s.cumVol > 0 ? s.cumPV / s.cumVol : null;
  }

  /** Current session VWAP for a symbol, or null before the first trade. */
  get(symbol) {
    const s = this.state.get(symbol.toUpperCase());
    return s && s.cumVol > 0 ? s.cumPV / s.cumVol : null;
  }
}
