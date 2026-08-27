// ---------------------------------------------------------------------------
// Pro Financial Chart Drawing Engine
//
// TradingView-grade financial charting tools:
//   - Trendlines & Rays (with price/delta angles)
//   - Horizontal Support/Resistance (with Y-axis price badge)
//   - Fibonacci Retracement (0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0)
//   - Long / Short Position Tool (Risk/Reward R:R Calculator)
//   - Order Block / Supply-Demand Rectangles
//   - Price & Time Measurement Cards
//
// All coordinates are anchored in { time, price } and scale synchronously with
// pan/zoom.
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = 'pulsestream.drawings.v1.';

export const FIBONACCI_LEVELS = [
  { level: 0.0, color: 'rgba(120, 123, 134, 0.8)', label: '0.000' },
  { level: 0.236, color: 'rgba(242, 54, 69, 0.85)', label: '0.236' },
  { level: 0.382, color: 'rgba(245, 158, 11, 0.85)', label: '0.382' },
  { level: 0.5, color: 'rgba(8, 153, 129, 0.85)', label: '0.500' },
  { level: 0.618, color: 'rgba(255, 214, 0, 0.95)', label: '0.618 (Golden)' },
  { level: 0.786, color: 'rgba(41, 98, 255, 0.85)', label: '0.786' },
  { level: 1.0, color: 'rgba(120, 123, 134, 0.8)', label: '1.000' },
];

export function loadSavedDrawings(symbol) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + symbol.toUpperCase());
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function persistDrawings(symbol, drawings) {
  try {
    localStorage.setItem(STORAGE_PREFIX + symbol.toUpperCase(), JSON.stringify(drawings));
  } catch {
    // storage unavailable / full
  }
}

/**
 * Magnet Snap: Snaps cursor position to nearest candle OHLC within pixel threshold
 */
export function snapToCandle(pixelX, pixelY, chart, candles, threshold = 18) {
  if (!chart || !chart.scales.x || !chart.scales.y || !candles || candles.length === 0) {
    return null;
  }

  const xScale = chart.scales.x;
  const yScale = chart.scales.y;

  // Scan closest candle
  let bestCandle = null;
  let minDistance = Infinity;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const cPx = xScale.getPixelForValue(c.timestamp);
    const dist = Math.abs(cPx - pixelX);
    if (dist < minDistance) {
      minDistance = dist;
      bestCandle = c;
    }
  }

  if (!bestCandle || minDistance > threshold * 2.5) {
    return null;
  }

  // Check which price point (High, Low, Open, Close) is closest to pixelY
  const points = [
    { name: 'high', price: bestCandle.high },
    { name: 'low', price: bestCandle.low },
    { name: 'open', price: bestCandle.open },
    { name: 'close', price: bestCandle.close },
  ];

  let bestPrice = bestCandle.close;
  let minPyDist = Infinity;

  for (const pt of points) {
    const py = yScale.getPixelForValue(pt.price);
    const dy = Math.abs(py - pixelY);
    if (dy < minPyDist) {
      minPyDist = dy;
      bestPrice = pt.price;
    }
  }

  if (minPyDist <= threshold * 3) {
    return {
      time: bestCandle.timestamp,
      price: bestPrice,
      pixelX: xScale.getPixelForValue(bestCandle.timestamp),
      pixelY: yScale.getPixelForValue(bestPrice),
    };
  }

  return null;
}

/**
 * Hit testing helper: Find drawing under cursor
 */
export function findDrawingAtPixel(pixelX, pixelY, chart, drawings, threshold = 10) {
  if (!chart || !chart.scales.x || !chart.scales.y || !drawings || drawings.length === 0) {
    return null;
  }

  const xScale = chart.scales.x;
  const yScale = chart.scales.y;
  const { left, right } = chart.chartArea || {};

  for (let i = drawings.length - 1; i >= 0; i--) {
    const item = drawings[i];

    if (item.type === 'horizontal') {
      const y = yScale.getPixelForValue(item.price);
      if (Math.abs(y - pixelY) <= threshold) return item;
    } else if (item.type === 'trendline') {
      const x1 = xScale.getPixelForValue(item.start.time);
      const y1 = yScale.getPixelForValue(item.start.price);
      const x2 = xScale.getPixelForValue(item.end.time);
      const y2 = yScale.getPixelForValue(item.end.price);
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) {
        if (Math.hypot(pixelX - x1, pixelY - y1) <= threshold) return item;
      } else {
        let t = ((pixelX - x1) * dx + (pixelY - y1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const projX = x1 + t * dx;
        const projY = y1 + t * dy;
        if (Math.hypot(pixelX - projX, pixelY - projY) <= threshold) return item;
      }
    } else if (item.type === 'rectangle' || item.type === 'measure') {
      const x1 = xScale.getPixelForValue(item.start.time);
      const y1 = yScale.getPixelForValue(item.start.price);
      const x2 = xScale.getPixelForValue(item.end.time);
      const y2 = yScale.getPixelForValue(item.end.price);
      const minX = Math.min(x1, x2) - threshold;
      const maxX = Math.max(x1, x2) + threshold;
      const minY = Math.min(y1, y2) - threshold;
      const maxY = Math.max(y1, y2) + threshold;
      if (pixelX >= minX && pixelX <= maxX && pixelY >= minY && pixelY <= maxY) {
        return item;
      }
    } else if (item.type === 'fibonacci') {
      const yStart = yScale.getPixelForValue(item.start.price);
      const yEnd = yScale.getPixelForValue(item.end.price);
      const minY = Math.min(yStart, yEnd) - threshold;
      const maxY = Math.max(yStart, yEnd) + threshold;
      if (left !== undefined && pixelX >= left && pixelX <= right && pixelY >= minY && pixelY <= maxY) {
        return item;
      }
    } else if (item.type === 'position') {
      const entryY = yScale.getPixelForValue(item.entry.price);
      const targetY = yScale.getPixelForValue(item.target.price);
      const stopY = yScale.getPixelForValue(item.stop.price);
      const startX = xScale.getPixelForValue(item.entry.time);
      const endX = xScale.getPixelForValue(item.target.time || item.entry.time + 3600000 * 20);
      const px1 = Math.min(startX, endX) - threshold;
      const px2 = Math.max(startX, endX) + threshold;
      const topY = Math.min(entryY, targetY, stopY) - threshold;
      const botY = Math.max(entryY, targetY, stopY) + threshold;
      if (pixelX >= px1 && pixelX <= px2 && pixelY >= topY && pixelY <= botY) {
        return item;
      }
    }
  }

  return null;
}

/**
 * Render all drawings and active drawing preview on the chart canvas
 */
export function renderDrawings(ctx, chart, drawings, activeDrawing, selectedId) {
  if (!chart || !chart.chartArea || !chart.scales.x || !chart.scales.y) return;

  const { left, right, top, bottom } = chart.chartArea;
  const xScale = chart.scales.x;
  const yScale = chart.scales.y;

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  ctx.clip(); // Ensure drawings never bleed outside chart area

  const allItems = activeDrawing ? [...drawings, activeDrawing] : drawings;

  for (const item of allItems) {
    const isSelected = item.id === selectedId;
    const color = item.color || '#2962ff';

    if (item.type === 'trendline') {
      drawTrendline(ctx, xScale, yScale, item, isSelected, color);
    } else if (item.type === 'horizontal') {
      drawHorizontal(ctx, xScale, yScale, item, isSelected, color, left, right);
    } else if (item.type === 'fibonacci') {
      drawFibonacci(ctx, xScale, yScale, item, isSelected, left, right);
    } else if (item.type === 'rectangle') {
      drawRectangle(ctx, xScale, yScale, item, isSelected, color);
    } else if (item.type === 'position') {
      drawPosition(ctx, xScale, yScale, item, isSelected);
    } else if (item.type === 'measure') {
      drawMeasure(ctx, xScale, yScale, item);
    }
  }

  ctx.restore();
}

function drawHandle(ctx, x, y, color = '#2962ff') {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

function drawTrendline(ctx, xScale, yScale, item, isSelected, color) {
  const x1 = xScale.getPixelForValue(item.start.time);
  const y1 = yScale.getPixelForValue(item.start.price);
  const x2 = xScale.getPixelForValue(item.end.time);
  const y2 = yScale.getPixelForValue(item.end.price);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = isSelected ? 2.5 : 1.8;
  if (item.dashed) ctx.setLineDash([5, 5]);
  ctx.stroke();

  // Price delta tag in the middle
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const deltaPrice = item.end.price - item.start.price;
  const deltaPct = item.start.price ? (deltaPrice / item.start.price) * 100 : 0;
  const deltaText = `${deltaPrice >= 0 ? '+' : ''}${deltaPrice.toFixed(2)} (${deltaPct.toFixed(2)}%)`;

  ctx.font = "bold 9px 'JetBrains Mono', monospace";
  const tw = ctx.measureText(deltaText).width;
  ctx.fillStyle = 'rgba(23, 27, 38, 0.85)';
  ctx.fillRect(midX - tw / 2 - 4, midY - 14, tw + 8, 14);
  ctx.fillStyle = deltaPrice >= 0 ? '#089981' : '#f23645';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(deltaText, midX, midY - 7);

  if (isSelected) {
    drawHandle(ctx, x1, y1, color);
    drawHandle(ctx, x2, y2, color);
  }
  ctx.restore();
}

function drawHorizontal(ctx, xScale, yScale, item, isSelected, color, left, right) {
  const y = yScale.getPixelForValue(item.price);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.strokeStyle = color;
  ctx.lineWidth = isSelected ? 2 : 1.5;
  if (item.dashed) ctx.setLineDash([4, 4]);
  ctx.stroke();

  // Price pill on right side
  const priceText = item.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  ctx.font = "bold 9px 'JetBrains Mono', monospace";
  const tw = ctx.measureText(priceText).width;
  ctx.fillStyle = color;
  ctx.fillRect(right - tw - 12, y - 8, tw + 12, 16);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(priceText, right - (tw + 12) / 2, y);

  if (isSelected) {
    drawHandle(ctx, (left + right) / 2, y, color);
  }
  ctx.restore();
}

function drawFibonacci(ctx, xScale, yScale, item, isSelected, left, right) {
  const yStart = yScale.getPixelForValue(item.start.price);
  const yEnd = yScale.getPixelForValue(item.end.price);
  const priceDiff = item.end.price - item.start.price;

  ctx.save();

  // Draw levels and soft shaded bands
  let prevY = null;
  for (let i = 0; i < FIBONACCI_LEVELS.length; i++) {
    const { level, color, label } = FIBONACCI_LEVELS[i];
    const levelPrice = item.start.price + priceDiff * level;
    const y = yScale.getPixelForValue(levelPrice);

    // Shaded zone between levels
    if (prevY !== null) {
      ctx.fillStyle = color.replace('0.85', '0.06').replace('0.95', '0.09');
      ctx.fillRect(left, Math.min(prevY, y), right - left, Math.abs(y - prevY));
    }
    prevY = y;

    // Line
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.strokeStyle = color;
    ctx.lineWidth = level === 0.618 || level === 0.5 ? 1.5 : 1;
    ctx.setLineDash(level === 0 || level === 1 ? [] : [4, 4]);
    ctx.stroke();

    // Label & Price tag
    const txt = `${label} - ${levelPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    ctx.font = "bold 9px 'JetBrains Mono', monospace";
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(txt, left + 8, y - 2);
  }

  if (isSelected) {
    const startX = xScale.getPixelForValue(item.start.time);
    const endX = xScale.getPixelForValue(item.end.time);
    drawHandle(ctx, startX, yStart, '#ffd600');
    drawHandle(ctx, endX, yEnd, '#ffd600');
  }
  ctx.restore();
}

function drawRectangle(ctx, xScale, yScale, item, isSelected, color) {
  const x1 = xScale.getPixelForValue(item.start.time);
  const y1 = yScale.getPixelForValue(item.start.price);
  const x2 = xScale.getPixelForValue(item.end.time);
  const y2 = yScale.getPixelForValue(item.end.price);

  const rx = Math.min(x1, x2);
  const ry = Math.min(y1, y2);
  const rw = Math.abs(x2 - x1);
  const rh = Math.abs(y2 - y1);

  ctx.save();
  ctx.fillStyle = color.replace(')', ', 0.12)').replace('rgb', 'rgba');
  ctx.fillRect(rx, ry, rw, rh);

  ctx.strokeStyle = color;
  ctx.lineWidth = isSelected ? 2 : 1.5;
  if (item.dashed) ctx.setLineDash([4, 4]);
  ctx.strokeRect(rx, ry, rw, rh);

  // Label: Zone
  ctx.font = "bold 9px 'Outfit', sans-serif";
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(item.label || 'ORDER BLOCK / ZONE', rx + 6, ry + 4);

  if (isSelected) {
    drawHandle(ctx, x1, y1, color);
    drawHandle(ctx, x2, y2, color);
    drawHandle(ctx, x1, y2, color);
    drawHandle(ctx, x2, y1, color);
  }
  ctx.restore();
}

function drawPosition(ctx, xScale, yScale, item, isSelected) {
  const entryY = yScale.getPixelForValue(item.entry.price);
  const targetY = yScale.getPixelForValue(item.target.price);
  const stopY = yScale.getPixelForValue(item.stop.price);

  const startX = xScale.getPixelForValue(item.entry.time);
  const endX = xScale.getPixelForValue(item.target.time || item.entry.time + 3600000 * 20);
  const px1 = Math.min(startX, endX);
  const px2 = Math.max(startX, endX);
  const pw = Math.max(80, px2 - px1);

  const isLong = item.side !== 'short';
  const targetDiff = Math.abs(item.target.price - item.entry.price);
  const stopDiff = Math.abs(item.entry.price - item.stop.price);
  const rr = stopDiff > 0 ? (targetDiff / stopDiff).toFixed(2) : '—';

  const targetPct = item.entry.price ? ((targetDiff / item.entry.price) * 100).toFixed(2) : '0.00';
  const stopPct = item.entry.price ? ((stopDiff / item.entry.price) * 100).toFixed(2) : '0.00';

  ctx.save();

  // Target Zone (Green)
  const targetTop = Math.min(entryY, targetY);
  const targetH = Math.abs(targetY - entryY);
  ctx.fillStyle = 'rgba(8, 153, 129, 0.18)';
  ctx.fillRect(px1, targetTop, pw, targetH);
  ctx.strokeStyle = '#089981';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(px1, targetTop, pw, targetH);

  // Stop Zone (Red)
  const stopTop = Math.min(entryY, stopY);
  const stopH = Math.abs(stopY - entryY);
  ctx.fillStyle = 'rgba(242, 54, 69, 0.18)';
  ctx.fillRect(px1, stopTop, pw, stopH);
  ctx.strokeStyle = '#f23645';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(px1, stopTop, pw, stopH);

  // Entry Line
  ctx.beginPath();
  ctx.moveTo(px1, entryY);
  ctx.lineTo(px1 + pw, entryY);
  ctx.strokeStyle = '#d1d4dc';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.stroke();

  // R:R Badge in Center
  const cardW = 120;
  const cardH = 34;
  const cardX = px1 + pw / 2 - cardW / 2;
  const cardY = entryY - cardH / 2;

  ctx.fillStyle = '#1e222d';
  ctx.strokeStyle = '#2a2e39';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.fillRect(cardX, cardY, cardW, cardH);
  ctx.strokeRect(cardX, cardY, cardW, cardH);

  ctx.font = "bold 10px 'Outfit', sans-serif";
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${isLong ? 'LONG' : 'SHORT'} · R:R ${rr}`, px1 + pw / 2, cardY + 10);

  ctx.font = "9px 'JetBrains Mono', monospace";
  ctx.fillStyle = '#089981';
  ctx.fillText(`TP: +${targetPct}%`, px1 + pw / 2 - 28, cardY + 23);
  ctx.fillStyle = '#f23645';
  ctx.fillText(`SL: -${stopPct}%`, px1 + pw / 2 + 28, cardY + 23);

  if (isSelected) {
    drawHandle(ctx, px1 + pw / 2, targetY, '#089981');
    drawHandle(ctx, px1 + pw / 2, entryY, '#2962ff');
    drawHandle(ctx, px1 + pw / 2, stopY, '#f23645');
  }

  ctx.restore();
}

function drawMeasure(ctx, xScale, yScale, item) {
  const x1 = xScale.getPixelForValue(item.start.time);
  const y1 = yScale.getPixelForValue(item.start.price);
  const x2 = xScale.getPixelForValue(item.end.time);
  const y2 = yScale.getPixelForValue(item.end.price);

  const rx = Math.min(x1, x2);
  const ry = Math.min(y1, y2);
  const rw = Math.abs(x2 - x1);
  const rh = Math.abs(y2 - y1);

  const priceDiff = item.end.price - item.start.price;
  const deltaPct = item.start.price ? (priceDiff / item.start.price) * 100 : 0;
  const isUp = priceDiff >= 0;
  const timeDiffMs = Math.abs(item.end.time - item.start.time);
  const hours = (timeDiffMs / (1000 * 60 * 60)).toFixed(1);

  ctx.save();
  ctx.fillStyle = isUp ? 'rgba(8, 153, 129, 0.12)' : 'rgba(242, 54, 69, 0.12)';
  ctx.fillRect(rx, ry, rw, rh);

  ctx.strokeStyle = isUp ? '#089981' : '#f23645';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(rx, ry, rw, rh);

  // Measurement Card
  const cardW = 130;
  const cardH = 38;
  const cardX = (x1 + x2) / 2 - cardW / 2;
  const cardY = (y1 + y2) / 2 - cardH / 2;

  ctx.fillStyle = '#171b26';
  ctx.strokeStyle = isUp ? '#089981' : '#f23645';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.fillRect(cardX, cardY, cardW, cardH);
  ctx.strokeRect(cardX, cardY, cardW, cardH);

  ctx.font = "bold 10px 'JetBrains Mono', monospace";
  ctx.fillStyle = isUp ? '#089981' : '#f23645';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${isUp ? '+' : ''}${priceDiff.toFixed(2)} (${deltaPct.toFixed(2)}%)`, cardX + cardW / 2, cardY + 11);

  ctx.font = "9px 'Outfit', sans-serif";
  ctx.fillStyle = '#787b86';
  ctx.fillText(`Duration: ~${hours} hrs`, cardX + cardW / 2, cardY + 25);

  drawHandle(ctx, x1, y1, isUp ? '#089981' : '#f23645');
  drawHandle(ctx, x2, y2, isUp ? '#089981' : '#f23645');

  ctx.restore();
}
