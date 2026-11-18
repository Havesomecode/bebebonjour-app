import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = '3dd9fa2683948ea32e7fd7b341a3e5559ae6f06c';
const PROOF = 'ops/cloudflare-successor-boundary.json';
const historicalEvidence = ['ops/installation-compatibility.json', 'ops/promotion-candidate-pins.json', 'ops/support-forward-candidate-pins.json', 'ops/test-a-consolidated-candidate-evidence.json'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function verifyPinnedPaths(files, paths, read) {
  assert.deepEqual([...paths].sort(), Object.keys(files).sort(), 'successor path set');
  for (const [name, expected] of Object.entries(files)) {
    assert.match(expected, /^[a-f0-9]{64}$/u);
    assert.equal(sha(read(name)), expected, name);
  }
}

// Verify the exact successor, without changing or transferring historical approval.
export function verifySuccessorBoundary(rootUrl = new URL('../', import.meta.url)) {
  const root = fileURLToPath(rootUrl);
  const git = (...args) => execFileSync('git', args, { cwd: root });
  const read = name => readFileSync(path.join(root, name));
  const historical = name => git('show', `${BASE}:${name}`);
  const lines = data => data.toString().split(/\r?\n/u).filter(Boolean);
  const proof = JSON.parse(read(PROOF));
  assert.equal(proof.base, BASE);
  const changed = new Set([...lines(git('diff', '--name-only', BASE, '--')), ...lines(git('ls-files', '--others', '--exclude-standard'))]);
  changed.delete(PROOF);
  verifyPinnedPaths(proof.files, [...changed], read);
  for (const name of historicalEvidence) assert.equal(sha(read(name)), sha(historical(name)), `${name} historical evidence changed`);
  const manifest = JSON.parse(historical('ops/installation-compatibility.json'));
  const promotion = JSON.parse(historical('ops/promotion-candidate-pins.json'));
  const support = JSON.parse(historical('ops/support-forward-candidate-pins.json'));
  assert.equal(Object.keys(manifest.recoveredFiles).length, 39);
  assert.equal(Object.keys(manifest.acceptedPaidFiles).length, 22);
  for (const [name, hash] of Object.entries(manifest.recoveredFiles)) assert.equal(sha(historical(name)), hash, name);
  for (const [name, hash] of Object.entries(manifest.acceptedPaidFiles)) assert.equal(sha(historical(name)), support.files[name] || promotion.files[name] || hash, name);
  for (const [name, hash] of Object.entries(promotion.files)) assert.equal(sha(historical(name)), support.files[name] || hash, name);
  for (const [name, hash] of Object.entries(support.files)) assert.equal(sha(historical(name)), hash, name);
  return proof;
}
