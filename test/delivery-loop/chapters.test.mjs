import test from "node:test";
import assert from "node:assert/strict";
import { buildAnnouncementChapters } from "../../src/delivery-loop/chapters.mjs";
import { resolveBriefName } from "../../src/delivery-loop/name-reference.mjs";
import { findNameLeak } from "../../src/delivery-loop/name-leak.mjs";

const brief = { firstName: "Bayane", nameArabic: "بَيَان", gender: "girl", birthDate: null, religion: "islam", tone: "tendre", phrases: [], languages: ["ar", "fr"] };
const language = { description: "Description", introLines: ["Bonjour"], introNarration: "Bonjour", blessingLines: ["Bonheur"], blessingNarration: "Bonheur", meaningLines: ["Douceur"], revealLines: ["Notre fille"], closingLines: ["Bienvenue"], closingNarration: "Bienvenue" };
const composition = { schemaVersion: "2.0", languages: { ar: structuredClone(language), fr: structuredClone(language) } };

test("chapters put catalog verses after the reveal", () => {
  const result = buildAnnouncementChapters({ composition, brief });
  assert.deepEqual(Object.keys(result), ["ar", "fr"]);
  for (const lang of brief.languages) assert.deepEqual(result[lang].map((s) => s.section), ["intro", "dua", "meaning", "reveal", "verses", "closing"]);
  assert.equal(result.fr[3].phrases.at(-1).text, "Bayane");
  assert.equal(result.ar[3].phrases.at(-1).text, "بَيَان");
  const verses = resolveBriefName(brief).suggestions[0].verses;
  assert.deepEqual(result.fr[4].phrases, verses.fr.map(v => ({ text: v.quote, reference: v.reference, arabic: v.sourceArabic, sourceKey: v.sourceKey })));
  assert.deepEqual(result.ar[4].phrases, verses.ar.map(v => ({ text: v.quote, reference: v.reference, sourceKey: v.sourceKey })));
});

test("general and unknown names omit verses", () => {
  for (const b of [{ ...brief, firstName: "Amal", nameArabic: null, religion: "general" }, { ...brief, firstName: "Lilou", nameArabic: null }]) {
    assert.deepEqual(buildAnnouncementChapters({ composition, brief: b }).fr.map((s) => s.section), ["intro", "dua", "meaning", "reveal", "closing"]);
  }
});

test("name leaks are rejected, including aliases and Arabic clitics", () => {
  for (const [lang, field, value] of [["fr", "meaningLines", "Bayane"], ["fr", "meaningLines", "Bayan"], ["ar", "meaningLines", "البيان"], ["fr", "revealLines", "Bayane"]]) {
    const c = structuredClone(composition); c.languages[lang][field] = [value];
    assert.throws(() => buildAnnouncementChapters({ composition: c, brief }));
  }
});

test("Latin word boundaries and Arabic clitics avoid substring false positives", () => {
  const b = { ...brief, firstName: "Amal", nameArabic: null };
  for (const [text, expected] of [["d'Amal", true], ["amalgame", false], ["الأمل", true], ["كامل", false], ["تأمل", false], ["وَبِالْأَمَلِ", true]]) {
    const c = structuredClone(composition); c.languages.fr.meaningLines = [text];
    assert.equal(Boolean(findNameLeak(c, b)), expected, text);
  }
});
