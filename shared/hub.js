// ---------------------------------------------------------------------------
// Hub / pub-sub broker (DISTRIBUTION layer — SHARED, isomorphic)
//
// Holds the current normalized state per symbol (the "golden record") in
// memory, and allows internal consumers to subscribe and unsubscribe to
// specific symbols. When the normalizer processes an upstream message and
// updates a symbol's fields, the hub merges the update into the golden record
// and pushes the complete, updated record to all subscribers of that symbol.
//
// Features:
//   - Multiplexes a single upstream data stream to multiple internal consumers.
//   - Decoupled from the upstream data source and the downstream transports.
//   - Decoupled from config too: the symbol pool is INJECTED via the
//     constructor, so the same class runs in Node (hub mode) and in the
//     browser (direct mode) without touching server config.
// ---------------------------------------------------------------------------

/** The empty golden-record shape every consumer can rely on. */
export function createEmptyRecord(symbol) {
  return {
    symbol,
    lastPrice: null,
    bestBid: null,
    bestAsk: null,
    lastTradeTime: null,
    activeCandle: null,
    open24h: null,
    high24h: null,
    low24h: null,
    volume24h: null,
    sessionVwap: null,
    source: null,
  };
}

export class Hub {
  /**
   * @param {string[]} [symbols] - symbol pool to pre-initialize golden records for
   */
  constructor(symbols = []) {
    // Stores the golden record for each symbol: Map<string, object>
    this.records = new Map();
    // Stores subscription callbacks: Map<string, Set<Function>>
    this.subscriptions = new Map();

    for (const sym of symbols) {
      const upperSym = sym.toUpperCase();
      this.records.set(upperSym, createEmptyRecord(upperSym));
    }
  }

  /**
   * Merges a normalized update into the symbol's golden record,
   * then publishes the updated golden record to all active subscribers.
   *
   * @param {object} update - The normalized update object containing symbol
   */
  update(update) {
    if (!update || !update.symbol) return;

    const sym = update.symbol.toUpperCase();
    let record = this.records.get(sym);

    if (!record) {
      // If we encounter a new symbol outside the pre-configured ones, initialize it
      record = createEmptyRecord(sym);
      this.records.set(sym, record);
    }

    // Merge the partial updates (e.g. trades merge lastPrice, bookTickers merge bestBid/bestAsk)
    Object.assign(record, update);

    // Get subscribers for this symbol
    const callbacks = this.subscriptions.get(sym);
    if (callbacks && callbacks.size > 0) {
      // Create a shallow copy to prevent subscribers from mutating the golden record directly
      const recordCopy = { ...record };
      for (const callback of callbacks) {
        try {
          callback(recordCopy);
        } catch (err) {
          console.error(`[hub] Error executing subscriber callback for ${sym}:`, err);
        }
      }
    }
  }

  /**
   * Subscribe a callback function to updates for a specific symbol.
   * Returns a function that unsubscribes the callback.
   *
   * @param {string} symbol - The symbol to subscribe to (e.g. "BTCUSDT")
   * @param {Function} callback - Callback function that receives the updated golden record
   * @returns {Function} Unsubscribe function
   */
  subscribe(symbol, callback) {
    const sym = symbol.toUpperCase();
    if (!this.subscriptions.has(sym)) {
      this.subscriptions.set(sym, new Set());
    }
    this.subscriptions.get(sym).add(callback);

    // Return unsubscribe convenience function
    return () => this.unsubscribe(sym, callback);
  }

  /**
   * Unsubscribe a callback function from updates for a specific symbol.
   *
   * @param {string} symbol
   * @param {Function} callback
   */
  unsubscribe(symbol, callback) {
    const sym = symbol.toUpperCase();
    const callbacks = this.subscriptions.get(sym);
    if (callbacks) {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.subscriptions.delete(sym);
      }
    }
  }

  /**
   * Get the current in-memory golden record for a symbol.
   *
   * @param {string} symbol
   * @returns {object|null} A copy of the golden record, or null if not found
   */
  getGoldenRecord(symbol) {
    const sym = symbol.toUpperCase();
    const record = this.records.get(sym);
    return record ? { ...record } : null;
  }
}
