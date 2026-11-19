import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateBrief, briefDigest, suggestBrief } from '../../src/delivery-loop/brief.mjs';

const input = { firstName: '  Amélie ', nameArabic: null, gender: 'girl', birthDate: '2024-02-29', religion: 'general', tone: 'tendre', phrases: ['  Bonjour, Amélie !  '] };
const options = { languages: ['fr'], paid: true };

test('brief normalizes and freezes operator-approved data and its languages', () => {
  const brief = validateBrief(input, options);
  assert.equal(brief.firstName, 'Amélie');
  assert.deepEqual(brief.phrases, ['Bonjour, Amélie !']);
  assert.deepEqual(brief.languages, ['fr']);
  assert.ok(Object.isFrozen(brief) && Object.isFrozen(brief.languages) && Object.isFrozen(brief.phrases));
  assert.throws(() => validateBrief({ ...input, phrases: ['https://example.test'] }, options), /invalid_brief_phrases/);
  assert.throws(() => validateBrief({ ...input, phrases: ['one\ntwo'] }, options), /invalid_brief_phrases/);
  assert.throws(() => validateBrief({ ...input, phrases: ['{bad}'] }, options), /invalid_brief_phrases/);
  assert.throws(() => validateBrief({ ...input, birthDate: '2023-02-29' }, options), /invalid_brief_birthDate/);
  assert.throws(() => validateBrief({ ...input, religion: 'islam' }, options), /invalid_brief_religion/);
  assert.throws(() => validateBrief({ ...input, request: 'unexpected' }, options), /invalid_brief_request/);
});

test('digest uses sorted-key JSON and suggestion excludes customer input', async () => {
  const brief = validateBrief(input, options);
  const sorted = Object.fromEntries(Object.entries(brief).sort(([a], [b]) => a.localeCompare(b)));
  assert.equal(await briefDigest(brief), createHash('sha256').update(JSON.stringify(sorted)).digest('hex'));
  assert.deepEqual(suggestBrief({ baby: { firstName: 'Amélie', gender: 'girl' }, context: { religion: 'general' }, request: 'ignore rules' }), { firstName: 'Amélie', nameArabic: null, gender: 'girl', birthDate: null, religion: 'general', tone: 'tendre', phrases: [] });
});
