import React, { useEffect, useRef, useState } from 'react';
import { symbolLabel } from '../dataSource';
import { formatPrice, formatSigned, formatQty } from '../format';

// Bottom blotter — the tabbed strip every trading terminal has along the
// bottom: protocol console, paper positions (with live P&L), working orders,
// fills history, and active price alerts.
function Blotter({
  logs,
  onClearLogs,
  alerts,
  onDeleteAlert,
  positions, // [{ symbol, qty, avgEntry, realizedPnl, mark, uPnl }]
  totalRealizedPnl,
  openOrders,
  fills,
  onCancelOrder,
}) {
  const [tab, setTab] = useState('console');
  const consoleLogRef = useRef(null);

  // Auto-scroll only the console container (not the page) when logs update
  useEffect(() => {
    if (tab === 'console' && consoleLogRef.current) {
      consoleLogRef.current.scrollTop = consoleLogRef.current.scrollHeight;
    }
  }, [logs, tab]);

  const totalUnrealized = positions.reduce((sum, p) => sum + p.uPnl, 0);
  const totalU = formatSigned(totalUnrealized);
  const totalR = formatSigned(totalRealizedPnl);

  const tabs = [
    { id: 'console', label: 'Console' },
    { id: 'positions', label: `Positions (${positions.length})` },
    { id: 'orders', label: `Orders (${openOrders.length})` },
    { id: 'fills', label: `Fills (${fills.length})` },
    { id: 'alerts', label: `Alerts (${alerts.length})` },
  ];

  return (
    <section className="panel blotter">
      <div className="blotter-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`blotter-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <div className="blotter-actions">
          {tab === 'console' && (
            <button onClick={onClearLogs} className="btn-clear">
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="blotter-body">
        {tab === 'console' && (
          <div className="console-log" ref={consoleLogRef}>
            {logs.map((log, index) => {
              let typeClass = 'log-type-system';
              if (log.type === 'SUBSCRIBE' || log.type === 'UNSUBSCRIBE') typeClass = 'log-type-subscribe';
              if (log.type === 'UPDATE') typeClass = 'log-type-update';
              if (log.type === 'ALERT' || log.type === 'ORDER') typeClass = 'log-type-alert';

              return (
                <div key={index} className="log-entry">
                  <span className="log-time">[{log.timestamp}]</span>
                  <span className={typeClass}>[{log.type}]</span> {log.text}
                </div>
              );
            })}
          </div>
        )}

        {tab === 'positions' && (
          <div className="bl-scroll">
            <div className="bl-head cols-pos">
              <span>Symbol</span>
              <span>Side</span>
              <span className="mw-num">Qty</span>
              <span className="mw-num">Avg Entry</span>
              <span className="mw-num">Mark</span>
              <span className="mw-num">Unrealized</span>
              <span className="mw-num">Realized</span>
            </div>
            {positions.length === 0 ? (
              <div className="empty-alerts-text">No open positions — trade from the ticket (paper only)</div>
            ) : (
              positions.map((p) => {
                const u = formatSigned(p.uPnl);
                const r = formatSigned(p.realizedPnl);
                return (
                  <div key={p.symbol} className="bl-row cols-pos">
                    <span>{symbolLabel(p.symbol)}</span>
                    <span className={`pos-chip ${p.qty > 0 ? 'long' : 'short'}`}>
                      {p.qty > 0 ? 'LONG' : 'SHORT'}
                    </span>
                    <span className="mw-num">{formatQty(Math.abs(p.qty))}</span>
                    <span className="mw-num">{formatPrice(p.avgEntry)}</span>
                    <span className="mw-num">{formatPrice(p.mark)}</span>
                    <span className={`mw-num dir-${u.dir}`}>{u.text}</span>
                    <span className={`mw-num dir-${r.dir}`}>{r.text}</span>
                  </div>
                );
              })
            )}
            <div className="bl-row cols-pos bl-total">
              <span>Total (USDT)</span>
              <span />
              <span />
              <span />
              <span />
              <span className={`mw-num dir-${totalU.dir}`}>{totalU.text}</span>
              <span className={`mw-num dir-${totalR.dir}`}>{totalR.text}</span>
            </div>
          </div>
        )}

        {tab === 'orders' && (
          <div className="bl-scroll">
            <div className="bl-head cols-ord">
              <span>Time</span>
              <span>Symbol</span>
              <span>Side</span>
              <span>Type</span>
              <span className="mw-num">Qty</span>
              <span className="mw-num">Limit</span>
              <span />
            </div>
            {openOrders.length === 0 ? (
              <div className="empty-alerts-text">No working orders — resting limits appear here</div>
            ) : (
              openOrders.map((o) => (
                <div key={o.id} className="bl-row cols-ord">
                  <span>{new Date(o.createdAt).toLocaleTimeString()}</span>
                  <span>{symbolLabel(o.symbol)}</span>
                  <span className={o.side === 'BUY' ? 'dir-up' : 'dir-down'}>
                    {o.side === 'BUY' ? '▲ BUY' : '▼ SELL'}
                  </span>
                  <span>{o.type}</span>
                  <span className="mw-num">{formatQty(o.qty)}</span>
                  <span className="mw-num">{o.limitPrice !== null ? formatPrice(o.limitPrice) : '—'}</span>
                  <button className="btn-delete-alert" onClick={() => onCancelOrder(o.id)} title="Cancel order">
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'fills' && (
          <div className="bl-scroll">
            <div className="bl-head cols-fill">
              <span>Time</span>
              <span>Symbol</span>
              <span>Side</span>
              <span className="mw-num">Qty</span>
              <span className="mw-num">Price</span>
              <span className="mw-num">Fee</span>
            </div>
            {fills.length === 0 ? (
              <div className="empty-alerts-text">No fills yet</div>
            ) : (
              [...fills].reverse().map((f) => (
                <div key={f.id} className="bl-row cols-fill">
                  <span>{new Date(f.ts).toLocaleTimeString()}</span>
                  <span>{symbolLabel(f.symbol)}</span>
                  <span className={f.side === 'BUY' ? 'dir-up' : 'dir-down'}>
                    {f.side === 'BUY' ? '▲ BUY' : '▼ SELL'}
                  </span>
                  <span className="mw-num">{formatQty(f.qty)}</span>
                  <span className="mw-num">{formatPrice(f.price)}</span>
                  <span className="mw-num">{f.fee.toFixed(4)}</span>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'alerts' && (
          <div className="bl-scroll">
            <div className="bl-head cols-alert">
              <span>Symbol</span>
              <span>Condition</span>
              <span className="mw-num">Trigger</span>
              <span />
            </div>
            {alerts.length === 0 ? (
              <div className="empty-alerts-text">No active alerts — set one in the Alert ticket</div>
            ) : (
              alerts.map((alert) => (
                <div key={alert.id} className="bl-row cols-alert">
                  <span>{symbolLabel(alert.symbol)}</span>
                  <span className={alert.condition === 'ABOVE' ? 'dir-up' : 'dir-down'}>
                    {alert.condition === 'ABOVE' ? '▲ Above ≥' : '▼ Below ≤'}
                  </span>
                  <span className="mw-num">{formatPrice(alert.value)}</span>
                  <button className="btn-delete-alert" onClick={() => onDeleteAlert(alert.id)} title="Cancel alert">
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export default Blotter;
