import React, { useEffect, useRef } from 'react';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

function PriceChart({ symbol, historicalCandles, activeCandle, sessionVwap }) {
  const canvasRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const candlesRef = useRef([]);
  // Latest VWAP for the (re)build effect — a ref so a VWAP tick never
  // destroys/recreates the whole chart; the live effect repaints the line.
  const vwapRef = useRef(sessionVwap);
  vwapRef.current = sessionVwap;

  // 1. Initialize and update chart on new historical data (e.g., symbol change)
  useEffect(() => {
    if (!historicalCandles || historicalCandles.length === 0) return;

    // Cache the candles locally in a mutable ref
    candlesRef.current = [...historicalCandles];

    const ctx = canvasRef.current.getContext('2d');

    // Destroy existing chart if it exists
    if (chartInstanceRef.current) {
      chartInstanceRef.current.destroy();
    }

    const labels = candlesRef.current.map((c) =>
      new Date(c.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    );
    const data = candlesRef.current.map((c) => c.close);

    // Create the Chart.js instance with premium styling
    chartInstanceRef.current = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: `${symbol} 1m Close`,
            data,
            // Neutral series blue (5.0:1 on the panel surface) — the up/down
            // greens/reds are reserved for directional deltas, not the series.
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.06)',
            fill: true,
            tension: 0.15,
            borderWidth: 2,
            pointRadius: 0, // hide points for a clean look
            pointHoverRadius: 4,
          },
          {
            label: 'Session VWAP',
            // Horizontal benchmark line at the live session VWAP (violet —
            // distinct from the price series, not a status color)
            data: labels.map(() => vwapRef.current ?? null),
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
          // Two series on one axis -> the legend is required so identity is
          // never color-alone
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: {
              color: '#8b9bb4',
              boxWidth: 14,
              boxHeight: 2,
              font: { family: "'Outfit', sans-serif", size: 10 },
            },
          },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: '#10151f',
            titleColor: '#8b9bb4',
            bodyColor: '#e8edf5',
            borderColor: '#1d2839',
            borderWidth: 1,
            bodyFont: {
              family: "'Outfit', sans-serif",
            },
            titleFont: {
              family: "'Outfit', sans-serif",
            },
          },
        },
        scales: {
          x: {
            grid: {
              color: 'rgba(29, 40, 57, 0.5)',
            },
            ticks: {
              color: '#8b9bb4',
              font: {
                family: "'Outfit', sans-serif",
                size: 10,
              },
              maxTicksLimit: 12,
            },
          },
          y: {
            grid: {
              color: 'rgba(29, 40, 57, 0.5)',
            },
            ticks: {
              color: '#8b9bb4',
              font: {
                family: "'JetBrains Mono', monospace",
                size: 10,
              },
              callback: function (value) {
                return value.toLocaleString(undefined, { minimumFractionDigits: 2 });
              },
            },
          },
        },
      },
    });

    // Cleanup on unmount
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

    // Refresh chart datasets (price series + VWAP benchmark line)
    chart.data.labels = candles.map((c) =>
      new Date(c.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    );
    chart.data.datasets[0].data = candles.map((c) => c.close);
    chart.data.datasets[1].data = candles.map(() => sessionVwap ?? null);

    // Update the chart without trigger transitions to save performance
    chart.update('none');
  }, [activeCandle, sessionVwap]);

  return (
    <div className="chart-canvas-wrap">
      <canvas ref={canvasRef} />
    </div>
  );
}

export default PriceChart;
