import React, { useEffect, useRef, useState } from 'react';
import { symbolLabel } from '../dataSource';
import { formatPrice, formatDeltaPct } from '../format';

// One row of the market-watch panel — two lines so nothing is cramped:
//   line 1: instrument name, staleness badge, subscribe/unsubscribe control
//   line 2: last price (flashing on ticks), 24h Δ, bid × ask
// Unwatched symbols collapse to one line with a clear "+ Watch" action.
function MarketWatchRow({ record, watched, isSelected, onSelect, onToggle }) {
  const [flashClass, setFlashClass] = useState('');
  const [isStale, setIsStale] = useState(false);
  const prevPriceRef = useRef(null);

  const { symbol, lastPrice, bestBid, bestAsk, open24h, lastReceivedAt } = record || {};

  // Staleness: no update received in >10s while watched
  useEffect(() => {
    if (!watched) return undefined;
    const checkFreshness = () => {
      setIsStale(lastReceivedAt ? Date.now() - lastReceivedAt > 10000 : false);
    };
    checkFreshness();
    const interval = setInterval(checkFreshness, 1000);
    return () => clearInterval(interval);
  }, [lastReceivedAt, watched]);

  // Row flash on tick direction
  useEffect(() => {
    if (lastPrice !== null && lastPrice !== undefined) {
      const prev = prevPriceRef.current;
      if (prev !== null && prev !== undefined) {
        if (lastPrice > prev) setFlashClass('row-flash-up');
        else if (lastPrice < prev) setFlashClass('row-flash-down');
      }
      prevPriceRef.current = lastPrice;
    }
  }, [lastPrice]);

  useEffect(() => {
    if (!flashClass) return undefined;
    const timer = setTimeout(() => setFlashClass(''), 700);
    return () => clearTimeout(timer);
  }, [flashClass]);

  const delta = watched ? formatDeltaPct(lastPrice, open24h) : null;

  return (
    <div
      className={`mw-row ${isSelected ? 'selected' : ''} ${watched ? '' : 'unwatched'} ${flashClass}`}
      onClick={watched ? onSelect : onToggle}
      title={watched ? 'Click to chart' : 'Click to subscribe'}
    >
      <div className="mw-top">
        <span className="mw-name">
          {symbolLabel(symbol)}
          {watched && isStale && <span className="stale-badge">Stale</span>}
        </span>
        <button
          className={`mw-toggle ${watched ? 'watched' : 'unwatched'}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          title={watched ? 'Unsubscribe (removes from watchlist)' : 'Subscribe (adds to watchlist)'}
        >
          {watched ? '×' : '+ Watch'}
        </button>
      </div>

      {watched ? (
        <div className="mw-quote">
          <span className="mw-last">{formatPrice(lastPrice)}</span>
          {delta && <span className={`mw-chg dir-${delta.dir}`}>{delta.text} 24h</span>}
          <span className="mw-ba">
            <span>B {formatPrice(bestBid)}</span>
            <span>A {formatPrice(bestAsk)}</span>
          </span>
        </div>
      ) : (
        <div className="mw-quote mw-off">not subscribed — no data flowing</div>
      )}
    </div>
  );
}

// Market-watch panel: every symbol in the pool as a live row. The Watch/×
// controls drive REAL subscribe/unsubscribe messages on the data feed;
// clicking a watched row selects it for the chart + trade ticket.
function MarketWatch({ symbols, records, watchlist, selectedSymbol, onSelect, onToggle }) {
  return (
    <section className="panel market-watch">
      <div className="panel-title">
        <span>Market Watch</span>
        <span>{watchlist.length}/{symbols.length} subscribed</span>
      </div>
      <div className="mw-scroll">
        {symbols.map((sym) => {
          const key = sym.toUpperCase();
          return (
            <MarketWatchRow
              key={key}
              record={records[key]}
              watched={watchlist.includes(key)}
              isSelected={selectedSymbol === key}
              onSelect={() => onSelect(key)}
              onToggle={() => onToggle(key)}
            />
          );
        })}
      </div>
    </section>
  );
}

export default MarketWatch;
