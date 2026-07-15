import React from 'react';
import { symbolLabel } from '../dataSource';
import { formatPrice, formatDeltaPct } from '../format';

// Horizontal live strip across the top of the terminal: every symbol in the
// pool with last price and session change (baseline = first price seen this
// session). Delta is signed + arrowed so color never carries meaning alone.
function TickerTape({ symbols, records, sessionOpen }) {
  return (
    <div className="ticker-tape">
      {symbols.map((sym) => {
        const key = sym.toUpperCase();
        const record = records[key];
        const last = record?.lastPrice;
        const delta = formatDeltaPct(last, sessionOpen[key]);
        return (
          <div className="tape-cell" key={key}>
            <span className="tape-symbol">{symbolLabel(key)}</span>
            <span className="tape-price">{formatPrice(last)}</span>
            {delta && <span className={`tape-delta dir-${delta.dir}`}>{delta.text}</span>}
          </div>
        );
      })}
    </div>
  );
}

export default TickerTape;
