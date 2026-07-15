// ---------------------------------------------------------------------------
// Emitter (SHARED utility)
//
// Minimal dependency-free event emitter that works in both Node and the
// browser (Node's `events` module isn't available in the browser bundle, and
// the DOM's EventTarget isn't ergonomic for plain data callbacks).
//
// on() returns an unsubscribe function — same convention as the hub.
// ---------------------------------------------------------------------------

export class Emitter {
  constructor() {
    this.listeners = new Map(); // event -> Set<Function>
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(callback);
      if (set.size === 0) this.listeners.delete(event);
    }
  }

  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy before iterating so a listener may unsubscribe itself mid-emit
    for (const callback of [...set]) {
      try {
        callback(payload);
      } catch (err) {
        console.error(`[emitter] listener error for "${event}":`, err);
      }
    }
  }
}
