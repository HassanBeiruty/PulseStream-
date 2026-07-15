// ---------------------------------------------------------------------------
// Display formatting helpers (frontend-only, presentation concerns)
//
// Directional values are ALWAYS returned with an explicit sign and an arrow so
// color is never the only channel carrying up/down (colorblind-safe rule from
// the design pass).
// ---------------------------------------------------------------------------

export function formatPrice(val, maxDecimals = 4) {
  if (val === null || val === undefined || Number.isNaN(val)) return '—';
  return val.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxDecimals,
  });
}

/**
 * Change vs a baseline as { text: "▲ +1.24%", dir: "up" | "down" | "flat" }.
 * Returns null when either side is missing.
 */
export function formatDeltaPct(current, baseline) {
  if (
    current === null || current === undefined ||
    baseline === null || baseline === undefined ||
    baseline === 0
  ) {
    return null;
  }
  const pct = ((current - baseline) / baseline) * 100;
  if (pct > 0) return { text: `▲ +${pct.toFixed(2)}%`, dir: 'up' };
  if (pct < 0) return { text: `▼ −${Math.abs(pct).toFixed(2)}%`, dir: 'down' };
  return { text: '0.00%', dir: 'flat' };
}

export function formatTime(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleTimeString();
}

/**
 * Signed number for P&L columns: { text: "+1.23" | "−1.23" | "0.00", dir }.
 * Always signed so color is never the only up/down channel.
 */
export function formatSigned(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return { text: '—', dir: 'flat' };
  }
  const rounded = Number(value.toFixed(decimals));
  if (rounded > 0) return { text: `+${rounded.toFixed(decimals)}`, dir: 'up' };
  if (rounded < 0) return { text: `−${Math.abs(rounded).toFixed(decimals)}`, dir: 'down' };
  return { text: (0).toFixed(decimals), dir: 'flat' };
}

/** Trade quantity: up to 6 decimals, trailing zeros trimmed. */
export function formatQty(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return parseFloat(value.toFixed(6)).toString();
}

/** Bid/ask spread, plus basis points vs the mid — classic trading readout. */
export function spreadInfo(bestBid, bestAsk) {
  if (
    bestBid === null || bestBid === undefined ||
    bestAsk === null || bestAsk === undefined
  ) {
    return null;
  }
  const spread = bestAsk - bestBid;
  const mid = (bestAsk + bestBid) / 2;
  const bps = mid > 0 ? (spread / mid) * 10000 : 0;
  return { spread, mid, bps };
}
