// ---------------------------------------------------------------------------
// App (frontend — a HUB CONSUMER)
//
// The UI consumes the DataFeed PORT (see feed/index.js) and never a concrete
// transport: in hub mode the adapter speaks the JSON wire protocol to our
// distribution server; in direct mode it runs the shared pipeline in-browser.
// Either way, App sees the same surface:
//
//   methods: subscribe / unsubscribe / setAlert / removeAlert
//   events:  update (goldenRecord) / feedStatus / alertConfirmed /
//            alertRemoved / alertTriggered / open / close / error
//
// So the watchlist buttons literally drive subscribe/unsubscribe on the feed,
// and price alerts are just another consumer of the same hub updates.
//
// All of the real state lives in the handful of useState hooks below; the JSX
// at the bottom is a pure render of that state.
// ---------------------------------------------------------------------------

import React, { useState, useEffect, useRef, useReducer } from 'react';
import TickerTape from './components/TickerTape';
import MarketWatch from './components/MarketWatch';
import TicketPanel from './components/TicketPanel';
import Blotter from './components/Blotter';
import PriceChart from './components/PriceChart';
import { PaperOMS, positionUnrealized } from '../../shared/oms.js';
import { fetchHealth, fetchHistory, createDataFeed, feedTargetLabel, symbolLabel, DIRECT_MODE } from './dataSource';
import { formatPrice, formatDeltaPct, spreadInfo, formatSigned, formatQty } from './format';
import './App.css';

// localStorage key for the paper-trading book (orders/fills/positions)
const OMS_STORAGE_KEY = 'pulsestream.oms.v1';

// Big last-price readout in the instrument bar; flashes up/down on ticks
// (direction is also carried by the adjacent signed Session Δ, never color alone).
function FlashPrice({ price }) {
  const [flashClass, setFlashClass] = useState('');
  const prevRef = useRef(null);

  useEffect(() => {
    if (price !== null && price !== undefined) {
      const prev = prevRef.current;
      if (prev !== null && prev !== undefined) {
        if (price > prev) setFlashClass('price-flash-up');
        else if (price < prev) setFlashClass('price-flash-down');
      }
      prevRef.current = price;
    }
  }, [price]);

  useEffect(() => {
    if (!flashClass) return undefined;
    const timer = setTimeout(() => setFlashClass(''), 700);
    return () => clearTimeout(timer);
  }, [flashClass]);

  return <span className={`instrument-price ${flashClass}`}>{formatPrice(price)}</span>;
}

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

  const feedRef = useRef(null);
  const prevTabPriceRef = useRef(null);
  // First price seen per symbol this session — the baseline for "Session Δ"
  const sessionOpenRef = useRef({});
  // Live mirror of activeAlerts for the reconnect handler: reading the state
  // directly there would capture a stale closure (alerts set after connect
  // would never re-register on reconnect).
  const activeAlertsRef = useRef([]);

  useEffect(() => {
    activeAlertsRef.current = activeAlerts;
  }, [activeAlerts]);

  // Paper-trading OMS: one engine per session, restored from localStorage.
  // It is a feed CONSUMER like the alert book — golden records tick it in the
  // feed 'update' handler below; it never talks to any transport itself.
  const omsRef = useRef(null);
  if (omsRef.current === null) {
    let restored = null;
    try {
      restored = PaperOMS.restore(localStorage.getItem(OMS_STORAGE_KEY));
    } catch {
      restored = null;
    }
    omsRef.current = restored || new PaperOMS();
  }
  // Bumped on every OMS mutation so React re-reads getState() during render
  const [, bumpOmsVersion] = useReducer((v) => v + 1, 0);

  // Small polish: show the selected symbol's live price (with tick direction)
  // in the browser tab, like real trading dashboards do.
  useEffect(() => {
    const price = selectedSymbol ? records[selectedSymbol]?.lastPrice : null;
    if (price === null || price === undefined) {
      document.title = 'PulseStream Terminal';
      return;
    }
    const prev = prevTabPriceRef.current;
    const arrow = prev !== null && price !== prev ? (price > prev ? ' ▲' : ' ▼') : '';
    prevTabPriceRef.current = price;
    document.title = `${selectedSymbol} ${price.toLocaleString()}${arrow} · PulseStream Terminal`;
  }, [records, selectedSymbol]);

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

  // Toast helper (alerts, fills, rejects) — auto-dismisses after 6s
  const pushToast = (type, title, message) => {
    const id = Math.random().toString(36).substring(2, 9);
    setNotifications((prev) => [{ id, type, title, message }, ...prev]);
    setTimeout(() => {
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, 6000);
  };

  // Wire OMS events once: persist + re-render on every mutation, log + toast
  // the order lifecycle (accepted -> filled/canceled, or rejected).
  useEffect(() => {
    const oms = omsRef.current;
    const persist = () => {
      try {
        localStorage.setItem(OMS_STORAGE_KEY, oms.serialize());
      } catch {
        /* storage blocked/full — paper book just won't survive reload */
      }
      bumpOmsVersion();
    };

    const subscriptions = [
      oms.on('changed', persist),
      oms.on('accepted', (o) =>
        logMessage(
          'ORDER',
          `${o.type} ${o.side} ${formatQty(o.qty)} ${o.symbol}${o.limitPrice !== null ? ` @ ${o.limitPrice}` : ''} accepted`
        )
      ),
      oms.on('filled', ({ fill }) => {
        logMessage(
          'ORDER',
          `FILLED ${fill.side} ${formatQty(fill.qty)} ${fill.symbol} @ ${fill.price} (fee ${fill.fee.toFixed(4)})`
        );
        pushToast(
          'success',
          'Order Filled (paper)',
          `${fill.side} ${formatQty(fill.qty)} ${fill.symbol} @ ${fill.price.toLocaleString()} · fee ${fill.fee.toFixed(4)} USDT`
        );
      }),
      oms.on('rejected', ({ reason }) => {
        logMessage('ORDER', `REJECTED: ${reason}`);
        pushToast('warning', 'Order Rejected', reason);
      }),
      oms.on('canceled', (o) =>
        logMessage(
          'ORDER',
          `Canceled ${o.side} ${formatQty(o.qty)} ${o.symbol}${o.limitPrice !== null ? ` @ ${o.limitPrice}` : ''}`
        )
      ),
    ];
    return () => subscriptions.forEach((off) => off());
  }, []);

  // 1. Fetch active symbols from server REST endpoint
  useEffect(() => {
    logMessage('SYSTEM', 'Fetching active symbols config...');
    fetchHealth()
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
    fetchHistory(selectedSymbol)
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

  // 3. Manage the DataFeed connection. App only wires PORT events here — it
  //    has no idea whether the adapter is our hub socket or direct Binance.
  useEffect(() => {
    if (symbols.length === 0) return;

    let reconnectTimer;
    // Guards the feed's async 'close' event: without it, cleanup would close
    // the feed and the late 'close' would still schedule a rogue reconnect.
    let disposed = false;

    const connectFeed = () => {
      logMessage('SYSTEM', `Opening data feed connection to ${feedTargetLabel()}...`);
      setConnectionStatus('connecting');

      const feed = createDataFeed();
      feedRef.current = feed;

      feed.on('open', () => {
        logMessage('SYSTEM', 'Data feed connection established.');
        setConnectionStatus('connected');

        // Subscribe to all currently active watchlist symbols
        watchlist.forEach((sym) => {
          logMessage('SUBSCRIBE', `Requesting subscription for ${sym}`);
          feed.subscribe(sym);
        });

        // Re-register active alerts if the feed dropped and reconnected
        // (read via ref — see activeAlertsRef above)
        activeAlertsRef.current.forEach((alert) => {
          logMessage('SYSTEM', `Re-registering alert for ${alert.symbol} at ${alert.condition} ${alert.value}`);
          feed.setAlert(alert);
        });
      });

      feed.on('feedStatus', ({ status }) => {
        setUpstreamStatus(status);
        logMessage('SYSTEM', `Upstream feed status updated to: ${status}`);
      });

      feed.on('update', (data) => {
        const sym = data.symbol.toUpperCase();

        // Capture the session baseline the first time a symbol prints
        if (
          data.lastPrice !== null &&
          data.lastPrice !== undefined &&
          sessionOpenRef.current[sym] === undefined
        ) {
          sessionOpenRef.current[sym] = data.lastPrice;
        }

        // Tick the paper OMS with the same golden record (executes any
        // resting limit orders the new top-of-book crosses)
        omsRef.current.onTick(data);

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
      });

      feed.on('alertConfirmed', (data) => {
        // Add to local alerts list if not already present
        setActiveAlerts((prev) => {
          if (prev.some((a) => a.id === data.id)) return prev;
          return [...prev, data];
        });
        logMessage('SYSTEM', `Alert confirmed: ${data.symbol} ${data.condition} ${data.value}`);
      });

      feed.on('alertRemoved', (data) => {
        setActiveAlerts((prev) => prev.filter((a) => a.id !== data.id));
        logMessage('SYSTEM', `Alert removed by server ID: ${data.id}`);
      });

      feed.on('alertTriggered', (data) => {
        // Remove from local active alerts list
        setActiveAlerts((prev) => prev.filter((a) => a.id !== data.id));

        pushToast(
          'warning',
          'Price Alert Triggered!',
          `${data.symbol} crossed target of ${data.condition} ${data.value} (Actual: ${data.price})`
        );
        logMessage('ALERT', `ALERT TRIGGERED: ${data.symbol} reached ${data.price} (Target: ${data.condition} ${data.value})`);
      });

      feed.on('close', () => {
        if (disposed) return; // deliberate close during cleanup — never reconnect
        logMessage('SYSTEM', 'Data feed disconnected. Reconnecting in 3s...');
        setConnectionStatus('disconnected');
        reconnectTimer = setTimeout(connectFeed, 3000);
      });

      feed.on('error', (err) => {
        logMessage('SYSTEM', 'Data feed error encountered.');
        console.error(err);
      });

      // Connect only after every listener is wired
      feed.connect();
    };

    connectFeed();

    return () => {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (feedRef.current) {
        feedRef.current.close();
      }
    };
  }, [symbols, watchlist]);

  // Keep the alert ticket's symbol valid: if it leaves the watchlist, snap to
  // the first remaining watched symbol.
  useEffect(() => {
    if (watchlist.length === 0) return;
    if (!watchlist.includes(alertSymbol)) {
      setAlertSymbol(watchlist[0]);
    }
  }, [watchlist, alertSymbol]);

  // Handle Watchlist addition/removal
  const toggleWatchlist = (sym) => {
    const isWatched = watchlist.includes(sym);
    const feed = feedRef.current;

    if (isWatched) {
      // Remove from watchlist
      const updated = watchlist.filter((s) => s !== sym);
      setWatchlist(updated);

      if (feed && feed.isOpen()) {
        logMessage('UNSUBSCRIBE', `Sending UNSUBSCRIBE for ${sym}`);
        feed.unsubscribe(sym);
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

      if (feed && feed.isOpen()) {
        logMessage('SUBSCRIBE', `Sending SUBSCRIBE for ${sym}`);
        feed.subscribe(sym);
      }

      if (!selectedSymbol) {
        setSelectedSymbol(sym);
      }
    }
  };

  // Handle setting a new alert
  const handleSetAlert = (e) => {
    e.preventDefault();
    const feed = feedRef.current;
    const value = parseFloat(alertPrice);

    if (isNaN(value) || value <= 0) return;
    if (!alertSymbol) return;

    const alertId = Math.random().toString(36).substring(2, 9);

    if (feed && feed.isOpen()) {
      logMessage('SYSTEM', `Requesting alert: ${alertSymbol} ${alertCondition} ${value}`);
      feed.setAlert({ id: alertId, symbol: alertSymbol, value, condition: alertCondition });
      setAlertPrice('');
    } else {
      logMessage('SYSTEM', 'Cannot set alert: data feed is offline.');
    }
  };

  // Handle deleting an active alert
  const handleDeleteAlert = (alertId) => {
    const feed = feedRef.current;
    if (feed && feed.isOpen()) {
      feed.removeAlert(alertId);
    }
  };

  // Paper-trading handlers — the OMS's events drive all logging/toasts
  const handlePlaceOrder = (request) => {
    omsRef.current.submit(request);
  };

  const handleCancelOrder = (orderId) => {
    omsRef.current.cancel(orderId);
  };

  const closeNotification = (id) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  // Derived values for the instrument bar (all real live data)
  const poolSymbols = symbols.map((s) => s.toUpperCase());
  const selectedRecord = selectedSymbol ? records[selectedSymbol] : null;
  const selectedDelta = selectedRecord
    ? formatDeltaPct(selectedRecord.lastPrice, sessionOpenRef.current[selectedSymbol])
    : null;
  const selectedSpread = selectedRecord
    ? spreadInfo(selectedRecord.bestBid, selectedRecord.bestAsk)
    : null;
  const activeCandle = selectedRecord?.activeCandle;

  // Paper book, marked to the latest prices (re-reads on every OMS mutation
  // via bumpOmsVersion, and on every records re-render for live P&L)
  const omsState = omsRef.current.getState();
  const positionsView = omsState.positions
    .filter((p) => p.qty !== 0)
    .map((p) => {
      const mark = records[p.symbol]?.lastPrice ?? null;
      return { ...p, mark, uPnl: positionUnrealized(p, mark) };
    });
  const totalPnl = omsState.totalRealizedPnl + positionsView.reduce((sum, p) => sum + p.uPnl, 0);
  const pnlChip = formatSigned(totalPnl);

  return (
    <div className="app-container">
      {/* Toast Notification Feed */}
      <div className="toast-container">
        {notifications.map((n) => (
          <div key={n.id} className={`toast-item ${n.type || ''}`}>
            <div className="toast-header">
              <span className={n.type === 'success' ? 'toast-title-success' : 'toast-title-warning'}>
                {n.type === 'success' ? '✓' : '⚠'} {n.title}
              </span>
              <button className="toast-close" onClick={() => closeNotification(n.id)}>×</button>
            </div>
            <div className="toast-body">{n.message}</div>
          </div>
        ))}
      </div>

      <header>
        <div className="logo-group">
          <div className="logo-icon">
            {/* Same ECG heartbeat mark as favicon.svg */}
            <svg viewBox="0 0 64 64" width="16" height="16" aria-hidden="true">
              <polyline
                points="9 36 20 36 26 21 34 47 41 27 45 36 55 36"
                fill="none"
                stroke="#fff"
                strokeWidth="6.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1>
            PulseStream<span className="h1-terminal">Terminal</span>
          </h1>
        </div>
        <div className="header-badges">
          {/* Live paper P&L: realized + unrealized across all positions */}
          <span className={`mode-badge pnl-chip dir-${pnlChip.dir}`} title="Paper trading P&L (USDT): realized + unrealized">
            P&L {pnlChip.text}
          </span>
          {/* Which DataFeed adapter this build runs on (Phase 7 port) */}
          <span className="mode-badge">{DIRECT_MODE ? 'direct · binance' : 'hub · 4-layer'}</span>
          <div className={`status-badge ${connectionStatus === 'connected' ? upstreamStatus : connectionStatus}`}>
            {connectionStatus === 'connected' ? `Feed: ${upstreamStatus}` : `Server: ${connectionStatus}`}
          </div>
        </div>
      </header>

      {/* Live strip: whole symbol pool with session deltas */}
      <TickerTape symbols={poolSymbols} records={records} sessionOpen={sessionOpenRef.current} />

      <main className="terminal-main">
        {/* Chart panel with instrument bar (last / Δ / bid / ask / spread / OHLCV) */}
        <section className="panel chart-card">
          {selectedSymbol && watchlist.includes(selectedSymbol) ? (
            <>
              <div className="instrument-bar">
                <div className="instrument-name">
                  <span className="instrument-symbol">{symbolLabel(selectedSymbol)}</span>
                  <span className="instrument-sub">{selectedSymbol} · Binance · 1m</span>
                </div>
                <FlashPrice price={selectedRecord?.lastPrice} />
                {selectedDelta && (
                  <span className={`instrument-delta dir-${selectedDelta.dir}`}>{selectedDelta.text}</span>
                )}
                <div className="instrument-stats">
                  <div className="stat-block">
                    <span className="stat-label">Bid</span>
                    <span className="stat-value">{formatPrice(selectedRecord?.bestBid)}</span>
                  </div>
                  <div className="stat-block">
                    <span className="stat-label">Ask</span>
                    <span className="stat-value">{formatPrice(selectedRecord?.bestAsk)}</span>
                  </div>
                  <div className="stat-block">
                    <span className="stat-label">Spread</span>
                    <span className="stat-value">
                      {selectedSpread
                        ? `${selectedSpread.spread.toFixed(2)} · ${selectedSpread.bps.toFixed(1)} bps`
                        : '—'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Live self-built 1m candle (the aggregation layer, visible) */}
              {activeCandle && (
                <div className="ohlc-row">
                  <span><b>O</b>{formatPrice(activeCandle.open)}</span>
                  <span><b>H</b>{formatPrice(activeCandle.high)}</span>
                  <span><b>L</b>{formatPrice(activeCandle.low)}</span>
                  <span><b>C</b>{formatPrice(activeCandle.close)}</span>
                  <span><b>Vol</b>{activeCandle.volume !== undefined ? activeCandle.volume.toFixed(4) : '—'}</span>
                  <span>
                    <b>Bucket</b>
                    {new Date(activeCandle.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              )}

              {historicalCandles.length > 0 ? (
                <PriceChart
                  symbol={selectedSymbol}
                  historicalCandles={historicalCandles}
                  activeCandle={activeCandle}
                />
              ) : (
                <div className="chart-empty">Backfilling 1m history…</div>
              )}
            </>
          ) : (
            <div className="chart-empty">
              No instrument selected — click a Market Watch row to chart it.
            </div>
          )}
        </section>

        {/* Right column: market watch + alert ticket */}
        <div className="side-col">
          <MarketWatch
            symbols={poolSymbols}
            records={records}
            sessionOpen={sessionOpenRef.current}
            watchlist={watchlist}
            selectedSymbol={selectedSymbol}
            onSelect={setSelectedSymbol}
            onToggle={toggleWatchlist}
          />
          <TicketPanel
            trade={{
              selectedSymbol: selectedSymbol && watchlist.includes(selectedSymbol) ? selectedSymbol : '',
              record: selectedRecord,
              feeBps: omsState.feeBps,
              onPlaceOrder: handlePlaceOrder,
            }}
            alert={{
              watchlist,
              alertSymbol,
              alertPrice,
              alertCondition,
              onSymbolChange: setAlertSymbol,
              onPriceChange: setAlertPrice,
              onConditionChange: setAlertCondition,
              onSubmit: handleSetAlert,
            }}
          />
        </div>
      </main>

      {/* Bottom blotter: console, paper positions/orders/fills, alerts */}
      <Blotter
        logs={logs}
        onClearLogs={clearLogs}
        alerts={activeAlerts}
        onDeleteAlert={handleDeleteAlert}
        positions={positionsView}
        totalRealizedPnl={omsState.totalRealizedPnl}
        openOrders={omsState.openOrders}
        fills={omsState.fills}
        onCancelOrder={handleCancelOrder}
      />
    </div>
  );
}

export default App;
