import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { renderAnnouncement } from '../../src/delivery-loop/render.mjs';
import { buildAnnouncementChapters } from '../../src/delivery-loop/chapters.mjs';
import { chaptersFromPageJson } from '../../src/delivery-loop/page-fixture-chapters.mjs';
import { SCREEN_INDEX_AT_SOURCE, SLIDESHOW_SCRIPT } from '../../src/delivery-loop/slideshow-script.mjs';
import { buildSync } from 'esbuild';
const screenIndexAt = new Function(`return ${SCREEN_INDEX_AT_SOURCE}`)();
import { chapterNarrationText } from '../../src/delivery-loop/narration-timing.mjs';
const page = JSON.parse(readFileSync(new URL('../../data/examples/bayane/page.json', import.meta.url)));
const chapters = chaptersFromPageJson(page, 'fr');
const opts = { chapters: { fr: chapters }, languages: ['fr'], revision: 1, publicToken: 'fixture', publicUrl: 'https://example.test/announcements/fixture' };
const screens = html => [...html.matchAll(/<section data-screen\b[^>]*>[\s\S]*?<\/section>/g)].map(m => m[0]);
const composition = { schemaVersion: '2.0', languages: Object.fromEntries(['fr','ar'].map(lang => [lang, { description: 'Une joie.', introLines: ['Bonjour.'], introNarration: 'Bonjour.', blessingLines: ['Douceur.'], blessingNarration: 'Douceur.', meaningLines: ['Un espoir.'], revealLines: ['Nous avons accueilli notre fille…'], closingLines: ['Amour.'], closingNarration: 'Amour.' }])) };
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
 assert.ok(SLIDESHOW_SCRIPT.includes(SCREEN_INDEX_AT_SOURCE));
});
// The server minifies its bundle and hashes SLIDESHOW_SCRIPT for the page CSP; the worker renders the unbundled
// string. Both must be byte-identical or the browser blocks the slideshow.
test('slideshow script survives a minified bundle byte for byte', async () => {
  const { outputFiles: [out] } = buildSync({ entryPoints: [new URL('../../src/delivery-loop/slideshow-script.mjs', import.meta.url).pathname], bundle: true, format: 'esm', minify: true, write: false });
  const bundled = await import('data:text/javascript;base64,' + Buffer.from(out.text).toString('base64'));
  assert.equal(bundled.SLIDESHOW_SCRIPT, SLIDESHOW_SCRIPT);
});
test('escapes values and rejects unsafe inputs; private inputs never serialized', () => {
 const bad = [{section:'intro',phrases:[{text:'<script>alert(1)</script> & test', private:'SECRET'}]}, {section:'reveal',phrases:[{text:'x',name:{latin:'<img src=x>'}}]}];
 const html=renderAnnouncement({...opts,chapters:{fr:bad}, private:'SECRET'}); assert.match(html,/&lt;script&gt;/); assert.match(html,/&lt;img/); assert.doesNotMatch(html,/<script>alert|<img src=x|SECRET/);
 for(const extra of [{publicUrl:'javascript:alert(1)'},{publicToken:'../secret'},{revision:0},{languages:['fr','fr']},{chapters:{fr:[{section:'intro',phrases:[{text:' ' }]}]}},{chapters:{fr:[{section:'intro',phrases:[{text:'x'.repeat(601)}]}]}}]) assert.throws(()=>renderAnnouncement({...opts,...extra}),/render_input_rejected/);
 assert.match(html,/src="\/announcements\/fixture\/audio\/1\/fr"/); assert.doesNotMatch(renderAnnouncement({...opts,narrationEnabled:false}),/<audio|data-play=|Une narration créée/);
 assert.doesNotMatch(renderAnnouncement({...opts,pendingReview:false}),/data-draft-marker|data-language-switch/);
});
test('worker chapters from a schema 2.0 composition render with the name last', () => {
 const brief={firstName:'Amal',nameArabic:'أمل',gender:'girl',birthDate:null,religion:'general',tone:'tendre',phrases:[],languages:['fr','ar']};
 const built=buildAnnouncementChapters({composition,brief}); assert.deepEqual(built.fr.map(c=>c.section),['intro','dua','meaning','reveal','closing']);
 const slides=screens(renderAnnouncement({...opts,chapters:built,languages:['fr','ar']})); const fr=slides.filter(s=>/data-name-screen/.test(s)); assert.equal(fr.length,2);
 assert.equal(slides.findIndex(s=>/Amal|أمل/.test(s)), slides.findIndex(s=>/data-name-screen/.test(s)));
 // Speech reads exactly the screens: one spoken phrase per screen, the name included.
 assert.deepEqual(chapterNarrationText(built.fr).split(/\n+/), built.fr.flatMap(c=>c.phrases.map(p=>p.text)));
 assert.equal(built.fr.flatMap(c=>c.phrases).length + built.ar.flatMap(c=>c.phrases).length, slides.length);
});
