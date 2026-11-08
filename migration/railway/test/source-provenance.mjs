import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../current-loop/', import.meta.url);
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: repository, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('current-loop source has signed immutable provenance, byte-exact gates and only the bounded receipt successor', async () => {
  const manifest = JSON.parse(await readFile(new URL('source-manifest.json', root), 'utf8'));
  assert.equal(manifest.commit, '5f9e63928b7489f92b4d5e5e8f2807e4c1edbc7d');
  git('verify-commit', manifest.commit);
  assert.equal(git('rev-parse', `${manifest.commit}^{tree}`).toString().trim(), manifest.tree);
  assert.equal(manifest.files.length, 6);
  for (const file of manifest.files) {
    const source = git('show', `${manifest.commit}:${file.path}`);
    assert.equal(git('rev-parse', `${manifest.commit}:${file.path}`).toString().trim(), file.blob);
    assert.equal(sha(source), file.sha256);
    const candidate = await readFile(new URL(file.derived || file.path, root));
    assert.equal(sha(candidate), file.candidate_sha256 || file.sha256);
    if (file.derived) {
      const text = source.toString();
      const derived = `// Extracted verbatim from ${manifest.commit}:${file.path}; see source-manifest.json.\nexport `
        + text.slice(text.indexOf('function emailPayload('), text.indexOf('async function provider('))
        + text.slice(text.indexOf('function escapeHtml('), text.indexOf('function safeReason('));
      assert.equal(candidate.toString(), derived);
    } else if (file.allowed_delta) {
      assert.equal(file.path, 'convex/deliveryLoop.js');
      const split = text => [text.slice(0, text.indexOf('export const completeEmail =')), text.slice(text.indexOf('export const fail ='))];
      assert.deepEqual(split(candidate.toString()), split(source.toString()), 'no other control may drift');
      assert.notEqual(candidate.toString(), source.toString());
    } else assert.deepEqual(candidate, source);
  }
  console.log(`CURRENT_LOOP_PROVENANCE=${JSON.stringify(manifest)}`);
});
