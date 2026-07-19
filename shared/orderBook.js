// ---------------------------------------------------------------------------
// L2 Order Book (SHARED, isomorphic) — snapshot + delta synchronization
//
// The hardest core problem in market data: keeping a correct local mirror of
// remote state over an unreliable stream. Implements Binance's documented
// algorithm for maintaining a local depth book:
//
//   1. Stream @depth diff events; BUFFER them while unsynced.
//   2. Fetch a REST depth snapshot (lastUpdateId + full bid/ask levels).
//   3. Drop buffered events with u <= lastUpdateId (already in the snapshot).
//   4. The first applied event must bracket the snapshot:
//        U <= lastUpdateId + 1 <= u          — otherwise the snapshot is too
//        old/new relative to the buffer -> resync with a fresh snapshot.
//   5. Each subsequent event must continue the sequence (U <= lastUpdateId+1);
//      a jump means a DROPPED event -> the book is silently wrong -> resync.
//   6. Deltas carry ABSOLUTE quantities per price level; qty 0 deletes.
//
// OrderBook = the pure data structure + sequence rules (fully unit-testable).
// OrderBookManager = the driver: owns books per symbol, fetches snapshots
// (fetch function is INJECTED so both runtimes and tests control I/O), and
// publishes top-of-book views. Runs in Node (hub mode) and the browser
// (direct mode) — the same code, like every other pipeline stage.
// ---------------------------------------------------------------------------

import { isValidDepthUpdate } from './schema.js';

export class OrderBook {
  constructor(symbol) {
    this.symbol = symbol.toUpperCase();
    this.reset();
  }

  reset() {
    this.bids = new Map(); // price -> qty (absolute)
    this.asks = new Map();
    this.lastUpdateId = 0;
    this.synced = false;
    this.buffer = []; // diff events queued while waiting for a snapshot
  }

  /**
   * Seed the book from a REST snapshot, then drain the buffered diffs.
   * @returns {'synced'|'gap'} 'gap' means the buffer didn't bracket the
   * snapshot — caller must fetch a fresh snapshot and try again.
   */
  applySnapshot({ lastUpdateId, bids, asks }) {
    this.bids.clear();
    this.asks.clear();
    for (const [price, qty] of bids) this.bids.set(parseFloat(price), parseFloat(qty));
    for (const [price, qty] of asks) this.asks.set(parseFloat(price), parseFloat(qty));
    this.lastUpdateId = lastUpdateId;
    this.synced = true;

    // Drain the buffer under the sequencing rules
    const queued = this.buffer;
    this.buffer = [];
    for (const event of queued) {
      const result = this.applyDiff(event);
      if (result === 'gap') return 'gap'; // book reset by applyDiff
    }
    return 'synced';
  }

  /**
   * Apply one @depth diff event.
   * @returns {'applied'|'buffered'|'ignored'|'gap'}
   */
  applyDiff(event) {
    if (!isValidDepthUpdate(event)) return 'ignored';

    if (!this.synced) {
      this.buffer.push(event);
      if (this.buffer.length > 1000) this.buffer.shift(); // bounded queue
      return 'buffered';
    }

    // Entirely before our snapshot — already reflected in the book
    if (event.u <= this.lastUpdateId) return 'ignored';

    // Sequence gap: an event we never saw moved the book. Ours is now
    // silently wrong — the only safe move is a full resync.
    if (event.U > this.lastUpdateId + 1) {
      this.reset();
      this.buffer.push(event); // this event seeds the next sync round
      return 'gap';
    }

    this.applyLevels(this.bids, event.b);
    this.applyLevels(this.asks, event.a);
    this.lastUpdateId = event.u;
    return 'applied';
  }

  applyLevels(side, levels) {
    for (const [priceStr, qtyStr] of levels) {
      const price = parseFloat(priceStr);
      const qty = parseFloat(qtyStr);
      if (qty === 0) side.delete(price);
      else side.set(price, qty);
    }
  }

  /** Top-N view: bids descending, asks ascending — the ladder. */
  top(n = 10) {
    const bids = [...this.bids.entries()]
      .sort((a, b) => b[0] - a[0])
      .slice(0, n)
      .map(([price, qty]) => ({ price, qty }));
    const asks = [...this.asks.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, n)
      .map(([price, qty]) => ({ price, qty }));
    return { bids, asks };
  }

  /** Spread / mid / order-book imbalance over the top-N levels. */
  stats(n = 10) {
    const { bids, asks } = this.top(n);
    if (bids.length === 0 || asks.length === 0) return null;

    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    const spread = bestAsk - bestBid;
    const mid = (bestAsk + bestBid) / 2;
    const bidQty = bids.reduce((sum, l) => sum + l.qty, 0);
    const askQty = asks.reduce((sum, l) => sum + l.qty, 0);
    // Imbalance in [-1, +1]: +1 = all resting size is bids (buy pressure)
    const imbalance = bidQty + askQty > 0 ? (bidQty - askQty) / (bidQty + askQty) : 0;

    return { bestBid, bestAsk, spread, mid, bidQty, askQty, imbalance };
  }
}

export class OrderBookManager {
  /**
   * @param {object} opts
   * @param {(symbol: string) => Promise<{lastUpdateId:number,bids:Array,asks:Array}>} opts.fetchSnapshot
   * @param {(view: object) => void} opts.onBook - called with the top-N view after each applied diff
   * @param {number} [opts.topN]
   * @param {number} [opts.resyncDelayMs] - backoff before retrying a failed/gapped snapshot
   */
  constructor({ fetchSnapshot, onBook, topN = 10, resyncDelayMs = 1000 }) {
    this.fetchSnapshot = fetchSnapshot;
    this.onBook = onBook;
    this.topN = topN;
    this.resyncDelayMs = resyncDelayMs;
    this.books = new Map(); // symbol -> OrderBook
    this.fetching = new Set(); // symbols with a snapshot request in flight
  }

  book(symbol) {
    const sym = symbol.toUpperCase();
    let book = this.books.get(sym);
    if (!book) {
      book = new OrderBook(sym);
      this.books.set(sym, book);
    }
    return book;
  }

  /** Feed one raw @depth diff event in (from either runtime's feed handler). */
  handleDiff(symbol, event) {
    const book = this.book(symbol);
    const result = book.applyDiff(event);

    if (result === 'applied') {
      this.publish(book);
    } else if (result === 'buffered' || result === 'gap') {
      this.ensureSnapshot(book.symbol);
    }
    return result;
  }

  publish(book) {
    const stats = book.stats(this.topN);
    if (!stats) return;
    this.onBook({
      symbol: book.symbol,
      ...book.top(this.topN),
      ...stats,
      lastUpdateId: book.lastUpdateId,
    });
  }

  async ensureSnapshot(symbol) {
    if (this.fetching.has(symbol)) return;
    this.fetching.add(symbol);
    try {
      const snapshot = await this.fetchSnapshot(symbol);
      const book = this.book(symbol);
      const result = book.applySnapshot(snapshot);
      if (result === 'gap') {
        // Snapshot didn't bracket the buffered events — retry after a pause
        setTimeout(() => this.ensureSnapshot(symbol), this.resyncDelayMs);
      } else {
        this.publish(book);
      }
    } catch {
      // Snapshot fetch failed (rate limit / network) — retry after a pause
      setTimeout(() => this.ensureSnapshot(symbol), this.resyncDelayMs);
    } finally {
      this.fetching.delete(symbol);
    }
  }
}
