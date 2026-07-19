// ---------------------------------------------------------------------------
// Wire protocol constants (SHARED — the client ↔ distribution-server contract)
//
// Isomorphic module. Both sides of the wire import these instead of typing
// string literals, so the protocol is defined in exactly one place:
//
//   client -> server: { type: SUBSCRIBE | UNSUBSCRIBE, symbol }
//                     { type: SET_ALERT, id?, symbol, value, condition }
//                     { type: REMOVE_ALERT, id }
//   server -> client: { type: UPDATE, data: goldenRecord }
//                     { type: FEED_STATUS, status, attempt?, delay? }
//                     { type: ALERT_CONFIRMED | ALERT_REMOVED | ALERT_TRIGGERED, data }
//
// The direct-mode adapter implements the same contract client-side, so the
// UI cannot tell which transport it is on.
// ---------------------------------------------------------------------------

// Client -> server message types
export const ClientMsg = {
  SUBSCRIBE: 'SUBSCRIBE',
  UNSUBSCRIBE: 'UNSUBSCRIBE',
  SET_ALERT: 'SET_ALERT',
  REMOVE_ALERT: 'REMOVE_ALERT',
};

// Server -> client message types
export const ServerMsg = {
  UPDATE: 'UPDATE',
  BOOK: 'BOOK', // L2 depth ladder view (top-N bids/asks + spread/mid/imbalance)
  FEED_STATUS: 'FEED_STATUS',
  ALERT_CONFIRMED: 'ALERT_CONFIRMED',
  ALERT_REMOVED: 'ALERT_REMOVED',
  ALERT_TRIGGERED: 'ALERT_TRIGGERED',
};

// Distribution policy: one UPDATE per symbol per interval, no matter how fast
// the upstream ticks (the frontend must never re-render per raw tick). Both
// the server relay and the direct-mode adapter flush on this cadence.
export const THROTTLE_MS = 300;
