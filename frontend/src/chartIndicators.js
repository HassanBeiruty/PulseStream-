// ---------------------------------------------------------------------------
// Chart Indicators and Transforms
//
// Fast pure functions for computing technical indicators and alternate bar
// types (Heikin-Ashi) over candle series.
// ---------------------------------------------------------------------------

/**
 * Simple Moving Average (SMA)
 * @param {Array<{timestamp: number, close: number}>} candles
 * @param {number} period
 * @returns {Array<{x: number, y: number|null}>}
 */
export function calculateSMA(candles, period) {
  if (!candles || candles.length === 0) return [];
  const result = [];
  let sum = 0;

  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) {
      sum -= candles[i - period].close;
    }
    if (i >= period - 1) {
      result.push({ x: candles[i].timestamp, y: sum / period });
    } else {
      result.push({ x: candles[i].timestamp, y: null });
    }
  }
  return result;
}

/**
 * Exponential Moving Average (EMA)
 * @param {Array<{timestamp: number, close: number}>} candles
 * @param {number} period
 * @returns {Array<{x: number, y: number|null}>}
 */
export function calculateEMA(candles, period) {
  if (!candles || candles.length === 0) return [];
  const result = [];
  const multiplier = 2 / (period + 1);
  let ema = null;
  let sum = 0;

  for (let i = 0; i < candles.length; i++) {
    const price = candles[i].close;
    if (i < period - 1) {
      sum += price;
      result.push({ x: candles[i].timestamp, y: null });
    } else if (i === period - 1) {
      sum += price;
      ema = sum / period;
      result.push({ x: candles[i].timestamp, y: ema });
    } else {
      ema = (price - ema) * multiplier + ema;
      result.push({ x: candles[i].timestamp, y: ema });
    }
  }
  return result;
}

/**
 * Bollinger Bands (period = 20, multiplier = 2)
 * @param {Array<{timestamp: number, close: number}>} candles
 * @param {number} period
 * @param {number} stdDevMult
 * @returns {{
 *   middle: Array<{x: number, y: number|null}>,
 *   upper: Array<{x: number, y: number|null}>,
 *   lower: Array<{x: number, y: number|null}>
 * }}
 */
export function calculateBollingerBands(candles, period = 20, stdDevMult = 2) {
  if (!candles || candles.length === 0) {
    return { middle: [], upper: [], lower: [] };
  }

  const middle = [];
  const upper = [];
  const lower = [];

  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      middle.push({ x: candles[i].timestamp, y: null });
      upper.push({ x: candles[i].timestamp, y: null });
      lower.push({ x: candles[i].timestamp, y: null });
      continue;
    }

    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += candles[j].close;
    }
    const mean = sum / period;

    let varianceSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      varianceSum += Math.pow(candles[j].close - mean, 2);
    }
    const stdDev = Math.sqrt(varianceSum / period);

    middle.push({ x: candles[i].timestamp, y: mean });
    upper.push({ x: candles[i].timestamp, y: mean + stdDevMult * stdDev });
    lower.push({ x: candles[i].timestamp, y: mean - stdDevMult * stdDev });
  }

  return { middle, upper, lower };
}

/**
 * Heikin-Ashi candle transformer
 * @param {Array<object>} candles
 * @returns {Array<object>}
 */
export function toHeikinAshi(candles) {
  if (!candles || candles.length === 0) return [];
  const result = [];
  let prevHaOpen = null;
  let prevHaClose = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen =
      prevHaOpen !== null && prevHaClose !== null
        ? (prevHaOpen + prevHaClose) / 2
        : (c.open + c.close) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);

    result.push({
      ...c,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
    });

    prevHaOpen = haOpen;
    prevHaClose = haClose;
  }
  return result;
}
