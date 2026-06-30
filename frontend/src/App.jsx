// ---------------------------------------------------------------------------
// App (frontend — a HUB CONSUMER)
//
// The browser never talks to Binance. It connects to OUR OWN WebSocket server
// (the distribution layer) and speaks a tiny JSON protocol:
//
//   client -> server:  { type: 'SUBSCRIBE'   | 'UNSUBSCRIBE', symbol }
//                      { type: 'SET_ALERT'   | 'REMOVE_ALERT', ... }
//   server -> client:  { type: 'UPDATE',          data: goldenRecord }
//                      { type: 'FEED_STATUS',      status }
//                      { type: 'ALERT_CONFIRMED' | 'ALERT_REMOVED' | 'ALERT_TRIGGERED', data }
//
// So the watchlist buttons literally drive subscribe/unsubscribe over the wire,
// and price alerts are just another consumer of the same hub updates.
//
// All of the real state lives in the handful of useState hooks below; the JSX
// at the bottom is a pure render of that state.
// ---------------------------------------------------------------------------

import React, { useState, useEffect, useRef } from 'react';
import TickerCard from './components/TickerCard';
import ConsolePanel from './components/ConsolePanel';
import PriceChart from './components/PriceChart';
import './App.css';

function App() {
  const [symbols, setSymbols] = useState([]);
  const [records, setRecords] = useState({});
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [logs, setLogs] = useState([]);
  
  // Watchlist & Selected Symbol States
  const [watchlist, setWatchlist] = useState([]);
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [historicalCandles, setHistoricalCandles] = useState([]);
  
  // Alerts & Notifications States
  const [activeAlerts, setActiveAlerts] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [alertSymbol, setAlertSymbol] = useState('');
  const [alertPrice, setAlertPrice] = useState('');
  const [alertCondition, setAlertCondition] = useState('ABOVE');
  const [upstreamStatus, setUpstreamStatus] = useState('connecting');

  const socketRef = useRef(null);

  // Helper to add log entries with a timestamp
  const logMessage = (type, text) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => {
      const updated = [...prev, { type, text, timestamp }];
      if (updated.length > 200) {
        return updated.slice(updated.length - 200);
      }
      return updated;
    });
  };

  const clearLogs = () => {
    setLogs([]);
  };

  // 1. Fetch active symbols from server REST endpoint
  useEffect(() => {
    logMessage('SYSTEM', 'Fetching active symbols config...');
    fetch('/health')
      .then((res) => res.json())
      .then((data) => {
        const fetchedSymbols = data.symbols || [];
        const upperSymbols = fetchedSymbols.map(s => s.toUpperCase());
        setSymbols(fetchedSymbols);
        setWatchlist(upperSymbols);
        logMessage('SYSTEM', `Loaded symbols: ${upperSymbols.join(', ')}`);

        if (upperSymbols.length > 0) {
          setSelectedSymbol(upperSymbols[0]);
          setAlertSymbol(upperSymbols[0]);
        }

        // Pre-initialize empty records for each symbol
        const initialRecords = {};
        upperSymbols.forEach((sym) => {
          initialRecords[sym] = {
            symbol: sym,
            lastPrice: null,
            bestBid: null,
            bestAsk: null,
            lastTradeTime: null,
            activeCandle: null,
            source: null,
          };
        });
        setRecords(initialRecords);
      })
      .catch((err) => {
        logMessage('SYSTEM', `Failed to load symbols config: ${err.message}`);
      });
  }, []);

  // 2. Fetch historical candle data when the selected symbol changes
  useEffect(() => {
    if (!selectedSymbol || !watchlist.includes(selectedSymbol)) {
      setHistoricalCandles([]);
      return;
    }

    logMessage('SYSTEM', `Fetching 1m candle history for ${selectedSymbol}...`);
    fetch(`/api/history?symbol=${selectedSymbol}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.candles) {
          setHistoricalCandles(data.candles);
          logMessage('SYSTEM', `Successfully backfilled ${data.candles.length} historical candles for ${selectedSymbol}.`);
        }
      })
      .catch((err) => {
        logMessage('SYSTEM', `Failed to load candle history: ${err.message}`);
      });
  }, [selectedSymbol, watchlist]);

  // 3. Manage WebSocket connection and message subscription
  useEffect(() => {
    if (symbols.length === 0) return;

    let reconnectTimer;

    const connectWS = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.hostname === 'localhost' ? 'localhost:3000' : window.location.host;
      const wsUrl = `${protocol}//${host}`;

      logMessage('SYSTEM', `Opening WebSocket connection to ${wsUrl}...`);
      setConnectionStatus('connecting');

      const ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        logMessage('SYSTEM', 'WebSocket connection established with distribution server.');
        setConnectionStatus('connected');

        // Subscribe to all currently active watchlist symbols
        watchlist.forEach((sym) => {
          logMessage('SUBSCRIBE', `Requesting subscription for ${sym}`);
          ws.send(JSON.stringify({ type: 'SUBSCRIBE', symbol: sym }));
        });

        // Re-register active alerts on the backend if socket dropped and reconnected
        activeAlerts.forEach((alert) => {
          logMessage('SYSTEM', `Re-registering alert for ${alert.symbol} at ${alert.condition} ${alert.value}`);
          ws.send(
            JSON.stringify({
              type: 'SET_ALERT',
              id: alert.id,
              symbol: alert.symbol,
              value: alert.value,
              condition: alert.condition,
            })
          );
        });
      };

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (e) {
          console.error('Failed to parse incoming WebSocket message', e);
          return;
        }

        if (!msg || !msg.type) return;

        const data = msg.data;

        if (msg.type === 'FEED_STATUS') {
          setUpstreamStatus(msg.status);
          logMessage('SYSTEM', `Upstream feed status updated to: ${msg.status}`);
        } else if (msg.type === 'UPDATE' && data) {
          const sym = data.symbol.toUpperCase();

          setRecords((prev) => {
            const currentPrice = data.lastPrice;
            const previous = prev[sym];
            if (previous && currentPrice !== null && currentPrice !== undefined) {
              if (previous.lastPrice !== null && previous.lastPrice !== undefined) {
                if (currentPrice > previous.lastPrice) {
                  logMessage('UPDATE', `${sym} price ticked UP to ${currentPrice}`);
                } else if (currentPrice < previous.lastPrice) {
                  logMessage('UPDATE', `${sym} price ticked DOWN to ${currentPrice}`);
                }
              }
            }
            return {
              ...prev,
              [sym]: {
                ...prev[sym],
                ...data,
                lastReceivedAt: Date.now(),
              },
            };
          });
        } else if (msg.type === 'ALERT_CONFIRMED' && data) {
          // Add to local alerts list if not already present
          setActiveAlerts((prev) => {
            if (prev.some((a) => a.id === data.id)) return prev;
            return [...prev, data];
          });
          logMessage('SYSTEM', `Alert confirmed: ${data.symbol} ${data.condition} ${data.value}`);
        } else if (msg.type === 'ALERT_REMOVED' && data) {
          setActiveAlerts((prev) => prev.filter((a) => a.id !== data.id));
          logMessage('SYSTEM', `Alert removed by server ID: ${data.id}`);
        } else if (msg.type === 'ALERT_TRIGGERED' && data) {
          // Remove from local active alerts list
          setActiveAlerts((prev) => prev.filter((a) => a.id !== data.id));

          // Trigger Toast Notification
          const notifId = Math.random().toString(36).substring(2, 9);
          const newToast = {
            id: notifId,
            type: 'warning',
            title: 'Price Alert Triggered!',
            message: `${data.symbol} crossed target of ${data.condition} ${data.value} (Actual: ${data.price})`,
          };
          setNotifications((prev) => [newToast, ...prev]);
          logMessage('ALERT', `ALERT TRIGGERED: ${data.symbol} reached ${data.price} (Target: ${data.condition} ${data.value})`);

          // Auto dismiss toast after 6 seconds
          setTimeout(() => {
            setNotifications((prev) => prev.filter((n) => n.id !== notifId));
          }, 6000);
        }
      };

      ws.onclose = () => {
        logMessage('SYSTEM', 'WebSocket connection disconnected. Reconnecting in 3s...');
        setConnectionStatus('disconnected');
        reconnectTimer = setTimeout(connectWS, 3000);
      };

      ws.onerror = (err) => {
        logMessage('SYSTEM', 'WebSocket error encountered.');
        console.error(err);
      };
    };

    connectWS();

    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
    };
  }, [symbols, watchlist]);

  // Handle Watchlist addition/removal
  const toggleWatchlist = (sym) => {
    const isWatched = watchlist.includes(sym);
    const ws = socketRef.current;

    if (isWatched) {
      // Remove from watchlist
      const updated = watchlist.filter((s) => s !== sym);
      setWatchlist(updated);

      if (ws && ws.readyState === WebSocket.OPEN) {
        logMessage('UNSUBSCRIBE', `Sending UNSUBSCRIBE for ${sym}`);
        ws.send(JSON.stringify({ type: 'UNSUBSCRIBE', symbol: sym }));
      }

      // Also clean up alerts associated with this symbol
      setActiveAlerts((prev) => prev.filter((a) => a.symbol !== sym));

      // Adjust selected symbol if we removed the active one
      if (selectedSymbol === sym) {
        setSelectedSymbol(updated.length > 0 ? updated[0] : '');
      }
    } else {
      // Add back to watchlist
      const updated = [...watchlist, sym];
      setWatchlist(updated);

      if (ws && ws.readyState === WebSocket.OPEN) {
        logMessage('SUBSCRIBE', `Sending SUBSCRIBE for ${sym}`);
        ws.send(JSON.stringify({ type: 'SUBSCRIBE', symbol: sym }));
      }

      if (!selectedSymbol) {
        setSelectedSymbol(sym);
      }
    }
  };

  // Handle setting a new alert
  const handleSetAlert = (e) => {
    e.preventDefault();
    const ws = socketRef.current;
    const value = parseFloat(alertPrice);

    if (isNaN(value) || value <= 0) return;
    if (!alertSymbol) return;

    const alertId = Math.random().toString(36).substring(2, 9);

    if (ws && ws.readyState === WebSocket.OPEN) {
      logMessage('SYSTEM', `Requesting alert: ${alertSymbol} ${alertCondition} ${value}`);
      ws.send(
        JSON.stringify({
          type: 'SET_ALERT',
          id: alertId,
          symbol: alertSymbol,
          value,
          condition: alertCondition,
        })
      );
      setAlertPrice('');
    } else {
      logMessage('SYSTEM', 'Cannot set alert: WebSocket connection is offline.');
    }
  };

  // Handle deleting an active alert
  const handleDeleteAlert = (alertId) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'REMOVE_ALERT', id: alertId }));
    }
  };

  const closeNotification = (id) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  return (
    <div className="app-container">
      {/* Toast Notification Feed */}
      <div className="toast-container">
        {notifications.map((n) => (
          <div key={n.id} className="toast-item">
            <div className="toast-header">
              <span className="toast-title-warning">⚠ {n.title}</span>
              <button className="toast-close" onClick={() => closeNotification(n.id)}>×</button>
            </div>
            <div className="toast-body">{n.message}</div>
          </div>
        ))}
      </div>

      <header>
        <div className="logo-group">
          <div className="logo-icon">H</div>
          <h1>Live Market Data Hub</h1>
        </div>
        <div className={`status-badge ${connectionStatus === 'connected' ? upstreamStatus : connectionStatus}`}>
          {connectionStatus === 'connected' ? `Upstream: ${upstreamStatus}` : `Server: ${connectionStatus}`}
        </div>
      </header>

      <main>
        {/* Watchlist Manager Panel */}
        <section className="watchlist-panel">
          <span className="watchlist-title">Watchlist Toggle:</span>
          {symbols.map((sym) => {
            const upper = sym.toUpperCase();
            const isActive = watchlist.includes(upper);
            return (
              <button
                key={upper}
                className={`watchlist-btn ${isActive ? 'active' : ''}`}
                onClick={() => toggleWatchlist(upper)}
              >
                {isActive ? '✓' : '+'} {upper}
              </button>
            );
          })}
        </section>

        {/* Real-time price cards (mapped only if in watchlist) */}
        <section className="ticker-grid">
          {symbols
            .filter((sym) => watchlist.includes(sym.toUpperCase()))
            .map((sym) => {
              const key = sym.toUpperCase();
              return (
                <TickerCard
                  key={key}
                  record={records[key]}
                  isSelected={selectedSymbol === key}
                  onClick={() => setSelectedSymbol(key)}
                />
              );
            })}
        </section>

        {/* Live chart and Alerts side-by-side dashboard row.
            The 2:1 column split is handled by `.dashboard-mid-row` (CSS grid). */}
        <div className="dashboard-mid-row">
          {/* Chart Panel */}
          <section className="chart-card">
            {selectedSymbol && watchlist.includes(selectedSymbol) && historicalCandles.length > 0 ? (
              <>
                <div className="chart-header">
                  <span className="chart-title">{selectedSymbol} Live Price Chart</span>
                  <span className="chart-subtitle">
                    Interval: 1m (Close Price)
                  </span>
                </div>
                <PriceChart
                  symbol={selectedSymbol}
                  historicalCandles={historicalCandles}
                  activeCandle={records[selectedSymbol]?.activeCandle}
                />
              </>
            ) : (
              <div className="chart-empty">
                No active symbol selected. Click a price card or toggle a symbol to view chart.
              </div>
            )}
          </section>

          {/* Alerts Panel */}
          <section className="alerts-card">
            <h2>Price Alerts Manager</h2>
            <form className="alerts-form" onSubmit={handleSetAlert}>
              <div className="form-group">
                <label>Symbol</label>
                <select
                  value={alertSymbol}
                  onChange={(e) => setAlertSymbol(e.target.value)}
                  disabled={watchlist.length === 0}
                >
                  {watchlist.map((sym) => (
                    <option key={sym} value={sym}>
                      {sym}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Target Price</label>
                <input
                  type="number"
                  step="any"
                  placeholder="e.g. 59500"
                  value={alertPrice}
                  onChange={(e) => setAlertPrice(e.target.value)}
                  required
                  disabled={watchlist.length === 0}
                />
              </div>
              <div className="form-group">
                <label>Trigger Condition</label>
                <select
                  value={alertCondition}
                  onChange={(e) => setAlertCondition(e.target.value)}
                  disabled={watchlist.length === 0}
                >
                  <option value="ABOVE">Price is Above (&ge;)</option>
                  <option value="BELOW">Price is Below (&le;)</option>
                </select>
              </div>
              <button type="submit" className="btn-primary" disabled={watchlist.length === 0}>
                Set Alert
              </button>
            </form>

            <div className="active-alerts-section">
              <span className="section-label">
                Active Alerts ({activeAlerts.length})
              </span>
              <div className="active-alerts-list">
                {activeAlerts.length === 0 ? (
                  <div className="empty-alerts-text">No active alerts set</div>
                ) : (
                  activeAlerts.map((alert) => (
                    <div key={alert.id} className="active-alert-item">
                      <span>
                        {alert.symbol} {alert.condition === 'ABOVE' ? '≥' : '≤'} {alert.value}
                      </span>
                      <button
                        className="btn-delete-alert"
                        onClick={() => handleDeleteAlert(alert.id)}
                        title="Delete Alert"
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        </div>

        {/* Live logs console */}
        <ConsolePanel logs={logs} onClear={clearLogs} />
      </main>
    </div>
  );
}

export default App;
