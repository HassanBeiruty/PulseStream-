// ---------------------------------------------------------------------------
// IndexedDB candle store (Phase 11 — browser-side persistence)
//
// Persists self-built 1m candles so a reload keeps history beyond the REST
// backfill window (100 candles). IndexedDB is the browser's transactional
// store for structured data — localStorage would choke on thousands of rows.
//
// Composite key [symbol, timestamp] makes writes idempotent: re-saving the
// same closed candle is an overwrite, not a duplicate. All operations are
// fail-soft — a blocked DB (private mode) degrades to "no persistence",
// never to a broken app.
// ---------------------------------------------------------------------------

const DB_NAME = 'pulsestream';
const DB_VERSION = 1;
const STORE = 'candles1m';
const MAX_ROWS_PER_SYMBOL = 2000; // ~33 hours of 1m candles

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: ['symbol', 'timestamp'] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Save one or more CLOSED candles for a symbol (idempotent upserts). */
export async function saveCandles(symbol, candles) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const sym = symbol.toUpperCase();
    for (const candle of candles) {
      store.put({ symbol: sym, ...candle });
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* persistence is best-effort */
  }
}

/** Load stored candles for a symbol, ascending by time (most recent N). */
export async function loadCandles(symbol, limit = 1000) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const sym = symbol.toUpperCase();
    const range = IDBKeyRange.bound([sym, 0], [sym, Number.MAX_SAFE_INTEGER]);
    const rows = await new Promise((resolve, reject) => {
      const req = store.getAll(range);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    rows.sort((a, b) => a.timestamp - b.timestamp);
    return rows.slice(-limit).map(({ timestamp, open, high, low, close, volume }) => ({
      timestamp, open, high, low, close, volume,
    }));
  } catch {
    return [];
  }
}

/** Trim a symbol's history to the newest MAX_ROWS_PER_SYMBOL rows. */
export async function pruneCandles(symbol) {
  try {
    const db = await openDb();
    const sym = symbol.toUpperCase();
    const all = await loadCandles(sym, Number.MAX_SAFE_INTEGER);
    const excess = all.length - MAX_ROWS_PER_SYMBOL;
    if (excess <= 0) return;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const candle of all.slice(0, excess)) {
      store.delete([sym, candle.timestamp]);
    }
  } catch {
    /* best-effort */
  }
}
