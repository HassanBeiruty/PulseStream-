# 📜 Cheat Sheet: Data Flow & WebSockets vs. Hub

This is your quick-reference guide explaining how data gets from the **Binance Exchange** into the **Browser Screen**, and how the different components relate to each other.

---

## ⚡ TL;DR: Quick Summary
* **WebSockets** are the physical network cables carrying data.
* **The Hub** is the brain on the server managing who gets what data.
* **The Normalizer** changes Binance terminology (like `p` and `q`) into clean code names (like `lastPrice` and `quantity`).
* **The Throttle (300ms)** batches data so your browser doesn't freeze under heavy traffic.

---

## 🗺️ Visual Flow Diagram

```text
 ┌────────────────────────┐
 │   Binance WS Stream    │  <-- Raw ticks (Trade & BookTicker)
 └───────────┬────────────┘
             │
             ▼ (Raw JSON payload)
 ┌────────────────────────┐
 │  1. Feed Handler       │  <-- Manages network, reconnects, watches for silence
 └───────────┬────────────┘
             │
             ▼ (Raw text parsed to JSON)
 ┌────────────────────────┐
 │  2. Normalizer         │  <-- Cleans keys: "p" -> "lastPrice", "q" -> "quantity"
 └───────────┬────────────┘
             │
             ▼ (Uniform internal format)
 ┌────────────────────────┐
 │  3. Hub (Pub-Sub)      │  <-- Caches latest price (Golden Record), notifies subscribers
 └───────────┬────────────┘
             │
             ▼ (Subscribers executed)
 ┌────────────────────────┐
 │  4. Client WS Server   │  <-- Groups client connections, queues ticks
 └───────────┬────────────┘
             │
             ▼ (Throttled every 300ms)
 ┌────────────────────────┐
 │  5. Browser UI (React) │  <-- Renders updated prices to the user
 └────────────────────────┘
```

---

## 🔍 Concept: WebSocket vs. Hub

| Concept | Layer | Role | Real-world Analogy |
| :--- | :--- | :--- | :--- |
| **WebSocket** | **Network** (The Wire) | Moves bytes between two machines. Keeps a persistent connection open. | **The telephone line** connecting two offices. |
| **Hub** | **Application** (The Logic) | Stores current prices and matches symbols to clients. | **The switchboard operator** routing incoming news to interested listeners. |

---

## 🔄 Step-by-Step Data Journey

### 1. Connecting to Binance
The server connects to Binance to ingest trades and bids/asks.
* **Endpoint:** `wss://stream.binance.com:9443/stream?streams=...`
* **File:** [server/feedHandler.js:L75](file:///c:/Users/User/Desktop/TradingApp_Training/server/feedHandler.js#L75)
```javascript
this.ws = new WebSocket(url);
```

---

### 2. Browser Connects to Server
The user opens the dashboard, establishing a local network connection.
* **Endpoint:** `ws://localhost:3000`
* **File:** [frontend/src/dataSource.js:L71](file:///c:/Users/User/Desktop/TradingApp_Training/frontend/src/dataSource.js#L71)
```javascript
return new WebSocket(`${protocol}//${host}`);
```

---

### 3. User Subscribes to a Coin
The browser requests updates for a specific coin (e.g., `BTCUSDT`).
* **Message:** `{ type: "SUBSCRIBE", symbol: "BTCUSDT" }`
* **File:** [frontend/src/App.jsx:L155](file:///c:/Users/User/Desktop/TradingApp_Training/frontend/src/App.jsx#L155)
```javascript
ws.send(JSON.stringify({ type: 'SUBSCRIBE', symbol: 'BTCUSDT' }));
```

---

### 4. Server Registers the Subscription
The server hooks the user's connection to the Hub.
* **Concept:** Assigns a callback function that runs every time the Hub receives new data for the symbol.
* **File:** [server/index.js:L200](file:///c:/Users/User/Desktop/TradingApp_Training/server/index.js#L200)
```javascript
const unsubscribe = hub.subscribe(symbol, (record) => {
  pendingUpdates.set(symbol, record); // Buffers the tick for this user
});
```

---

### 5. Binance Sends Raw Ticks
Binance sends a data packet when a trade occurs.
* **Format:** Raw JSON text with short keys (e.g., `s` for symbol, `p` for price).
```json
{
  "stream": "btcusdt@trade",
  "data": { "s": "BTCUSDT", "p": "62150.00", "q": "0.045", "T": 17838491000 }
}
```

---

### 6. Normalization
The server converts raw feed formats into standard internal formats.
* **Goal:** Ensures that if we switch exchanges later, we only edit this one file.
* **File:** [server/index.js:L83](file:///c:/Users/User/Desktop/TradingApp_Training/server/index.js#L83)
```javascript
const update = normalize(stream, data); // Returns { symbol: 'BTCUSDT', lastPrice: 62150.00, ... }
hub.update(update);
```

---

### 7. Hub Updates and Fires Callbacks
The Hub updates the in-memory cache and triggers all registered user connections.
* **File:** [server/hub.js:L67](file:///c:/Users/User/Desktop/TradingApp_Training/server/hub.js#L67)
```javascript
Object.assign(record, update); // Merges the update
for (const callback of callbacks) {
  callback({ ...record }); // Fires callback with a copy
}
```

---

### 8. Throttled Flush to Browser
To prevent UI freeze, the server batches updates and sends them every 300ms.
* **Why:** Too many updates causes "layout thrashing" and lag in web browsers.
* **File:** [server/index.js:L152](file:///c:/Users/User/Desktop/TradingApp_Training/server/index.js#L152)
```javascript
const flushInterval = setInterval(() => {
  if (pendingUpdates.size > 0) {
    for (const record of pendingUpdates.values()) {
      ws.send(JSON.stringify({ type: 'UPDATE', data: record }));
    }
    pendingUpdates.clear();
  }
}, 300);
```

---

### 9. Browser Receives & Renders Data
The browser processes the incoming message, updates state, and React redraws.
* **File:** [frontend/src/App.jsx:L189](file:///c:/Users/User/Desktop/TradingApp_Training/frontend/src/App.jsx#L189)
```javascript
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'UPDATE') {
    setRecords((prev) => ({ ...prev, [msg.data.symbol]: msg.data }));
  }
};
```
