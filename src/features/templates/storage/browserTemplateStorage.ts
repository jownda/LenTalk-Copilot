import type { Template } from '../types';

const DB_NAME = 'storyboard-copilot';
const STORE_NAME = 'templates';
const FALLBACK_KEY = 'storyboard-browser-templates-v1';

let dbPromise: Promise<IDBDatabase> | null = null;
let idbFailed = false;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    idbFailed = true;
    return Promise.reject(new Error('IndexedDB is not available'));
  }
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      idbFailed = true;
      dbPromise = null;
      reject(request.error ?? new Error('open IndexedDB failed'));
    };
  });
  return dbPromise;
}

function readIdb(db: IDBDatabase): Promise<Template[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result as Template[] : []);
    request.onerror = () => reject(request.error ?? new Error('read templates failed'));
  });
}

function writeIdb(db: IDBDatabase, templates: Template[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.clear();
    templates.forEach((template) => store.put(template));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('write templates failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('write templates aborted'));
  });
}

function readFallback(): Template[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FALLBACK_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed as Template[] : [];
  } catch {
    return [];
  }
}

function writeFallback(templates: Template[]): void {
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(templates));
}

export async function readAllBrowserTemplates(): Promise<Template[]> {
  if (!idbFailed) {
    try {
      return await readIdb(await openDatabase());
    } catch (error) {
      console.warn('[browser-template-storage] IndexedDB unavailable, using localStorage', error);
      idbFailed = true;
    }
  }
  return readFallback();
}

export async function writeAllBrowserTemplates(templates: Template[]): Promise<void> {
  if (!idbFailed) {
    try {
      await writeIdb(await openDatabase(), templates);
      return;
    } catch (error) {
      console.warn('[browser-template-storage] IndexedDB write failed, using localStorage', error);
      idbFailed = true;
    }
  }
  writeFallback(templates);
}
