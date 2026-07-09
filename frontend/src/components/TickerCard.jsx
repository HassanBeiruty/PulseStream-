import React, { useState, useEffect, useRef } from 'react';
import { symbolLabel } from '../dataSource';

function TickerCard({ record, isSelected, onClick }) {
  const [flashClass, setFlashClass] = useState('');
  const [isStale, setIsStale] = useState(false);
  const prevPriceRef = useRef(null);

  const { symbol, lastPrice, bestBid, bestAsk, lastTradeTime, source, lastReceivedAt } = record || {};

  // Track data staleness: warn if no update is received in > 10 seconds
  useEffect(() => {
    const checkFreshness = () => {
      if (!lastReceivedAt) {
        setIsStale(false);
        return;
      }
      const elapsed = Date.now() - lastReceivedAt;
      setIsStale(elapsed > 10000);
    };

    checkFreshness();
    const interval = setInterval(checkFreshness, 1000);
    return () => clearInterval(interval);
  }, [lastReceivedAt]);

  useEffect(() => {
    if (lastPrice !== null && lastPrice !== undefined) {
      const prevPrice = prevPriceRef.current;
      if (prevPrice !== null && prevPrice !== undefined) {
        if (lastPrice > prevPrice) {
          setFlashClass('price-flash-up');
        } else if (lastPrice < prevPrice) {
          setFlashClass('price-flash-down');
        }
      }
      prevPriceRef.current = lastPrice;
    }
  }, [lastPrice]);

  // Reset flash class after animation completes
  useEffect(() => {
    if (flashClass) {
      const timer = setTimeout(() => {
        setFlashClass('');
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [flashClass]);

  const formatPrice = (val) => {
    if (val === null || val === undefined || isNaN(val)) return '—';
    return val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '—';
    return new Date(timestamp).toLocaleTimeString();
  };

  return (
    <div className={`ticker-card ${isSelected ? 'selected' : ''} ${isStale ? 'stale' : ''}`} onClick={onClick} id={`card-${symbol}`}>
      <div className="card-header">
        <div className="card-symbol-group">
          <span className="symbol-name">{symbolLabel(symbol)}</span>
          {!lastReceivedAt && <span className="waiting-badge">Waiting</span>}
          {lastReceivedAt && isStale && <span className="stale-badge">Stale</span>}
        </div>
        <span className="source-badge">{source || '—'}</span>
      </div>
      <div className="price-display">
        <span className="price-label">Last Price</span>
        <span className={`price-value ${flashClass}`}>
          {formatPrice(lastPrice)}
        </span>
      </div>
      <div className="bid-ask-container">
        <div className="quote-col">
          <span className="quote-label">Bid</span>
          <span className="quote-val quote-bid">{formatPrice(bestBid)}</span>
        </div>
        <div className="quote-col">
          <span className="quote-label">Ask</span>
          <span className="quote-val quote-ask">{formatPrice(bestAsk)}</span>
        </div>
      </div>
      <div className="card-footer">
        <span>Feed Status: Live</span>
        <span className="time-display">{formatTime(lastTradeTime)}</span>
      </div>
    </div>
  );
}

export default TickerCard;
