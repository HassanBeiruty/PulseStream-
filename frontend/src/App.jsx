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
import DrawingToolbar from './components/DrawingToolbar';
import { loadSavedDrawings, persistDrawings } from './drawingEngine';
import { PaperOMS, positionUnrealized } from '../../shared/oms.js';
import { createEmptyRecord } from '../../shared/hub.js';
import { mergeCandleHistories } from '../../shared/klines.js';
import { DEFAULT_TIMEFRAME, resolveTimeframe } from '../../shared/timeframes.js';
import { CoinbaseFeed, COINBASE_PRODUCTS } from '../../shared/coinbaseFeed.js';
import { saveCandles, loadCandles, pruneCandles } from './candleStore';
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
  const [books, setBooks] = useState({}); // symbol -> L2 depth view
  const [venues, setVenues] = useState({}); // symbol -> Coinbase venue record
  const [telemetry, setTelemetry] = useState(null); // Phase 10 HUD data
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [logs, setLogs] = useState([]);
  
  // Watchlist & Selected Symbol States
  const [watchlist, setWatchlist] = useState([]);
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [historicalCandles, setHistoricalCandles] = useState([]);
  // Which "<symbol>|<timeframe>" the candles above actually belong to. The
  // chart compares it against the selection so a freshly picked symbol never
  // folds its live ticks into the previous symbol's series while the backfill
  // is still in flight.
  const [historyKey, setHistoryKey] = useState('');
  // Chart window (1m … 1W). Drives the REST backfill interval AND the bucket
  // width the live 1m candles are folded into — see shared/timeframes.js.
  const [timeframe, setTimeframe] = useState(DEFAULT_TIMEFRAME);
  const [chartType, setChartType] = useState('candlestick');
  const [indicators, setIndicators] = useState({
    ema9: false,
    ema21: false,
    sma50: false,
    sma200: false,
    bollinger: false,
    volume: true,
    vwap: true,
  });
  const [interactionMode, setInteractionMode] = useState('crosshair');
  const [hoveredCandle, setHoveredCandle] = useState(null);
  const [isChartZoomed, setIsChartZoomed] = useState(false);
  const [activeRangePreset, setActiveRangePreset] = useState(null);
  const [showIndicatorsDropdown, setShowIndicatorsDropdown] = useState(false);
  const [showTfDropdown, setShowTfDropdown] = useState(false);
  const chartRef = useRef(null);

  // Pro Drawing States
  const [activeDrawingTool, setActiveDrawingTool] = useState('cursor');
  const [drawings, setDrawings] = useState([]);
  const [magnetEnabled, setMagnetEnabled] = useState(true);
  const [drawingColor, setDrawingColor] = useState('#2962ff');

  // Load drawings on symbol change
  useEffect(() => {
    if (selectedSymbol) {
      setDrawings(loadSavedDrawings(selectedSymbol));
    }
  }, [selectedSymbol]);

  const handleUpdateDrawings = (newDrawings) => {
    setDrawings(newDrawings);
    if (selectedSymbol) {
      persistDrawings(selectedSymbol, newDrawings);
    }
  };

  const handleUndoDrawing = () => {
    if (drawings.length === 0) return;
    const next = drawings.slice(0, drawings.length - 1);
    handleUpdateDrawings(next);
  };

  const handleClearDrawings = () => {
    handleUpdateDrawings([]);
  };
  
  // Alerts & Notifications States
  const [activeAlerts, setActiveAlerts] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [alertSymbol, setAlertSymbol] = useState('');
  const [alertPrice, setAlertPrice] = useState('');
  const [alertCondition, setAlertCondition] = useState('ABOVE');
  const [upstreamStatus, setUpstreamStatus] = useState('connecting');

  const RANGE_PRESETS = [
    { label: '1H', ms: 60 * 60 * 1000, tf: '1m' },
    { label: '6H', ms: 6 * 60 * 60 * 1000, tf: '5m' },
    { label: '24H', ms: 24 * 60 * 60 * 1000, tf: '15m' },
    { label: '7D', ms: 7 * 24 * 60 * 60 * 1000, tf: '1h' },
    { label: '30D', ms: 30 * 24 * 60 * 60 * 1000, tf: '4h' },
    { label: '90D', ms: 90 * 24 * 60 * 60 * 1000, tf: '1d' },
    { label: 'ALL', ms: 'ALL', tf: '1d' },
  ];

  // A range preset that also switches the timeframe has to wait for that
  // window's backfill: the chart resets to its default view the moment new
  // history lands, so firing fitRangeMs on a timer just loses the race.
  const pendingRangeRef = useRef(null);

  const handleRangePreset = (preset) => {
    setActiveRangePreset(preset.label);
    if (preset.tf && timeframe !== preset.tf) {
      pendingRangeRef.current = { ms: preset.ms, key: `${selectedSymbol}|${preset.tf}` };
      setTimeframe(preset.tf);
      return;
    }
    pendingRangeRef.current = null;
    if (chartRef.current) chartRef.current.fitRangeMs(preset.ms);
  };

  useEffect(() => {
    const pending = pendingRangeRef.current;
    if (!pending || historyKey !== pending.key) return;
    pendingRangeRef.current = null;
    // Child effects run before this one, so the chart has already rebuilt.
    if (chartRef.current) chartRef.current.fitRangeMs(pending.ms);
  }, [historyKey]);

  const toggleIndicator = (key) => {
    setIndicators((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const feedRef = useRef(null);
  const prevTabPriceRef = useRef(null);
  // Per-symbol throttle state for console heartbeat lines (1 per ~5s)
  const tickLogRef = useRef({});
  // Telemetry: rolling event-time -> processing latency samples (ms)
  const latencyRef = useRef([]);
  const clientReconnectsRef = useRef(0);
  // Last seen active candle per symbol — a new bucket closes the previous one
  const prevCandlesRef = useRef({});
  // Live mirror of records for non-React consumers (arb monitor)
  const recordsRef = useRef({});
  // Arb-alert cooldowns per symbol
  const arbAlertAtRef = useRef({});

  useEffect(() => {
    recordsRef.current = records;
  }, [records]);
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

        // Pre-initialize empty records for each symbol (shared shape)
        const initialRecords = {};
        upperSymbols.forEach((sym) => {
          initialRecords[sym] = createEmptyRecord(sym);
        });
        setRecords(initialRecords);
      })
      .catch((err) => {
        logMessage('SYSTEM', `Failed to load symbols config: ${err.message}`);
      });
  }, []);

  // 2. Fetch historical candle data when the symbol OR the timeframe changes
  useEffect(() => {
    if (!selectedSymbol || !watchlist.includes(selectedSymbol)) {
      setHistoricalCandles([]);
      setHistoryKey('');
      return undefined;
    }

    // Switching windows fires a new request while the old one may still be in
    // flight; this flag drops the loser so a slow 1W response can't overwrite
    // a freshly selected 1m chart.
    let cancelled = false;
    const tf = resolveTimeframe(timeframe);

    logMessage('SYSTEM', `Fetching ${tf.id} candle history for ${selectedSymbol}...`);
    // Phase 11: REST backfill merged with locally persisted candles — history
    // survives beyond the REST window across reloads. The IndexedDB store only
    // holds our SELF-BUILT 1m candles, so the merge only applies on 1m; wider
    // windows come from REST alone (500 x 4H is ~83 days — far more than the
    // ~33h of 1m candles we keep locally).
    const storedPromise = tf.id === DEFAULT_TIMEFRAME ? loadCandles(selectedSymbol) : Promise.resolve([]);

    Promise.all([fetchHistory(selectedSymbol, tf.id).catch(() => null), storedPromise])
      .then(([data, stored]) => {
        if (cancelled) return;
        const rest = data?.candles || [];
        const merged = mergeCandleHistories(stored, rest);
        setHistoricalCandles(merged);
        setHistoryKey(`${selectedSymbol}|${tf.id}`);
        if (merged.length > 0) {
          logMessage(
            'SYSTEM',
            `Backfilled ${selectedSymbol} ${tf.id}: ${rest.length} REST + ${stored.length} stored -> ${merged.length} candles.`
          );
        }
        if (rest.length > 0 && tf.id === DEFAULT_TIMEFRAME) {
          saveCandles(selectedSymbol, rest).then(() => pruneCandles(selectedSymbol));
        }
      })
      .catch((err) => {
        if (!cancelled) logMessage('SYSTEM', `Failed to load candle history: ${err.message}`);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSymbol, watchlist, timeframe]);

  // Phase 13: second venue — an independent Coinbase feed (isomorphic class;
  // runs browser-side in both modes as its own consumer). Drives the
  // cross-venue panel and the arbitrage-spread monitor.
  useEffect(() => {
    if (symbols.length === 0) return;
    const venueFeed = new CoinbaseFeed(symbols.map((s) => s.toUpperCase()));

    venueFeed.on('update', (record) => {
      setVenues((prev) => ({ ...prev, [record.symbol]: record }));

      // Arb monitor: cross-venue spread >= 10 bps toasts, max once/min/symbol.
      // (Binance quotes USDT, Coinbase quotes USD — the spread includes the
      // USDT/USD basis, which is exactly why it's rarely free money.)
      const binance = recordsRef.current[record.symbol];
      if (binance?.lastPrice && record.lastPrice) {
        const mid = (binance.lastPrice + record.lastPrice) / 2;
        const bps = ((binance.lastPrice - record.lastPrice) / mid) * 10000;
        if (Math.abs(bps) >= 10) {
          const lastAlert = arbAlertAtRef.current[record.symbol] || 0;
          if (Date.now() - lastAlert > 60000) {
            arbAlertAtRef.current[record.symbol] = Date.now();
            pushToast(
              'warning',
              'Cross-Venue Spread',
              `${record.symbol}: Binance vs Coinbase ${bps > 0 ? '+' : ''}${bps.toFixed(1)} bps`
            );
            logMessage('VENUE', `Arb spread ${record.symbol}: ${bps.toFixed(1)} bps vs Coinbase`);
          }
        }
      }
    });
    venueFeed.on('status', (status) => logMessage('VENUE', `Coinbase feed: ${status}`));
    venueFeed.connect();

    return () => venueFeed.close();
  }, [symbols]);

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

      feed.on('book', (view) => {
        setBooks((prev) => ({ ...prev, [view.symbol]: view }));
      });

      feed.on('metrics', (m) => {
        const sorted = [...latencyRef.current].sort((a, b) => a - b);
        const pct = (p) =>
          sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
        setTelemetry({
          ...m,
          latencyP50: pct(50),
          latencyP95: pct(95),
          clientReconnects: clientReconnectsRef.current,
        });
      });

      feed.on('feedStatus', ({ status }) => {
        setUpstreamStatus(status);
        logMessage('SYSTEM', `Upstream feed status updated to: ${status}`);
      });

      feed.on('update', (data) => {
        const sym = data.symbol.toUpperCase();

        // Tick the paper OMS with the same golden record (executes any
        // resting limit orders the new top-of-book crosses)
        omsRef.current.onTick(data);

        // Telemetry: event-time -> arrival latency sample (trade updates only)
        if (data.lastTradeTime) {
          const lat = latencyRef.current;
          lat.push(Date.now() - data.lastTradeTime);
          if (lat.length > 300) lat.shift();
        }

        // Phase 11: a new minute bucket means the previous candle CLOSED —
        // persist it to IndexedDB so reloads keep history
        if (data.activeCandle) {
          const prevCandle = prevCandlesRef.current[sym];
          if (prevCandle && data.activeCandle.timestamp > prevCandle.timestamp) {
            saveCandles(sym, [prevCandle]).then(() => pruneCandles(sym));
          }
          prevCandlesRef.current[sym] = data.activeCandle;
        }

        // Console heartbeat: at most ONE line per symbol per 5s, with a
        // conflation count — alive without drowning the protocol log.
        const beat = tickLogRef.current[sym] || { count: 0, lastLoggedAt: 0, lastPrice: null };
        beat.count += 1;
        const now = Date.now();
        if (data.lastPrice !== null && data.lastPrice !== undefined && now - beat.lastLoggedAt >= 5000) {
          const arrow =
            beat.lastPrice === null ? '' : data.lastPrice > beat.lastPrice ? ' ▲' : data.lastPrice < beat.lastPrice ? ' ▼' : '';
          logMessage('UPDATE', `${sym} ${data.lastPrice}${arrow} (${beat.count} updates conflated)`);
          beat.lastLoggedAt = now;
          beat.lastPrice = data.lastPrice;
          beat.count = 0;
        }
        tickLogRef.current[sym] = beat;

        setRecords((prev) => ({
          ...prev,
          [sym]: {
            ...prev[sym],
            ...data,
            // Only stamp freshness when the update carries real market data —
            // the initial empty golden record (source: null) must show
            // "waiting", not become "stale" 10s later.
            lastReceivedAt: data.source ? now : (prev[sym]?.lastReceivedAt ?? null),
          },
        }));
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
        clientReconnectsRef.current += 1;
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
    ? formatDeltaPct(selectedRecord.lastPrice, selectedRecord.open24h)
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

  // Cross-venue comparison rows (Phase 13)
  const venuesView = poolSymbols.map((sym) => {
    const binance = records[sym]?.lastPrice ?? null;
    const venueRecord = venues[sym];
    const coinbase = venueRecord?.lastPrice ?? null;
    const bps =
      binance !== null && coinbase !== null
        ? ((binance - coinbase) / ((binance + coinbase) / 2)) * 10000
        : null;
    return { symbol: sym, binance, coinbase, bps, listed: !!COINBASE_PRODUCTS[sym] };
  });

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

      {/* Live strip: whole symbol pool with 24h deltas */}
      <TickerTape symbols={poolSymbols} records={records} />

      <main className="terminal-body">
        {/* Left column: chart on top, blotter below */}
        <div className="main-col">
        {/* Chart panel with instrument bar (last / Δ / bid / ask / spread / OHLCV) */}
        <section className="panel chart-card">
          {selectedSymbol && watchlist.includes(selectedSymbol) ? (
            <>
              <div className="instrument-bar">
                <div className="instrument-name">
                  <span className="instrument-symbol">{symbolLabel(selectedSymbol)}</span>
                  <span className="instrument-sub">
                    {selectedSymbol} · Binance · {resolveTimeframe(timeframe).label}
                  </span>
                </div>
                <FlashPrice price={selectedRecord?.lastPrice} />
                {selectedDelta && (
                  <span className={`instrument-delta dir-${selectedDelta.dir}`}>{selectedDelta.text} 24h</span>
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
                  <div className="stat-block">
                    <span className="stat-label">Session VWAP</span>
                    <span className="stat-value">{formatPrice(selectedRecord?.sessionVwap)}</span>
                  </div>
                  <div className="stat-block">
                    <span className="stat-label">24h High</span>
                    <span className="stat-value">{formatPrice(selectedRecord?.high24h)}</span>
                  </div>
                  <div className="stat-block">
                    <span className="stat-label">24h Low</span>
                    <span className="stat-value">{formatPrice(selectedRecord?.low24h)}</span>
                  </div>
                  <div className="stat-block">
                    <span className="stat-label">24h Vol</span>
                    <span className="stat-value">
                      {selectedRecord?.volume24h !== null && selectedRecord?.volume24h !== undefined
                        ? selectedRecord.volume24h.toLocaleString(undefined, { maximumFractionDigits: 0 })
                        : '—'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Live self-built 1m candle (the aggregation layer, visible) */}
              {activeCandle && (
                <div className="ohlc-row">
                  <span className="ohlc-tag">Self-built 1m</span>
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

              {/* Pro OHLCV Live / Hovered Bar HUD */}
              <div className="ohlc-row pro-hud">
                {(() => {
                  const bar = hoveredCandle || activeCandle || (historicalCandles.length > 0 ? historicalCandles[historicalCandles.length - 1] : null);
                  if (!bar) return <span className="ohlc-tag">Waiting for market data…</span>;
                  const isHover = !!hoveredCandle;
                  const deltaPct = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : 0;
                  const isUp = bar.close >= bar.open;

                  return (
                    <>
                      <span className={`ohlc-tag ${isHover ? 'tag-hover' : 'tag-live'}`}>
                        {isHover ? 'Cursor Bar' : `Live ${resolveTimeframe(timeframe).label}`}
                      </span>
                      <span className="hud-time">
                        {new Date(bar.timestamp).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span><b>O</b>{formatPrice(bar.open)}</span>
                      <span><b>H</b>{formatPrice(bar.high)}</span>
                      <span><b>L</b>{formatPrice(bar.low)}</span>
                      <span><b>C</b>{formatPrice(bar.close)}</span>
                      <span className={`hud-delta ${isUp ? 'dir-up' : 'dir-down'}`}>
                        {isUp ? '+' : ''}{deltaPct.toFixed(2)}%
                      </span>
                      <span><b>Vol</b>{bar.volume !== undefined ? formatQty(bar.volume) : '—'}</span>
                    </>
                  );
                })()}
              </div>

              {/* Pro Chart Toolbar: Timeframes, Chart Type, Indicators, Range Presets, Nav Controls */}
              <div className="chart-toolbar pro-toolbar">
                {/* 1. Timeframe Quick Group */}
                <div className="toolbar-section">
                  <div className="timeframe-group" role="group" aria-label="Chart timeframe">
                    {['1m', '5m', '15m', '1h', '4h', '1d', '1w'].map((tfId) => {
                      const tfObj = resolveTimeframe(tfId);
                      return (
                        <button
                          key={tfId}
                          type="button"
                          className={`tf-btn ${timeframe === tfId ? 'active' : ''}`}
                          onClick={() => {
                            setTimeframe(tfId);
                            setActiveRangePreset(null);
                          }}
                          aria-pressed={timeframe === tfId}
                          title={`${tfObj.group} — ${tfObj.label}`}
                        >
                          {tfObj.label}
                        </button>
                      );
                    })}

                    {/* More Windows Dropdown Trigger */}
                    <div className="dropdown-wrap">
                      <button
                        type="button"
                        className={`tf-btn btn-dropdown ${['3m', '30m', '2h', '6h', '12h', '3d'].includes(timeframe) ? 'active' : ''}`}
                        onClick={() => setShowTfDropdown((prev) => !prev)}
                        title="All Timeframes"
                      >
                        ⏱ More ▾
                      </button>
                      {showTfDropdown && (
                        <div className="pro-dropdown tf-dropdown-menu">
                          <div className="tf-category">
                            <span className="tf-cat-title">Minutes</span>
                            <div className="tf-cat-btns">
                              {['1m', '3m', '5m', '15m', '30m'].map((id) => (
                                <button
                                  key={id}
                                  type="button"
                                  className={`tf-sub-btn ${timeframe === id ? 'active' : ''}`}
                                  onClick={() => {
                                    setTimeframe(id);
                                    setActiveRangePreset(null);
                                    setShowTfDropdown(false);
                                  }}
                                >
                                  {id}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="tf-category">
                            <span className="tf-cat-title">Hours</span>
                            <div className="tf-cat-btns">
                              {['1h', '2h', '4h', '6h', '12h'].map((id) => (
                                <button
                                  key={id}
                                  type="button"
                                  className={`tf-sub-btn ${timeframe === id ? 'active' : ''}`}
                                  onClick={() => {
                                    setTimeframe(id);
                                    setActiveRangePreset(null);
                                    setShowTfDropdown(false);
                                  }}
                                >
                                  {id.toUpperCase()}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="tf-category">
                            <span className="tf-cat-title">Days & Weeks</span>
                            <div className="tf-cat-btns">
                              {['1d', '3d', '1w'].map((id) => (
                                <button
                                  key={id}
                                  type="button"
                                  className={`tf-sub-btn ${timeframe === id ? 'active' : ''}`}
                                  onClick={() => {
                                    setTimeframe(id);
                                    setActiveRangePreset(null);
                                    setShowTfDropdown(false);
                                  }}
                                >
                                  {id.toUpperCase()}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* 2. Chart Type Selector */}
                <div className="toolbar-section">
                  <div className="chart-type-group" role="group" aria-label="Chart style">
                    {[
                      { id: 'candlestick', label: '🕯️ Candles', title: 'Candlestick Chart' },
                      { id: 'heikinAshi', label: '📊 Heikin-Ashi', title: 'Heikin-Ashi Smoothed Trend' },
                      { id: 'line', label: '📈 Line', title: 'Line Chart' },
                      { id: 'area', label: '🌊 Area', title: 'Area Glowing Chart' },
                      { id: 'ohlc', label: '🥢 Bars', title: 'OHLC Tick Bars' },
                    ].map((type) => (
                      <button
                        key={type.id}
                        type="button"
                        className={`type-switch-btn ${chartType === type.id ? 'active' : ''}`}
                        onClick={() => setChartType(type.id)}
                        title={type.title}
                      >
                        {type.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 3. Technical Indicators Menu */}
                <div className="toolbar-section dropdown-wrap">
                  <button
                    type="button"
                    className={`tool-btn ${Object.values(indicators).some(Boolean) ? 'active' : ''}`}
                    onClick={() => setShowIndicatorsDropdown((prev) => !prev)}
                    title="Technical Indicators Overlay"
                  >
                    📊 Indicators ⚙️
                  </button>
                  {showIndicatorsDropdown && (
                    <div className="pro-dropdown indicators-dropdown-menu">
                      <div className="dropdown-head">Technical Indicators</div>
                      <label className="ind-item">
                        <input
                          type="checkbox"
                          checked={indicators.ema9}
                          onChange={() => toggleIndicator('ema9')}
                        />
                        <span className="ind-color-dot" style={{ background: '#00e5ff' }}></span>
                        <span>EMA 9 (Fast)</span>
                      </label>
                      <label className="ind-item">
                        <input
                          type="checkbox"
                          checked={indicators.ema21}
                          onChange={() => toggleIndicator('ema21')}
                        />
                        <span className="ind-color-dot" style={{ background: '#ffd600' }}></span>
                        <span>EMA 21 (Medium)</span>
                      </label>
                      <label className="ind-item">
                        <input
                          type="checkbox"
                          checked={indicators.sma50}
                          onChange={() => toggleIndicator('sma50')}
                        />
                        <span className="ind-color-dot" style={{ background: '#e040fb' }}></span>
                        <span>SMA 50 (Major)</span>
                      </label>
                      <label className="ind-item">
                        <input
                          type="checkbox"
                          checked={indicators.sma200}
                          onChange={() => toggleIndicator('sma200')}
                        />
                        <span className="ind-color-dot" style={{ background: '#ff6d00' }}></span>
                        <span>SMA 200 (Macro)</span>
                      </label>
                      <label className="ind-item">
                        <input
                          type="checkbox"
                          checked={indicators.bollinger}
                          onChange={() => toggleIndicator('bollinger')}
                        />
                        <span className="ind-color-dot" style={{ background: '#2962ff' }}></span>
                        <span>Bollinger Bands (20, 2)</span>
                      </label>
                      <label className="ind-item">
                        <input
                          type="checkbox"
                          checked={indicators.volume}
                          onChange={() => toggleIndicator('volume')}
                        />
                        <span className="ind-color-dot" style={{ background: '#089981' }}></span>
                        <span>Volume Sub-bars</span>
                      </label>
                      <label className="ind-item">
                        <input
                          type="checkbox"
                          checked={indicators.vwap}
                          onChange={() => toggleIndicator('vwap')}
                        />
                        <span className="ind-color-dot" style={{ background: '#9085e9' }}></span>
                        <span>Session VWAP</span>
                      </label>
                    </div>
                  )}
                </div>

                {/* 4. Quick Range Jump Presets */}
                <div className="toolbar-section">
                  <div className="range-presets-group" role="group" aria-label="Range presets">
                    <span className="range-label">Range:</span>
                    {RANGE_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className={`range-btn ${activeRangePreset === preset.label ? 'active' : ''}`}
                        onClick={() => handleRangePreset(preset)}
                        title={`Zoom view to last ${preset.label}`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 5. Navigation & Zoom Control Buttons */}
                <div className="toolbar-section nav-controls-section">
                  <div className="nav-btn-group">
                    <button
                      type="button"
                      className={`nav-btn ${interactionMode === 'crosshair' ? 'active' : ''}`}
                      onClick={() => setInteractionMode('crosshair')}
                      title="Crosshair Tool"
                    >
                      ✛
                    </button>
                    <button
                      type="button"
                      className={`nav-btn ${interactionMode === 'pan' ? 'active' : ''}`}
                      onClick={() => setInteractionMode('pan')}
                      title="Drag-to-Pan Tool"
                    >
                      ✋
                    </button>
                    <button
                      type="button"
                      className="nav-btn"
                      onClick={() => chartRef.current?.zoomIn()}
                      title="Zoom In (+)"
                    >
                      ➕
                    </button>
                    <button
                      type="button"
                      className="nav-btn"
                      onClick={() => chartRef.current?.zoomOut()}
                      title="Zoom Out (-)"
                    >
                      ➖
                    </button>
                    <button
                      type="button"
                      className="nav-btn"
                      onClick={() => chartRef.current?.panLeft()}
                      title="Pan Left (Back in time)"
                    >
                      ◀
                    </button>
                    <button
                      type="button"
                      className="nav-btn"
                      onClick={() => chartRef.current?.panRight()}
                      title="Pan Right (Forward in time)"
                    >
                      ▶
                    </button>
                    <button
                      type="button"
                      className={`nav-btn reset-btn ${isChartZoomed ? 'zoomed-active' : ''}`}
                      onClick={() => {
                        chartRef.current?.resetView();
                        setActiveRangePreset(null);
                      }}
                      title="Reset View / Follow Live Edge"
                    >
                      ⟲ {isChartZoomed ? 'Reset' : ''}
                    </button>
                  </div>
                </div>
              </div>

              <div className="chart-drawing-layout">
                <DrawingToolbar
                  activeTool={activeDrawingTool}
                  onSelectTool={setActiveDrawingTool}
                  magnetEnabled={magnetEnabled}
                  onToggleMagnet={() => setMagnetEnabled((prev) => !prev)}
                  activeColor={drawingColor}
                  onChangeColor={setDrawingColor}
                  onUndo={handleUndoDrawing}
                  onClearAll={handleClearDrawings}
                  drawingsCount={drawings.length}
                />
                <div className="chart-canvas-container">
                  {historicalCandles.length > 0 ? (
                    <PriceChart
                      ref={chartRef}
                      symbol={selectedSymbol}
                      timeframe={timeframe}
                      historicalCandles={historicalCandles}
                      historyKey={historyKey}
                      activeCandle={activeCandle}
                      sessionVwap={selectedRecord?.sessionVwap}
                      chartType={chartType}
                      indicators={indicators}
                      interactionMode={interactionMode}
                      activeDrawingTool={activeDrawingTool}
                      drawings={drawings}
                      onUpdateDrawings={handleUpdateDrawings}
                      onUndo={handleUndoDrawing}
                      magnetEnabled={magnetEnabled}
                      drawingColor={drawingColor}
                      onHoverBar={setHoveredCandle}
                      onZoomChange={setIsChartZoomed}
                    />
                  ) : (
                    <div className="chart-empty">Backfilling {resolveTimeframe(timeframe).label} history…</div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="chart-empty">
              No instrument selected — click a Market Watch row to chart it.
            </div>
          )}
        </section>

        {/* Blotter under the chart: console, positions, orders, fills, alerts */}
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
          venues={venuesView}
          telemetry={telemetry}
        />
        </div>

        {/* Independent right section: market watch sized to its rows, and the
            trade/alert ticket takes ALL the remaining height below it */}
        <div className="right-col">
          <MarketWatch
            symbols={poolSymbols}
            records={records}
            watchlist={watchlist}
            selectedSymbol={selectedSymbol}
            onSelect={setSelectedSymbol}
            onToggle={toggleWatchlist}
          />
          <TicketPanel
            book={selectedSymbol ? books[selectedSymbol] : null}
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
    </div>
  );
}

export default App;
