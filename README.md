# Vault

Offline, zero-knowledge file encryption that runs entirely in the browser.
Serve the folder — any static host, GitHub Pages, or `npm run serve` — and it
works with the network unplugged afterwards. No backend, no build step, no
accounts.

> Served, not double-clicked: the app is split into native ES modules, which
> browsers refuse to load over `file://`. Use a static server (one line, below)
> or install the hosted page as a PWA — it then launches and works offline like
> a native app.

Files live inside a single encrypted `.svault` container: AES-256-GCM over a
DEFLATE archive, with the key stretched from your password by PBKDF2-HMAC-SHA256.
Nothing is uploaded, and no key material is ever written to disk or storage.

## What it does

- **Browse like a file manager** — folders, breadcrumbs, grid or list, sort by
  name/size/date/type, search across the whole vault.
- **Preview in place** — images (pinch/wheel zoom, pan, rotate, ←/→ between
  files), video, audio, PDFs, and rendered Markdown.
- **Edit in place** — text, code, and Markdown files, saved back into the vault.
- **Bulk work** — multi-select, move between folders, delete, export a subset as
  a plain `.zip`, or convert selected images into one PDF.
- **Add anything** — drag and drop files *or whole folders* (structure is
  preserved), or use the file/folder pickers.
- **Save in place** — with the File System Access API the vault is written back
  to the same file, with optional auto-save; elsewhere it downloads. Recently
  opened vaults are remembered (handles only) for one-tap reopening.
- **Stay safe** — password generator and strength meter, master-password change,
  idle auto-lock, unsaved-changes guards.
- **Work on a phone** — bottom sheets, long-press menus, safe-area insets,
  44px targets, light/dark/system themes, installable and offline-capable.

## Container format

Reading auto-detects both layouts; writing always emits v2.

| | v1 (previous releases) | v2 (current) |
|---|---|---|
| Prefix | `salt[16] │ iv[12]` | `"SVLT" │ ver[1] │ kdf[1] │ iters[4 BE] │ saltLen[1] │ salt[32] │ iv[12]` |
| KDF | PBKDF2-SHA256, fixed 100 000 | PBKDF2-SHA256, count stored in the header (default 600 000) |
| Cipher | AES-256-GCM | AES-256-GCM, prefix bound as additional data |

**Old vaults keep working.** A v1 file opens unchanged, and saving it rewrites it
as v2 with the stronger KDF — same password, same contents. This is covered by
tests, not just by intent (`test/crypto.test.mjs`, `test/e2e.mjs`).

## Layout

Plain ES modules, loaded natively. No bundler, no framework glue.

```
index.html          markup + icon sprite; all behaviour is Alpine directives
src/crypto.js       container format, KDF, encrypt/decrypt  (no DOM, no deps)
src/password.js     generator + strength estimate           (no DOM, no deps)
src/vault.js        the ZIP container: open, seal, list, add, move, remove
src/preview.js      type → kind → icon/viewer/MIME, thumbnails
src/ui.js           formatting, downloads, File System Access, drops, idle
src/app.js          Alpine component: view state and orchestration only
src/styles.css      design tokens + components; two theme blocks
src/deps.js         every CDN dependency and version, in one place
sw.js               offline shell
```

Dependencies are four CDN modules, imported lazily where they are heavy:
Alpine (reactivity), JSZip (container), jsPDF (image→PDF), marked (Markdown).
Bump a version in `src/deps.js` and `CACHE` in `sw.js`; there is nothing else to
update.

## Develop

```sh
npm run serve        # http://localhost:8080 — any static server works
npm test             # crypto/format/password unit tests, no dependencies
npm run test:e2e     # real-browser suite (npm i -D playwright first)
```

The e2e suite deletes `showOpenFilePicker` before load, so it exercises the
`<input type=file>` + download path that Firefox and Safari use.

## Security notes

- **There is no recovery.** Lose the password and the data is unrecoverable.
- Decrypted content exists only in tab memory; locking or closing the tab drops it.
- `localStorage` holds UI preferences only. IndexedDB holds file *handles* for
  the recent list — no passwords, no keys, no contents.
- Markdown previews render in a sandboxed iframe, so a note containing markup or
  scripts cannot reach the app's origin.
- Exported `.zip` files are **not** encrypted — that is the point of exporting.
- Keep backups. A corrupted or half-written `.svault` will not decrypt.

## License

MIT — see [LICENSE](LICENSE).
