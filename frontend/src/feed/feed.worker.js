// ---------------------------------------------------------------------------
// Direct-mode feed WORKER (Phase 10)
//
// Runs the ENTIRE direct-mode pipeline — browser feed handler -> shared
// normalizer -> candle aggregator -> VWAP -> hub -> order books -> alert
// book -> throttled flush — off the main thread, so the UI thread only
// renders. This is how real trading front-ends survive fast feeds: market
// data processing never competes with paint.
//
// Protocol with the main thread (see workerFeed.js, the port adapter):
//   main -> worker: { cmd: 'connect' } | { cmd: <DataFeed method>, args: [...] }
//   worker -> main: { event: <DataFeed event>, payload }
// ---------------------------------------------------------------------------

import { DirectBinanceFeed } from './directBinanceFeed.js';
import { SYMBOLS } from '../../../shared/symbols.js';

const FORWARDED_EVENTS = [
  'open',
  'close',
  'error',
  'update',
  'book',
  'feedStatus',
  'alertConfirmed',
  'alertRemoved',
  'alertTriggered',
  'metrics',
];

let feed = null;

self.onmessage = (e) => {
  const { cmd, args } = e.data || {};

  if (cmd === 'connect') {
    if (feed) return;
    feed = new DirectBinanceFeed(SYMBOLS);
    for (const event of FORWARDED_EVENTS) {
      feed.on(event, (payload) => {
        // Error objects aren't structured-cloneable — flatten them
        const safe =
          event === 'error' ? { message: String(payload?.message || 'feed error') } : payload;
        self.postMessage({ event, payload: safe });
      });
    }
    feed.connect();
    return;
  }

  if (feed && typeof feed[cmd] === 'function') {
    feed[cmd](...(args || []));
  }
};
