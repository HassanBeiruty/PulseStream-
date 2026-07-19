import React, { useState } from 'react';
import TradeTicket from './TradeTicket';
import AlertTicket from './AlertTicket';
import DepthLadder from './DepthLadder';

// Right-column ticket panel: the paper-trading order ticket, the live L2
// depth ladder for the selected instrument, and the price-alert ticket.
function TicketPanel({ trade, alert, book }) {
  const [tab, setTab] = useState('trade');

  return (
    <section className="panel alert-ticket">
      <div className="ticket-tabs">
        <button
          className={`blotter-tab ${tab === 'trade' ? 'active' : ''}`}
          onClick={() => setTab('trade')}
          type="button"
        >
          Trade
        </button>
        <button
          className={`blotter-tab ${tab === 'book' ? 'active' : ''}`}
          onClick={() => setTab('book')}
          type="button"
        >
          Book
        </button>
        <button
          className={`blotter-tab ${tab === 'alert' ? 'active' : ''}`}
          onClick={() => setTab('alert')}
          type="button"
        >
          Alert
        </button>
      </div>
      {tab === 'trade' && <TradeTicket {...trade} />}
      {tab === 'book' && <DepthLadder book={book} />}
      {tab === 'alert' && <AlertTicket {...alert} />}
    </section>
  );
}

export default TicketPanel;
