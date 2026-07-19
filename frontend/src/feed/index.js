// ---------------------------------------------------------------------------
// DataFeed PORT + factory (ports & adapters / hexagonal architecture)
//
// This is the composition root of the frontend's data layer. The UI depends
// on ONE interface — the DataFeed port — and never on a concrete transport.
// Which adapter fulfils the port is decided here, once, at BUILD time:
//
//   - HubSocketFeed     (default)               WebSocket to OUR distribution
//                                               server — the full 4-layer hub.
//   - DirectBinanceFeed (VITE_DATA_MODE=direct) no backend exists (static
//                                               Vercel deploy), so the browser
//                                               runs the shared pipeline
//                                               itself against Binance.
//
// The DataFeed port (implemented by both adapters):
//
//   connect()                       open the feed (wire listeners FIRST)
//   close()                         dispose; emits 'close' like a real socket
//   isOpen()                        -> boolean
//   subscribe(symbol)               start receiving 'update' for symbol
//   unsubscribe(symbol)             stop + drop that symbol's alerts
//   setAlert({ id?, symbol, value, condition })
//   removeAlert(id)
//   on(event, cb)                   -> unsubscribe fn
//
// Events: 'open' | 'close' | 'error'
//         'update'         (goldenRecord)
//         'book'           (L2 view: { symbol, bids, asks, spread, mid, imbalance, ... })
//         'feedStatus'     ({ status, attempt?, delay? })
//         'alertConfirmed' | 'alertRemoved' | 'alertTriggered'  (data)
// ---------------------------------------------------------------------------

import { SYMBOLS } from '../../../shared/symbols.js';
import { HubSocketFeed } from './hubSocketFeed.js';
import { DirectBinanceFeed } from './directBinanceFeed.js';
import { WorkerFeed } from './workerFeed.js';

export const DIRECT_MODE = import.meta.env.VITE_DATA_MODE === 'direct';

function hubSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host =
    window.location.hostname === 'localhost' ? 'localhost:3000' : window.location.host;
  return `${protocol}//${host}`;
}

/** Build the DataFeed adapter for the current mode. */
export function createDataFeed() {
  if (DIRECT_MODE) {
    // Phase 10: run the whole pipeline in a Web Worker so the UI thread only
    // renders; fall back to in-thread processing where workers don't exist.
    if (typeof Worker !== 'undefined') {
      return new WorkerFeed();
    }
    return new DirectBinanceFeed(SYMBOLS);
  }
  return new HubSocketFeed(hubSocketUrl());
}

/** Human-readable description of where the feed will connect, for logs. */
export function feedTargetLabel() {
  if (DIRECT_MODE) {
    return 'Binance public stream (direct mode — no backend)';
  }
  return hubSocketUrl();
}
