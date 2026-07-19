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

const BINANCE_REST_BASE = 'https://data-api.binance.vision/api/v3';

export default async function handler(req, res) {
  const symbol = (req.query.symbol || '').toUpperCase();

  if (!SYMBOLS.includes(symbol)) {
    return res
      .status(400)
      .json({ error: `Invalid symbol. Configured symbols are: ${SYMBOLS.join(', ')}` });
  }

  try {
    const url = `${BINANCE_REST_BASE}/klines?symbol=${symbol}&interval=1m&limit=100`;
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({ error: `Upstream returned status ${response.status}` });
    }
    const data = await response.json();

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({ symbol, candles: klinesToCandles(data) });
  } catch (err) {
    return res.status(502).json({ error: `Failed to fetch history: ${err.message}` });
  }
}
