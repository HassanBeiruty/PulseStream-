import React from 'react';
import { formatPrice, formatQty, formatSigned } from '../format';

// L2 depth ladder: top-10 asks stacked above the spread, top-10 bids below —
// the classic ladder orientation. Size bars are normalized to the largest
// level on screen. All figures come from the shared order-book engine
// (snapshot + sequenced deltas), not from a pre-made provider widget.
function LadderRow({ level, side, maxQty }) {
  const width = maxQty > 0 ? Math.min(100, (level.qty / maxQty) * 100) : 0;
  return (
    <div className={`ladder-row ${side}`}>
      <div className={`ladder-bar ${side}`} style={{ width: `${width}%` }} />
      <span className={`ladder-price dir-${side === 'bid' ? 'up' : 'down'}`}>
        {formatPrice(level.price)}
      </span>
      <span className="ladder-qty">{formatQty(level.qty)}</span>
    </div>
  );
}

function DepthLadder({ book }) {
  if (!book || !book.bids || book.bids.length === 0) {
    return <div className="ladder-empty">Order book syncing… (snapshot + deltas)</div>;
  }

  const maxQty = Math.max(
    ...book.bids.map((l) => l.qty),
    ...book.asks.map((l) => l.qty)
  );
  const imb = formatSigned(book.imbalance * 100, 1);

  return (
    <div className="ladder">
      <div className="ladder-head">
        <span>Price</span>
        <span className="ladder-qty">Size</span>
      </div>

      {/* Asks: worst (highest) at top, best ask just above the spread */}
      <div className="ladder-side asks">
        {[...book.asks].reverse().map((level) => (
          <LadderRow key={`a${level.price}`} level={level} side="ask" maxQty={maxQty} />
        ))}
      </div>

      <div className="ladder-spread">
        <span>
          spread {formatPrice(book.spread)}
          {book.mid > 0 ? ` · ${((book.spread / book.mid) * 10000).toFixed(1)} bps` : ''}
        </span>
        <span>mid {formatPrice(book.mid)}</span>
      </div>

      <div className="ladder-side bids">
        {book.bids.map((level) => (
          <LadderRow key={`b${level.price}`} level={level} side="bid" maxQty={maxQty} />
        ))}
      </div>

      <div className="ladder-foot">
        {/* Imbalance: signed + labeled, color never alone */}
        <span>
          imbalance <b className={`dir-${imb.dir}`}>{imb.text}%</b>
        </span>
        <span>
          {imb.dir === 'up' ? 'bid-heavy' : imb.dir === 'down' ? 'ask-heavy' : 'balanced'} · top {book.bids.length}
        </span>
      </div>
    </div>
  );
}

export default DepthLadder;
