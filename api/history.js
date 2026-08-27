// ---------------------------------------------------------------------------
// Serverless /api/history (Vercel function)
//
// The static deploy has no long-running backend, but it CAN run short-lived
// serverless functions. This one proxies Binance klines for chart backfill
// and lets Vercel's edge CDN absorb repeat traffic:
//
//   Cache-Control: s-maxage=30, stale-while-revalidate=120
//     -> the edge serves the cached copy for 30s, then keeps serving the
//        stale copy (instantly) while revalidating in the background.
//
// Result: N browsers loading the chart cost ~1 Binance call per symbol per
// 30s instead of N calls — the serverless + edge-caching pattern in one file.
// Reuses the same shared symbol pool and klines mapping as both runtimes.
// ---------------------------------------------------------------------------

import { SYMBOLS } from '../shared/symbols.js';
import { klinesToCandles } from '../shared/klines.js';
import { resolveTimeframe, isTimeframe, TIMEFRAMES } from '../shared/timeframes.js';

const BINANCE_REST_BASE = 'https://data-api.binance.vision/api/v3';

export default async function handler(req, res) {
  const symbol = (req.query.symbol || '').toUpperCase();
  const requested = req.query.interval;

  if (!SYMBOLS.includes(symbol)) {
    return res
      .status(400)
      .json({ error: `Invalid symbol. Configured symbols are: ${SYMBOLS.join(', ')}` });
  }
  if (requested !== undefined && !isTimeframe(requested)) {
    return res
      .status(400)
      .json({ error: `Invalid interval. Supported timeframes are: ${TIMEFRAMES.map((t) => t.id).join(', ')}` });
  }
  const timeframe = resolveTimeframe(requested);

  try {
    const url = `${BINANCE_REST_BASE}/klines?symbol=${symbol}&interval=${timeframe.id}&limit=${timeframe.limit}`;
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({ error: `Upstream returned status ${response.status}` });
    }
    const data = await response.json();

    // Cache per (symbol, interval) — a 1D bar is worth holding far longer at
    // the edge than a 1m one, so the TTL scales with the bucket width.
    const edgeTtl = Math.min(300, Math.max(30, Math.round(timeframe.ms / 4000)));
    res.setHeader('Cache-Control', `s-maxage=${edgeTtl}, stale-while-revalidate=${edgeTtl * 4}`);
    return res.status(200).json({ symbol, interval: timeframe.id, candles: klinesToCandles(data) });
  } catch (err) {
    return res.status(502).json({ error: `Failed to fetch history: ${err.message}` });
  }
}
