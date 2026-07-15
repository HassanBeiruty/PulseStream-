// ---------------------------------------------------------------------------
// Alert book (SHARED, isomorphic — a hub CONSUMER concern)
//
// Owns a set of registered price alerts and evaluates them against incoming
// ticks. Semantics (identical on both sides of the wire, because it IS the
// same code):
//
//   - ABOVE triggers when price >= value; BELOW when price <= value.
//   - An alert triggers ONCE, then is discarded.
//   - Removing a symbol's subscription discards its alerts.
//
// Before Phase 7 this logic was written twice: inline in server/index.js
// (per-client) and again in frontend/src/directFeed.js.
// ---------------------------------------------------------------------------

function randomId() {
  return Math.random().toString(36).substring(2, 9);
}

export class AlertBook {
  constructor() {
    this.alerts = []; // Array<{ id, symbol, value, condition }>
  }

  /**
   * Register an alert. Returns the normalized alert, or null if invalid.
   *
   * @param {object} params - { id?, symbol, value, condition? }
   * @returns {object|null}
   */
  set({ id, symbol, value, condition } = {}) {
    if (!symbol) return null;
    const numValue = parseFloat(value);
    if (Number.isNaN(numValue)) return null;

    const alert = {
      id: id || randomId(),
      symbol: symbol.toUpperCase(),
      value: numValue,
      condition: (condition || 'ABOVE').toUpperCase(),
    };
    this.alerts.push(alert);
    return { ...alert };
  }

  /**
   * Remove an alert by id. Returns the removed alert, or null if not found.
   *
   * @param {string} id
   * @returns {object|null}
   */
  remove(id) {
    const index = this.alerts.findIndex((a) => a.id === id);
    if (index === -1) return null;
    return this.alerts.splice(index, 1)[0];
  }

  /**
   * Discard every alert registered for a symbol (used on UNSUBSCRIBE).
   *
   * @param {string} symbol
   */
  removeForSymbol(symbol) {
    const sym = symbol.toUpperCase();
    this.alerts = this.alerts.filter((a) => a.symbol !== sym);
  }

  /**
   * Evaluate a tick against the book. Triggered alerts are removed from the
   * book (trigger once) and returned with the triggering price attached.
   *
   * @param {string} symbol
   * @param {number|null|undefined} price
   * @returns {object[]} triggered alerts as { id, symbol, value, condition, price }
   */
  evaluate(symbol, price) {
    if (price === null || price === undefined) return [];
    const sym = symbol.toUpperCase();
    const triggered = [];

    for (let i = this.alerts.length - 1; i >= 0; i--) {
      const alert = this.alerts[i];
      if (alert.symbol !== sym) continue;
      const hit =
        (alert.condition === 'ABOVE' && price >= alert.value) ||
        (alert.condition === 'BELOW' && price <= alert.value);
      if (hit) {
        triggered.push({ ...alert, price });
        this.alerts.splice(i, 1);
      }
    }
    return triggered;
  }
}
