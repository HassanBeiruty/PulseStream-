import React from 'react';

const COLORS = [
  { name: 'TradingView Blue', value: '#2962ff' },
  { name: 'Teal Green', value: '#089981' },
  { name: 'Coral Red', value: '#f23645' },
  { name: 'Gold Yellow', value: '#ffd600' },
  { name: 'Lavender Purple', value: '#9085e9' },
  { name: 'Pure White', value: '#ffffff' },
];

export default function DrawingToolbar({
  activeTool,
  onSelectTool,
  magnetEnabled,
  onToggleMagnet,
  activeColor,
  onChangeColor,
  onUndo,
  onClearAll,
  drawingsCount = 0,
}) {
  const tools = [
    {
      id: 'cursor',
      name: 'Crosshair / Pointer',
      icon: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9" />
          <line x1="12" y1="3" x2="12" y2="21" />
          <line x1="3" y1="12" x2="21" y2="12" />
        </svg>
      ),
    },
    {
      id: 'trendline',
      name: 'Trend Line (Angle & %)',
      icon: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="4" y1="20" x2="20" y2="4" />
          <circle cx="4" cy="20" r="2.5" fill="currentColor" />
          <circle cx="20" cy="4" r="2.5" fill="currentColor" />
        </svg>
      ),
    },
    {
      id: 'horizontal',
      name: 'Horizontal Price Level / Ray',
      icon: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="2" y1="12" x2="22" y2="12" />
          <rect x="15" y="8" width="7" height="8" rx="2" fill="currentColor" />
        </svg>
      ),
    },
    {
      id: 'fibonacci',
      name: 'Fibonacci Retracement (Auto-levels)',
      icon: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <line x1="3" y1="4" x2="21" y2="4" />
          <line x1="3" y1="9" x2="21" y2="9" strokeDasharray="2 2" />
          <line x1="3" y1="14" x2="21" y2="14" strokeDasharray="2 2" />
          <line x1="3" y1="20" x2="21" y2="20" />
          <path d="M4 20 L20 4" stroke="#ffd600" strokeWidth="2" />
        </svg>
      ),
    },
    {
      id: 'position',
      name: 'Long/Short Position (R:R Calculator)',
      icon: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="4" y="4" width="16" height="7" fill="rgba(8, 153, 129, 0.4)" stroke="#089981" />
          <rect x="4" y="13" width="16" height="7" fill="rgba(242, 54, 69, 0.4)" stroke="#f23645" />
          <line x1="2" y1="12" x2="22" y2="12" stroke="#fff" strokeWidth="1.5" />
        </svg>
      ),
    },
    {
      id: 'rectangle',
      name: 'Order Block / Supply-Demand Zone',
      icon: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="4" y="6" width="16" height="12" rx="2" fill="rgba(41, 98, 255, 0.25)" stroke="#2962ff" />
        </svg>
      ),
    },
    {
      id: 'measure',
      name: 'Price & Time Range Measure',
      icon: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="4" y="5" width="16" height="14" rx="1" strokeDasharray="3 3" />
          <path d="M7 15 L17 9" />
          <polyline points="13 9 17 9 17 13" />
        </svg>
      ),
    },
  ];

  return (
    <aside className="drawing-dock" aria-label="Pro Drawing Tools">
      <div className="drawing-tools-list">
        {tools.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`dock-btn ${activeTool === t.id ? 'active' : ''}`}
            onClick={() => onSelectTool(t.id)}
            title={t.name}
            aria-pressed={activeTool === t.id}
          >
            {t.icon}
          </button>
        ))}
      </div>

      <div className="dock-divider" />

      {/* Magnet Snap Toggle */}
      <button
        type="button"
        className={`dock-btn magnet-btn ${magnetEnabled ? 'active' : ''}`}
        onClick={onToggleMagnet}
        title={`Magnet Mode (${magnetEnabled ? 'ON - Snapping to OHLC' : 'OFF'})`}
        aria-pressed={magnetEnabled}
      >
        <span className="dock-icon-label">🧲</span>
      </button>

      {/* Color Palette Picker */}
      <div className="color-palette-popover">
        <div className="color-dots">
          {COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`color-dot ${activeColor === c.value ? 'selected' : ''}`}
              style={{ background: c.value }}
              onClick={() => onChangeColor(c.value)}
              title={c.name}
            />
          ))}
        </div>
      </div>

      <div className="dock-divider" />

      {/* Undo Button */}
      <button
        type="button"
        className="dock-btn action-btn"
        onClick={onUndo}
        disabled={drawingsCount === 0}
        title="Undo Last Drawing (Ctrl+Z)"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 10h10a5 5 0 0 1 5 5v2" />
          <polyline points="7 6 3 10 7 14" />
        </svg>
      </button>

      {/* Clear All Button */}
      <button
        type="button"
        className="dock-btn action-btn delete-all"
        onClick={onClearAll}
        disabled={drawingsCount === 0}
        title="Clear All Drawings on Chart"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
    </aside>
  );
}
