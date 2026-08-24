/**
 * The vault container: a ZIP archive that only ever exists decrypted in
 * memory, plus a metadata index used by the UI.
 *
 * JSZip holds the bytes; `store.index` holds the metadata (size, mtime) so
 * the UI never has to reach into JSZip internals or decompress an entry just
 * to draw a row. Both are kept in step by the mutators in this module — call
 * them, don't touch `store.zip` directly.
 */

import { loadZip } from './deps.js';
import { decryptVault, encryptVault, DEFAULT_ITERATIONS } from './crypto.js';

/** Internal bookkeeping lives under this prefix and is hidden from the UI. */
const META_DIR = '.vault';
const META_FILE = `${META_DIR}/meta.json`;
export const APP_ID = 'vault';
export const FORMAT_VERSION = 2;

const isInternal = (path) => path === META_DIR || path.startsWith(`${META_DIR}/`);
export const parentOf = (path) => path.replace(/[^/]*\/?$/, '');
export const baseName = (path) => path.replace(/\/$/, '').split('/').pop();
export const extOf = (name) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** Collapses `..`, duplicate slashes and other things a filename should not do. */
export function normalizePath(path) {
  const parts = [];
  for (const raw of String(path).split('/')) {
    const part = raw.trim().replace(/[\u0000-\u001f\u007f]/g, '');
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

export async function createStore() {
  const JSZip = await loadZip();
  const store = {
    zip: new JSZip(),
    index: new Map(),
    folders: new Set(),
    format: 'v2',
    iterations: DEFAULT_ITERATIONS,
    meta: { app: APP_ID, version: FORMAT_VERSION, created: Date.now(), modified: Date.now() },
  };
  return store;
}

/**
 * Decrypt and parse a `.svault` payload. Throws `VaultError` on a bad
 * password and a plain `Error` if the plaintext is not a readable archive.
 */
export async function openStore(payload, password) {
  const { data, format, iterations } = await decryptVault(payload, password);
  const JSZip = await loadZip();
  let zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch (err) {
    throw new Error('Decrypted, but the contents are not a valid archive.', { cause: err });
  }
  const store = { zip, index: new Map(), folders: new Set(), format, iterations, meta: null };
  reindex(store);
  store.meta = await readMeta(store);
  return store;
}

/** Rebuilds `index` and `folders` from whatever JSZip currently holds. */
export function reindex(store) {
  store.index.clear();
  store.folders.clear();
  store.folders.add('');
  for (const [path, file] of Object.entries(store.zip.files)) {
    if (isInternal(path)) continue;
    if (file.dir) {
      addFolderChain(store, path);
      continue;
    }
    store.index.set(path, {
      size: file._data?.uncompressedSize ?? 0,
      date: file.date instanceof Date ? file.date.getTime() : Date.now(),
    });
    addFolderChain(store, parentOf(path));
  }
}

function addFolderChain(store, dir) {
  const parts = dir.replace(/\/$/, '').split('/').filter(Boolean);
  let acc = '';
  for (const part of parts) {
    acc += `${part}/`;
    store.folders.add(acc);
  }
}

async function readMeta(store) {
  const fallback = {
    app: APP_ID,
    version: FORMAT_VERSION,
    created: Date.now(),
    modified: Date.now(),
  };
  const file = store.zip.file(META_FILE);
  if (!file) return fallback;
  try {
    return { ...fallback, ...JSON.parse(await file.async('string')) };
  } catch {
    return fallback;
  }
}

/**
 * Entries for one directory, folders first.
 * @returns {{path: string, name: string, ext: string, size: number,
 *            date: number, dir: boolean}[]}
 */
export function listDir(store, dir = '') {
  const rows = [];
  for (const folder of store.folders) {
    if (folder && parentOf(folder.replace(/\/$/, '')) === dir) {
      rows.push({ path: folder, name: baseName(folder), ext: '', size: 0, date: 0, dir: true });
    }
  }
  for (const [path, meta] of store.index) {
    if (parentOf(path) !== dir) continue;
    rows.push({ path, name: baseName(path), ext: extOf(path), dir: false, ...meta });
  }
  return rows;
}

/** Every file in the vault, ignoring folder structure. */
export function listAll(store) {
  return [...store.index].map(([path, meta]) => ({
    path,
    name: baseName(path),
    ext: extOf(path),
    dir: false,
    ...meta,
  }));
}

export const totalSize = (store) =>
  [...store.index.values()].reduce((sum, m) => sum + m.size, 0);

/** `notes.md` -> `notes (2).md` when the path is taken. */
export function uniquePath(store, path) {
  if (!store.index.has(path)) return path;
  const dir = parentOf(path);
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const tail = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${dir}${stem} (${n})${tail}`;
    if (!store.index.has(candidate)) return candidate;
  }
}

/**
 * @param {{name: string, blob: Blob|File, date?: number}[]} items
 * @returns {string[]} the paths actually written
 */
export function addFiles(store, items, dir = '') {
  const written = [];
  for (const item of items) {
    const rel = normalizePath(item.name);
    if (!rel) continue;
    const path = uniquePath(store, `${dir}${rel}`);
    const date = new Date(item.date ?? item.blob?.lastModified ?? Date.now());
    store.zip.file(path, item.blob, { date });
    store.index.set(path, { size: item.blob.size ?? 0, date: date.getTime() });
    addFolderChain(store, parentOf(path));
    written.push(path);
  }
  return written;
}

export function writeText(store, path, text) {
  const blob = new Blob([text], { type: 'text/plain' });
  store.zip.file(path, blob, { date: new Date() });
  store.index.set(path, { size: blob.size, date: Date.now() });
  addFolderChain(store, parentOf(path));
  return path;
}

export function makeFolder(store, dir, name) {
  const path = `${dir}${normalizePath(name)}/`;
  store.zip.folder(path.slice(0, -1));
  addFolderChain(store, path);
  return path;
}

/** Removes a file, or a folder and everything beneath it. */
export function remove(store, path) {
  if (path.endsWith('/')) {
    for (const child of [...store.index.keys()]) {
      if (child.startsWith(path)) {
        store.zip.remove(child);
        store.index.delete(child);
      }
    }
    for (const folder of [...store.folders]) {
      if (folder === path || folder.startsWith(path)) store.folders.delete(folder);
    }
    store.zip.remove(path.slice(0, -1));
    return;
  }
  store.zip.remove(path);
  store.index.delete(path);
}

/** Rename or move. Folders are moved by re-keying every descendant. */
export async function move(store, from, to) {
  if (from === to) return to;
  if (from.endsWith('/')) {
    const target = to.endsWith('/') ? to : `${to}/`;
    for (const child of [...store.index.keys()]) {
      if (child.startsWith(from)) {
        await move(store, child, target + child.slice(from.length));
      }
    }
    for (const folder of [...store.folders]) {
      if (folder.startsWith(from)) store.folders.delete(folder);
    }
    store.zip.remove(from.slice(0, -1));
    addFolderChain(store, target);
    return target;
  }
  const meta = store.index.get(from);
  const blob = await readBlob(store, from);
  const path = uniquePath(store, to);
  store.zip.file(path, blob, { date: new Date(meta?.date ?? Date.now()) });
  store.index.set(path, { size: blob.size, date: meta?.date ?? Date.now() });
  addFolderChain(store, parentOf(path));
  store.zip.remove(from);
  store.index.delete(from);
  return path;
}

export const readBlob = (store, path) => store.zip.file(path).async('blob');
export const readText = (store, path) => store.zip.file(path).async('string');
export const readBytes = (store, path) => store.zip.file(path).async('uint8array');

/**
 * Compress, encrypt, and hand back the bytes to write to disk.
 *
 * @param {(percent: number, stage: string) => void} [opts.onProgress]
 */
export async function seal(store, password, opts = {}) {
  const iterations = opts.iterations ?? store.iterations ?? DEFAULT_ITERATIONS;
  store.meta = {
    app: APP_ID,
    version: FORMAT_VERSION,
    created: store.meta?.created ?? Date.now(),
    modified: Date.now(),
    entries: store.index.size,
  };
  store.zip.file(META_FILE, JSON.stringify(store.meta));

  const archive = await store.zip.generateAsync(
    { type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    ({ percent }) => opts.onProgress?.(percent * 0.8, 'Compressing'),
  );
  opts.onProgress?.(85, 'Encrypting');
  const payload = await encryptVault(archive, password, { iterations });
  opts.onProgress?.(100, 'Done');
  store.iterations = iterations;
  store.format = 'v2';
  return payload;
}

/** A plain, unencrypted ZIP of some or all entries — for exporting out. */
export async function exportZip(store, paths) {
  const JSZip = await loadZip();
  const out = new JSZip();
  const wanted = paths?.length
    ? [...store.index.keys()].filter((p) =>
        paths.some((sel) => (sel.endsWith('/') ? p.startsWith(sel) : p === sel)),
      )
    : [...store.index.keys()];
  for (const path of wanted) {
    out.file(path, await readBytes(store, path), {
      date: new Date(store.index.get(path).date),
    });
  }
  return out.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}



