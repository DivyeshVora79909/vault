/**
 * Vault container crypto.
 *
 * Two on-disk layouts are understood. Reading auto-detects; writing always
 * emits `v2`.
 *
 *   v1 (legacy, written by Secure Vault Pro v2 and earlier)
 *     salt[16] | iv[12] | AES-256-GCM ciphertext
 *     PBKDF2-HMAC-SHA256, 100_000 iterations, no AAD.
 *
 *   v2 (current)
 *     "SVLT" | ver[1] | kdf[1] | iters[4 BE] | saltLen[1] | salt[n] | iv[12] | ct
 *     PBKDF2-HMAC-SHA256, iteration count stored in the header, and the whole
 *     header+salt+iv prefix is bound to the ciphertext as GCM additional data,
 *     so downgrading the iteration count is detectable.
 *
 * Both layouts are AES-256-GCM, so the 16-byte auth tag is what makes a wrong
 * password observable. Nothing here ever touches the network or storage.
 */

const MAGIC = [0x53, 0x56, 0x4c, 0x54]; // "SVLT"
const KDF_PBKDF2_SHA256 = 1;
const V2_HEADER = 11; // magic4 + ver1 + kdf1 + iters4 + saltLen1
const IV_LEN = 12;
const LEGACY_SALT = 16;
const LEGACY_ITERATIONS = 100_000;

/** OWASP 2024 floor for PBKDF2-HMAC-SHA256. */
export const DEFAULT_ITERATIONS = 600_000;
export const MIN_ITERATIONS = 100_000;
export const MAX_ITERATIONS = 5_000_000;

export class VaultError extends Error {
  constructor(message, { code = 'vault_error', cause } = {}) {
    super(message, { cause });
    this.name = 'VaultError';
    this.code = code;
  }
}

const bytes = (input) =>
  input instanceof Uint8Array ? input : new Uint8Array(input);

const random = (n) => crypto.getRandomValues(new Uint8Array(n));

async function deriveKey(password, salt, iterations) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new VaultError('A password is required.', { code: 'no_password' });
  }
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Iteration counts are clamped so a corrupt header cannot hang the tab. */
export function clampIterations(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_ITERATIONS;
  return Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, n));
}

function buildPrefix(iterations, salt, iv) {
  const prefix = new Uint8Array(V2_HEADER + salt.length + iv.length);
  prefix.set(MAGIC, 0);
  prefix[4] = 2;
  prefix[5] = KDF_PBKDF2_SHA256;
  new DataView(prefix.buffer).setUint32(6, iterations, false);
  prefix[10] = salt.length;
  prefix.set(salt, V2_HEADER);
  prefix.set(iv, V2_HEADER + salt.length);
  return prefix;
}

const hasMagic = (buf) =>
  buf.length > V2_HEADER && MAGIC.every((b, i) => buf[i] === b);

/**
 * @param {Uint8Array|ArrayBuffer} plaintext
 * @returns {Promise<Uint8Array>} the complete `.svault` payload
 */
export async function encryptVault(plaintext, password, opts = {}) {
  const iterations = clampIterations(opts.iterations ?? DEFAULT_ITERATIONS);
  const salt = random(32);
  const iv = random(IV_LEN);
  const prefix = buildPrefix(iterations, salt, iv);
  const key = await deriveKey(password, salt, iterations);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: prefix },
      key,
      bytes(plaintext),
    ),
  );
  const out = new Uint8Array(prefix.length + ct.length);
  out.set(prefix, 0);
  out.set(ct, prefix.length);
  return out;
}

async function openV2(buf, password) {
  const version = buf[4];
  if (version !== 2) {
    throw new VaultError(
      `This vault uses format v${version}, which this build cannot read. Update the app.`,
      { code: 'unsupported_version' },
    );
  }
  if (buf[5] !== KDF_PBKDF2_SHA256) {
    throw new VaultError('Unknown key-derivation function in vault header.', {
      code: 'unsupported_kdf',
    });
  }
  const iterations = clampIterations(
    new DataView(buf.buffer, buf.byteOffset).getUint32(6, false),
  );
  const saltLen = buf[10];
  const ivAt = V2_HEADER + saltLen;
  const ctAt = ivAt + IV_LEN;
  if (saltLen < 16 || buf.length <= ctAt) {
    throw new VaultError('Vault header is truncated or corrupt.', {
      code: 'corrupt',
    });
  }
  const key = await deriveKey(password, buf.slice(V2_HEADER, ivAt), iterations);
  const data = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: buf.slice(ivAt, ctAt),
      additionalData: buf.slice(0, ctAt),
    },
    key,
    buf.slice(ctAt),
  );
  return { data: new Uint8Array(data), format: 'v2', iterations };
}

async function openLegacy(buf, password) {
  const ctAt = LEGACY_SALT + IV_LEN;
  if (buf.length <= ctAt) {
    throw new VaultError('File is too small to be a vault.', { code: 'corrupt' });
  }
  const key = await deriveKey(
    password,
    buf.slice(0, LEGACY_SALT),
    LEGACY_ITERATIONS,
  );
  const data = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf.slice(LEGACY_SALT, ctAt) },
    key,
    buf.slice(ctAt),
  );
  return { data: new Uint8Array(data), format: 'v1', iterations: LEGACY_ITERATIONS };
}

/**
 * Decrypt a `.svault` payload of either layout.
 *
 * @returns {Promise<{data: Uint8Array, format: 'v1'|'v2', iterations: number}>}
 */
export async function decryptVault(payload, password) {
  const buf = bytes(payload);
  if (hasMagic(buf)) {
    try {
      return await openV2(buf, password);
    } catch (err) {
      // A v1 salt starting with the ASCII bytes "SVLT" is a 1-in-2^32 fluke,
      // but it costs one extra derivation to rule out, so rule it out.
      if (err instanceof VaultError && err.code !== 'corrupt') throw err;
    }
  }
  try {
    return await openLegacy(buf, password);
  } catch (err) {
    if (err instanceof VaultError) throw err;
    throw new VaultError('Wrong password, or this file is not a vault.', {
      code: 'bad_password',
      cause: err,
    });
  }
}

