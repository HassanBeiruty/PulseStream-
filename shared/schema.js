// ---------------------------------------------------------------------------
// Exchange-message schema validation (SHARED, isomorphic — the feed BOUNDARY)
//
// Raw exchange payloads are untrusted input: a malformed frame must be
// rejected loudly at the boundary, never allowed to seed NaN prices into the
// golden records downstream. Hand-rolled (no dependency) — each validator
// checks exactly the fields the normalizer / order book will read.
// ---------------------------------------------------------------------------

// Binance sends prices/quantities as numeric STRINGS ("65000.10")
function isNumericString(v) {
  return typeof v === 'string' && v !== '' && !Number.isNaN(Number(v));
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** @trade payload: s, p (price), q (qty), T (trade time ms) */
export function isValidTrade(data) {
  return (
    !!data &&
    typeof data.s === 'string' &&
    data.s.length > 0 &&
    isNumericString(data.p) &&
    isNumericString(data.q) &&
    isFiniteNumber(data.T)
  );
}

/** @bookTicker payload: s, b (best bid), a (best ask) */
export function isValidBookTicker(data) {
  return (
    !!data &&
    typeof data.s === 'string' &&
    data.s.length > 0 &&
    isNumericString(data.b) &&
    isNumericString(data.a)
  );
}

/** @miniTicker payload: s, o/h/l (24h open/high/low), v (24h base volume) */
export function isValidMiniTicker(data) {
  return (
    !!data &&
    typeof data.s === 'string' &&
    data.s.length > 0 &&
    isNumericString(data.o) &&
    isNumericString(data.h) &&
    isNumericString(data.l) &&
    isNumericString(data.v)
  );
}

/** @depth diff payload: s, U/u (first/final update id), b/a (level arrays) */
export function isValidDepthUpdate(data) {
  return (
    !!data &&
    typeof data.s === 'string' &&
    data.s.length > 0 &&
    isFiniteNumber(data.U) &&
    isFiniteNumber(data.u) &&
    data.u >= data.U &&
    Array.isArray(data.b) &&
    Array.isArray(data.a)
  );
}
