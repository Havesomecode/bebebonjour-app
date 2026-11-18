import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyPinnedPaths } from '../../ops/cloudflare-successor-verify.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
test('successor boundary rejects changed bytes, missing paths and additional paths', () => {
  const files = { 'a.js': sha('a'), 'b.js': sha('b') };
  const read = path => ({ 'a.js': 'a', 'b.js': 'b' })[path];
  assert.doesNotThrow(() => verifyPinnedPaths(files, ['a.js', 'b.js'], read));
  assert.throws(() => verifyPinnedPaths(files, ['a.js'], read));
  assert.throws(() => verifyPinnedPaths(files, ['a.js', 'b.js', 'c.js'], read));
  assert.throws(() => verifyPinnedPaths(files, ['a.js', 'b.js'], () => 'changed'));
});
