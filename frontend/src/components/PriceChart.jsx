import React, { useEffect, useRef } from 'react';
import { Chart, registerables } from 'chart.js';
import 'chartjs-adapter-date-fns';
import {
  CandlestickController,
  CandlestickElement,
  OhlcController,
  OhlcElement,
} from 'chartjs-chart-financial';

Chart.register(...registerables, CandlestickController, CandlestickElement, OhlcController, OhlcElement);

// TradingView palette (matches App.css tokens — Chart.js can't read CSS vars)
const UP = '#089981';
const DOWN = '#f23645';
const NEUTRAL = '#787b86';
const GRID = 'rgba(42, 46, 57, 0.55)';
const CANDLE_COLORS = { up: UP, down: DOWN, unchanged: NEUTRAL };

const toPoint = (c) => ({ x: c.timestamp, o: c.open, h: c.high, l: c.low, c: c.close });

// Real candlesticks from the SELF-BUILT 1m OHLCV candles (REST backfill +
// IndexedDB history + live aggregation) — not a provider widget.
function PriceChart({ symbol, historicalCandles, activeCandle, sessionVwap }) {
  const canvasRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const candlesRef = useRef([]);
  // Latest VWAP for the (re)build effect — a ref so a VWAP tick never
  // destroys/recreates the whole chart; the live effect repaints the line.
  const vwapRef = useRef(sessionVwap);
  vwapRef.current = sessionVwap;

  // 1. (Re)build the chart when the symbol or backfill changes
  useEffect(() => {
    if (!historicalCandles || historicalCandles.length === 0) return;

    candlesRef.current = [...historicalCandles];
    const ctx = canvasRef.current.getContext('2d');
    if (chartInstanceRef.current) {
      chartInstanceRef.current.destroy();
    }

    chartInstanceRef.current = new Chart(ctx, {
      type: 'candlestick',
      data: {
        datasets: [
          {
            label: `${symbol} 1m`,
            data: candlesRef.current.map(toPoint),
            // chartjs-chart-financial reads these {up,down,unchanged} maps
            color: CANDLE_COLORS,
            borderColor: CANDLE_COLORS,
            backgroundColor: CANDLE_COLORS,
            borderColors: CANDLE_COLORS,
            backgroundColors: CANDLE_COLORS,
          },
          {
            type: 'line',
            label: 'Session VWAP',
            data: candlesRef.current.map((c) => ({ x: c.timestamp, y: vwapRef.current ?? null })),
            borderColor: '#9085e9',
            borderDash: [6, 4],
            borderWidth: 1.5,
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: {
              color: NEUTRAL,
              boxWidth: 14,
              boxHeight: 2,
              font: { family: "'Outfit', sans-serif", size: 10 },
            },
          },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: '#1e222d',
            titleColor: NEUTRAL,
            bodyColor: '#d1d4dc',
            borderColor: '#2a2e39',
            borderWidth: 1,
            bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
            titleFont: { family: "'Outfit', sans-serif", size: 10 },
          },
        },
        scales: {
          x: {
            type: 'timeseries',
            time: {
              unit: 'minute',
              tooltipFormat: 'HH:mm',
              displayFormats: { minute: 'HH:mm' },
            },
            grid: { color: GRID },
            ticks: {
              color: NEUTRAL,
              font: { family: "'Outfit', sans-serif", size: 10 },
              maxTicksLimit: 10,
              maxRotation: 0,
            },
          },
          y: {
            // Price axis on the RIGHT — the trading-terminal convention
            position: 'right',
            grid: { color: GRID },
            ticks: {
              color: NEUTRAL,
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              callback: (value) => value.toLocaleString(undefined, { minimumFractionDigits: 2 }),
            },
          },
        },
      },
    });

    return () => {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy();
        chartInstanceRef.current = null;
      }
    };
  }, [historicalCandles, symbol]);

  // 2. Incorporate live active-candle + VWAP updates from the feed
  useEffect(() => {
    const chart = chartInstanceRef.current;
    if (!chart || !activeCandle) return;

    const candles = candlesRef.current;
    if (candles.length === 0) return;

    const lastCandle = candles[candles.length - 1];

    if (activeCandle.timestamp === lastCandle.timestamp) {
      // Update the active candle in the buffer
      candles[candles.length - 1] = activeCandle;
    } else if (activeCandle.timestamp > lastCandle.timestamp) {
      // A new minute has rolled over! Append it to the history
      candles.push(activeCandle);
      // Cap on-screen history (persisted history can exceed the backfill window)
      if (candles.length > 1000) {
        candles.shift();
      }
    }

    chart.data.datasets[0].data = candles.map(toPoint);
    chart.data.datasets[1].data = candles.map((c) => ({ x: c.timestamp, y: sessionVwap ?? null }));

    // Update the chart without transitions to save performance
    chart.update('none');
  }, [activeCandle, sessionVwap]);

  return (
    <div className="chart-canvas-wrap">
      <canvas ref={canvasRef} />
    </div>
  );
}

export default PriceChart;
