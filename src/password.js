/**
 * Password generation and a deliberately conservative strength estimate.
 *
 * This is not zxcvbn — it is a few kilobytes of arithmetic that reports
 * log2 of the search space and then subtracts for the patterns that make a
 * password guessable in practice. It under-promises on purpose.
 */

const SETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!#$%&*+-=?@^_~',
};

/** Ambiguous glyphs (l/I/1, O/0) are excluded from every set above. */
export function randomPassword({
  length = 24,
  lower = true,
  upper = true,
  digits = true,
  symbols = true,
} = {}) {
  const pools = Object.entries({ lower, upper, digits, symbols })
    .filter(([, on]) => on)
    .map(([name]) => SETS[name]);
  if (!pools.length) pools.push(SETS.lower);
  const alphabet = pools.join('');
  const size = Math.max(length, pools.length);
  const out = [];

  // One character from every enabled pool first, then fill, then shuffle,
  // so "include symbols" is a guarantee rather than a probability.
  for (const pool of pools) out.push(pick(pool));
  while (out.length < size) out.push(pick(alphabet));
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

const pick = (pool) => pool[randomBelow(pool.length)];

/** Rejection sampling — modulo would bias the low end of the alphabet. */
function randomBelow(bound) {
  const limit = Math.floor(0x100000000 / bound) * bound;
  const buf = new Uint32Array(1);
  let n;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return n % bound;
}

const COMMON = new Set([
  'password', 'passw0rd', '123456', '12345678', '123456789', 'qwerty',
  'qwertyuiop', 'letmein', 'welcome', 'admin', 'iloveyou', 'monkey',
  'dragon', 'football', 'abc123', 'secret', 'master', 'sunshine',
  'princess', 'trustno1', 'vault', 'changeme', 'test', 'root',
]);

const LEVELS = [
  { at: 0, label: 'Trivial', tone: 'crit' },
  { at: 40, label: 'Weak', tone: 'warn' },
  { at: 60, label: 'Fair', tone: 'warn' },
  { at: 80, label: 'Strong', tone: 'ok' },
  { at: 110, label: 'Excellent', tone: 'ok' },
];

/**
 * @returns {{bits: number, score: number, label: string, tone: string,
 *            hints: string[]}} `score` is 0-100 for meter width.
 */
export function estimateStrength(password = '') {
  if (!password) {
    return { bits: 0, score: 0, label: 'Empty', tone: 'crit', hints: [] };
  }
  const hints = [];
  const classes = [
    /[a-z]/.test(password) && 26,
    /[A-Z]/.test(password) && 26,
    /[0-9]/.test(password) && 10,
    /[^A-Za-z0-9]/.test(password) && 33,
  ].filter(Boolean);
  const pool = classes.reduce((a, b) => a + b, 0) || 1;
  let bits = password.length * Math.log2(pool);

  const lower = password.toLowerCase();
  if (COMMON.has(lower)) {
    bits = Math.min(bits, 8);
    hints.push('This is one of the most-guessed passwords in existence.');
  }
  const unique = new Set(password).size;
  if (unique < password.length) {
    // Repeated characters shrink the effective alphabet.
    bits *= unique / password.length;
    if (unique <= 3) hints.push('Too few distinct characters.');
  }
  if (/^(.+?)\1+$/.test(password)) {
    bits = Math.min(bits, 20);
    hints.push('This is a short pattern repeated.');
  }
  if (hasRun(lower)) {
    bits -= 12;
    hints.push('Avoid runs like "abcd" or "1234".');
  }
  if (password.length < 12) hints.push('Aim for 12 characters or more.');
  if (classes.length < 3) hints.push('Mix cases, digits and symbols.');

  bits = Math.max(0, Math.round(bits));
  const level = [...LEVELS].reverse().find((l) => bits >= l.at);
  return {
    bits,
    score: Math.min(100, Math.round((bits / 120) * 100)),
    label: level.label,
    tone: level.tone,
    hints: hints.slice(0, 2),
  };
}

/** True when the string contains 4+ consecutive ascending/descending codes. */
function hasRun(text) {
  let asc = 1;
  let desc = 1;
  for (let i = 1; i < text.length; i++) {
    const delta = text.charCodeAt(i) - text.charCodeAt(i - 1);
    asc = delta === 1 ? asc + 1 : 1;
    desc = delta === -1 ? desc + 1 : 1;
    if (asc >= 4 || desc >= 4) return true;
  }
  return false;
}

