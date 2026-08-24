/**
 * End-to-end smoke test in a real browser.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node test/e2e.mjs
 *
 * `showOpenFilePicker` is deleted before the app loads so the run exercises
 * the same `<input type=file>` + download path that Safari and Firefox use —
 * the fallback is the part most likely to rot.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { makeLegacyVault, makePng } from './fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname));
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

const playwright = await import(process.env.PLAYWRIGHT ?? 'playwright');
const { chromium } = playwright.chromium ? playwright : playwright.default;
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
const results = [];
const check = async (name, fn) => {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 420, height: 780 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => { throw error; });
  await page.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; });
  try {
    await fn(page);
    results.push(`  ok   ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error.message.split('\n')[0]}`);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
};

const PASSWORD = 'tr0mbone-kettle-Whisper!42';
const FILES_INPUT = 'input[multiple]:not([webkitdirectory])';
const VAULT_INPUT = 'input[accept*=".svault"]';

const unlock = async (page, path, password) => {
  await page.setInputFiles(VAULT_INPUT, path);
  await page.fill('input[placeholder="Master password"]', password);
  await page.click('button:has-text("Unlock")');
};

await check('creates a vault, stores a file, and reopens it after a reload', async (page) => {
  await page.goto(base);
  await page.click('button:has-text("Create new")');
  await page.fill('input[placeholder="New master password"]', PASSWORD);
  await page.fill('input[placeholder="Repeat password"]', PASSWORD);
  await page.click('button:has-text("Create vault")');
  await page.waitForSelector('.shell', { state: 'visible' });

  await page.setInputFiles(FILES_INPUT, {
    name: 'hello.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('round trip please'),
  });
  await page.waitForSelector('.tile:has-text("hello.txt")');
  assert.match(await page.textContent('.topbar-id small'), /1 files/);

  const download = await Promise.all([
    page.waitForEvent('download'),
    page.click('.topbar button:has-text("Save")'),
  ]).then(([event]) => event);
  const saved = await download.path();
  assert.match(download.suggestedFilename(), /\.svault$/);

  await page.reload();
  await unlock(page, saved, PASSWORD);
  await page.waitForSelector('.shell', { state: 'visible' });
  await page.click('.tile:has-text("hello.txt")');
  await page.waitForSelector('.viewer textarea');
  assert.equal(await page.inputValue('.viewer textarea'), 'round trip please');
});

await check('opens a legacy v1 vault written by the previous release', async (page) => {
  const legacy = join(ROOT, 'test', '.tmp-legacy.svault');
  const { writeFile, rm } = await import('node:fs/promises');
  await writeFile(legacy, await makeLegacyVault('old-password', [
    { name: 'diary.md', data: '# still readable' },
    { name: 'photos/note.txt', data: 'nested' },
  ]));
  try {
    await page.goto(base);
    await unlock(page, legacy, 'old-password');
    await page.waitForSelector('.shell', { state: 'visible' });
    await page.waitForSelector('.tile:has-text("diary.md")');
    await page.waitForSelector('.tile:has-text("photos")');
    assert.match(await page.textContent('.topbar-id small'), /legacy v1/);

    await page.click('.tile:has-text("diary.md")');
    await page.waitForSelector('.viewer iframe');
  } finally {
    await rm(legacy, { force: true });
  }
});

await check('rejects the wrong password without crashing', async (page) => {
  const legacy = join(ROOT, 'test', '.tmp-bad.svault');
  const { writeFile, rm } = await import('node:fs/promises');
  await writeFile(legacy, await makeLegacyVault('right', [{ name: 'a.txt', data: 'x' }]));
  try {
    await page.goto(base);
    await unlock(page, legacy, 'definitely-not-right');
    await page.waitForSelector('.toast');
    assert.match(await page.textContent('.toast'), /Wrong password/i);
    assert.ok(await page.isVisible('.lock'), 'stays on the lock screen');
  } finally {
    await rm(legacy, { force: true });
  }
});

await check('navigates folders, searches, and deletes with the action menu', async (page) => {
  await page.goto(base);
  await page.click('button:has-text("Create new")');
  await page.fill('input[placeholder="New master password"]', PASSWORD);
  await page.fill('input[placeholder="Repeat password"]', PASSWORD);
  await page.click('button:has-text("Create vault")');
  await page.waitForSelector('.shell', { state: 'visible' });

  await page.setInputFiles(FILES_INPUT, [
    { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from('a') },
    { name: 'beta.md', mimeType: 'text/markdown', buffer: Buffer.from('# b') },
  ]);
  await page.waitForSelector('.tile:has-text("beta.md")');

  await page.fill('input[placeholder^="Search"]', 'alpha');
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1);

  await page.fill('input[placeholder^="Search"]', '');
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2);

  page.on('dialog', (dialog) => dialog.dismiss()); // native dialogs are a bug now
  await page.click('.tile:has-text("alpha.txt") .tile-meta button');
  await page.click('.menu button:has-text("Delete")');
  await page.click('.sheet button:has-text("Delete")');
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1);
});

await check('folders, notes, markdown editing and save survive a reload', async (page) => {
  await page.goto(base);
  await page.click('button:has-text("Create new")');
  await page.fill('input[placeholder="New master password"]', PASSWORD);
  await page.fill('input[placeholder="Repeat password"]', PASSWORD);
  await page.click('button:has-text("Create vault")');
  await page.waitForSelector('.shell', { state: 'visible' });

  // New folder, then a note inside it.
  await page.click('button[title="New folder"]');
  await page.fill('.sheet input.field', 'journal');
  await page.click('.sheet button:has-text("Create")');
  await page.waitForFunction(() => document.querySelector('.crumbs')?.textContent.includes('journal'));

  await page.click('button[title="New note"]');
  await page.fill('.sheet input.field', 'day-one.md');
  await page.click('.sheet button:has-text("Create")');
  await page.waitForSelector('.viewer textarea');
  await page.fill('.viewer textarea', '# Day one\n\nIt works.');
  await page.click('.viewer button:has-text("Save")');
  await page.click('.viewer-bar button[aria-label="Back"]');

  const download = await Promise.all([
    page.waitForEvent('download'),
    page.click('.topbar button:has-text("Save")'),
  ]).then(([event]) => event);
  const saved = await download.path();

  await page.reload();
  await unlock(page, saved, PASSWORD);
  await page.waitForSelector('.tile:has-text("journal")');
  await page.click('.tile:has-text("journal")');
  await page.click('.tile:has-text("day-one.md")');
  await page.waitForSelector('.viewer iframe');
  // The srcdoc is written after the async markdown import resolves.
  await page.waitForFunction(() =>
    document.querySelector('.viewer iframe')?.getAttribute('srcdoc')?.includes('<h1'));
  const frame = page.frameLocator('.viewer iframe');
  assert.equal(await frame.locator('h1').textContent(), 'Day one');
});

await check('legacy vaults keep every byte when upgraded to v2', async (page) => {
  const { writeFile, rm } = await import('node:fs/promises');
  const legacy = join(ROOT, 'test', '.tmp-upgrade.svault');
  await writeFile(legacy, await makeLegacyVault('old-password', [
    { name: 'keep.txt', data: 'exact bytes' },
    { name: 'sub/deep.txt', data: 'nested bytes' },
  ]));
  try {
    await page.goto(base);
    await unlock(page, legacy, 'old-password');
    await page.waitForSelector('.shell', { state: 'visible' });

    const download = await Promise.all([
      page.waitForEvent('download'),
      page.click('.topbar button:has-text("Save")'),
    ]).then(([event]) => event);
    const upgraded = await download.path();

    await page.reload();
    await unlock(page, upgraded, 'old-password');
    await page.waitForSelector('.shell', { state: 'visible' });
    assert.match(await page.textContent('.topbar-id small'), /v2/);

    await page.click('.tile:has-text("keep.txt")');
    await page.waitForSelector('.viewer textarea');
    assert.equal(await page.inputValue('.viewer textarea'), 'exact bytes');
    await page.click('.viewer-bar button[aria-label="Back"]');

    await page.click('.tile:has-text("sub")');
    await page.click('.tile:has-text("deep.txt")');
    await page.waitForSelector('.viewer textarea');
    assert.equal(await page.inputValue('.viewer textarea'), 'nested bytes');
  } finally {
    await rm(legacy, { force: true });
  }
});

await check('thumbnails, image→PDF and plain-zip export all work', async (page) => {
  await page.goto(base);
  await page.click('button:has-text("Create new")');
  await page.fill('input[placeholder="New master password"]', PASSWORD);
  await page.fill('input[placeholder="Repeat password"]', PASSWORD);
  await page.click('button:has-text("Create vault")');
  await page.waitForSelector('.shell', { state: 'visible' });

  await page.setInputFiles(FILES_INPUT, {
    name: 'photo.png',
    mimeType: 'image/png',
    buffer: Buffer.from(await makePng(96)),
  });
  await page.waitForSelector('.tile:has-text("photo.png")');
  // A thumbnail replaces the generic icon once it has been decoded.
  await page.waitForSelector('.tile img[src^="data:image/jpeg"]');

  await page.click('.tile:has-text("photo.png") .tile-check');
  await page.click('.bulkbar button:has-text("PDF")');
  await page.waitForSelector('.tile:has-text("photo.pdf")', { timeout: 60_000 });

  await page.click('.tile:has-text("photo.png") .tile-check');
  const download = await Promise.all([
    page.waitForEvent('download'),
    page.click('.bulkbar button:has-text("Export")'),
  ]).then(([event]) => event);
  assert.match(download.suggestedFilename(), /-export\.zip$/);
});

await check('moves a file into a folder and renames it', async (page) => {
  await page.goto(base);
  await page.click('button:has-text("Create new")');
  await page.fill('input[placeholder="New master password"]', PASSWORD);
  await page.fill('input[placeholder="Repeat password"]', PASSWORD);
  await page.click('button:has-text("Create vault")');
  await page.waitForSelector('.shell', { state: 'visible' });

  await page.setInputFiles(FILES_INPUT, {
    name: 'loose.txt', mimeType: 'text/plain', buffer: Buffer.from('move me'),
  });
  await page.waitForSelector('.tile:has-text("loose.txt")');

  await page.click('button[title="New folder"]');
  await page.fill('.sheet input.field', 'inbox');
  await page.click('.sheet button:has-text("Create")');
  await page.click('.crumbs button:has-text("Vault")');
  await page.waitForSelector('.tile:has-text("inbox")');

  // Rename through the row menu.
  await page.click('.tile:has-text("loose.txt") .tile-meta button');
  await page.click('.menu button:has-text("Rename")');
  await page.fill('.sheet input.field', 'kept.txt');
  await page.click('.sheet button:has-text("Rename")');
  await page.waitForSelector('.tile:has-text("kept.txt")');

  // Then move it into the folder via the dialog's destination picker.
  await page.click('.tile:has-text("kept.txt") .tile-meta button');
  await page.click('.menu button:has-text("Move to folder")');
  await page.selectOption('.sheet select.field', 'inbox/');
  await page.click('.sheet button:has-text("Move")');
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1);

  await page.click('.tile:has-text("inbox")');
  await page.waitForSelector('.tile:has-text("kept.txt")');
});

console.log(results.join('\n'));
await browser.close();
server.close();
