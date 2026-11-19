import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeArabicName, normalizeLatinName, resolveName } from "../scripts/lib/name-resolution.mjs";
import { buildCodexCompositionRequest } from "../scripts/lib/codex-subscription-composition.mjs";
import { buildAnnouncementChapters } from "../src/delivery-loop/chapters.mjs";
import { findNameLeak } from "../src/delivery-loop/name-leak.mjs";

const read = async (file) => JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
const catalog = await read("../data/reference-catalog.json");
const quran = await read("../data/quran-verses.json");
const entries = Object.entries(catalog.names);
const suggestionsOf = (entry) => [...(entry.general || []), ...Object.values(entry.religious || {}).flat()];
const easternDigits = (n) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[d]);

test("the catalog covers about 150 names", () => {
  assert.ok(entries.length >= 150, `${entries.length} names`);
});

test("every entry cites its sources, and every cited meaning points to one of them", () => {
  for (const [key, entry] of entries) {
    const sources = Object.entries(entry.sources || {});
    assert.ok(sources.length > 0, `${key} has no source`);
    for (const [sourceKey, url] of sources) assert.match(url, /^https:\/\/(www\.behindthename\.com\/name\/|quran\.com\/\d+\/\d+$)/, `${key} ${sourceKey}`);
    assert.ok(catalog.origins[entry.origin], `${key} origin`);
    assert.ok(["girl", "boy"].includes(entry.gender), `${key} gender`);
    for (const suggestion of suggestionsOf(entry)) {
      assert.ok(suggestion.meaning?.fr && suggestion.meaning?.ar, `${key} ${suggestion.id} meaning`);
      for (const sourceKey of suggestion.meaningSourceKeys || []) assert.ok(entry.sources[sourceKey], `${key} cites unknown ${sourceKey}`);
      if (key !== "bayane") assert.ok(suggestion.meaningSourceKeys?.length, `${key} ${suggestion.id} meaning is uncited`);
    }
  }
});

test("every verse is quoted verbatim from Tanzil and Hamidullah with a matching reference", () => {
  let count = 0;
  for (const [key, entry] of entries) {
    for (const suggestion of suggestionsOf(entry)) {
      const { ar = [], fr = [] } = suggestion.verses || {};
      assert.deepEqual(ar.map((v) => v.sourceKey), fr.map((v) => v.sourceKey), `${key} ar/fr verses differ`);
      for (const [index, verse] of ar.entries()) {
        const [, surah, ayah] = verse.sourceKey.match(/^quran-(\d+)-(\d+)$/);
        const source = quran.verses[`${surah}:${ayah}`];
        assert.ok(source, `${key} ${verse.sourceKey} missing from data/quran-verses.json`);
        assert.ok(entry.sources[verse.sourceKey], `${key} ${verse.sourceKey} not in entry sources`);
        assert.ok(source.ar.includes(verse.quote), `${key} ${verse.sourceKey} Arabic quote`);
        assert.equal(verse.reference, `${source.surah.ar}: ${easternDigits(ayah)}`);
        assert.ok(normalizeArabicName(verse.quote).includes(normalizeArabicName(entry.canonical.arabic)), `${key} ${verse.sourceKey} does not contain the name`);
        const translation = fr[index];
        assert.ok(source.fr.includes(translation.quote), `${key} ${verse.sourceKey} French quote`);
        assert.ok(source.ar.includes(translation.sourceArabic), `${key} ${verse.sourceKey} sourceArabic`);
        assert.equal(translation.reference, `Sourate ${source.surah.fr}, ${surah}:${ayah}`);
        count += 1;
      }
    }
  }
  assert.ok(count >= 20, `${count} verses`);
});

test("canonical forms and aliases are unique across the catalog", () => {
  for (const [script, normalize] of [["latin", normalizeLatinName], ["arabic", normalizeArabicName]]) {
    const owner = new Map();
    for (const [key, entry] of entries) {
      for (const form of [entry.canonical[script], ...(entry.aliases[script] || [])].filter(Boolean)) {
        const value = normalize(form);
        assert.ok(!owner.has(value) || owner.get(value) === key, `${form} belongs to ${owner.get(value)} and ${key}`);
        owner.set(value, key);
      }
    }
  }
});

test("each name resolves to itself with a citable meaning that never spells the name", () => {
  const composition = (fr, ar) => ({ languages: { fr: { meaningLines: [fr] }, ar: { meaningLines: [ar] } } });
  for (const [key, entry] of entries) {
    const intake = { baby: { firstName: entry.canonical.latin }, context: { religion: "islam" } };
    const resolution = resolveName(intake, catalog);
    assert.equal(resolution.match.canonicalKey, key, key);
    if (key !== "bayane") assert.equal(resolution.claimPolicy.meaningAllowed, true, key);
    for (const suggestion of suggestionsOf(entry)) {
      const brief = { firstName: entry.canonical.latin, nameArabic: null };
      assert.equal(findNameLeak(composition(suggestion.meaning.fr, suggestion.meaning.ar), brief), null, `${key} meaning spells the name`);
    }
  }
});

const brief = (firstName, religion, nameArabic = null) => ({ firstName, nameArabic, gender: "girl", birthDate: null, religion, tone: "tendre", phrases: [], languages: ["ar", "fr"] });
const lines = { description: "Description", introLines: ["Bonjour"], introNarration: "Bonjour", blessingLines: ["Bonheur"], blessingNarration: "Bonheur", meaningLines: ["Douceur"], revealLines: ["Notre enfant"], closingLines: ["Bienvenue"], closingNarration: "Bienvenue" };
const composition = { schemaVersion: "2.0", languages: { ar: structuredClone(lines), fr: structuredClone(lines) } };

test("spot check: a French name carries its meaning into the R1 request", () => {
  const request = buildCodexCompositionRequest(brief("Louise", "general"));
  assert.deepEqual(request.nameReference, { meaning: { fr: "illustre au combat", ar: "الشهيرة في المعركة" } });
  const chapters = buildAnnouncementChapters({ composition, brief: brief("Louise", "general") });
  assert.deepEqual(chapters.fr.map((c) => c.section), ["intro", "dua", "meaning", "reveal", "closing"]);
  assert.equal(chapters.ar[3].phrases.at(-1).text, "Louise");
});

test("spot check: an Arabic name with its Arabic spelling gets the verse that names it", () => {
  const b = { ...brief("Youssef", "islam", "يُوسُف"), gender: "boy" };
  assert.deepEqual(buildCodexCompositionRequest(b).nameReference.meaning, { fr: "il ajoutera", ar: "سيزيد" });
  const chapters = buildAnnouncementChapters({ composition, brief: b });
  assert.deepEqual(chapters.fr.map((c) => c.section), ["intro", "dua", "meaning", "reveal", "verses", "closing"]);
  assert.equal(chapters.ar[3].phrases.at(-1).text, "يُوسُف");
  assert.equal(chapters.ar[4].phrases[0].reference, "يوسف: ٤");
  assert.match(chapters.ar[4].phrases[0].text, /يُوسُفُ/);
  assert.equal(chapters.fr[4].phrases[0].reference, "Sourate Yusuf, 12:4");
  assert.match(chapters.fr[4].phrases[0].text, /^Quand Joseph dit à son père/);
});

test("spot check: a spelling variant resolves through its alias and keeps the parents' spelling", () => {
  const resolution = resolveName({ baby: { firstName: "Ilyès" }, context: { religion: "islam" } }, catalog);
  assert.equal(resolution.match.kind, "alias");
  assert.equal(resolution.match.canonicalKey, "ilyas");
  const b = { ...brief("Ilyès", "islam"), gender: "boy" };
  const chapters = buildAnnouncementChapters({ composition, brief: b });
  assert.equal(chapters.fr[3].phrases.at(-1).text, "Ilyès");
  assert.equal(chapters.ar[3].phrases.at(-1).text, "إلياس");
  assert.equal(chapters.fr[4].phrases[0].reference, "Sourate As-Saffat, 37:123");
  const leaking = structuredClone(composition);
  leaking.languages.fr.introLines = ["Bienvenue Ilyas"];
  assert.throws(() => buildAnnouncementChapters({ composition: leaking, brief: b }));
});
