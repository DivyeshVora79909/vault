/**
 * Alpine component wiring the UI to the vault modules.
 *
 * Rule of thumb for this file: it holds *view state and orchestration only*.
 * Anything reusable belongs in vault.js / crypto.js / preview.js / ui.js, and
 * the ZIP itself is deliberately kept out of Alpine's reactive proxy (see
 * `store` below) so large archives don't get deep-proxied on every keystroke.
 */

import { loadAlpine, loadMarkdown, loadPdf } from './deps.js';
import * as V from './vault.js';
import { DEFAULT_ITERATIONS, VaultError } from './crypto.js';
import { estimateStrength, randomPassword } from './password.js';
import * as P from './preview.js';
import * as U from './ui.js';

/** The live vault. Intentionally module-scoped, not Alpine state. */
let store = null;
/** The master password for the open session. Never persisted. */
let secret = '';

const DEFAULTS = {
  theme: 'system',
  layout: 'grid',
  sort: 'name',
  order: 'asc',
  autolockMinutes: 10,
  autosave: false,
  thumbnails: true,
  iterations: DEFAULT_ITERATIONS,
};

/**
 * Iteration presets offered in the UI. The `<option value>`s in index.html are
 * static (x-model cannot match options that Alpine has not rendered yet), so
 * these numbers are mirrored there — keep the two in step.
 */
const ITERATIONS = { fast: 200_000, balanced: DEFAULT_ITERATIONS, paranoid: 1_200_000 };

let toastId = 0;

const app = () => ({
  // ---- lifecycle ---------------------------------------------------
  view: 'lock',
  mode: 'open',
  settings: U.loadSettings(DEFAULTS),
  /** Guards against a stale preference naming an iteration count we dropped. */
  knownIterations: Object.values(ITERATIONS),
  supportsFsa: U.supportsFsa,
  toasts: [],
  /**
   * Web Crypto is only exposed in secure contexts, so an app served over plain
   * HTTP to anything but localhost cannot encrypt at all. Say so up front
   * rather than failing at the first unlock.
   */
  insecure: !globalThis.crypto?.subtle,
  busy: { on: false, label: '', pct: 0 },
  helpOpen: false,
  settingsOpen: false,

  async init() {
    if (!this.knownIterations.includes(this.settings.iterations)) {
      this.settings.iterations = ITERATIONS.balanced;
    }
    this.applyTheme();
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (this.settings.theme === 'system') this.applyTheme();
    });
    this.recent = await U.recentVaults();
    this.stopIdle = U.watchIdle(
      () => (this.view === 'vault' ? this.settings.autolockMinutes : 0),
      () => this.lock({ reason: 'Locked after inactivity.' }),
    );
    addEventListener('beforeunload', (event) => {
      if (!this.dirty) return;
      event.preventDefault();
      event.returnValue = 'This vault has unsaved changes.';
    });
    this.$watch('settings', (value) => U.saveSettings(value));
    // The search box is debounced, so react to the model rather than to input.
    this.$watch('query', () => this.refresh());
  },

  // ---- chrome ------------------------------------------------------
  applyTheme() {
    const { theme } = this.settings;
    document.documentElement.dataset.theme =
      theme === 'system'
        ? matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
        : theme;
  },

  toast(message, tone = 'ok') {
    const id = ++toastId;
    this.toasts.push({ id, message, tone });
    setTimeout(() => { this.toasts = this.toasts.filter((t) => t.id !== id); }, 4200);
  },

  /** Wraps a long operation with the progress bar and uniform error reporting. */
  async run(label, fn) {
    this.busy = { on: true, label, pct: 0 };
    try {
      return await fn((pct, stage) => {
        this.busy.pct = Math.round(pct);
        if (stage) this.busy.label = stage;
      });
    } catch (error) {
      console.error(error);
      this.toast(error instanceof VaultError ? error.message : (error.message || String(error)), 'bad');
      return undefined;
    } finally {
      this.busy = { on: false, label: '', pct: 0 };
    }
  },

  fmtSize: U.formatSize,
  fmtDate: U.formatDate,
  relTime: U.relTime,
  iconOf: P.iconOf,

  // ---- unlock screen -----------------------------------------------
  pw: '',
  pw2: '',
  reveal: false,
  recent: [],
  handle: null,
  picked: null,
  get pickedName() {
    return this.handle?.name ?? this.picked?.name ?? '';
  },
  get strength() {
    return estimateStrength(this.pw);
  },
  generate() {
    this.pw = randomPassword({ length: 24 });
    this.pw2 = this.pw;
    this.reveal = true;
    this.toast('Generated a 24-character password — save it somewhere safe.');
  },
  async copyPassword() {
    try {
      await navigator.clipboard.writeText(this.pw);
      this.toast('Password copied to the clipboard.');
    } catch {
      this.toast('Clipboard is blocked — select and copy manually.', 'warn');
    }
  },

  async pickVault() {
    if (U.supportsFsa) {
      try {
        const [handle] = await showOpenFilePicker(U.VAULT_PICKER);
        this.handle = handle;
        this.picked = null;
      } catch { /* user dismissed the picker */ }
      return;
    }
    this.$refs.vaultInput.click();
  },

  onVaultInput(event) {
    this.picked = event.target.files[0] ?? null;
    this.handle = null;
  },

  onLockDrop(event) {
    const file = event.dataTransfer.files[0];
    if (!file) return;
    this.picked = file;
    this.handle = null;
    this.mode = 'open';
  },

  async useRecent(item) {
    if (!(await U.ensurePermission(item.handle, 'read'))) {
      this.toast('Permission to read that file was declined.', 'warn');
      return;
    }
    this.handle = item.handle;
    this.picked = null;
    this.$refs.pwInput?.focus();
  },

  async dropRecent(item) {
    await U.forgetVault(item.id);
    this.recent = await U.recentVaults();
  },

  async unlock() {
    let source = this.picked;
    if (this.handle) {
      try {
        source = await this.handle.getFile();
      } catch {
        this.toast('That file is no longer readable — pick it again.', 'warn');
        this.handle = null;
        return;
      }
    }
    if (!source) return this.toast('Choose a .svault file first.', 'warn');
    if (!this.pw) return this.toast('Enter the master password.', 'warn');

    const opened = await this.run('Deriving key', async () => {
      const payload = new Uint8Array(await source.arrayBuffer());
      return V.openStore(payload, this.pw);
    });
    if (!opened) return;

    store = opened;
    secret = this.pw;
    this.vaultName = this.handle?.name ?? source.name;
    if (this.handle) {
      await U.rememberVault(this.handle);
      this.recent = await U.recentVaults();
    }
    this.enterVault();
    this.toast(
      opened.format === 'v1'
        ? 'Unlocked a legacy vault — saving will upgrade it to the current format.'
        : 'Vault unlocked.',
    );
  },

  async create() {
    if (this.strength.bits < 40) {
      return this.toast('That password is too weak to protect a vault.', 'warn');
    }
    if (this.pw !== this.pw2) return this.toast('The two passwords do not match.', 'warn');
    store = await V.createStore();
    store.iterations = this.settings.iterations;
    secret = this.pw;
    this.handle = null;
    this.vaultName = 'Untitled.svault';
    this.enterVault();
    this.dirty = true;
    this.toast('Vault created. Add files, then save it to disk.');
  },

  enterVault() {
    this.pw = '';
    this.pw2 = '';
    this.reveal = false;
    this.cwd = '';
    this.query = '';
    this.selected = [];
    this.dirty = false;
    this.view = 'vault';
    this.refresh();
  },

  async lock({ reason } = {}) {
    if (this.dirty) {
      const ok = await this.confirm(
        'Lock without saving?',
        'This vault has unsaved changes. They are lost when it locks.',
        'Lock anyway',
      );
      if (!ok) return;
    }
    store = null;
    secret = '';
    P.clearThumbs();
    this.closeViewer({ force: true });
    this.rows = [];
    this.thumbs = {};
    this.selected = [];
    this.dirty = false;
    this.view = 'lock';
    this.mode = 'open';
    if (reason) this.toast(reason, 'warn');
  },

  /* ---- in-app dialogs ------------------------------------------------
   * One promise-based sheet replaces window.prompt/confirm: it is styleable,
   * works in installed PWAs where native dialogs are suppressed, and keeps
   * focus inside the app on mobile. */
  dialog: { open: false, title: '', message: '', value: '', input: true, choices: null, ok: 'OK', danger: false },

  ask(options) {
    this.dialog = {
      open: true, title: '', message: '', value: '', input: true,
      choices: null, ok: 'OK', danger: false, ...options,
    };
    return new Promise((resolve) => { this.settleDialog = resolve; });
  },

  confirm(title, message, ok = 'Delete') {
    return this.ask({ title, message, input: false, ok, danger: true });
  },

  closeDialog(accepted) {
    const value = this.dialog.input || this.dialog.choices ? this.dialog.value : true;
    this.dialog.open = false;
    const settle = this.settleDialog;
    this.settleDialog = null;
    settle?.(accepted ? value : null);
  },

  // ---- browsing ----------------------------------------------------
  vaultName: '',
  cwd: '',
  rows: [],
  thumbs: {},
  query: '',
  selected: [],
  dirty: false,

  get searching() {
    return this.query.trim().length > 0;
  },

  get crumbs() {
    const parts = this.cwd.split('/').filter(Boolean);
    let acc = '';
    return parts.map((part) => ({ name: part, path: (acc += `${part}/`) }));
  },

  /**
   * A reactive snapshot of the (deliberately non-reactive) store. Recomputed
   * by `refresh`, because Alpine cannot observe the ZIP itself.
   */
  stats: { count: 0, size: '0 B', format: '', iterations: 0 },

  refresh() {
    if (!store) return;
    this.stats = {
      count: store.index.size,
      size: U.formatSize(V.totalSize(store)),
      format: store.format === 'v1' ? 'legacy v1' : 'v2',
      iterations: store.iterations,
    };
    const query = this.query.trim().toLowerCase();
    const rows = query
      ? V.listAll(store).filter((row) => row.path.toLowerCase().includes(query))
      : V.listDir(store, this.cwd);

    const { sort, order } = this.settings;
    const sign = order === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      if (sort === 'size') return (a.size - b.size) * sign;
      if (sort === 'date') return (a.date - b.date) * sign;
      if (sort === 'type') return (a.ext.localeCompare(b.ext) || a.name.localeCompare(b.name)) * sign;
      return a.name.localeCompare(b.name, undefined, { numeric: true }) * sign;
    });
    this.rows = rows;
    this.selected = this.selected.filter((path) => rows.some((row) => row.path === path));
    this.queueThumbs();
  },

  /**
   * Generates thumbnails one at a time in the background so a folder of 500
   * photos doesn't stall the main thread or blow up memory.
   */
  queueThumbs() {
    if (!this.settings.thumbnails) return;
    const token = (this.thumbToken = Symbol('thumbs'));
    const pending = this.rows.filter((row) => !row.dir && !(row.path in this.thumbs));
    (async () => {
      for (const row of pending.slice(0, 200)) {
        if (this.thumbToken !== token || !store) return;
        const url = await P.thumbFor(row, (path) => V.readBlob(store, path));
        if (url) this.thumbs[row.path] = url;
      }
    })();
  },

  goto(dir) {
    this.cwd = dir;
    this.query = '';
    this.selected = [];
    this.refresh();
  },

  up() {
    this.goto(V.parentOf(this.cwd.replace(/\/$/, '')));
  },

  activate(row) {
    if (row.dir) return this.goto(row.path);
    return this.open(row);
  },

  // ---- selection ---------------------------------------------------
  isSelected(path) {
    return this.selected.includes(path);
  },
  toggleSelect(path) {
    this.selected = this.isSelected(path)
      ? this.selected.filter((p) => p !== path)
      : [...this.selected, path];
  },
  selectAll() {
    this.selected = this.selected.length === this.rows.length ? [] : this.rows.map((r) => r.path);
  },

  // ---- mutations ---------------------------------------------------
  touch() {
    this.dirty = true;
    this.refresh();
    if (this.settings.autosave && this.handle) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = setTimeout(() => this.save({ quiet: true }), 4000);
    }
  },

  async ingest(items) {
    if (!items.length) return;
    const added = V.addFiles(store, items, this.cwd);
    this.touch();
    this.toast(`Added ${added.length} file${added.length === 1 ? '' : 's'}.`);
  },

  async onPick(event) {
    await this.ingest(U.inputItems(event.target));
    event.target.value = '';
  },

  async onDrop(event) {
    this.dragging = false;
    if (this.view !== 'vault') return this.onLockDrop(event);
    await this.run('Reading dropped items', async () => {
      await this.ingest(await U.collectDrop(event.dataTransfer));
    });
  },

  async newFolder() {
    const name = await this.ask({ title: 'New folder', value: '', ok: 'Create' });
    if (!name?.trim()) return;
    this.goto(V.makeFolder(store, this.cwd, name));
    this.dirty = true;
  },

  async newNote() {
    const name = await this.ask({ title: 'New note', value: 'note.md', ok: 'Create' });
    if (!name?.trim()) return;
    const path = V.uniquePath(store, this.cwd + V.normalizePath(name));
    V.writeText(store, path, '');
    this.touch();
    await this.open({ path, name: V.baseName(path), ext: V.extOf(path), dir: false, size: 0, date: Date.now() });
    this.viewer.editing = true; // a brand-new note opens ready to type in
  },

  async rename(row) {
    const name = await this.ask({ title: 'Rename', value: row.name, ok: 'Rename' });
    if (!name?.trim() || name === row.name) return;
    const target = V.parentOf(row.path.replace(/\/$/, '')) + V.normalizePath(name) + (row.dir ? '/' : '');
    await this.run('Renaming', () => V.move(store, row.path, target));
    P.forgetThumb(row.path);
    this.touch();
  },

  async moveTo(paths) {
    const target = await this.ask({
      title: paths.length === 1 ? `Move ${V.baseName(paths[0])}` : `Move ${paths.length} items`,
      value: this.cwd,
      ok: 'Move',
      choices: [
        { value: '', label: 'Vault root' },
        ...[...store.folders]
          .filter((folder) => folder && !paths.some((path) => folder.startsWith(path)))
          .sort()
          .map((folder) => ({ value: folder, label: folder })),
      ],
    });
    if (target === null) return;
    await this.run('Moving', async () => {
      for (const path of paths) {
        await V.move(store, path, target + V.baseName(path) + (path.endsWith('/') ? '/' : ''));
      }
    });
    this.selected = [];
    this.touch();
  },

  async remove(paths) {
    const label = paths.length === 1 ? V.baseName(paths[0]) : `${paths.length} items`;
    const ok = await this.confirm(
      `Delete ${label}?`,
      'It is removed from the vault immediately and gone for good once you save.',
    );
    if (!ok) return;
    for (const path of paths) {
      V.remove(store, path);
      P.forgetThumb(path);
      delete this.thumbs[path];
    }
    this.selected = [];
    this.touch();
    this.toast(`Deleted ${label}.`);
  },

  // ---- export ------------------------------------------------------
  async exportOne(row) {
    const blob = await V.readBlob(store, row.path);
    U.downloadBlob(new Blob([blob], { type: P.mimeOf(row.name) }), row.name);
  },

  async exportMany(paths) {
    await this.run('Packing export', async () => {
      const blob = await V.exportZip(store, paths);
      const stem = this.vaultName.replace(/\.svault$/i, '') || 'vault';
      U.downloadBlob(blob, `${stem}-export.zip`);
      this.toast('Exported as an unencrypted .zip — handle it carefully.', 'warn');
    });
  },

  async toPdf(paths) {
    const images = paths.filter((path) => P.kindOf(path) === 'image');
    if (!images.length) return this.toast('Select one or more images first.', 'warn');
    await this.run('Building PDF', async () => {
      const JsPDF = await loadPdf();
      let doc = null;
      for (const path of images) {
        const dataUrl = await blobToDataUrl(await V.readBlob(store, path), P.mimeOf(path));
        const props = (doc ?? new JsPDF()).getImageProperties(dataUrl);
        const landscape = props.width > props.height;
        if (!doc) doc = new JsPDF({ orientation: landscape ? 'l' : 'p' });
        else doc.addPage(undefined, landscape ? 'l' : 'p');
        const pw = doc.internal.pageSize.getWidth();
        const ph = doc.internal.pageSize.getHeight();
        const scale = Math.min(pw / props.width, ph / props.height);
        const w = props.width * scale;
        const h = props.height * scale;
        doc.addImage(dataUrl, 0, 0, w, h, undefined, 'FAST');
      }
      const name = V.uniquePath(
        store,
        this.cwd + (images.length === 1
          ? V.baseName(images[0]).replace(/\.[^.]+$/, '')
          : 'images') + '.pdf',
      );
      V.addFiles(store, [{ name: V.baseName(name), blob: doc.output('blob') }], V.parentOf(name));
      this.selected = [];
      this.touch();
      this.toast(`${V.baseName(name)} added to the vault.`);
    });
  },

  // ---- persistence -------------------------------------------------
  async save({ quiet = false } = {}) {
    if (!store) return;
    const payload = await this.run('Sealing vault', (onProgress) =>
      V.seal(store, secret, { iterations: this.settings.iterations, onProgress }),
    );
    if (!payload) return;

    if (this.handle && (await U.ensurePermission(this.handle))) {
      try {
        await U.writeHandle(this.handle, payload);
        this.dirty = false;
        if (!quiet) this.toast(`Saved to ${this.handle.name}.`);
        return;
      } catch (error) {
        console.error(error);
        this.toast('Could not write that file — pick a new location.', 'warn');
      }
    }
    await this.saveAs(payload);
  },

  /** Save As always goes through a picker (or a download on unsupported browsers). */
  async saveAs(payload) {
    const bytes = payload ?? (await this.run('Sealing vault', (onProgress) =>
      V.seal(store, secret, { iterations: this.settings.iterations, onProgress })));
    if (!bytes) return;
    const suggested = this.vaultName.endsWith('.svault') ? this.vaultName : `${this.vaultName}.svault`;

    if (U.supportsFsa) {
      try {
        const handle = await showSaveFilePicker({ suggestedName: suggested, ...U.VAULT_PICKER });
        await U.writeHandle(handle, bytes);
        this.handle = handle;
        this.vaultName = handle.name;
        await U.rememberVault(handle);
        this.recent = await U.recentVaults();
        this.dirty = false;
        this.toast(`Saved to ${handle.name}.`);
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error(error);
      }
    }
    U.downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), suggested);
    this.dirty = false;
    this.toast('Downloaded the encrypted vault. Keep it somewhere safe.');
  },

  // ---- master password ---------------------------------------------
  rekey: { open: false, pw: '', pw2: '' },
  get rekeyStrength() {
    return estimateStrength(this.rekey.pw);
  },
  applyRekey() {
    if (this.rekeyStrength.bits < 40) return this.toast('Too weak. Pick a longer password.', 'warn');
    if (this.rekey.pw !== this.rekey.pw2) return this.toast('The two passwords do not match.', 'warn');
    secret = this.rekey.pw;
    this.rekey = { open: false, pw: '', pw2: '' };
    this.dirty = true;
    this.toast('Password changed in memory — save now to write it to disk.', 'warn');
  },
  suggestRekey() {
    this.rekey.pw = randomPassword({ length: 24 });
    this.rekey.pw2 = this.rekey.pw;
  },

  // ---- viewer ------------------------------------------------------
  viewer: {
    open: false, kind: 'download', path: '', name: '', url: '', text: '', html: '',
    editing: false, dirty: false, wrap: true, zoom: 1, rotate: 0, x: 0, y: 0,
  },

  get viewableRows() {
    return this.rows.filter((row) => !row.dir);
  },

  async open(row) {
    const kind = P.viewerOf(row.name);
    this.revokeViewerUrl();
    Object.assign(this.viewer, {
      open: true, kind, path: row.path, name: row.name,
      url: '', text: '', html: '', editing: kind === 'editor',
      dirty: false, zoom: 1, rotate: 0, x: 0, y: 0,
    });
    await this.run('Decrypting', async () => {
      if (kind === 'editor' || kind === 'markdown') {
        this.viewer.text = await V.readText(store, row.path);
        if (kind === 'markdown') await this.renderMarkdown();
        return;
      }
      if (kind === 'download') return;
      const blob = await V.readBlob(store, row.path);
      this.viewer.url = URL.createObjectURL(new Blob([blob], { type: P.mimeOf(row.name) }));
    });
  },

  /**
   * Markdown is rendered inside a sandboxed iframe (`srcdoc`, no
   * allow-scripts) so a note containing `<script>` can never reach the
   * vault's own origin.
   */
  async renderMarkdown() {
    const marked = await loadMarkdown();
    const body = marked.parse(this.viewer.text, { breaks: true, gfm: true });
    this.viewer.html = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${MD_CSS}</style><body>${body}</body>`;
  },

  step(delta) {
    const rows = this.viewableRows;
    const at = rows.findIndex((row) => row.path === this.viewer.path);
    const next = rows[(at + delta + rows.length) % rows.length];
    if (next && rows.length > 1) this.open(next);
  },

  /** Tab indents at the caret instead of leaving the textarea. */
  insertTab(event) {
    const el = event.target;
    const { selectionStart: start, selectionEnd: end, value } = el;
    el.value = `${value.slice(0, start)}  ${value.slice(end)}`;
    el.selectionStart = el.selectionEnd = start + 2;
    this.viewer.text = el.value;
    this.viewer.dirty = true;
  },

  async saveEdit() {
    V.writeText(store, this.viewer.path, this.viewer.text);
    this.viewer.dirty = false;
    if (this.viewer.kind === 'markdown') await this.renderMarkdown();
    P.forgetThumb(this.viewer.path);
    this.touch();
    this.toast('Saved into the vault — remember to save the vault itself.');
  },

  async closeViewer({ force = false } = {}) {
    if (this.viewer.dirty && !force) {
      const ok = await this.confirm(
        'Discard changes?',
        `“${this.viewer.name}” has edits that have not been written into the vault.`,
        'Discard',
      );
      if (!ok) return;
    }
    this.revokeViewerUrl();
    this.viewer.open = false;
    this.viewer.editing = false;
    this.viewer.dirty = false;
  },

  revokeViewerUrl() {
    if (this.viewer.url) URL.revokeObjectURL(this.viewer.url);
    this.viewer.url = '';
  },

  zoomBy(factor) {
    this.viewer.zoom = Math.min(8, Math.max(0.2, this.viewer.zoom * factor));
    if (this.viewer.zoom <= 1) { this.viewer.x = 0; this.viewer.y = 0; }
  },

  resetZoom() {
    Object.assign(this.viewer, { zoom: 1, rotate: 0, x: 0, y: 0 });
  },

  // ---- pointer gestures (pan + pinch on the image stage) -----------
  pointers: new Map(),
  gesture: null,

  onStageDown(event) {
    if (this.viewer.kind !== 'image') return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.gesture = { dist: distance(a, b), zoom: this.viewer.zoom };
    }
  },

  onStageMove(event) {
    if (!this.pointers.has(event.pointerId)) return;
    const previous = this.pointers.get(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.pointers.size === 2 && this.gesture) {
      const [a, b] = [...this.pointers.values()];
      const ratio = distance(a, b) / (this.gesture.dist || 1);
      this.viewer.zoom = Math.min(8, Math.max(0.2, this.gesture.zoom * ratio));
      return;
    }
    if (this.viewer.zoom > 1) {
      this.viewer.x += event.clientX - previous.x;
      this.viewer.y += event.clientY - previous.y;
    }
  },

  onStageUp(event) {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.gesture = null;
  },

  onStageWheel(event) {
    if (this.viewer.kind !== 'image') return;
    event.preventDefault();
    this.zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
  },

  // ---- row actions menu --------------------------------------------
  menu: { open: false, row: null, x: 0, y: 0 },

  openMenu(event, row) {
    const x = Math.min(event.clientX ?? 0, innerWidth - 220);
    const y = Math.min(event.clientY ?? 0, innerHeight - 320);
    this.menu = { open: true, row, x: Math.max(8, x), y: Math.max(8, y) };
  },

  /** Long-press opens the same menu on touch, where contextmenu is unreliable. */
  pressStart(event, row) {
    clearTimeout(this.pressTimer);
    const touch = event.touches?.[0];
    this.pressTimer = setTimeout(() => {
      navigator.vibrate?.(8);
      this.openMenu({ clientX: touch?.clientX, clientY: touch?.clientY }, row);
    }, 480);
  },

  pressEnd() {
    clearTimeout(this.pressTimer);
  },

  closeMenu() {
    this.menu.open = false;
  },

  /** Menu and bulk-bar actions both funnel through here. */
  act(name, paths) {
    const list = paths ?? (this.menu.row ? [this.menu.row.path] : this.selected);
    const row = this.menu.row ?? this.rows.find((r) => r.path === list[0]);
    this.closeMenu();
    const actions = {
      open: () => this.activate(row),
      download: () => (list.length === 1 && !row.dir ? this.exportOne(row) : this.exportMany(list)),
      zip: () => this.exportMany(list),
      pdf: () => this.toPdf(list),
      rename: () => this.rename(row),
      move: () => this.moveTo(list),
      delete: () => this.remove(list),
      select: () => this.toggleSelect(row.path),
    };
    actions[name]?.();
  },

  // ---- keyboard ----------------------------------------------------
  dragging: false,

  onKey(event) {
    const meta = event.ctrlKey || event.metaKey;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);

    if (meta && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (this.viewer.open && this.viewer.editing) return this.saveEdit();
      if (this.view === 'vault') return this.save();
      return;
    }
    if (event.key === 'Escape') {
      if (this.dialog.open) return this.closeDialog(false);
      if (this.menu.open) return this.closeMenu();
      if (this.viewer.open) return this.closeViewer();
      if (this.helpOpen) return (this.helpOpen = false);
      if (this.settingsOpen) return (this.settingsOpen = false);
      if (this.rekey.open) return (this.rekey.open = false);
      return;
    }
    if (this.viewer.open && !typing) {
      if (event.key === 'ArrowRight') return this.step(1);
      if (event.key === 'ArrowLeft') return this.step(-1);
      if (event.key === '+' || event.key === '=') return this.zoomBy(1.2);
      if (event.key === '-') return this.zoomBy(1 / 1.2);
      if (event.key === '0') return this.resetZoom();
    }
    if (typing || this.view !== 'vault' || this.viewer.open) return;

    if (meta && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      return this.selectAll();
    }
    if (event.key === '/') {
      event.preventDefault();
      return this.$refs.search?.focus();
    }
    if (event.key === '?') return (this.helpOpen = !this.helpOpen);
    if (event.key === 'Delete' && this.selected.length) return this.remove(this.selected);
    if (event.key === 'Backspace' && this.cwd) return this.up();
  },
});

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function blobToDataUrl(blob, type) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(type ? new Blob([blob], { type }) : blob);
  });
}
/** Styling for the sandboxed markdown preview iframe. */
const MD_CSS = `
:root { color-scheme: dark; }
body { margin: 0 auto; padding: 24px; max-width: 46rem; background: #0e1117; color: #d7dce5;
  font: 16px/1.65 ui-sans-serif, system-ui, sans-serif; overflow-wrap: break-word; }
h1,h2,h3,h4 { color: #fff; line-height: 1.25; margin: 1.6em 0 .6em; }
h1,h2 { border-bottom: 1px solid #262c39; padding-bottom: .3em; }
a { color: #6ea8fe; }
code { background: #1b2130; padding: .15em .4em; border-radius: 4px; font-size: .9em; }
pre { background: #1b2130; padding: 14px; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: 1em 0; padding: .2em 1em; border-left: 3px solid #39415a; color: #9aa4b8; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #262c39; padding: 6px 10px; text-align: left; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid #262c39; }
`;

export async function start() {
  const Alpine = await loadAlpine();
  Alpine.data('vault', app);
  globalThis.Alpine = Alpine;
  Alpine.start();
}
