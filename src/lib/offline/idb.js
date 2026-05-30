// ─── IndexedDB wrapper (caregiver offline support) ───
// A tiny, dependency-free promise wrapper around IndexedDB used by the
// caregiver PWA for (a) caching shift/client data for offline reads and
// (b) an outbox of clock events queued while offline.
//
// Everything is structured around a small async "store" interface
// { get, put, getAll, delete, clear } so the business logic that uses it
// can be unit-tested against an in-memory store (see createMemoryStore)
// without needing a real IndexedDB in jsdom.

const DB_NAME = 'tc-caregiver';
// v2 adds the observation outbox + care-plan cache (offline care-plan
// logging). The upgrade handler creates any missing store, so bumping the
// version is enough — existing stores and data are preserved.
const DB_VERSION = 2;

// Object stores. All use keyPath 'id'.
export const STORES = {
  shiftCache: 'shiftCache',
  clientCache: 'clientCache',
  clockEventsCache: 'clockEventsCache',
  clockOutbox: 'clockOutbox',
  observationOutbox: 'observationOutbox',
  carePlanCache: 'carePlanCache',
};

export function idbAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function runTx(storeName, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Returns an async store bound to one object store. If IndexedDB is
// unavailable (private mode, old browser, SSR), returns a no-op store so
// callers degrade gracefully to online-only behavior instead of crashing.
export function makeIdbStore(storeName) {
  if (!idbAvailable()) return createNoopStore();
  return {
    async get(key) {
      return runTx(storeName, 'readonly', (store) => reqToPromise(store.get(key))).then(
        (v) => v ?? null,
      );
    },
    async put(value) {
      await runTx(storeName, 'readwrite', (store) => store.put(value));
      return value;
    },
    async getAll() {
      return runTx(storeName, 'readonly', (store) => reqToPromise(store.getAll())).then(
        (v) => v ?? [],
      );
    },
    async delete(key) {
      await runTx(storeName, 'readwrite', (store) => store.delete(key));
    },
    async clear() {
      await runTx(storeName, 'readwrite', (store) => store.clear());
    },
  };
}

// No-op store so the app keeps working (online-only) when IndexedDB is
// unavailable. Reads return empty; writes silently succeed.
export function createNoopStore() {
  return {
    async get() {
      return null;
    },
    async put(value) {
      return value;
    },
    async getAll() {
      return [];
    },
    async delete() {},
    async clear() {},
  };
}

// In-memory store implementing the same interface — used by unit tests.
export function createMemoryStore(initial = []) {
  const map = new Map(initial.map((v) => [v.id, v]));
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(value) {
      map.set(value.id, value);
      return value;
    },
    async getAll() {
      return Array.from(map.values());
    },
    async delete(key) {
      map.delete(key);
    },
    async clear() {
      map.clear();
    },
  };
}
