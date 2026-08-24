/**
 * Every third-party dependency, in one place.
 *
 * Bumping a version means editing exactly one line here (and `CACHE` in
 * ../sw.js so the offline copy refreshes). Heavy libraries are behind lazy
 * getters so the initial load stays small — `jspdf` alone is 340 KB and most
 * sessions never convert anything to PDF.
 */

const CDN = 'https://cdn.jsdelivr.net/npm';

export const VERSIONS = {
  alpine: '3.15.0',
  jszip: '3.10.1',
  jspdf: '2.5.2',
  marked: '15.0.7',
};

/** URLs are also consumed by the service worker's precache list. */
export const URLS = {
  alpine: `${CDN}/alpinejs@${VERSIONS.alpine}/dist/module.esm.min.js`,
  jszip: `${CDN}/jszip@${VERSIONS.jszip}/+esm`,
  jspdf: `${CDN}/jspdf@${VERSIONS.jspdf}/+esm`,
  marked: `${CDN}/marked@${VERSIONS.marked}/+esm`,
};

const memo = new Map();
const once = (name, load) => {
  if (!memo.has(name)) memo.set(name, load().catch((err) => {
    memo.delete(name);
    throw err;
  }));
  return memo.get(name);
};

export const loadAlpine = () =>
  once('alpine', async () => (await import(URLS.alpine)).default);

export const loadZip = () =>
  once('jszip', async () => (await import(URLS.jszip)).default);

export const loadPdf = () =>
  once('jspdf', async () => (await import(URLS.jspdf)).jsPDF);

export const loadMarkdown = () =>
  once('marked', async () => (await import(URLS.marked)).marked);
