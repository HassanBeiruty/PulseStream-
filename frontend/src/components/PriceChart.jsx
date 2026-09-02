import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { Chart, registerables } from 'chart.js';
import 'chartjs-adapter-date-fns';
import {
  CandlestickController,
  CandlestickElement,
  OhlcController,
  OhlcElement,
} from 'chartjs-chart-financial';
import { resolveTimeframe, bucketStart, foldCandle } from '../../../shared/timeframes.js';
import {
  calculateEMA,
  calculateSMA,
  calculateBollingerBands,
  toHeikinAshi,
} from '../chartIndicators.js';
import {
  renderDrawings,
  snapToCandle,
  findDrawingAtPixel,
} from '../drawingEngine.js';

Chart.register(
  ...registerables,
  CandlestickController,
  CandlestickElement,
  OhlcController,
  OhlcElement
);

// TradingView Pro Palette
const UP = '#089981';
const DOWN = '#f23645';
const NEUTRAL = '#787b86';
const GRID = 'rgba(42, 46, 57, 0.45)';
const CANDLE_COLORS = { up: UP, down: DOWN, unchanged: NEUTRAL };

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POINTS = 1500;

// ---------------------------------------------------------------------------
// Interaction "feel" knobs.
//
// A pro chart never re-renders straight off a DOM event: wheel/pointer events
// only move a TARGET viewport, and one requestAnimationFrame tick eases the
// live viewport toward it and repaints once. That is what keeps zoom/pan at a
// steady 60fps instead of firing a full Chart.js update per event.
// ---------------------------------------------------------------------------
const DEFAULT_BARS = 180; // bars visible on a fresh chart (terminals never cram 500)
const MIN_BARS = 10; // hard zoom-in stop
const MAX_BARS = 2200; // hard zoom-out stop
const RIGHT_PAD_BARS = 6; // empty space kept to the right of the newest bar
const SLICE_MARGIN = 4; // bars rendered just outside the viewport
const ZOOM_EASE = 0.32; // viewport lerp per 16.7ms toward the zoom target
const Y_EASE = 0.24; // price-axis lerp — stops the vertical jitter while panning
const WHEEL_SENSITIVITY = 0.2;

const EMPTY_DRAWINGS = [];

const toFinancialPoint = (c) => ({ x: c.timestamp, o: c.open, h: c.high, l: c.low, c: c.close });
const toLinePoint = (c) => ({ x: c.timestamp, y: c.close });

const DISPLAY_FORMATS = {
  minute: 'HH:mm',
  hour: 'HH:mm',
  day: 'MMM d',
  week: 'MMM d',
  month: 'MMM',
  year: 'yyyy',
};

const tooltipFormatFor = (tf) => (tf.ms >= DAY_MS ? 'MMM d, yyyy' : 'MMM d, HH:mm');

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** First index whose candle timestamp is >= t (binary search; candles are sorted). */
function lowerBound(candles, t) {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].timestamp < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Replace the trailing candle, or append if this is a newer bucket. */
function upsertCandle(candles, candle) {
  const last = candles[candles.length - 1];
  if (!last || candle.timestamp > last.timestamp) {
    candles.push(candle);
    if (candles.length > MAX_POINTS) candles.shift();
    return true;
  }
  if (candle.timestamp === last.timestamp) {
    candles[candles.length - 1] = candle;
  }
  return false;
}

/** Index window of the candles visible in [min, max], plus a little slack. */
function visibleRange(candles, min, max) {
  let i0 = Math.max(0, lowerBound(candles, min) - SLICE_MARGIN);
  let i1 = Math.min(candles.length, lowerBound(candles, max) + SLICE_MARGIN);
  if (i1 - i0 < 2) {
    i0 = Math.max(0, candles.length - 2);
    i1 = candles.length;
  }
  return { i0, i1 };
}

/** Price + volume extents of one index window — what the axes should show. */
function computeVisualFit(candles, fitSource, i0, i1) {
  let lo = Infinity;
  let hi = -Infinity;
  let volMax = 0;
  for (let i = i0; i < i1; i++) {
    const c = fitSource[i];
    if (!c) continue;
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
    const v = candles[i].volume || 0;
    if (v > volMax) volMax = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.002 || 1;
  return { yMin: lo - pad, yMax: hi + pad, volMax };
}

/** The newest `bars` candles with a little air to the right of the last one. */
function defaultWindowFor(candles, tfMs, bars = DEFAULT_BARS) {
  if (candles.length === 0) return null;
  const first = candles[0].timestamp;
  const last = candles[candles.length - 1].timestamp;
  return {
    min: Math.max(first - tfMs, last - tfMs * Math.min(bars, candles.length)),
    max: last + tfMs * RIGHT_PAD_BARS,
  };
}

/**
 * Build every dataset AND a parallel "layout" holding the FULL series arrays.
 *
 * The chart itself only ever carries the visible slice (see applySlice) — that
 * is the difference between drawing ~150 candles a frame and drawing 1500.
 */
function computeLayout(candles, cfg, vwapValue) {
  const { chartType, indicators, showVwap, symbol, tf } = cfg;
  const working = chartType === 'heikinAshi' ? toHeikinAshi(candles) : candles;

  const datasets = [];
  const layout = [];
  const add = (ds, data, colors) => {
    ds.data = data;
    datasets.push(ds);
    layout.push({ data, colors: colors || null });
  };

  const label = `${symbol} ${tf.label}`;

  if (chartType === 'candlestick' || chartType === 'heikinAshi') {
    add(
      {
        type: 'candlestick',
        label,
        color: CANDLE_COLORS,
        borderColor: CANDLE_COLORS,
        backgroundColor: CANDLE_COLORS,
        borderColors: CANDLE_COLORS,
        backgroundColors: CANDLE_COLORS,
        normalized: true,
        order: 2,
      },
      working.map(toFinancialPoint)
    );
  } else if (chartType === 'ohlc') {
    add(
      {
        type: 'ohlc',
        label,
        color: CANDLE_COLORS,
        borderColor: CANDLE_COLORS,
        normalized: true,
        order: 2,
      },
      working.map(toFinancialPoint)
    );
  } else if (chartType === 'area') {
    add(
      {
        type: 'line',
        label,
        borderColor: '#2962ff',
        backgroundColor: 'rgba(41, 98, 255, 0.12)',
        fill: 'origin',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 0,
        tension: 0.1,
        parsing: false,
        normalized: true,
        order: 2,
      },
      working.map(toLinePoint)
    );
  } else {
    add(
      {
        type: 'line',
        label,
        borderColor: '#2962ff',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 0,
        tension: 0.1,
        fill: false,
        parsing: false,
        normalized: true,
        order: 2,
      },
      working.map(toLinePoint)
    );
  }

  const overlayLine = (lbl, color, data, extra) =>
    add(
      {
        type: 'line',
        label: lbl,
        borderColor: color,
        borderWidth: 1.5,
        fill: false,
        pointRadius: 0,
        pointHoverRadius: 0,
        parsing: false,
        normalized: true,
        order: 3,
        ...extra,
      },
      data
    );

  if (indicators.ema9) overlayLine('EMA 9', '#00e5ff', calculateEMA(candles, 9));
  if (indicators.ema21) overlayLine('EMA 21', '#ffd600', calculateEMA(candles, 21));
  if (indicators.sma50) overlayLine('SMA 50', '#e040fb', calculateSMA(candles, 50));
  if (indicators.sma200) overlayLine('SMA 200', '#ff6d00', calculateSMA(candles, 200));

  if (indicators.bollinger) {
    const bb = calculateBollingerBands(candles, 20, 2);
    // The three bands stay adjacent so the `fill: '+2'` offset still points at
    // the lower band after slicing.
    overlayLine('BB Upper', 'rgba(41, 98, 255, 0.6)', bb.upper, {
      borderDash: [3, 3],
      borderWidth: 1.2,
      fill: '+2',
      backgroundColor: 'rgba(41, 98, 255, 0.05)',
      order: 4,
    });
    overlayLine('BB Basis', 'rgba(41, 98, 255, 0.8)', bb.middle, {
      borderWidth: 1,
      order: 4,
    });
    overlayLine('BB Lower', 'rgba(41, 98, 255, 0.6)', bb.lower, {
      borderDash: [3, 3],
      borderWidth: 1.2,
      order: 4,
    });
  }

  if (showVwap) {
    overlayLine(
      'Session VWAP',
      '#9085e9',
      candles.map((c) => ({ x: c.timestamp, y: vwapValue ?? null })),
      { borderDash: [5, 4] }
    );
  }

  if (indicators.volume ?? true) {
    add(
      {
        type: 'bar',
        label: 'Volume',
        borderColor: 'transparent',
        yAxisID: 'yVol',
        order: 10,
        barPercentage: 0.8,
        categoryPercentage: 0.9,
        parsing: false,
        normalized: true,
      },
      candles.map((c) => ({ x: c.timestamp, y: c.volume || 0 })),
      candles.map((c) =>
        c.close >= c.open ? 'rgba(8, 153, 129, 0.35)' : 'rgba(242, 54, 69, 0.35)'
      )
    );
  }

  return { datasets, layout, fitSource: working };
}

const PriceChart = forwardRef(function PriceChart(
  {
    symbol,
    timeframe,
    historicalCandles,
    historyKey,
    activeCandle,
    sessionVwap,
    chartType = 'candlestick',
    indicators = {
      ema9: false,
      ema21: false,
      sma50: false,
      sma200: false,
      bollinger: false,
      volume: true,
      vwap: true,
    },
    interactionMode = 'crosshair',
    activeDrawingTool = 'cursor',
    drawings = [],
    onUpdateDrawings,
    onUndo,
    magnetEnabled = false,
    drawingColor = '#2962ff',
    onHoverBar,
    onZoomChange,
  },
  ref
) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const wrapRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const candlesRef = useRef([]);
  const layoutRef = useRef([]);
  const builtFromRef = useRef(null);
  const fitSourceRef = useRef([]);
  const sliceRef = useRef({ i0: -1, i1: -1 });

  // Zoom state lives in a ref, not state: a pan gesture must not re-render
  // React 60 times a second just to keep a boolean in sync.
  const zoomedRef = useRef(false);

  const crosshairPosRef = useRef(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, min: 0, max: 0 });
  const lastHoverTsRef = useRef(null);

  // Drawing state
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;
  const [selectedDrawingId, setSelectedDrawingId] = useState(null);
  const selectedIdRef = useRef(null);
  selectedIdRef.current = selectedDrawingId;
  const drawingInProgressRef = useRef(null);
  const snapPointRef = useRef(null);

  const tf = resolveTimeframe(timeframe);
  const showVwap = (indicators.vwap ?? true) && tf.ms < DAY_MS;

  // The series on screen belongs to `historyKey`. While a newly selected
  // symbol/timeframe is still backfilling we must NOT fold its live ticks into
  // the old series — that is the price "spike" you see right after a switch.
  const wantKey = `${symbol}|${tf.id}`;
  const stale = Boolean(historyKey) && historyKey !== wantKey;
  const staleRef = useRef(stale);
  staleRef.current = stale;

  // Every prop the imperative event layer needs, in one ref, so the pointer /
  // wheel listeners can be registered exactly ONCE for the component's life.
  const cfgRef = useRef(null);
  cfgRef.current = {
    symbol,
    tf,
    chartType,
    indicators,
    showVwap,
    interactionMode,
    activeDrawingTool,
    magnetEnabled,
    drawingColor,
    onUpdateDrawings,
    onUndo,
    onHoverBar,
    onZoomChange,
  };

  const vwapRef = useRef(sessionVwap);
  vwapRef.current = sessionVwap;

  // ---- viewport state ------------------------------------------------------
  // `view` is what gets painted this frame, `target` is where the gesture wants
  // it. Panning writes both (1:1 with the cursor, zero lag); zooming writes
  // only the target and lets the frame loop ease into it.
  const viewRef = useRef({ min: null, max: null });
  const targetRef = useRef({ min: null, max: null });
  const yViewRef = useRef({ min: null, max: null });
  const volViewRef = useRef(null);
  const followRef = useRef(true); // keep the newest bar pinned to the right edge

  const rafRef = useRef(0);
  const frameRef = useRef(null);
  const chartDirtyRef = useRef(false);
  const lastFrameRef = useRef(0);

  const anchorRef = useRef(0);
  const liveRef = useRef({
    bucketStart: null,
    base: null,
    lastMinute: null,
    seededMinuteTs: null,
    seededMinuteVol: 0,
  });

  const schedule = useCallback((needsChart) => {
    if (needsChart) chartDirtyRef.current = true;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => frameRef.current());
    }
  }, []);

  const setZoomed = useCallback((zoomed) => {
    if (zoomedRef.current === zoomed) return;
    zoomedRef.current = zoomed;
    const cb = cfgRef.current.onZoomChange;
    if (cb) cb(zoomed);
  }, []);

  /** Keep the viewport within reach of the data so panning can never get lost. */
  const clampTarget = useCallback((min, max) => {
    const candles = candlesRef.current;
    if (candles.length === 0) return { min, max };
    const span = max - min;
    const first = candles[0].timestamp;
    const last = candles[candles.length - 1].timestamp;
    const lo = first - span * 0.8;
    const hi = last + span * 0.8;
    if (min < lo) return { min: lo, max: lo + span };
    if (max > hi) return { min: hi - span, max: hi };
    return { min, max };
  }, []);

  const setTarget = useCallback(
    (min, max, immediate) => {
      const c = clampTarget(min, max);
      targetRef.current.min = c.min;
      targetRef.current.max = c.max;
      if (immediate) {
        viewRef.current.min = c.min;
        viewRef.current.max = c.max;
      }
      const candles = candlesRef.current;
      const last = candles.length ? candles[candles.length - 1].timestamp : 0;
      followRef.current = c.max >= last;
      schedule(true);
    },
    [clampTarget, schedule]
  );

  const defaultWindow = useCallback(
    () => defaultWindowFor(candlesRef.current, cfgRef.current.tf.ms),
    []
  );

  // ---- overlay layer -------------------------------------------------------
  // Crosshair, magnet ring, axis badges and the drawing currently being dragged
  // live on their own canvas. Moving the mouse repaints a dozen lines instead
  // of 1500 candles — the whole trick behind a buttery crosshair.
  const paintOverlay = useCallback(() => {
    const chart = chartInstanceRef.current;
    const overlay = overlayRef.current;
    if (!chart || !overlay || !chart.chartArea) return;

    const dpr = chart.currentDevicePixelRatio || window.devicePixelRatio || 1;
    const w = chart.width;
    const h = chart.height;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (overlay.width !== pw || overlay.height !== ph) {
      overlay.width = pw;
      overlay.height = ph;
      overlay.style.width = `${w}px`;
      overlay.style.height = `${h}px`;
    }

    const ctx = overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (drawingInProgressRef.current) {
      renderDrawings(ctx, chart, EMPTY_DRAWINGS, drawingInProgressRef.current, null);
    }

    const pos = crosshairPosRef.current;
    if (!pos) return;

    const { left, right, top, bottom } = chart.chartArea;
    const { x, y } = pos;
    if (x < left || x > right || y < top || y > bottom) return;

    ctx.save();

    ctx.strokeStyle = 'rgba(209, 212, 220, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();

    if (snapPointRef.current) {
      ctx.beginPath();
      ctx.arc(snapPointRef.current.pixelX, snapPointRef.current.pixelY, 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffd600';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.stroke();
    }

    const yScale = chart.scales.y;
    if (yScale) {
      const priceVal = yScale.getValueForPixel(y);
      if (Number.isFinite(priceVal)) {
        const priceText = priceVal.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        ctx.font = "bold 10px 'JetBrains Mono', monospace";
        const badgeW = ctx.measureText(priceText).width + 12;
        const badgeH = 18;
        ctx.fillStyle = '#2962ff';
        ctx.fillRect(right, y - badgeH / 2, badgeW, badgeH);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(priceText, right + 6, y);
      }
    }

    const xScale = chart.scales.x;
    if (xScale) {
      const timeVal = xScale.getValueForPixel(x);
      if (Number.isFinite(timeVal)) {
        const dateObj = new Date(timeVal);
        const tfMs = cfgRef.current.tf.ms;
        const timeText =
          tfMs >= DAY_MS
            ? dateObj.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
            : `${dateObj.toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })} ${dateObj.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;

        ctx.font = "bold 10px 'Outfit', sans-serif";
        const badgeW = ctx.measureText(timeText).width + 12;
        const badgeH = 18;
        const badgeX = Math.max(left, Math.min(right - badgeW, x - badgeW / 2));
        ctx.fillStyle = '#2a2e39';
        ctx.fillRect(badgeX, bottom, badgeW, badgeH);
        ctx.fillStyle = '#d1d4dc';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(timeText, badgeX + badgeW / 2, bottom + badgeH / 2);
      }
    }

    ctx.restore();
  }, []);

  /** Swap the visible window of every dataset in one pass. */
  const applySlice = useCallback((chart, i0, i1) => {
    const layout = layoutRef.current;
    const dss = chart.data.datasets;
    for (let d = 0; d < layout.length && d < dss.length; d++) {
      const entry = layout[d];
      dss[d].data = entry.data.slice(i0, i1);
      if (entry.colors) dss[d].backgroundColor = entry.colors.slice(i0, i1);
    }
  }, []);

  // ---- the single render frame --------------------------------------------
  frameRef.current = () => {
    rafRef.current = 0;
    const chart = chartInstanceRef.current;
    if (!chart) return;

    const now = performance.now();
    const dt = clamp(now - lastFrameRef.current, 1, 50);
    lastFrameRef.current = now;

    const view = viewRef.current;
    const target = targetRef.current;
    if (target.min === null) return;
    if (view.min === null) {
      view.min = target.min;
      view.max = target.max;
      chartDirtyRef.current = true;
    }

    let animating = false;

    // Frame-rate independent easing toward the zoom target.
    const dMin = target.min - view.min;
    const dMax = target.max - view.max;
    if (dMin !== 0 || dMax !== 0) {
      const kx = 1 - Math.pow(1 - ZOOM_EASE, dt / 16.667);
      const eps = (target.max - target.min) * 0.0006;
      if (Math.abs(dMin) < eps && Math.abs(dMax) < eps) {
        view.min = target.min;
        view.max = target.max;
      } else {
        view.min += dMin * kx;
        view.max += dMax * kx;
        animating = true;
      }
      chartDirtyRef.current = true;
    }

    if (chartDirtyRef.current) {
      const candles = candlesRef.current;
      const { i0, i1 } = visibleRange(candles, view.min, view.max);

      // Price axis fitted to what is actually on screen, then eased so a pan
      // glides vertically instead of snapping bar by bar.
      const fit = computeVisualFit(candles, fitSourceRef.current, i0, i1);

      if (fit) {
        const tMin = fit.yMin;
        const tMax = fit.yMax;
        const yView = yViewRef.current;
        if (yView.min === null) {
          yView.min = tMin;
          yView.max = tMax;
        } else {
          const ky = 1 - Math.pow(1 - Y_EASE, dt / 16.667);
          const eMin = tMin - yView.min;
          const eMax = tMax - yView.max;
          const yEps = (tMax - tMin) * 0.0015;
          if (Math.abs(eMin) < yEps && Math.abs(eMax) < yEps) {
            yView.min = tMin;
            yView.max = tMax;
          } else {
            yView.min += eMin * ky;
            yView.max += eMax * ky;
            animating = true;
          }
        }
        chart.options.scales.y.min = yView.min;
        chart.options.scales.y.max = yView.max;
      }

      const volTarget = ((fit && fit.volMax) || 100) * 4.5;
      volViewRef.current =
        volViewRef.current === null
          ? volTarget
          : volViewRef.current + (volTarget - volViewRef.current) * 0.2;
      chart.options.scales.yVol.max = volViewRef.current;

      chart.options.scales.x.min = view.min;
      chart.options.scales.x.max = view.max;

      if (i0 !== sliceRef.current.i0 || i1 !== sliceRef.current.i1) {
        sliceRef.current = { i0, i1 };
        applySlice(chart, i0, i1);
      }

      chart.update('none');
      chartDirtyRef.current = false;
    }

    paintOverlay();

    if (animating) {
      chartDirtyRef.current = true;
      rafRef.current = requestAnimationFrame(() => frameRef.current());
    }
  };

  // ---- imperative viewport API --------------------------------------------
  const resetView = useCallback(() => {
    const win = defaultWindow();
    if (!win) return;
    followRef.current = true;
    setTarget(win.min, win.max, false);
    setZoomed(false);
  }, [defaultWindow, setTarget, setZoomed]);

  const zoomBy = useCallback(
    (factor, centerRatio = 0.5) => {
      if (candlesRef.current.length === 0 || targetRef.current.min === null) return;
      const tfMs = cfgRef.current.tf.ms;
      const t = targetRef.current;
      const range = t.max - t.min;
      const next = clamp(range * factor, MIN_BARS * tfMs, MAX_BARS * tfMs);
      const center = t.min + range * centerRatio;
      const newMin = center - next * centerRatio;
      setTarget(newMin, newMin + next, false);
      setZoomed(true);
    },
    [setTarget, setZoomed]
  );

  const panBy = useCallback(
    (ratio) => {
      const t = targetRef.current;
      if (t.min === null) return;
      const shift = (t.max - t.min) * ratio;
      setTarget(t.min + shift, t.max + shift, false);
      setZoomed(true);
    },
    [setTarget, setZoomed]
  );

  const fitRangeMs = useCallback(
    (ms) => {
      const candles = candlesRef.current;
      if (candles.length === 0) return;
      const tfMs = cfgRef.current.tf.ms;
      const last = candles[candles.length - 1].timestamp;
      const rightEdge = last + tfMs * RIGHT_PAD_BARS;

      if (!ms || ms === 'ALL') {
        setTarget(candles[0].timestamp - tfMs, rightEdge, false);
      } else {
        setTarget(last - ms, rightEdge, false);
      }
      setZoomed(true);
    },
    [setTarget, setZoomed]
  );

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => zoomBy(0.72),
      zoomOut: () => zoomBy(1.38),
      panLeft: () => panBy(-0.2),
      panRight: () => panBy(0.2),
      resetView,
      fitRangeMs,
    }),
    [zoomBy, panBy, resetView, fitRangeMs]
  );

  // ---- build / rebuild the Chart.js instance -------------------------------
  // Deliberately NOT keyed on `symbol` or `selectedDrawingId`: a symbol switch
  // already delivers a fresh `historicalCandles` array (one rebuild, not two),
  // and selecting a drawing must never tear down the whole chart.
  useEffect(() => {
    if (!historicalCandles || historicalCandles.length === 0) return undefined;

    candlesRef.current = [...historicalCandles];
    anchorRef.current = candlesRef.current[0].timestamp;
    const lastHistorical = candlesRef.current[candlesRef.current.length - 1];
    liveRef.current = {
      bucketStart: lastHistorical.timestamp,
      base: { ...lastHistorical },
      lastMinute: null,
      seededMinuteTs: null,
      seededMinuteVol: 0,
    };

    const cfg = cfgRef.current;
    const { datasets, layout, fitSource } = computeLayout(
      candlesRef.current,
      cfg,
      vwapRef.current
    );
    layoutRef.current = layout;
    fitSourceRef.current = fitSource;

    // Toggling an indicator or switching candles->line rebuilds the chart but
    // is NOT new data: keep the window the user is looking at, the way a real
    // terminal does. Only fresh history (symbol/timeframe) resets the view.
    const sameSeries = builtFromRef.current === historicalCandles && targetRef.current.min !== null;
    builtFromRef.current = historicalCandles;

    // Seed the viewport, the slice and both axes BEFORE `new Chart(...)`.
    // Leaving that to the first animation frame makes the chart paint one
    // frame auto-fitted to ALL history and then snap — a visible flash on
    // every symbol/timeframe switch.
    const win = sameSeries
      ? { min: targetRef.current.min, max: targetRef.current.max }
      : defaultWindowFor(candlesRef.current, cfg.tf.ms) || { min: 0, max: 1 };
    const { i0, i1 } = visibleRange(candlesRef.current, win.min, win.max);
    const fit = computeVisualFit(candlesRef.current, fitSource, i0, i1);
    for (let d = 0; d < layout.length; d++) {
      datasets[d].data = layout[d].data.slice(i0, i1);
      if (layout[d].colors) datasets[d].backgroundColor = layout[d].colors.slice(i0, i1);
    }
    sliceRef.current = { i0, i1 };
    if (!sameSeries) followRef.current = true;
    targetRef.current = { min: win.min, max: win.max };
    viewRef.current = { min: win.min, max: win.max };
    yViewRef.current = fit ? { min: fit.yMin, max: fit.yMax } : { min: null, max: null };
    volViewRef.current = ((fit && fit.volMax) || 100) * 4.5;

    const ctx = canvasRef.current.getContext('2d');
    if (chartInstanceRef.current) chartInstanceRef.current.destroy();

    const proPlugin = {
      id: 'proChartPlugin',
      afterDatasetsDraw: (chart) => {
        renderDrawings(chart.ctx, chart, drawingsRef.current, null, selectedIdRef.current);
      },
    };

    chartInstanceRef.current = new Chart(ctx, {
      type: 'candlestick',
      data: { datasets },
      plugins: [proPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        animations: false,
        transitions: { active: { animation: { duration: 0 } } },
        // We own every pointer interaction; leaving Chart.js's own hover
        // pipeline on would cost a hit-test per mousemove for nothing.
        events: ['click'],
        interaction: { mode: 'index', intersect: false, axis: 'x' },
        onResize: () => {
          sliceRef.current = { i0: -1, i1: -1 };
          schedule(true);
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: {
              color: NEUTRAL,
              boxWidth: 10,
              boxHeight: 2,
              font: { family: "'Outfit', sans-serif", size: 10 },
              filter: (item) => item.text !== 'BB Basis' && item.text !== 'BB Lower',
            },
          },
          tooltip: { enabled: false },
          decimation: { enabled: false },
        },
        scales: {
          x: {
            // `time` (not `timeseries`) keeps pixel<->timestamp a straight
            // linear map: cheaper per frame, and the crosshair/drawings land
            // exactly where the cursor is.
            type: 'time',
            offset: false,
            min: win.min,
            max: win.max,
            time: {
              minUnit: 'minute',
              tooltipFormat: tooltipFormatFor(cfg.tf),
              displayFormats: DISPLAY_FORMATS,
            },
            grid: { color: GRID },
            ticks: {
              // The financial controller ships `source: 'data'` and a 75px
              // autoSkipPadding; both have to be overridden or a 3-hour window
              // gets three lonely hour labels.
              source: 'auto',
              autoSkipPadding: 24,
              color: NEUTRAL,
              font: { family: "'Outfit', sans-serif", size: 10 },
              maxTicksLimit: 12,
              maxRotation: 0,
              autoSkip: true,
            },
          },
          y: {
            position: 'right',
            min: yViewRef.current.min ?? undefined,
            max: yViewRef.current.max ?? undefined,
            grid: { color: GRID },
            ticks: {
              color: NEUTRAL,
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              maxTicksLimit: 9,
              callback: (value) => value.toLocaleString(undefined, { minimumFractionDigits: 2 }),
            },
          },
          yVol: {
            position: 'left',
            display: false,
            min: 0,
            max: volViewRef.current,
            grid: { display: false },
          },
        },
      },
    });

    if (!sameSeries) setZoomed(false);
    lastFrameRef.current = performance.now();
    schedule(true);

    return () => {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy();
        chartInstanceRef.current = null;
      }
    };
  }, [historicalCandles, chartType, indicators, showVwap, defaultWindow, schedule, setZoomed]);

  // Symbol / timeframe label patched in place — no teardown just for a rename.
  useEffect(() => {
    const chart = chartInstanceRef.current;
    if (!chart) return;
    if (chart.data.datasets[0]) chart.data.datasets[0].label = `${symbol} ${tf.label}`;
    chart.options.scales.x.time.tooltipFormat = tooltipFormatFor(tf);
    schedule(true);
  }, [symbol, tf, schedule]);

  // Drawings / selection changed: repaint the existing scene, don't rebuild it.
  useEffect(() => {
    drawingsRef.current = drawings;
    const chart = chartInstanceRef.current;
    if (chart) chart.draw();
  }, [drawings, selectedDrawingId]);

  // ---- pointer + wheel layer (registered once) -----------------------------
  useEffect(() => {
    const wrapEl = wrapRef.current;
    const canvasEl = canvasRef.current;
    if (!wrapEl || !canvasEl) return undefined;

    const localPoint = (e) => {
      const rect = canvasEl.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const inChartArea = (chart, x, y) => {
      const a = chart.chartArea;
      return Boolean(a) && x >= a.left && x <= a.right && y >= a.top && y <= a.bottom;
    };

    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const chart = chartInstanceRef.current;
      if (!chart || candlesRef.current.length === 0 || !chart.chartArea) return;

      const { x, y } = localPoint(e);
      if (!inChartArea(chart, x, y)) return;

      const { left, right } = chart.chartArea;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;

      // Two-finger horizontal swipe pans instead of zooming.
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5) {
        const t = targetRef.current;
        if (t.min === null) return;
        const shift = ((e.deltaX * unit) / (right - left)) * (t.max - t.min);
        setTarget(t.min + shift, t.max + shift, false);
        setZoomed(true);
        return;
      }

      // Trackpads deliver a stream of small deltas and mice one big notch; the
      // exponential map makes both feel like the same gesture.
      const steps = clamp((e.deltaY * unit) / 100, -4, 4);
      const centerRatio = clamp((x - left) / (right - left), 0, 1);
      zoomBy(Math.exp(steps * WHEEL_SENSITIVITY), centerRatio);
    };

    const getChartPoint = (px, py) => {
      const chart = chartInstanceRef.current;
      if (!chart || !chart.scales.x || !chart.scales.y) return null;

      if (cfgRef.current.magnetEnabled) {
        const snap = snapToCandle(px, py, chart, candlesRef.current);
        if (snap) {
          snapPointRef.current = snap;
          return { time: snap.time, price: snap.price };
        }
      }
      snapPointRef.current = null;
      return {
        time: chart.scales.x.getValueForPixel(px),
        price: chart.scales.y.getValueForPixel(py),
      };
    };

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      const chart = chartInstanceRef.current;
      if (!chart || !chart.chartArea) return;

      const { x, y } = localPoint(e);
      if (!inChartArea(chart, x, y)) return;

      const cfg = cfgRef.current;
      const tool = cfg.activeDrawingTool;

      if (tool && tool !== 'cursor') {
        const pt = getChartPoint(x, y);
        if (!pt) return;

        if (tool === 'horizontal') {
          const next = [
            ...drawingsRef.current,
            {
              id: `h_${Date.now()}`,
              type: 'horizontal',
              price: pt.price,
              color: cfg.drawingColor,
              dashed: false,
            },
          ];
          if (cfg.onUpdateDrawings) cfg.onUpdateDrawings(next);
          return;
        }

        if (!drawingInProgressRef.current) {
          if (tool === 'position') {
            const spread = pt.price * 0.015;
            drawingInProgressRef.current = {
              id: `pos_${Date.now()}`,
              type: 'position',
              side: 'long',
              entry: { time: pt.time, price: pt.price },
              target: { time: pt.time + cfg.tf.ms * 15, price: pt.price + spread * 2 },
              stop: { time: pt.time + cfg.tf.ms * 15, price: pt.price - spread },
            };
          } else {
            drawingInProgressRef.current = {
              id: `draw_${Date.now()}`,
              type: tool,
              start: { time: pt.time, price: pt.price },
              end: { time: pt.time, price: pt.price },
              color: cfg.drawingColor,
              dashed: false,
            };
          }
          schedule(false);
        } else {
          const inProgress = drawingInProgressRef.current;
          inProgress.end = { time: pt.time, price: pt.price };
          if (tool === 'position') inProgress.target = { time: pt.time, price: pt.price };
          drawingInProgressRef.current = null;
          if (cfg.onUpdateDrawings) cfg.onUpdateDrawings([...drawingsRef.current, inProgress]);
          schedule(false);
        }
        return;
      }

      if (tool === 'cursor') {
        const hit = findDrawingAtPixel(x, y, chart, drawingsRef.current);
        if (hit) {
          setSelectedDrawingId(hit.id);
          return;
        }
        if (selectedIdRef.current) setSelectedDrawingId(null);
      }

      const t = targetRef.current;
      if (t.min === null) return;
      isDraggingRef.current = true;
      dragStartRef.current = { x: e.clientX, min: t.min, max: t.max };
      try {
        canvasEl.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety, not a requirement */
      }
      wrapEl.style.cursor = 'grabbing';
    };

    const onPointerMove = (e) => {
      const chart = chartInstanceRef.current;
      if (!chart || !chart.chartArea) return;
      const { x, y } = localPoint(e);

      if (isDraggingRef.current) {
        e.preventDefault();
        const dx = e.clientX - dragStartRef.current.x;
        const width = chart.chartArea.right - chart.chartArea.left;
        const range = dragStartRef.current.max - dragStartRef.current.min;
        const deltaMs = (dx / width) * range;
        // Panning tracks the cursor 1:1 — easing here would feel like drag.
        setTarget(dragStartRef.current.min - deltaMs, dragStartRef.current.max - deltaMs, true);
        setZoomed(true);
        return;
      }

      if (drawingInProgressRef.current) {
        const pt = getChartPoint(x, y);
        if (pt) {
          drawingInProgressRef.current.end = { time: pt.time, price: pt.price };
          if (drawingInProgressRef.current.type === 'position') {
            drawingInProgressRef.current.target = { time: pt.time, price: pt.price };
          }
        }
      }

      if (inChartArea(chart, x, y)) {
        crosshairPosRef.current = { x, y };
        snapPointRef.current = cfgRef.current.magnetEnabled
          ? snapToCandle(x, y, chart, candlesRef.current)
          : null;

        const hoverTs = chart.scales.x.getValueForPixel(x);
        const candles = candlesRef.current;
        const idx = lowerBound(candles, hoverTs);
        let closest = null;
        let bestDiff = Infinity;
        for (let i = Math.max(0, idx - 1); i <= Math.min(candles.length - 1, idx); i++) {
          const diff = Math.abs(candles[i].timestamp - hoverTs);
          if (diff < bestDiff) {
            bestDiff = diff;
            closest = candles[i];
          }
        }
        const cb = cfgRef.current.onHoverBar;
        const tfMs = cfgRef.current.tf.ms;
        if (closest && bestDiff <= tfMs * 1.5) {
          // Only bubble a React state change when the BAR changes, not per pixel.
          if (cb && lastHoverTsRef.current !== closest.timestamp) {
            lastHoverTsRef.current = closest.timestamp;
            cb(closest);
          }
        } else if (cb && lastHoverTsRef.current !== null) {
          lastHoverTsRef.current = null;
          cb(null);
        }
        schedule(false);
      } else if (crosshairPosRef.current) {
        crosshairPosRef.current = null;
        snapPointRef.current = null;
        if (cfgRef.current.onHoverBar && lastHoverTsRef.current !== null) {
          lastHoverTsRef.current = null;
          cfgRef.current.onHoverBar(null);
        }
        schedule(false);
      }
    };

    const endDrag = (e) => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      try {
        if (e && e.pointerId !== undefined) canvasEl.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      const cfg = cfgRef.current;
      wrapEl.style.cursor =
        cfg.activeDrawingTool !== 'cursor'
          ? 'crosshair'
          : cfg.interactionMode === 'pan'
          ? 'grab'
          : 'crosshair';
    };

    const onPointerLeave = () => {
      if (isDraggingRef.current) return;
      if (crosshairPosRef.current || snapPointRef.current) {
        crosshairPosRef.current = null;
        snapPointRef.current = null;
        schedule(false);
      }
      if (cfgRef.current.onHoverBar && lastHoverTsRef.current !== null) {
        lastHoverTsRef.current = null;
        cfgRef.current.onHoverBar(null);
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        drawingInProgressRef.current = null;
        snapPointRef.current = null;
        setSelectedDrawingId(null);
        schedule(false);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIdRef.current) {
          const next = drawingsRef.current.filter((d) => d.id !== selectedIdRef.current);
          setSelectedDrawingId(null);
          if (cfgRef.current.onUpdateDrawings) cfgRef.current.onUpdateDrawings(next);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (cfgRef.current.onUndo) cfgRef.current.onUndo();
      }
    };

    const onGesture = (e) => e.preventDefault();

    wrapEl.addEventListener('wheel', onWheel, { passive: false, capture: true });
    canvasEl.addEventListener('pointerdown', onPointerDown);
    canvasEl.addEventListener('pointermove', onPointerMove);
    canvasEl.addEventListener('pointerup', endDrag);
    canvasEl.addEventListener('pointercancel', endDrag);
    canvasEl.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('keydown', onKeyDown);
    wrapEl.addEventListener('gesturestart', onGesture, { passive: false });
    wrapEl.addEventListener('gesturechange', onGesture, { passive: false });

    return () => {
      wrapEl.removeEventListener('wheel', onWheel, { capture: true });
      canvasEl.removeEventListener('pointerdown', onPointerDown);
      canvasEl.removeEventListener('pointermove', onPointerMove);
      canvasEl.removeEventListener('pointerup', endDrag);
      canvasEl.removeEventListener('pointercancel', endDrag);
      canvasEl.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('keydown', onKeyDown);
      wrapEl.removeEventListener('gesturestart', onGesture);
      wrapEl.removeEventListener('gesturechange', onGesture);
    };
  }, [zoomBy, setTarget, setZoomed, schedule]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    },
    []
  );

  // ---- live candle folding -------------------------------------------------
  useEffect(() => {
    const chart = chartInstanceRef.current;
    if (!chart || !activeCandle || staleRef.current) return;

    const candles = candlesRef.current;
    if (candles.length === 0) return;

    const st = liveRef.current;
    const anchor = anchorRef.current;
    const contribution = (minute) =>
      minute.timestamp === st.seededMinuteTs
        ? { ...minute, volume: Math.max(0, (minute.volume || 0) - st.seededMinuteVol) }
        : minute;

    if (st.lastMinute && activeCandle.timestamp > st.lastMinute.timestamp) {
      if (bucketStart(st.lastMinute.timestamp, tf.ms, anchor) === st.bucketStart) {
        st.base = foldCandle(st.base, contribution(st.lastMinute));
      }
    }

    const bucket = bucketStart(activeCandle.timestamp, tf.ms, anchor);
    if (st.bucketStart !== null && bucket !== st.bucketStart) {
      if (st.base) upsertCandle(candles, st.base);
      st.base = null;
      st.seededMinuteTs = null;
      st.seededMinuteVol = 0;
    }
    st.bucketStart = bucket;

    if (st.lastMinute === null && st.base) {
      st.seededMinuteTs = activeCandle.timestamp;
      st.seededMinuteVol = activeCandle.volume || 0;
    }
    st.lastMinute = { ...activeCandle };

    const merged = st.base
      ? foldCandle(st.base, contribution(activeCandle))
      : { ...activeCandle, timestamp: bucket };
    const appended = upsertCandle(candles, { ...merged, timestamp: bucket });

    // Recompute the full series cache; the frame loop re-slices what shows.
    const { layout, fitSource } = computeLayout(candles, cfgRef.current, sessionVwap);
    layoutRef.current = layout;
    fitSourceRef.current = fitSource;
    sliceRef.current = { i0: -1, i1: -1 };

    // Auto-scroll only while the view is still pinned to the right edge.
    if (appended && followRef.current && targetRef.current.min !== null) {
      const t = targetRef.current;
      const last = candles[candles.length - 1].timestamp;
      const shift = last + tf.ms * RIGHT_PAD_BARS - t.max;
      if (shift > 0) {
        t.min += shift;
        t.max += shift;
        viewRef.current.min += shift;
        viewRef.current.max += shift;
      }
    }

    schedule(true);
  }, [activeCandle, sessionVwap, tf, showVwap, chartType, indicators, schedule]);

  return (
    <div
      className={`chart-canvas-wrap ${
        activeDrawingTool !== 'cursor'
          ? 'mode-drawing'
          : interactionMode === 'pan'
          ? 'mode-pan'
          : 'mode-crosshair'
      }${stale ? ' is-loading' : ''}`}
      ref={wrapRef}
      onDoubleClick={resetView}
    >
      <div className="chart-stack">
        <canvas ref={canvasRef} />
        <canvas ref={overlayRef} className="chart-overlay" />
      </div>
    </div>
  );
});

export default PriceChart;
