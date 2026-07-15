import React, { useEffect, useRef, useState } from 'react';
import { symbolLabel } from '../dataSource';
import { formatPrice, formatDeltaPct } from '../format';

// One row of the market-watch panel. Owns its own tick-flash + staleness
// state (same logic the old TickerCard had, in table-row form).
function MarketWatchRow({ record, sessionBaseline, watched, isSelected, onSelect, onToggle }) {
  const [flashClass, setFlashClass] = useState('');
  const [isStale, setIsStale] = useState(false);
  const prevPriceRef = useRef(null);

  const { symbol, lastPrice, bestBid, bestAsk, lastReceivedAt } = record || {};

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

  const delta = watched ? formatDeltaPct(lastPrice, sessionBaseline) : null;

  return (
    <div
      className={`mw-row ${isSelected ? 'selected' : ''} ${watched ? '' : 'unwatched'} ${flashClass}`}
      onClick={watched ? onSelect : onToggle}
      title={watched ? 'Click to chart' : 'Click to add to watchlist'}
    >
      <span className="mw-sym">
        <span className="mw-sym-label">{symbolLabel(symbol)}</span>
        {watched && isStale && <span className="stale-badge">Stale</span>}
      </span>
      <span className="mw-num">{watched ? formatPrice(lastPrice) : '—'}</span>
      <span className={`mw-num mw-delta ${delta ? `dir-${delta.dir}` : ''}`}>
        {delta ? delta.text : ''}
      </span>
      <span className="mw-num">{watched ? formatPrice(bestBid) : ''}</span>
      <span className="mw-num">{watched ? formatPrice(bestAsk) : ''}</span>
      <button
        className={`mw-toggle ${watched ? 'watched' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        title={watched ? 'Remove from watchlist (unsubscribe)' : 'Add to watchlist (subscribe)'}
      >
        {watched ? '×' : '+'}
      </button>
    </div>
  );
}

// Market-watch panel: every symbol in the pool as a live table row. The +/×
// toggle drives REAL subscribe/unsubscribe messages on the data feed; clicking
// a watched row selects it for the chart.
function MarketWatch({ symbols, records, sessionOpen, watchlist, selectedSymbol, onSelect, onToggle }) {
  return (
    <section className="panel market-watch">
      <div className="panel-title">
        <span>Market Watch</span>
        <span>{watchlist.length}/{symbols.length} subscribed</span>
      </div>
      <div className="mw-head">
        <span>Symbol</span>
        <span className="mw-num">Last</span>
        <span className="mw-num">Session Δ</span>
        <span className="mw-num">Bid</span>
        <span className="mw-num">Ask</span>
        <span />
      </div>
      <div className="mw-scroll">
        {symbols.map((sym) => {
          const key = sym.toUpperCase();
          return (
            <MarketWatchRow
              key={key}
              record={records[key]}
              sessionBaseline={sessionOpen[key]}
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
