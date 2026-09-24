import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bmpSafe, dropLoneSurrogates, isSensitivePath, redactSecrets, safeSlice, sanitize, stripPrivate, truncate } from '../src/privacy.mjs';

test('stripPrivate removes tagged blocks, including unclosed ones', () => {
  assert.equal(stripPrivate('keep <private>drop this</private> keep'), 'keep [private] keep');
  assert.equal(stripPrivate('a <PRIVATE>x</PRIVATE> b <private>y</private>'), 'a [private] b [private]');
  assert.equal(stripPrivate('start <private>never closed'), 'start [private]');
  assert.equal(stripPrivate(''), '');
});

test('isSensitivePath matches secret files and directories', () => {
  for (const p of [
    '.env',
    '/app/.env.production',
    'C:\\proj\\config\\local.env',
    'server.pem',
    'deploy.key',
    '/home/u/.ssh/id_rsa',
    '/home/u/.ssh/id_ed25519.pub',
    'C:\\Users\\u\\.aws\\credentials',
    '/home/u/.docker/config.json',
    '.npmrc',
    'secrets.yaml',
    'google-credentials.json',
  ]) {
    assert.equal(isSensitivePath(p), true, p);
  }
});

test('isSensitivePath leaves ordinary files and templates alone', () => {
  for (const p of ['src/index.ts', 'README.md', '.env.example', '.env.sample', 'config.json', 'package.json', 'environment.ts', 'keyboard.ts']) {
    assert.equal(isSensitivePath(p), false, p);
  }
});

test('redactSecrets masks common credential formats', () => {
  const cases = [
    ['ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', 'sk-ant-'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_'],
    ['export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnopqrstuvwxyz'],
    ['git clone https://user:s3cretpass@github.com/x/y.git', 's3cretpass'],
    ['password: hunter22', 'hunter22'],
    ['"api_key": "abcdef123456"', 'abcdef123456'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJhbGci'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----', 'MIIE'],
  ];
  for (const [input, secret] of cases) {
    const out = redactSecrets(input);
    assert.ok(!out.includes(secret), `${input} -> ${out}`);
    assert.ok(out.includes('[REDACTED'), out);
  }
});

test('redactSecrets keeps innocuous text intact', () => {
  for (const s of ['npm test', 'const token = 5;', 'the password field is required', 'git commit -m "fix login"', 'AKIA is a prefix']) {
    assert.equal(redactSecrets(s), s);
  }
});

test('sanitize applies both filters', () => {
  assert.equal(sanitize('x <private>ghp_abcdefghijklmnopqrstuvwxyz0123456789</private> password=topsecret1'), 'x [private] password=[REDACTED]');
});

test('truncate collapses whitespace and appends an ellipsis', () => {
  assert.equal(truncate('a  b\n\nc', 100), 'a b c');
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.equal(truncate(null, 5), '');
});

// Any string that reaches Claude's context must be well-formed UTF-16: a lone
// surrogate makes the API reject every request of the session.
const wellFormed = (s) => s.isWellFormed();

test('truncate and safeSlice never split a surrogate pair', () => {
  const s = 'Готово 😀 теперь 🐛 ещё';
  for (let max = 1; max <= s.length + 1; max++) {
    assert.ok(wellFormed(truncate(s, max)), `truncate at ${max}: ${JSON.stringify(truncate(s, max))}`);
    assert.ok(wellFormed(safeSlice(s, max)), `safeSlice at ${max}`);
  }
  assert.equal(safeSlice('ab😀', 3), 'ab', 'cut inside the pair drops the half');
  assert.equal(safeSlice('ab😀', 4), 'ab😀');
});

test('dropLoneSurrogates and bmpSafe repair and flatten text', () => {
  assert.equal(dropLoneSurrogates('a\uD83Db\uDE00c'), 'abc');
  assert.equal(dropLoneSurrogates('ok 😀'), 'ok 😀');
  assert.equal(bmpSafe('fix 🐛 in ✨ parser \uD83D'), 'fix • in ✨ parser ');
  assert.ok(wellFormed(sanitize('broken \uD83D input')));
});
