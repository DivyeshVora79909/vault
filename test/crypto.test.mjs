import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_ITERATIONS,
  MIN_ITERATIONS,
  VaultError,
  clampIterations,
  decryptVault,
  encryptVault,
} from '../src/crypto.js';
import { estimateStrength, randomPassword } from '../src/password.js';
import { makeLegacyVault, makeZip } from './fixtures.mjs';

const utf8 = new TextEncoder();
// Real iteration counts make these tests take seconds; the format is what is
// under test, so use the floor.
const fast = { iterations: MIN_ITERATIONS };

test('v2 round-trips', async () => {
  const plain = utf8.encode('the quick brown fox');
  const payload = await encryptVault(plain, 'correct horse', fast);
  const opened = await decryptVault(payload, 'correct horse');

  assert.equal(opened.format, 'v2');
  assert.equal(opened.iterations, MIN_ITERATIONS);
  assert.deepEqual(opened.data, plain);
});

test('v2 payloads are self-describing and salted per save', async () => {
  const a = await encryptVault(utf8.encode('x'), 'pw', fast);
  const b = await encryptVault(utf8.encode('x'), 'pw', fast);

  assert.deepEqual([...a.slice(0, 4)], [...utf8.encode('SVLT')]);
  assert.equal(a[4], 2, 'version byte');
  assert.notDeepEqual(a.slice(11, 43), b.slice(11, 43), 'salt must differ');
  assert.notDeepEqual(a, b);
});

test('legacy v1 vaults still open, and re-save as v2', async () => {
  const legacy = await makeLegacyVault('old-password', [
    { name: 'notes.txt', data: 'hello from 2024' },
  ]);
  const opened = await decryptVault(legacy, 'old-password');

  assert.equal(opened.format, 'v1');
  assert.equal(opened.iterations, 100000);
  // The plaintext is a ZIP: check the local file header magic survived.
  assert.deepEqual([...opened.data.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);

  const upgraded = await decryptVault(
    await encryptVault(opened.data, 'old-password', fast),
    'old-password',
  );
  assert.equal(upgraded.format, 'v2');
  assert.deepEqual(upgraded.data, opened.data);
});

test('wrong password is rejected for both layouts', async () => {
  const v2 = await encryptVault(utf8.encode('secret'), 'right', fast);
  const v1 = await makeLegacyVault('right', [{ name: 'a', data: 'b' }]);

  for (const payload of [v2, v1]) {
    await assert.rejects(() => decryptVault(payload, 'wrong'), (error) => {
      assert.ok(error instanceof VaultError);
      assert.equal(error.code, 'bad_password');
      return true;
    });
  }
});

test('tampering with the header or body is detected', async () => {
  const payload = await encryptVault(utf8.encode('secret'), 'pw', fast);

  const downgraded = payload.slice();
  new DataView(downgraded.buffer).setUint32(6, 1000, false); // fewer iterations
  await assert.rejects(() => decryptVault(downgraded, 'pw'));

  const flipped = payload.slice();
  flipped[flipped.length - 1] ^= 0xff;
  await assert.rejects(() => decryptVault(flipped, 'pw'));
});

test('truncated and empty input fail cleanly', async () => {
  await assert.rejects(() => decryptVault(new Uint8Array(0), 'pw'), VaultError);
  await assert.rejects(() => decryptVault(new Uint8Array(20), 'pw'), VaultError);
  await assert.rejects(() => encryptVault(utf8.encode('x'), ''), VaultError);
});

test('iteration counts are clamped, not trusted', () => {
  assert.equal(clampIterations(50), MIN_ITERATIONS);
  assert.equal(clampIterations(1e12), 5_000_000);
  assert.equal(clampIterations('nonsense'), DEFAULT_ITERATIONS);
});

test('generated passwords honour the requested classes', () => {
  const pw = randomPassword({ length: 24 });
  assert.equal(pw.length, 24);
  assert.match(pw, /[a-z]/);
  assert.match(pw, /[A-Z]/);
  assert.match(pw, /[0-9]/);
  assert.match(pw, /[^A-Za-z0-9]/);
  assert.doesNotMatch(pw, /[lIO01]/, 'ambiguous glyphs are excluded');
  assert.equal(randomPassword({ length: 40, symbols: false }).length, 40);
  assert.doesNotMatch(randomPassword({ length: 30, symbols: false }), /[^A-Za-z0-9]/);
});

test('strength estimate punishes the obvious', () => {
  assert.ok(estimateStrength('password').bits < 20);
  assert.ok(estimateStrength('abcdefgh').bits < estimateStrength('kv7#Qm2!').bits);
  assert.ok(estimateStrength('aaaaaaaaaaaa').bits < 30);
  assert.ok(estimateStrength(randomPassword({ length: 24 })).bits > 100);
  assert.equal(estimateStrength('').label, 'Empty');
});

test('the zip fixture writer produces something JSZip-compatible', () => {
  const zip = makeZip([{ name: 'a.txt', data: 'a' }, { name: 'dir/b.txt', data: 'bb' }]);
  assert.deepEqual([...zip.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.deepEqual([...zip.slice(-22, -18)], [0x50, 0x4b, 0x05, 0x06]);
});
