import React from 'react';
import { symbolLabel } from '../dataSource';

// Price-alert ticket (body of the TicketPanel's "Alert" tab). Pick a side
// (ABOVE green / BELOW red), a symbol, a trigger price, and submit. Alerts are
// hub consumers — they ride the same feed updates as everything else.
function AlertTicket({
  watchlist,
  alertSymbol,
  alertPrice,
  alertCondition,
  onSymbolChange,
  onPriceChange,
  onConditionChange,
  onSubmit,
}) {
  const disabled = watchlist.length === 0;

  return (
    <form className="ticket-body" onSubmit={onSubmit}>
      <div className="ticket-side">
        <button
          type="button"
          className={`side-btn above ${alertCondition === 'ABOVE' ? 'active' : ''}`}
          onClick={() => onConditionChange('ABOVE')}
          disabled={disabled}
        >
          ▲ Above ≥
        </button>
        <button
          type="button"
          className={`side-btn below ${alertCondition === 'BELOW' ? 'active' : ''}`}
          onClick={() => onConditionChange('BELOW')}
          disabled={disabled}
        >
          ▼ Below ≤
        </button>
      </div>

      <div className="form-group">
        <label>Symbol</label>
        <select value={alertSymbol} onChange={(e) => onSymbolChange(e.target.value)} disabled={disabled}>
          {watchlist.map((sym) => (
            <option key={sym} value={sym}>
              {symbolLabel(sym)}
            </option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label>Trigger Price (USDT)</label>
        <input
          type="number"
          step="any"
          placeholder="e.g. 65000"
          value={alertPrice}
          onChange={(e) => onPriceChange(e.target.value)}
          required
          disabled={disabled}
        />
      </div>

      <button
        type="submit"
        className={`ticket-submit ${alertCondition === 'BELOW' ? 'below' : ''}`}
        disabled={disabled}
      >
        Set {alertCondition === 'ABOVE' ? '▲ Above' : '▼ Below'} Alert
      </button>
    </form>
  );
}

export default AlertTicket;
