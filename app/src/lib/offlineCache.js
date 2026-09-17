// Lightweight IndexedDB cache so the booking screen works offline-first.
// We cache: preset pickup spots, the driver's public info, and saved places.
// When the network fails, the UI can still show this data and let the customer
// drop a pin + draft a booking request.

const DB_NAME = 'drivelocal-offline';
const STORE = 'kv';
const TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      return reject(new Error('indexedDB unavailable'));
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function setItem(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ value, savedAt: Date.now() }, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getItem(key) {
  try {
    const db = await openDb();
    const entry = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(key);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    if (!entry) return null;
    if (Date.now() - (entry.savedAt || 0) > TTL_MS) return null;
    return entry.value;
  } catch {
    return null;
  }
}

// "Get or fetch": returns cached data instantly, refreshes it in the background,
// and falls back to the cache on network failure.
export async function getOrFetch(key, fetcher) {
  const cached = await getItem(key);
  if (cached != null) {
    fetcher().then((fresh) => setItem(key, fresh)).catch(() => {});
    return cached;
  }
  try {
    const fresh = await fetcher();
    setItem(key, fresh);
    return fresh;
  } catch (e) {
    if (cached != null) return cached;
    throw e;
  }
}

export default { setItem, getItem, getOrFetch };