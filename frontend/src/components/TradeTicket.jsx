import React, { useState } from 'react';
import { symbolLabel } from '../dataSource';
import { formatPrice } from '../format';

// Paper-trading order ticket (body of the TicketPanel's "Trade" tab).
// Trades the currently SELECTED instrument against live top-of-book quotes.
// Everything here is simulated by shared/oms.js — no real order ever exists.
function TradeTicket({ selectedSymbol, record, feeBps, onPlaceOrder }) {
  const [side, setSide] = useState('BUY');
  const [type, setType] = useState('MARKET');
  const [qty, setQty] = useState('');
  const [limitPrice, setLimitPrice] = useState('');

  const disabled = !selectedSymbol;

  // Estimated execution price: taker touch for market, your limit for limit
  const touch = side === 'BUY' ? record?.bestAsk : record?.bestBid;
  const estPrice = type === 'LIMIT' ? parseFloat(limitPrice) : touch;
  const qtyNum = parseFloat(qty);
  const notional = Number.isFinite(estPrice) && Number.isFinite(qtyNum) ? estPrice * qtyNum : null;
  const estFee = notional !== null ? notional * (feeBps / 10000) : null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (disabled) return;
    onPlaceOrder({
      symbol: selectedSymbol,
      side,
      type,
      qty,
      limitPrice: type === 'LIMIT' ? limitPrice : null,
    });
    setQty('');
  };

  return (
    <form className="ticket-body" onSubmit={handleSubmit}>
      <div className="ticket-instrument">
        {disabled ? 'Select an instrument in Market Watch' : `${symbolLabel(selectedSymbol)} · paper`}
      </div>

      <div className="ticket-side">
        <button
          type="button"
          className={`side-btn buy ${side === 'BUY' ? 'active' : ''}`}
          onClick={() => setSide('BUY')}
          disabled={disabled}
        >
          Buy
        </button>
        <button
          type="button"
          className={`side-btn sell ${side === 'SELL' ? 'active' : ''}`}
          onClick={() => setSide('SELL')}
          disabled={disabled}
        >
          Sell
        </button>
      </div>

      <div className="ticket-side">
        <button
          type="button"
          className={`type-btn ${type === 'MARKET' ? 'active' : ''}`}
          onClick={() => setType('MARKET')}
          disabled={disabled}
        >
          Market
        </button>
        <button
          type="button"
          className={`type-btn ${type === 'LIMIT' ? 'active' : ''}`}
          onClick={() => setType('LIMIT')}
          disabled={disabled}
        >
          Limit
        </button>
      </div>

      <div className="form-group">
        <label>Quantity ({selectedSymbol ? selectedSymbol.replace('USDT', '') : 'base'})</label>
        <input
          type="number"
          step="any"
          min="0"
          placeholder="e.g. 0.01"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          required
          disabled={disabled}
        />
      </div>

      {type === 'LIMIT' && (
        <div className="form-group">
          <label>Limit Price (USDT)</label>
          <input
            type="number"
            step="any"
            min="0"
            placeholder={touch ? `touch ${formatPrice(touch)}` : 'e.g. 65000'}
            value={limitPrice}
            onChange={(e) => setLimitPrice(e.target.value)}
            required
            disabled={disabled}
          />
        </div>
      )}

      <div className="ticket-est">
        <span>Est. {type === 'MARKET' ? `@ ${formatPrice(touch)}` : `@ ${limitPrice || '—'}`}</span>
        <span>
          {notional !== null ? `≈ ${formatPrice(notional, 2)} USDT · fee ≈ ${estFee.toFixed(4)}` : `fee ${feeBps} bps`}
        </span>
      </div>

      <button type="submit" className={`ticket-submit ${side === 'SELL' ? 'below' : ''}`} disabled={disabled}>
        {side === 'BUY' ? '▲ Buy' : '▼ Sell'} {type === 'LIMIT' ? 'Limit' : 'Market'}
      </button>
    </form>
  );
}

export default TradeTicket;
