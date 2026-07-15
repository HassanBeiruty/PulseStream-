import React, { useState } from 'react';
import TradeTicket from './TradeTicket';
import AlertTicket from './AlertTicket';

// Right-column ticket panel with two tabs: the paper-trading order ticket and
// the price-alert ticket. Both are "tickets" in terminal vocabulary — an entry
// form that produces an instruction (a simulated order / an alert).
function TicketPanel({ trade, alert }) {
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
          className={`blotter-tab ${tab === 'alert' ? 'active' : ''}`}
          onClick={() => setTab('alert')}
          type="button"
        >
          Alert
        </button>
      </div>
      {tab === 'trade' ? <TradeTicket {...trade} /> : <AlertTicket {...alert} />}
    </section>
  );
}

export default TicketPanel;
