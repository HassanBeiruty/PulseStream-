// ---------------------------------------------------------------------------
// Phase 2 verification runner (NOT a production layer)
//
// Wires up Feed Handler -> Normalizer -> Hub and subscribes to the Hub to
// show that raw messages from multiple independent streams (trades and bookTicker)
// correctly merge into a single "golden record" state.
//
// Usage:
//   node scripts/hub-demo.js                 run until Ctrl+C
//   FEED_DEMO_SECONDS=10 node ...             auto-exit after 10s (used for checks)
//   FEED_DEMO_KILL_AT=5  node ...             force a drop at 5s to test reconnect
// ---------------------------------------------------------------------------

const { BinanceFeedHandler } = require('../server/feedHandler');
const { normalize } = require('../server/normalizer');
const Hub = require('../server/hub');
const config = require('../server/config');

const runSeconds = Number(process.env.FEED_DEMO_SECONDS) || 0; // 0 = run forever
const killAt = Number(process.env.FEED_DEMO_KILL_AT) || 0;     // 0 = don't simulate a drop

const feed = new BinanceFeedHandler();
const hub = new Hub();

// Counters to show statistics at the end
const counts = { raw: 0, normalized: 0 };
const symbolUpdateCounts = {};
for (const sym of config.symbols) {
  symbolUpdateCounts[sym.toUpperCase()] = 0;
}

// 1. Wire the Feed Handler to the Normalizer, and the Normalizer to the Hub.
feed.on('raw', ({ stream, data }) => {
  counts.raw += 1;
  const update = normalize(stream, data);
  if (update) {
    counts.normalized += 1;
    hub.update(update);
  }
});

// 2. Subscribe to the Hub for updates to each configured symbol.
const unsubscribes = [];
for (const sym of config.symbols) {
  const upperSym = sym.toUpperCase();
  const unsub = hub.subscribe(upperSym, (record) => {
    symbolUpdateCounts[upperSym] += 1;

    // Log the first few updates in detail, then log summary messages to avoid terminal flooding.
    if (symbolUpdateCounts[upperSym] <= 3) {
      console.log(
        `[demo-sub] ${upperSym} Update #${symbolUpdateCounts[upperSym]}:\n` +
        `   Last Price: ${record.lastPrice ?? 'N/A'}\n` +
        `   Best Bid:   ${record.bestBid ?? 'N/A'}\n` +
        `   Best Ask:   ${record.bestAsk ?? 'N/A'}\n` +
        `   Trade Time: ${record.lastTradeTime ? new Date(record.lastTradeTime).toLocaleTimeString() : 'N/A'}\n` +
        `   Source:     ${record.source ?? 'N/A'}`
      );
    }
  });
  unsubscribes.push(unsub);
}

// Log general feed events for context
feed.on('open', () => console.log('[demo] feed reports OPEN'));
feed.on('reconnecting', ({ attempt, delay }) =>
  console.log(`[demo] feed reports RECONNECTING (attempt ${attempt}, ${delay}ms)`)
);
feed.on('stale', ({ silentMs }) => console.log(`[demo] feed reports STALE (${silentMs}ms silent)`));
feed.on('close', ({ code, reason }) => console.log(`[demo] feed reports CLOSED (code=${code})`));

// Periodic status summary
const summaryInterval = setInterval(() => {
  console.log(`\n--- Hub Status Summary ---`);
  console.log(`Messages received: Raw=${counts.raw} Normalized=${counts.normalized}`);
  for (const sym of config.symbols) {
    const record = hub.getGoldenRecord(sym);
    console.log(
      `${sym.padEnd(8)} | updates=${symbolUpdateCounts[sym.toUpperCase()]} ` +
      `| price=${(record.lastPrice ?? 'N/A').toString().padEnd(10)} ` +
      `| bid=${(record.bestBid ?? 'N/A').toString().padEnd(10)} ` +
      `| ask=${(record.bestAsk ?? 'N/A').toString().padEnd(10)}`
    );
  }
  console.log(`--------------------------\n`);
}, 3000);

console.log('[demo] starting Feed Handler...');
feed.start();

if (killAt > 0) {
  console.log(`[demo] scheduled connection drop in ${killAt} seconds`);
  setTimeout(() => feed.simulateDrop(), killAt * 1000);
}

function shutdown() {
  console.log('\n[demo] shutting down...');
  clearInterval(summaryInterval);
  
  // Unsubscribe all listeners from the Hub
  for (const unsub of unsubscribes) {
    unsub();
  }
  
  // Stop the feed handler
  feed.stop();

  console.log('\n--- Final Stats ---');
  console.log(`Raw updates received:        ${counts.raw}`);
  console.log(`Normalized updates processed: ${counts.normalized}`);
  for (const sym of config.symbols) {
    console.log(`Updates for ${sym.padEnd(8)}:       ${symbolUpdateCounts[sym.toUpperCase()]}`);
  }
  process.exit(0);
}

if (runSeconds > 0) {
  setTimeout(shutdown, runSeconds * 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
