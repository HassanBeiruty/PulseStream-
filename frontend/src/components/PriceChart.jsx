import React, { useEffect, useRef } from 'react';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

function PriceChart({ symbol, historicalCandles, activeCandle }) {
  const canvasRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const candlesRef = useRef([]);

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
            label: `${symbol} 1m Candle Close`,
            data,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.03)',
            fill: true,
            tension: 0.15,
            borderWidth: 2,
            pointRadius: 0, // hide points for a clean look
            pointHoverRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: '#121824',
            titleColor: '#8b9bb4',
            bodyColor: '#f0f4f9',
            borderColor: '#212c40',
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
              color: 'rgba(33, 44, 64, 0.3)',
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
              color: 'rgba(33, 44, 64, 0.3)',
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

  // 2. Incorporate live active candle updates from WebSocket
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
      // Limit to 100 historical points on screen
      if (candles.length > 100) {
        candles.shift();
      }
    }

    // Refresh chart datasets
    chart.data.labels = candles.map((c) =>
      new Date(c.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    );
    chart.data.datasets[0].data = candles.map((c) => c.close);

    // Update the chart without trigger transitions to save performance
    chart.update('none');
  }, [activeCandle]);

  return (
    <div className="chart-canvas-wrap">
      <canvas ref={canvasRef} />
    </div>
  );
}

export default PriceChart;
