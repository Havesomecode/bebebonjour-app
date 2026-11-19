import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { chaptersFromLegacyComposition, renderAnnouncement, narrationText } from '../../src/delivery-loop/render.mjs';
import { chaptersFromPageJson } from '../../src/delivery-loop/page-fixture-chapters.mjs';
import { screenIndexAt, SLIDESHOW_SCRIPT } from '../../src/delivery-loop/slideshow-script.mjs';
import { reviewedNarrationText } from '../../src/delivery-loop/reviewed-narration.mjs';
const page = JSON.parse(readFileSync(new URL('../../data/examples/bayane/page.json', import.meta.url)));
const chapters = chaptersFromPageJson(page, 'fr');
const opts = { chapters: { fr: chapters }, languages: ['fr'], revision: 1, publicToken: 'fixture', publicUrl: 'https://example.test/announcements/fixture' };
const screens = html => [...html.matchAll(/<section data-screen\b[^>]*>[\s\S]*?<\/section>/g)].map(m => m[0]);
const composition = { schemaVersion: '1.0', languages: Object.fromEntries(['fr','ar'].map(lang => [lang, { description: 'Une joie.', introLines: ['Bonjour.'], introNarration: 'Bonjour.', blessingLines: ['Douceur.'], blessingNarration: 'Douceur.', closingLines: ['Amour.'], closingNarration: 'Amour.' }])) };
test('Bayane has 23 ordered screens, six bars and name reveal at 15', () => {
  assert.deepEqual(chapters.map(c => c.phrases.length), [5,4,5,2,4,3]);
  const html = renderAnnouncement(opts), slides = screens(html);
  assert.equal(slides.length, 23); assert.deepEqual(slides.map(s => Number(s.match(/data-index="(\d+)"/)[1])), Array.from({length:23}, (_,i) => i));
  assert.match(slides[0], /Au nom d’Allah/); assert.match(slides[22], /paix intérieure/);
  assert.equal((html.match(/<i><b><\/b><\/i>/g) || []).length, 6);
  assert.equal(slides.findIndex(s => /Bayane|بَيَان/.test(s)), 15); assert.match(slides[15], /data-name-screen/);
  const outside = html.replace(/<div class="stage"[\s\S]*?<\/div>/, '').replace(/<span class="namechip"[^>]*>[\s\S]*?<\/span>/, '');
  assert.doesNotMatch(outside, /Bayane|بَيَان/);
  assert.match(slides[17], /lang="ar" dir="rtl"/); assert.match(slides[17], /Sourate Ar-Rahman/);
});
test('timings are validated and embedded, with exact boundary indexing', () => {
 const starts = Array.from({length:23}, (_,i) => i*1.5), html = renderAnnouncement({...opts, phraseStarts:{fr:starts}});
 assert.equal((html.match(/data-start="/g)||[]).length,23);
 for (const value of [[0], Array(23).fill(0), [...starts.slice(0,22), Infinity]]) assert.throws(() => renderAnnouncement({...opts,phraseStarts:{fr:value}}), /render_input_rejected/);
 const fake=[0,1.2,2.5,4]; fake.forEach((v,i) => { assert.equal(screenIndexAt(fake,v),i); if(i) assert.equal(screenIndexAt(fake,v-.001),i-1); });
 assert.equal(screenIndexAt(fake,-1),0); assert.ok(!SLIDESHOW_SCRIPT.includes('</script'));
});
test('escapes values and rejects unsafe inputs; private inputs never serialized', () => {
 const bad = [{section:'intro',phrases:[{text:'<script>alert(1)</script> & test', private:'SECRET'}]}, {section:'reveal',phrases:[{text:'x',name:{latin:'<img src=x>'}}]}];
 const html=renderAnnouncement({...opts,chapters:{fr:bad}, private:'SECRET'}); assert.match(html,/&lt;script&gt;/); assert.match(html,/&lt;img/); assert.doesNotMatch(html,/<script>alert|<img src=x|SECRET/);
 for(const extra of [{publicUrl:'javascript:alert(1)'},{publicToken:'../secret'},{revision:0},{languages:['fr','fr']},{chapters:{fr:[{section:'intro',phrases:[{text:' ' }]}]}},{chapters:{fr:[{section:'intro',phrases:[{text:'x'.repeat(601)}]}]}}]) assert.throws(()=>renderAnnouncement({...opts,...extra}),/render_input_rejected/);
 assert.match(html,/src="\/announcements\/fixture\/audio\/1\/fr"/); assert.doesNotMatch(renderAnnouncement({...opts,narrationEnabled:false}),/<audio|data-play=|Une narration créée/);
 assert.doesNotMatch(renderAnnouncement({...opts,pendingReview:false}),/data-draft-marker|data-language-switch/);
});
test('legacy projection and narration remain available', () => {
 const result=chaptersFromLegacyComposition(composition,{firstName:'Amal',nameArabic:'أمل'},'fr'); assert.deepEqual(result.map(c=>c.section),['intro','dua','reveal','closing']);
 assert.equal(narrationText(composition,'fr'),'Bonjour.\n\nDouceur.\n\nAmour.'); assert.equal(reviewedNarrationText(composition.languages.fr),'Bonjour.\n\nDouceur.\n\nAmour.');
});
