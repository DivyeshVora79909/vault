/**
 * Test fixtures with no dependencies.
 *
 * `makeZip` writes a minimal store-only (uncompressed) ZIP, which is enough
 * for JSZip to read back, and `makeLegacyVault` wraps one in the exact v1
 * layout the previous release of this app produced — that is what guarantees
 * old vaults still open.
 */

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {{name: string, data: string|Uint8Array}[]} entries */
export function makeZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return concat([...chunks, ...central, new Uint8Array(end.buffer)]);
}

export function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A real 8-bit greyscale PNG, so thumbnail and PDF paths get decodable input. */
export async function makePng(size = 64) {
  const { deflateSync } = await import('node:zlib');
  const chunk = (type, body) => {
    const head = new DataView(new ArrayBuffer(8));
    head.setUint32(0, body.length, false);
    const name = new TextEncoder().encode(type);
    new Uint8Array(head.buffer).set(name, 4);
    const tail = new DataView(new ArrayBuffer(4));
    tail.setUint32(0, crc32(concat([name, body])), false);
    return concat([new Uint8Array(head.buffer), body, new Uint8Array(tail.buffer)]);
  };
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = new Uint8Array(size + 1); // leading filter byte stays 0
    for (let x = 0; x < size; x++) row[x + 1] = ((x >> 3) + (y >> 3)) % 2 ? 20 : 235;
    rows.push(row);
  }
  const ihdr = new DataView(new ArrayBuffer(13));
  ihdr.setUint32(0, size, false);
  ihdr.setUint32(4, size, false);
  ihdr.setUint8(8, 8); // bit depth
  return concat([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', new Uint8Array(ihdr.buffer)),
    chunk('IDAT', new Uint8Array(deflateSync(concat(rows)))),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** The v1 layout, reimplemented here exactly as the old app wrote it. */
export async function makeLegacyVault(password, entries) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  const archive = makeZip(entries);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, archive));
  return concat([salt, iv, ct]);
}
