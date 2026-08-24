/**
 * Browser plumbing: formatting, downloads, the File System Access API,
 * drag-and-drop folder walking, idle detection, and settings persistence.
 *
 * Nothing here knows about vault contents, and nothing secret is persisted —
 * `localStorage` only ever sees UI preferences.
 */

const SETTINGS_KEY = 'vault:settings:v1';
const RECENT_KEY = 'vault:recent:v1';

export const supportsFsa = 'showOpenFilePicker' in globalThis;

export const VAULT_PICKER = {
  types: [{ description: 'Encrypted vault', accept: { 'application/octet-stream': ['.svault'] } }],
  multiple: false,
  excludeAcceptAllOption: false,
};

export function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function relTime(ms) {
  if (!ms) return '—';
  const delta = Math.round((ms - Date.now()) / 1000);
  const steps = [
    [60, 'second', 1], [3600, 'minute', 60], [86400, 'hour', 3600],
    [604800, 'day', 86400], [2629800, 'week', 604800], [31557600, 'month', 2629800],
  ];
  const abs = Math.abs(delta);
  const [, unit, div] = steps.find(([limit]) => abs < limit) ?? [0, 'year', 31557600];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    .format(Math.round(delta / div), unit);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const loadSettings = (defaults) => {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...defaults };
  }
};

export const saveSettings = (settings) => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* private mode — preferences just won't persist */ }
};

/* ------------------------------------------------------------------ *
 * Recent vaults
 *
 * File System Access handles are structured-cloneable, so IndexedDB can
 * remember them and a returning user reopens a vault in one tap instead of
 * re-navigating the file picker. Handles carry no key material; permission is
 * re-requested on use.
 * ------------------------------------------------------------------ */

const DB_NAME = 'vault-handles';
const STORE = 'recent';

function withStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: 'id' });
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(request?.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

const safely = (promise) => promise.catch(() => null);

export const recentVaults = async () =>
  (await safely(withStore('readonly', (s) => s.getAll())))
    ?.sort((a, b) => b.openedAt - a.openedAt) ?? [];

export const rememberVault = (handle) =>
  safely(withStore('readwrite', (s) =>
    s.put({ id: handle.name, name: handle.name, handle, openedAt: Date.now() })));

export const forgetVault = (id) =>
  safely(withStore('readwrite', (s) => s.delete(id)));

/** Chrome drops handle permission between sessions; ask for it back. */
export async function ensurePermission(handle, mode = 'readwrite') {
  if (!handle?.queryPermission) return true;
  if ((await handle.queryPermission({ mode })) === 'granted') return true;
  return (await handle.requestPermission({ mode })) === 'granted';
}

export async function writeHandle(handle, bytes) {
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

/* ------------------------------------------------------------------ *
 * Drag and drop
 * ------------------------------------------------------------------ */

/**
 * Flatten a drop into `{name, blob}` items, walking dropped directories so
 * folder structure survives. Falls back to `dataTransfer.files` on browsers
 * without the entries API (iOS Safari).
 *
 * @returns {Promise<{name: string, blob: File}[]>}
 */
export async function collectDrop(dataTransfer) {
  const entries = [...(dataTransfer.items ?? [])]
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length) {
    return [...dataTransfer.files].map((file) => ({ name: file.name, blob: file }));
  }
  const out = [];
  await Promise.all(entries.map((entry) => walkEntry(entry, '', out)));
  return out;
}

async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ name: prefix + file.name, blob: file });
    return;
  }
  const reader = entry.createReader();
  for (;;) {
    // readEntries returns at most 100 at a time and signals the end with [].
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return;
    for (const child of batch) await walkEntry(child, `${prefix + entry.name}/`, out);
  }
}

/** `<input type="file" webkitdirectory>` puts the folder path here. */
export const inputItems = (input) =>
  [...input.files].map((file) => ({
    name: file.webkitRelativePath || file.name,
    blob: file,
  }));

/* ------------------------------------------------------------------ *
 * Auto-lock
 * ------------------------------------------------------------------ */

/**
 * Calls `onIdle` after `minutes` without user input. Returns a disposer.
 * Passing 0 minutes disables it.
 */
export function watchIdle(getMinutes, onIdle) {
  let timer;
  const reset = () => {
    clearTimeout(timer);
    const minutes = getMinutes();
    if (minutes > 0) timer = setTimeout(onIdle, minutes * 60_000);
  };
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focus'];
  for (const type of events) addEventListener(type, reset, { passive: true, capture: true });
  reset();
  return () => {
    clearTimeout(timer);
    for (const type of events) removeEventListener(type, reset, { capture: true });
  };
}


