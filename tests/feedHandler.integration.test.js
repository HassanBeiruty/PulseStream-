import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { BinanceFeedHandler } from '../server/feedHandler.js';

// Integration test against a MOCK EXCHANGE: a local WebSocket server standing
// in for Binance. Proves the ingestion layer's three core behaviours —
// message forwarding, reconnect-with-backoff after a drop, and the staleness
// watchdog forcing a reconnect on a silent (half-open) connection.

function waitFor(emitter, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), timeoutMs);
    emitter.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('feed handler vs mock exchange', () => {
  let wss;
  let port;
  let feed;
  let connections;

  beforeEach(async () => {
    connections = [];
    wss = new WebSocketServer({ port: 0 });
    await new Promise((resolve) => wss.once('listening', resolve));
    port = wss.address().port;
    wss.on('connection', (socket) => connections.push(socket));
  });

  afterEach(async () => {
    if (feed) feed.stop();
    await new Promise((resolve) => wss.close(resolve));
  });

  function startFeed(opts = {}) {
    feed = new BinanceFeedHandler({
      symbols: ['TESTUSDT'],
      wsBase: `ws://127.0.0.1:${port}/stream`,
      baseDelayMs: 20,
      maxDelayMs: 40,
      stalenessMs: 300,
      ...opts,
    });
    feed.start();
    return feed;
  }

  it('connects and forwards combined-stream frames as raw events', async () => {
    startFeed();
    await waitFor(feed, 'open');

    const rawPromise = waitFor(feed, 'raw');
    connections[0].send(
      JSON.stringify({
        stream: 'testusdt@trade',
        data: { s: 'TESTUSDT', p: '100.5', q: '2', T: 1784146817430 },
      })
    );

    const { stream, data } = await rawPromise;
    expect(stream).toBe('testusdt@trade');
    expect(data.p).toBe('100.5');
  });

  it('ignores frames that are not combined-stream shaped', async () => {
    startFeed();
    await waitFor(feed, 'open');

    let rawCount = 0;
    feed.on('raw', () => rawCount++);
    connections[0].send(JSON.stringify({ result: null, id: 1 })); // subscribe ack
    connections[0].send('not json at all');
    connections[0].send(JSON.stringify({ stream: 'testusdt@trade', data: { s: 'TESTUSDT', p: '1', q: '1', T: 1 } }));

    await waitFor(feed, 'raw');
    expect(rawCount).toBe(1);
  });

  it('reconnects with backoff after the exchange drops the connection', async () => {
    startFeed();
    await waitFor(feed, 'open');
    expect(connections).toHaveLength(1);

    const reconnecting = waitFor(feed, 'reconnecting');
    const reopened = waitFor(feed, 'open');
    connections[0].close(); // exchange kills us

    const info = await reconnecting;
    expect(info.attempt).toBe(1);
    expect(info.delay).toBeLessThanOrEqual(40);

    await reopened; // proves a SECOND connection was established
    expect(connections.length).toBeGreaterThanOrEqual(2);
  });

  it('detects a silent half-open connection via staleness and forces a reconnect', async () => {
    startFeed();
    await waitFor(feed, 'open');

    // Send one frame so lastMessageAt is set, then go silent
    connections[0].send(JSON.stringify({ stream: 'testusdt@trade', data: { s: 'TESTUSDT', p: '1', q: '1', T: 1 } }));
    await waitFor(feed, 'raw');

    const stale = await waitFor(feed, 'stale', 5000); // watchdog fires after stalenessMs
    expect(stale.silentMs).toBeGreaterThanOrEqual(300);

    await waitFor(feed, 'open', 5000); // and the feed recovers on its own
    expect(connections.length).toBeGreaterThanOrEqual(2);
  });
});
