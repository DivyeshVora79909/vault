/**
 * File-type classification, icons, and thumbnail generation.
 *
 * Adding support for a new format means adding one line to `KINDS` — the
 * viewer, the icon, and the thumbnail path all derive from the kind.
 */

const KINDS = {
  image: 'png jpg jpeg gif webp bmp avif svg ico',
  video: 'mp4 webm mov m4v ogv',
  audio: 'mp3 wav ogg oga m4a flac aac opus',
  pdf: 'pdf',
  markdown: 'md markdown mdx',
  text: 'txt log csv tsv rtf ini cfg conf env',
  code: 'js mjs cjs ts tsx jsx json json5 html htm css scss less xml yml yaml sh bash zsh py rb go rs java kt c h cpp hpp cs php sql toml gradle dockerfile makefile vue svelte',
  archive: 'zip rar 7z tar gz bz2 xz svault',
  doc: 'doc docx odt xls xlsx ods ppt pptx odp',
};

const EXT_KIND = new Map();
for (const [kind, list] of Object.entries(KINDS)) {
  for (const ext of list.split(' ')) EXT_KIND.set(ext, kind);
}

/** MIME types the browser needs spelled out; Blob type from ZIP is empty. */
const MIME = {
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  ico: 'image/x-icon',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  opus: 'audio/ogg',
  pdf: 'application/pdf',
  svault: 'application/octet-stream',
};

export const extOf = (name = '') => {
  const base = name.split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase();
};

export const kindOf = (name) => EXT_KIND.get(extOf(name)) ?? 'other';

export function mimeOf(name) {
  const ext = extOf(name);
  if (MIME[ext]) return MIME[ext];
  const kind = kindOf(name);
  if (kind === 'image' || kind === 'video' || kind === 'audio') return `${kind}/${ext}`;
  if (kind === 'text' || kind === 'markdown' || kind === 'code') return 'text/plain';
  return 'application/octet-stream';
}

/** Which viewer a kind opens in. `download` means "no in-app preview". */
export const viewerOf = (name) =>
  ({
    image: 'image',
    video: 'media',
    audio: 'audio',
    pdf: 'pdf',
    markdown: 'markdown',
    text: 'editor',
    code: 'editor',
  })[kindOf(name)] ?? 'download';

/** Ids of the `<symbol>` elements defined in index.html. */
export const iconOf = (row) =>
  row.dir ? 'i-folder' : `i-${{
    image: 'image', video: 'video', audio: 'audio', pdf: 'pdf',
    markdown: 'markdown', text: 'text', code: 'code',
    archive: 'archive', doc: 'doc',
  }[kindOf(row.name)] ?? 'file'}`;

const THUMB_MAX = 256;
const THUMB_LIMIT = 8 * 1024 * 1024; // bigger files aren't worth the decode
const cache = new Map(); // path -> data URL | null

/**
 * Best-effort thumbnail as a data URL, or null when one can't be made.
 * Results are memoised per path for the life of the unlocked session; call
 * `forgetThumb` after an edit and `clearThumbs` on lock.
 */
export async function thumbFor(row, getBlob) {
  if (cache.has(row.path)) return cache.get(row.path);
  const kind = kindOf(row.name);
  const eligible =
    (kind === 'image' || kind === 'video') && row.size > 0 && row.size < THUMB_LIMIT;
  if (!eligible) {
    cache.set(row.path, null);
    return null;
  }
  let url;
  try {
    const blob = new Blob([await getBlob(row.path)], { type: mimeOf(row.name) });
    url = URL.createObjectURL(blob);
    const source = kind === 'image' ? await decodeImage(url) : await grabFrame(url);
    const thumb = toDataUrl(source);
    cache.set(row.path, thumb);
    return thumb;
  } catch {
    cache.set(row.path, null);
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

export const forgetThumb = (path) => cache.delete(path);
export const clearThumbs = () => cache.clear();

function decodeImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = url;
  });
}

/** Seeks a little way in so we don't capture a black leading frame. */
function grabFrame(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(0.5, (video.duration || 1) / 4);
    };
    video.onseeked = () => resolve(video);
    video.onerror = () => reject(new Error('decode failed'));
    setTimeout(() => reject(new Error('timeout')), 8000);
    video.src = url;
  });
}

function toDataUrl(source) {
  const w = source.videoWidth || source.naturalWidth;
  const h = source.videoHeight || source.naturalHeight;
  if (!w || !h) throw new Error('no intrinsic size');
  const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.72);
}

