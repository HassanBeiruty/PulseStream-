// ---------------------------------------------------------------------------
// Phase 1 verification runner (NOT a production layer)
//
// Spins up the feed handler and acts as a dumb consumer of its 'raw' events so
// we can SEE that trades and bookTicker data are arriving, and watch the
// reconnect-with-backoff logic recover from a deliberately killed connection.
//
// It only listens to events — it never touches the WebSocket itself. That is
// the layer boundary the project is teaching: ingestion is the feed handler's
// job; everyone else just consumes what it emits.
//
// Usage:
//   node scripts/feed-demo.js                 run until Ctrl+C
//   FEED_DEMO_SECONDS=10 node ...             auto-exit after 10s (used for checks)
//   FEED_DEMO_KILL_AT=5  node ...             force a drop at 5s to test reconnect
// ---------------------------------------------------------------------------

import { BinanceFeedHandler } from '../server/feedHandler.js';

const runSeconds = Number(process.env.FEED_DEMO_SECONDS) || 0; // 0 = run forever
const killAt = Number(process.env.FEED_DEMO_KILL_AT) || 0; // 0 = don't simulate a drop

const feed = new BinanceFeedHandler();

// Counters + a few samples so the console shows real payloads without drowning
// in the firehose (BTC alone can tick dozens of times per second).
const counts = { trade: 0, bookTicker: 0, other: 0 };
const sampleShown = { trade: false, bookTicker: false };

feed.on('raw', ({ stream, data }) => {
  if (stream.endsWith('@trade')) {
    counts.trade += 1;
    if (!sampleShown.trade) {
      sampleShown.trade = true;
      // Raw Binance trade shape: s=symbol, p=price, q=qty, T=trade time, m=isBuyerMaker
      console.log(`[demo] sample @trade  ${stream} ->`, JSON.stringify(data));
    }
  } else if (stream.endsWith('@bookTicker')) {
    counts.bookTicker += 1;
    if (!sampleShown.bookTicker) {
      sampleShown.bookTicker = true;
      // Raw Binance bookTicker shape: s=symbol, b/B=best bid px/qty, a/A=best ask px/qty
      console.log(`[demo] sample @bookTicker  ${stream} ->`, JSON.stringify(data));
    }
  } else {
    counts.other += 1;
  }
});

feed.on('open', () => console.log('[demo] feed reports OPEN'));
feed.on('reconnecting', ({ attempt, delay }) =>
  console.log(`[demo] feed reports RECONNECTING (attempt ${attempt}, ${delay}ms)`)
);
feed.on('stale', ({ silentMs }) => console.log(`[demo] feed reports STALE (${silentMs}ms silent)`));

// Periodic heartbeat so we can confirm a steady flow of both stream types.
const summary = setInterval(() => {
  console.log(`[demo] counts -> trades=${counts.trade}  bookTicker=${counts.bookTicker}  other=${counts.other}`);
}, 2000);

feed.start();

if (killAt > 0) {
  setTimeout(() => feed.simulateDrop(), killAt * 1000);
}

function shutdown() {
  clearInterval(summary);
  feed.stop();
  console.log(`[demo] final counts -> trades=${counts.trade}  bookTicker=${counts.bookTicker}  other=${counts.other}`);
  process.exit(0);
}

if (runSeconds > 0) {
  setTimeout(shutdown, runSeconds * 1000);
}
process.on('SIGINT', shutdown);
