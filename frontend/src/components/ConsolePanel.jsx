import React, { useEffect, useRef } from 'react';

function ConsolePanel({ logs, onClear }) {
  const consoleLogRef = useRef(null);

  // Auto-scroll only the console log container (not the page) when logs update
  useEffect(() => {
    if (consoleLogRef.current) {
      consoleLogRef.current.scrollTop = consoleLogRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <section className="console-panel">
      <div className="console-header">
        <span className="console-title">Protocol Feed Console</span>
        <button
          onClick={onClear}
          style={{
            background: 'transparent',
            border: '1px solid var(--border-color)',
            color: 'var(--text-muted)',
            fontSize: '0.75rem',
            cursor: 'pointer',
            padding: '0.25rem 0.5rem',
            borderRadius: '4px',
          }}
        >
          Clear
        </button>
      </div>
      <div className="console-log" ref={consoleLogRef}>
        {logs.map((log, index) => {
          let typeClass = 'log-type-system';
          if (log.type === 'SUBSCRIBE') typeClass = 'log-type-subscribe';
          if (log.type === 'UPDATE') typeClass = 'log-type-update';

          return (
            <div key={index} className="log-entry">
              <span className="log-time">[{log.timestamp}]</span>
              <span className={typeClass}>[{log.type}]</span> {log.text}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default ConsolePanel;
