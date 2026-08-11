// ---------------------------------------------------------------------------
// 浏览器降级项目存储:优先使用 IndexedDB(容量大,几百 MB 级,不会像
// localStorage 5MB 那样因图片数据超限而静默丢数据),IndexedDB 不可用时
// (如 Safari 隐私模式)回退到 localStorage。
// 首次使用会自动把 localStorage 里的旧项目数据迁移到 IndexedDB。
// ---------------------------------------------------------------------------

/** 与 projectState 的 BrowserProjectEntry 一致(避免循环依赖,独立定义) */
export interface BrowserProjectEntry {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  thumbnails?: string[];
  nodesJson: string;
  edgesJson: string;
  viewportJson: string;
  historyJson: string;
}

const DB_NAME = 'storyboard-copilot';
const STORE_NAME = 'browser-projects';
/** 旧版 localStorage 存储键(与 projectState 的历史键一致,用于迁移) */
export const LEGACY_LOCAL_STORAGE_KEY = 'storyboard-browser-projects-v1';
/** 回退用 localStorage 键(IndexedDB 不可用时) */
const FALLBACK_LOCAL_STORAGE_KEY = 'storyboard-browser-projects-fallback';

let dbPromise: Promise<IDBDatabase> | null = null;
let idbFailed = false;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }
  if (typeof indexedDB === 'undefined') {
    idbFailed = true;
    return Promise.reject(new Error('IndexedDB is not available'));
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      idbFailed = true;
      dbPromise = null;
      reject(request.error ?? new Error('open IndexedDB failed'));
    };
    request.onblocked = () => {
      // 其他标签页持有连接时阻塞,这里不主动处理,等待超时由 onerror 兜底
    };
  });
  return dbPromise;
}

function readAllFromIdb(db: IDBDatabase): Promise<BrowserProjectEntry[]> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        const rows = request.result as BrowserProjectEntry[];
        resolve(Array.isArray(rows) ? rows : []);
      };
      request.onerror = () => reject(request.error);
    } catch (error) {
      reject(error);
    }
  });
}

function writeAllToIdb(
  db: IDBDatabase,
  entries: BrowserProjectEntry[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      for (const entry of entries) {
        store.put(entry);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
    } catch (error) {
      reject(error);
    }
  });
}

// ------------------------- localStorage 回退 --------------------------------

function readFallback(): BrowserProjectEntry[] {
  try {
    const raw = localStorage.getItem(FALLBACK_LOCAL_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeFallback(entries: BrowserProjectEntry[]): boolean {
  try {
    localStorage.setItem(FALLBACK_LOCAL_STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    console.warn('[browser-project-storage] localStorage 写入失败(容量超限?),项目可能未保存完整');
    return false;
  }
}

// ------------------------------ 对外接口 ------------------------------------

/** 读取全部项目记录(自动从 localStorage 迁移旧数据) */
export async function readAllBrowserProjects(): Promise<BrowserProjectEntry[]> {
  // 尝试 IndexedDB
  if (!idbFailed) {
    try {
      const db = await openDatabase();
      const entries = await readAllFromIdb(db);

      // 首次使用:IndexedDB 为空但 localStorage 有旧数据 → 迁移
      if (entries.length === 0) {
        const legacy = readLegacyLocalStorage();
        if (legacy.length > 0) {
          await writeAllToIdb(db, legacy);
          try {
            localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY);
          } catch {
            // 忽略清理失败
          }
          return legacy;
        }
      }
      return entries;
    } catch (error) {
      console.warn('[browser-project-storage] IndexedDB 不可用,回退 localStorage', error);
      idbFailed = true;
    }
  }
  return readFallback();
}

/** 全量写入项目记录(成功返回 true) */
export async function writeAllBrowserProjects(
  entries: BrowserProjectEntry[]
): Promise<boolean> {
  if (!idbFailed) {
    try {
      const db = await openDatabase();
      await writeAllToIdb(db, entries);
      return true;
    } catch (error) {
      console.warn('[browser-project-storage] IndexedDB 写入失败,回退 localStorage', error);
      idbFailed = true;
    }
  }
  return writeFallback(entries);
}

/** 旧版 localStorage 数据(迁移用) */
function readLegacyLocalStorage(): BrowserProjectEntry[] {
  try {
    const raw = localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
