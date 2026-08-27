import React, { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
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

const toFinancialPoint = (c) => ({ x: c.timestamp, o: c.open, h: c.high, l: c.low, c: c.close });
const toLinePoint = (c) => ({ x: c.timestamp, y: c.close });

const DISPLAY_FORMATS = {
  minute: 'HH:mm',
  hour: 'MMM d HH:mm',
  day: 'MMM d',
  week: 'MMM d',
  month: 'MMM yyyy',
};

const tooltipFormatFor = (tf) => (tf.ms >= DAY_MS ? 'MMM d, yyyy' : 'MMM d, HH:mm');

/** Replace the trailing candle, or append if this is a newer bucket. */
function upsertCandle(candles, candle) {
  const last = candles[candles.length - 1];
  if (!last || candle.timestamp > last.timestamp) {
    candles.push(candle);
    if (candles.length > MAX_POINTS) candles.shift();
  } else if (candle.timestamp === last.timestamp) {
    candles[candles.length - 1] = candle;
  }
}

/** Dynamic Y-axis auto-fitting based on visible range */
function fitPriceAxis(chart, candles) {
  const xScale = chart.scales.x;
  if (!xScale) return;
  const { min, max } = xScale;
  let visible = candles.filter((c) => c.timestamp >= min && c.timestamp <= max);
  if (visible.length === 0) visible = candles;

  let lo = Infinity;
  let hi = -Infinity;
  for (const c of visible) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;

  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.002 || 1;
  chart.options.scales.y.min = lo - pad;
  chart.options.scales.y.max = hi + pad;
}

const PriceChart = forwardRef(function PriceChart(
  {
    symbol,
    timeframe,
    historicalCandles,
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
  const wrapRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const candlesRef = useRef([]);
  const [isZoomed, setIsZoomed] = useState(false);
  const crosshairPosRef = useRef(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, min: 0, max: 0 });

  // Drawing states
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;
  const [selectedDrawingId, setSelectedDrawingId] = useState(null);
  const drawingInProgressRef = useRef(null);
  const snapPointRef = useRef(null);

  // Redraw when drawings list or selection changes
  useEffect(() => {
    drawingsRef.current = drawings;
    if (chartInstanceRef.current) {
      chartInstanceRef.current.draw();
    }
  }, [drawings, selectedDrawingId]);

  const tf = resolveTimeframe(timeframe);
  const showVwap = (indicators.vwap ?? true) && tf.ms < DAY_MS;

  const anchorRef = useRef(0);
  const liveRef = useRef({
    bucketStart: null,
    base: null,
    lastMinute: null,
    seededMinuteTs: null,
    seededMinuteVol: 0,
  });

  const vwapRef = useRef(sessionVwap);
  vwapRef.current = sessionVwap;

  const updateZoomState = useCallback(
    (zoomed) => {
      setIsZoomed(zoomed);
      if (onZoomChange) onZoomChange(zoomed);
    },
    [onZoomChange]
  );

  const resetView = useCallback(() => {
    const chart = chartInstanceRef.current;
    if (!chart || candlesRef.current.length === 0) return;

    delete chart.options.scales.x.min;
    delete chart.options.scales.x.max;
    fitPriceAxis(chart, candlesRef.current);
    chart.update('none');
    updateZoomState(false);
  }, [updateZoomState]);

  const zoomBy = useCallback(
    (factor, centerRatio = 0.5) => {
      const chart = chartInstanceRef.current;
      if (!chart || candlesRef.current.length === 0) return;
      const xScale = chart.scales.x;
      if (!xScale) return;

      const candles = candlesRef.current;
      const fullMin = candles[0].timestamp;
      const fullMax = candles[candles.length - 1].timestamp;
      const currentMin = xScale.min !== undefined ? xScale.min : fullMin;
      const currentMax = xScale.max !== undefined ? xScale.max : fullMax;
      const currentRange = currentMax - currentMin;

      const minRange = tf.ms * 4;
      const maxRange = (fullMax - fullMin) * 1.5;
      const targetRange = Math.max(minRange, Math.min(maxRange, currentRange * factor));

      const centerVal = currentMin + currentRange * centerRatio;
      const newMin = centerVal - targetRange * centerRatio;
      const newMax = newMin + targetRange;

      chart.options.scales.x.min = newMin;
      chart.options.scales.x.max = newMax;
      fitPriceAxis(chart, candles);
      chart.update('none');
      updateZoomState(true);
    },
    [tf.ms, updateZoomState]
  );

  const panBy = useCallback(
    (ratio) => {
      const chart = chartInstanceRef.current;
      if (!chart || candlesRef.current.length === 0) return;
      const xScale = chart.scales.x;
      if (!xScale) return;

      const candles = candlesRef.current;
      const fullMin = candles[0].timestamp;
      const fullMax = candles[candles.length - 1].timestamp;
      const currentMin = xScale.min !== undefined ? xScale.min : fullMin;
      const currentMax = xScale.max !== undefined ? xScale.max : fullMax;
      const range = currentMax - currentMin;
      const shift = range * ratio;

      chart.options.scales.x.min = currentMin + shift;
      chart.options.scales.x.max = currentMax + shift;
      fitPriceAxis(chart, candles);
      chart.update('none');
      updateZoomState(true);
    },
    [updateZoomState]
  );

  const fitRangeMs = useCallback(
    (ms) => {
      const chart = chartInstanceRef.current;
      if (!chart || candlesRef.current.length === 0) return;
      const candles = candlesRef.current;
      const lastTs = candles[candles.length - 1].timestamp;

      if (!ms || ms === 'ALL') {
        resetView();
        return;
      }

      chart.options.scales.x.min = lastTs - ms;
      chart.options.scales.x.max = lastTs + tf.ms * 2;
      fitPriceAxis(chart, candles);
      chart.update('none');
      updateZoomState(true);
    },
    [resetView, tf.ms, updateZoomState]
  );

  // Expose imperative API for parent toolbar
  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => zoomBy(0.75),
      zoomOut: () => zoomBy(1.33),
      panLeft: () => panBy(-0.2),
      panRight: () => panBy(0.2),
      resetView,
      fitRangeMs,
    }),
    [zoomBy, panBy, resetView, fitRangeMs]
  );

  // Build / rebuild chart
  useEffect(() => {
    if (!historicalCandles || historicalCandles.length === 0) return undefined;

    candlesRef.current = [...historicalCandles];
    setIsZoomed(false);

    anchorRef.current = candlesRef.current[0].timestamp;
    const lastHistorical = candlesRef.current[candlesRef.current.length - 1];
    liveRef.current = {
      bucketStart: lastHistorical.timestamp,
      base: { ...lastHistorical },
      lastMinute: null,
      seededMinuteTs: null,
      seededMinuteVol: 0,
    };

    const ctx = canvasRef.current.getContext('2d');
    if (chartInstanceRef.current) {
      chartInstanceRef.current.destroy();
    }

    const candles = candlesRef.current;
    const workingCandles = chartType === 'heikinAshi' ? toHeikinAshi(candles) : candles;

    const datasets = [];

    if (chartType === 'candlestick' || chartType === 'heikinAshi') {
      datasets.push({
        type: 'candlestick',
        label: `${symbol} ${tf.label}`,
        data: workingCandles.map(toFinancialPoint),
        color: CANDLE_COLORS,
        borderColor: CANDLE_COLORS,
        backgroundColor: CANDLE_COLORS,
        borderColors: CANDLE_COLORS,
        backgroundColors: CANDLE_COLORS,
        order: 2,
      });
    } else if (chartType === 'ohlc') {
      datasets.push({
        type: 'ohlc',
        label: `${symbol} ${tf.label}`,
        data: workingCandles.map(toFinancialPoint),
        color: CANDLE_COLORS,
        borderColor: CANDLE_COLORS,
        order: 2,
      });
    } else if (chartType === 'area') {
      datasets.push({
        type: 'line',
        label: `${symbol} ${tf.label}`,
        data: workingCandles.map(toLinePoint),
        borderColor: '#2962ff',
        backgroundColor: 'rgba(41, 98, 255, 0.12)',
        fill: 'origin',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.1,
        order: 2,
      });
    } else {
      datasets.push({
        type: 'line',
        label: `${symbol} ${tf.label}`,
        data: workingCandles.map(toLinePoint),
        borderColor: '#2962ff',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.1,
        fill: false,
        order: 2,
      });
    }

    if (indicators.ema9) {
      const ema9 = calculateEMA(candles, 9);
      datasets.push({
        type: 'line',
        label: 'EMA 9',
        data: ema9,
        borderColor: '#00e5ff',
        borderWidth: 1.5,
        fill: false,
        pointRadius: 0,
        order: 3,
      });
    }

    if (indicators.ema21) {
      const ema21 = calculateEMA(candles, 21);
      datasets.push({
        type: 'line',
        label: 'EMA 21',
        data: ema21,
        borderColor: '#ffd600',
        borderWidth: 1.5,
        fill: false,
        pointRadius: 0,
        order: 3,
      });
    }

    if (indicators.sma50) {
      const sma50 = calculateSMA(candles, 50);
      datasets.push({
        type: 'line',
        label: 'SMA 50',
        data: sma50,
        borderColor: '#e040fb',
        borderWidth: 1.5,
        fill: false,
        pointRadius: 0,
        order: 3,
      });
    }

    if (indicators.sma200) {
      const sma200 = calculateSMA(candles, 200);
      datasets.push({
        type: 'line',
        label: 'SMA 200',
        data: sma200,
        borderColor: '#ff6d00',
        borderWidth: 1.5,
        fill: false,
        pointRadius: 0,
        order: 3,
      });
    }

    if (indicators.bollinger) {
      const bb = calculateBollingerBands(candles, 20, 2);
      datasets.push({
        type: 'line',
        label: 'BB Upper',
        data: bb.upper,
        borderColor: 'rgba(41, 98, 255, 0.6)',
        borderDash: [3, 3],
        borderWidth: 1.2,
        fill: '+2',
        backgroundColor: 'rgba(41, 98, 255, 0.05)',
        pointRadius: 0,
        order: 4,
      });
      datasets.push({
        type: 'line',
        label: 'BB Basis',
        data: bb.middle,
        borderColor: 'rgba(41, 98, 255, 0.8)',
        borderWidth: 1,
        fill: false,
        pointRadius: 0,
        order: 4,
      });
      datasets.push({
        type: 'line',
        label: 'BB Lower',
        data: bb.lower,
        borderColor: 'rgba(41, 98, 255, 0.6)',
        borderDash: [3, 3],
        borderWidth: 1.2,
        fill: false,
        pointRadius: 0,
        order: 4,
      });
    }

    if (showVwap) {
      datasets.push({
        type: 'line',
        label: 'Session VWAP',
        data: candles.map((c) => ({ x: c.timestamp, y: vwapRef.current ?? null })),
        borderColor: '#9085e9',
        borderDash: [5, 4],
        borderWidth: 1.5,
        fill: false,
        pointRadius: 0,
        pointHoverRadius: 0,
        order: 3,
      });
    }

    if (indicators.volume ?? true) {
      const volData = candles.map((c) => ({
        x: c.timestamp,
        y: c.volume || 0,
      }));
      const volColors = candles.map((c) =>
        c.close >= c.open ? 'rgba(8, 153, 129, 0.35)' : 'rgba(242, 54, 69, 0.35)'
      );

      datasets.push({
        type: 'bar',
        label: 'Volume',
        data: volData,
        backgroundColor: volColors,
        borderColor: 'transparent',
        yAxisID: 'yVol',
        order: 10,
        barPercentage: 0.8,
        categoryPercentage: 0.9,
      });
    }

    const maxVol = candles.reduce((m, c) => Math.max(m, c.volume || 0), 0) || 100;

    // Drawings & Crosshair Composite Plugin
    const proPlugin = {
      id: 'proChartPlugin',
      afterDatasetsDraw: (chart) => {
        // Render drawings on top of candlesticks/lines
        renderDrawings(
          chart.ctx,
          chart,
          drawingsRef.current,
          drawingInProgressRef.current,
          selectedDrawingId
        );
      },
      afterDraw: (chart) => {
        const pos = crosshairPosRef.current;
        if (!pos || !chart.chartArea) return;
        const { left, right, top, bottom } = chart.chartArea;
        const { x, y } = pos;

        if (x < left || x > right || y < top || y > bottom) return;

        const drawCtx = chart.ctx;
        drawCtx.save();

        // 1. Draw dashed crosshair lines
        drawCtx.strokeStyle = 'rgba(209, 212, 220, 0.4)';
        drawCtx.lineWidth = 1;
        drawCtx.setLineDash([4, 4]);

        drawCtx.beginPath();
        drawCtx.moveTo(x, top);
        drawCtx.lineTo(x, bottom);
        drawCtx.stroke();

        drawCtx.beginPath();
        drawCtx.moveTo(left, y);
        drawCtx.lineTo(right, y);
        drawCtx.stroke();

        // 2. Magnet Snap point indicator (Ring)
        if (snapPointRef.current) {
          drawCtx.beginPath();
          drawCtx.arc(snapPointRef.current.pixelX, snapPointRef.current.pixelY, 5, 0, Math.PI * 2);
          drawCtx.strokeStyle = '#ffd600';
          drawCtx.lineWidth = 2;
          drawCtx.setLineDash([]);
          drawCtx.stroke();
        }

        // 3. Draw Price Badge on Y-axis (Right)
        const yScale = chart.scales.y;
        if (yScale) {
          const priceVal = yScale.getValueForPixel(y);
          if (priceVal !== undefined && Number.isFinite(priceVal)) {
            const priceText = priceVal.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            });
            drawCtx.font = "bold 10px 'JetBrains Mono', monospace";
            const textWidth = drawCtx.measureText(priceText).width;
            const badgeW = textWidth + 12;
            const badgeH = 18;
            const badgeX = right;
            const badgeY = y - badgeH / 2;

            drawCtx.fillStyle = '#2962ff';
            drawCtx.fillRect(badgeX, badgeY, badgeW, badgeH);

            drawCtx.fillStyle = '#ffffff';
            drawCtx.textAlign = 'left';
            drawCtx.textBaseline = 'middle';
            drawCtx.fillText(priceText, badgeX + 6, y);
          }
        }

        // 4. Draw Time Badge on X-axis (Bottom)
        const xScale = chart.scales.x;
        if (xScale) {
          const timeVal = xScale.getValueForPixel(x);
          if (timeVal !== undefined && Number.isFinite(timeVal)) {
            const dateObj = new Date(timeVal);
            const timeText =
              tf.ms >= DAY_MS
                ? dateObj.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
                : dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
                  ' ' +
                  dateObj.toLocaleDateString([], { month: 'short', day: 'numeric' });

            drawCtx.font = "bold 10px 'Outfit', sans-serif";
            const textWidth = drawCtx.measureText(timeText).width;
            const badgeW = textWidth + 12;
            const badgeH = 18;
            const badgeX = Math.max(left, Math.min(right - badgeW, x - badgeW / 2));
            const badgeY = bottom;

            drawCtx.fillStyle = '#2a2e39';
            drawCtx.fillRect(badgeX, badgeY, badgeW, badgeH);

            drawCtx.fillStyle = '#d1d4dc';
            drawCtx.textAlign = 'center';
            drawCtx.textBaseline = 'middle';
            drawCtx.fillText(timeText, badgeX + badgeW / 2, badgeY + badgeH / 2);
          }
        }

        drawCtx.restore();
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
        interaction: { mode: 'index', intersect: false, axis: 'x' },
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
          tooltip: {
            enabled: false,
          },
        },
        scales: {
          x: {
            type: 'timeseries',
            time: {
              tooltipFormat: tooltipFormatFor(tf),
              displayFormats: DISPLAY_FORMATS,
            },
            grid: { color: GRID },
            ticks: {
              color: NEUTRAL,
              font: { family: "'Outfit', sans-serif", size: 10 },
              maxTicksLimit: 10,
              maxRotation: 0,
              autoSkip: true,
            },
          },
          y: {
            position: 'right',
            grid: { color: GRID },
            ticks: {
              color: NEUTRAL,
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              callback: (value) => value.toLocaleString(undefined, { minimumFractionDigits: 2 }),
            },
          },
          yVol: {
            position: 'left',
            display: false,
            min: 0,
            max: maxVol * 4.5,
            grid: { display: false },
          },
        },
      },
    });

    fitPriceAxis(chartInstanceRef.current, candlesRef.current);
    chartInstanceRef.current.update('none');

    return () => {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy();
        chartInstanceRef.current = null;
      }
    };
  }, [historicalCandles, symbol, tf, showVwap, chartType, indicators, selectedDrawingId]);

  // Robust capture-phase event listeners for wheel zoom, pan, and DRAWING interactions
  useEffect(() => {
    const wrapEl = wrapRef.current;
    const canvasEl = canvasRef.current;
    if (!wrapEl || !canvasEl) return undefined;

    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const chart = chartInstanceRef.current;
      if (!chart || candlesRef.current.length === 0) return;

      const rect = canvasEl.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;

      const { left, right, top, bottom } = chart.chartArea || {};
      if (
        left === undefined ||
        clientX < left ||
        clientX > right ||
        clientY < top ||
        clientY > bottom
      ) {
        return;
      }

      const centerRatio = Math.max(0, Math.min(1, (clientX - left) / (right - left)));
      const factor = e.deltaY < 0 ? 0.82 : 1.22;
      zoomBy(factor, centerRatio);
    };

    const getChartPoint = (clientX, clientY) => {
      const chart = chartInstanceRef.current;
      if (!chart || !chart.scales.x || !chart.scales.y) return null;

      if (magnetEnabled) {
        const snap = snapToCandle(clientX, clientY, chart, candlesRef.current);
        if (snap) {
          snapPointRef.current = snap;
          return { time: snap.time, price: snap.price };
        }
      }
      snapPointRef.current = null;

      const time = chart.scales.x.getValueForPixel(clientX);
      const price = chart.scales.y.getValueForPixel(clientY);
      return { time, price };
    };

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      const chart = chartInstanceRef.current;
      if (!chart || !chart.chartArea) return;

      const rect = canvasEl.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;
      const { left, right, top, bottom } = chart.chartArea;
      if (clientX < left || clientX > right || clientY < top || clientY > bottom) return;

      // Handle PRO DRAWING creation
      if (activeDrawingTool && activeDrawingTool !== 'cursor') {
        const pt = getChartPoint(clientX, clientY);
        if (!pt) return;

        if (activeDrawingTool === 'horizontal') {
          const newH = {
            id: 'h_' + Date.now(),
            type: 'horizontal',
            price: pt.price,
            color: drawingColor,
            dashed: false,
          };
          const next = [...drawingsRef.current, newH];
          if (onUpdateDrawings) onUpdateDrawings(next);
          chart.draw();
          return;
        }

        if (!drawingInProgressRef.current) {
          // Point 1 (Start)
          if (activeDrawingTool === 'position') {
            const spread = pt.price * 0.015;
            drawingInProgressRef.current = {
              id: 'pos_' + Date.now(),
              type: 'position',
              side: 'long',
              entry: { time: pt.time, price: pt.price },
              target: { time: pt.time + tf.ms * 15, price: pt.price + spread * 2 },
              stop: { time: pt.time + tf.ms * 15, price: pt.price - spread },
            };
          } else {
            drawingInProgressRef.current = {
              id: 'draw_' + Date.now(),
              type: activeDrawingTool,
              start: { time: pt.time, price: pt.price },
              end: { time: pt.time, price: pt.price },
              color: drawingColor,
              dashed: false,
            };
          }
          chart.draw();
        } else {
          // Point 2 (Finish)
          const inProgress = drawingInProgressRef.current;
          inProgress.end = { time: pt.time, price: pt.price };
          if (activeDrawingTool === 'position') {
            inProgress.target = { time: pt.time, price: pt.price };
          }
          const next = [...drawingsRef.current, inProgress];
          drawingInProgressRef.current = null;
          if (onUpdateDrawings) onUpdateDrawings(next);
          chart.draw();
        }
        return;
      }

      // If in cursor mode: test if a drawing was clicked to select it
      if (activeDrawingTool === 'cursor') {
        const hit = findDrawingAtPixel(clientX, clientY, chart, drawingsRef.current);
        if (hit) {
          setSelectedDrawingId(hit.id);
          chart.draw();
          return;
        } else if (selectedDrawingId) {
          setSelectedDrawingId(null);
          chart.draw();
        }
      }

      // Drag to pan in pan mode or cursor mode
      const xScale = chart.scales.x;
      const candles = candlesRef.current;
      const fullMin = candles[0]?.timestamp || 0;
      const fullMax = candles[candles.length - 1]?.timestamp || 0;
      const currentMin = xScale.min !== undefined ? xScale.min : fullMin;
      const currentMax = xScale.max !== undefined ? xScale.max : fullMax;

      isDraggingRef.current = true;
      dragStartRef.current = {
        x: e.clientX,
        min: currentMin,
        max: currentMax,
      };
      wrapEl.style.cursor = 'grabbing';
    };

    const onPointerMove = (e) => {
      const chart = chartInstanceRef.current;
      if (!chart || !chart.chartArea) return;

      const rect = canvasEl.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;

      if (isDraggingRef.current) {
        e.preventDefault();
        const dx = e.clientX - dragStartRef.current.x;
        const width = chart.chartArea.width;
        const currentRange = dragStartRef.current.max - dragStartRef.current.min;
        const deltaMs = (dx / width) * currentRange;

        chart.options.scales.x.min = dragStartRef.current.min - deltaMs;
        chart.options.scales.x.max = dragStartRef.current.max - deltaMs;
        fitPriceAxis(chart, candlesRef.current);
        chart.update('none');
        updateZoomState(true);
        return;
      }

      // Live drawing update during movement
      if (drawingInProgressRef.current) {
        const pt = getChartPoint(clientX, clientY);
        if (pt) {
          drawingInProgressRef.current.end = { time: pt.time, price: pt.price };
          if (drawingInProgressRef.current.type === 'position') {
            drawingInProgressRef.current.target = { time: pt.time, price: pt.price };
          }
          chart.draw();
        }
      }

      // Crosshair tracking
      const { left, right, top, bottom } = chart.chartArea;
      if (clientX >= left && clientX <= right && clientY >= top && clientY <= bottom) {
        crosshairPosRef.current = { x: clientX, y: clientY };

        if (magnetEnabled) {
          snapToCandle(clientX, clientY, chart, candlesRef.current);
        }

        const xScale = chart.scales.x;
        const hoverTs = xScale.getValueForPixel(clientX);
        const candles = candlesRef.current;
        let closest = null;
        let minDiff = Infinity;
        for (let i = 0; i < candles.length; i++) {
          const diff = Math.abs(candles[i].timestamp - hoverTs);
          if (diff < minDiff) {
            minDiff = diff;
            closest = candles[i];
          }
        }
        if (onHoverBar && closest && minDiff <= tf.ms * 1.5) {
          onHoverBar(closest);
        }

        chart.draw();
      } else {
        if (crosshairPosRef.current) {
          crosshairPosRef.current = null;
          snapPointRef.current = null;
          if (onHoverBar) onHoverBar(null);
          chart.draw();
        }
      }
    };

    const onPointerUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        wrapEl.style.cursor = activeDrawingTool !== 'cursor' ? 'crosshair' : interactionMode === 'pan' ? 'grab' : 'crosshair';
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        drawingInProgressRef.current = null;
        snapPointRef.current = null;
        setSelectedDrawingId(null);
        if (chartInstanceRef.current) chartInstanceRef.current.draw();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedDrawingId) {
          const next = drawingsRef.current.filter((d) => d.id !== selectedDrawingId);
          setSelectedDrawingId(null);
          if (onUpdateDrawings) onUpdateDrawings(next);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (onUndo) onUndo();
      }
    };

    const onGesture = (e) => {
      e.preventDefault();
    };

    wrapEl.addEventListener('wheel', onWheel, { passive: false, capture: true });
    canvasEl.addEventListener('wheel', onWheel, { passive: false, capture: true });
    canvasEl.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKeyDown);
    wrapEl.addEventListener('gesturestart', onGesture, { passive: false });
    wrapEl.addEventListener('gesturechange', onGesture, { passive: false });

    return () => {
      wrapEl.removeEventListener('wheel', onWheel, { capture: true });
      canvasEl.removeEventListener('wheel', onWheel, { capture: true });
      canvasEl.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      wrapEl.removeEventListener('gesturestart', onGesture);
      wrapEl.removeEventListener('gesturechange', onGesture);
    };
  }, [
    zoomBy,
    updateZoomState,
    interactionMode,
    activeDrawingTool,
    magnetEnabled,
    drawingColor,
    onHoverBar,
    tf.ms,
    onUpdateDrawings,
    onUndo,
    selectedDrawingId,
  ]);

  // Handle live activeCandle updates
  useEffect(() => {
    const chart = chartInstanceRef.current;
    if (!chart || !activeCandle) return;

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
    upsertCandle(candles, { ...merged, timestamp: bucket });

    const workingCandles = chartType === 'heikinAshi' ? toHeikinAshi(candles) : candles;

    if (chartType === 'candlestick' || chartType === 'heikinAshi' || chartType === 'ohlc') {
      chart.data.datasets[0].data = workingCandles.map(toFinancialPoint);
    } else {
      chart.data.datasets[0].data = workingCandles.map(toLinePoint);
    }

    let dsIdx = 1;
    if (indicators.ema9 && chart.data.datasets[dsIdx]) {
      chart.data.datasets[dsIdx++].data = calculateEMA(candles, 9);
    }
    if (indicators.ema21 && chart.data.datasets[dsIdx]) {
      chart.data.datasets[dsIdx++].data = calculateEMA(candles, 21);
    }
    if (indicators.sma50 && chart.data.datasets[dsIdx]) {
      chart.data.datasets[dsIdx++].data = calculateSMA(candles, 50);
    }
    if (indicators.sma200 && chart.data.datasets[dsIdx]) {
      chart.data.datasets[dsIdx++].data = calculateSMA(candles, 200);
    }
    if (indicators.bollinger && chart.data.datasets[dsIdx + 2]) {
      const bb = calculateBollingerBands(candles, 20, 2);
      chart.data.datasets[dsIdx++].data = bb.upper;
      chart.data.datasets[dsIdx++].data = bb.middle;
      chart.data.datasets[dsIdx++].data = bb.lower;
    }
    if (showVwap && chart.data.datasets[dsIdx]) {
      chart.data.datasets[dsIdx++].data = candles.map((c) => ({
        x: c.timestamp,
        y: sessionVwap ?? null,
      }));
    }
    if ((indicators.volume ?? true) && chart.data.datasets[dsIdx]) {
      chart.data.datasets[dsIdx].data = candles.map((c) => ({
        x: c.timestamp,
        y: c.volume || 0,
      }));
      chart.data.datasets[dsIdx].backgroundColor = candles.map((c) =>
        c.close >= c.open ? 'rgba(8, 153, 129, 0.35)' : 'rgba(242, 54, 69, 0.35)'
      );
    }

    if (!isZoomed) {
      fitPriceAxis(chart, candles);
    }

    chart.update('none');
  }, [activeCandle, sessionVwap, tf, showVwap, isZoomed, chartType, indicators]);

  return (
    <div
      className={`chart-canvas-wrap ${
        activeDrawingTool !== 'cursor'
          ? 'mode-drawing'
          : interactionMode === 'pan'
          ? 'mode-pan'
          : 'mode-crosshair'
      }`}
      ref={wrapRef}
      onDoubleClick={resetView}
    >
      <canvas ref={canvasRef} />
    </div>
  );
});

export default PriceChart;
