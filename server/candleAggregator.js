// ---------------------------------------------------------------------------
// Candle Aggregator (AGGREGATION layer)
//
// This module aggregates raw trade updates into 1-minute OHLCV (Open, High,
// Low, Close, Volume) candles in memory.
//
// When a trade tick is received, it determines which 1-minute interval the
// trade belongs to. If it's a new minute, it starts a new candle; if it is the
// current minute, it updates the existing candle's High, Low, Close, and Volume.
// ---------------------------------------------------------------------------

class CandleAggregator {
  constructor() {
    // Map of symbol -> activeCandle object
    this.candles = new Map();
  }

  /**
   * Updates the active candle for a symbol using a trade update.
   *
   * @param {object} trade - Normalized trade object containing symbol, lastPrice, lastTradeTime, quantity
   * @returns {object} The updated active candle for the symbol
   */
  update(trade) {
    if (!trade || !trade.symbol || trade.lastPrice === undefined || !trade.lastTradeTime) {
      return null;
    }

    const sym = trade.symbol.toUpperCase();
    const price = trade.lastPrice;
    const qty = trade.quantity || 0;
    
    // Determine the 1-minute bucket timestamp (milliseconds)
    const minuteStart = Math.floor(trade.lastTradeTime / 60000) * 60000;

    let active = this.candles.get(sym);

    if (!active || minuteStart > active.timestamp) {
      // Create a new candle for the new 1-minute interval
      active = {
        timestamp: minuteStart,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: qty,
      };
    } else {
      // Update the existing candle for the current minute
      active.high = Math.max(active.high, price);
      active.low = Math.min(active.low, price);
      active.close = price;
      active.volume += qty;
    }

    this.candles.set(sym, active);
    return { ...active }; // return a copy to prevent mutability side effects
  }

  /**
   * Get the active candle for a symbol.
   *
   * @param {string} symbol
   * @returns {object|null}
   */
  getActiveCandle(symbol) {
    const active = this.candles.get(symbol.toUpperCase());
    return active ? { ...active } : null;
  }
}

module.exports = CandleAggregator;
