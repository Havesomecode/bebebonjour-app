import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestAOperatorIsolationInventory } from '../../src/config/test-a-operator-isolation.mjs';

const root = new URL('../../', import.meta.url);
const base = '3dd9fa2683948ea32e7fd7b341a3e5559ae6f06c';
const proofPath = 'ops/cloudflare-successor-boundary.json';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const sha = data => createHash('sha256').update(data).digest('hex');
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url));
const historical = path => execFileSync('git', ['show', `${base}:${path}`], { cwd: root });

test('historical installation pins remain valid on their support baseline', () => {
  const manifest = JSON.parse(historical('ops/installation-compatibility.json'));
  const promotion = JSON.parse(historical('ops/promotion-candidate-pins.json'));
  const support = JSON.parse(historical('ops/support-forward-candidate-pins.json'));
  assert.equal(Object.keys(manifest.recoveredFiles).length, 39);
  assert.equal(Object.keys(manifest.acceptedPaidFiles).length, 22);
  for (const [path, hash] of Object.entries(manifest.recoveredFiles)) assert.equal(sha(historical(path)), hash, path);
  for (const [path, hash] of Object.entries(manifest.acceptedPaidFiles)) assert.equal(sha(historical(path)), support.files[path] || promotion.files[path] || hash, path);
  for (const [path, hash] of Object.entries(promotion.files)) assert.equal(sha(historical(path)), support.files[path] || hash, path);
  for (const [path, hash] of Object.entries(support.files)) assert.equal(sha(historical(path)), hash, path);
  for (const path of ['ops/installation-compatibility.json', 'ops/promotion-candidate-pins.json', 'ops/support-forward-candidate-pins.json', 'ops/test-a-consolidated-candidate-evidence.json']) {
    assert.equal(sha(read(path)), sha(historical(path)), `${path} historical attestation changed`);
  }
});

test('successor preserves the historical TEST-A isolation inventory', async () => {
  const expected = JSON.parse(historical('ops/test-a-consolidated-candidate-evidence.json')).isolation;
  const actual = await createTestAOperatorIsolationInventory({ rootPath: fileURLToPath(root) });
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, key);
});

test('successor source is restricted to the explicitly pinned changes', () => {
  const proof = JSON.parse(read(proofPath));
  assert.equal(proof.base, base);
  const changed = git('diff', '--name-only', base, '--').trim().split('\n').filter(Boolean);
  const untracked = git('ls-files', '--others', '--exclude-standard').trim().split('\n').filter(Boolean);
  const paths = [...new Set([...changed, ...untracked])].sort();
  assert.deepEqual(paths, [...Object.keys(proof.files), proofPath].sort());
  for (const [path, hash] of Object.entries(proof.files)) assert.equal(sha(read(path)), hash, path);
});
