import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { commandCompose } from "../scripts/lib/commands.mjs";
import { resolveName } from "../scripts/lib/name-resolution.mjs";

const catalog = JSON.parse(
  await readFile(new URL("../data/reference-catalog.json", import.meta.url), "utf8"),
);
const evidenceSchema = JSON.parse(
  await readFile(new URL("../schemas/name-resolution-evidence.schema.json", import.meta.url), "utf8"),
);
const baseIntake = JSON.parse(
  await readFile(new URL("../data/examples/bayane/intake.json", import.meta.url), "utf8"),
);

function intakeFor(firstName, nameArabic = undefined) {
  const intake = structuredClone(baseIntake);
  intake.baby.firstName = firstName;
  if (nameArabic === undefined) delete intake.baby.nameArabic;
  else intake.baby.nameArabic = nameArabic;
  return intake;
}

async function captureConsole(action) {
  const original = console.log;
  const lines = [];
  console.log = (...values) => lines.push(values.join(" "));
  try {
    await action();
  } finally {
    console.log = original;
  }
  return lines;
}

test("name resolution preserves display spelling for an exact canonical match", () => {
  const resolution = resolveName(intakeFor("Bayane", "بَيَان"), catalog);

  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.match.kind, "exact");
  assert.equal(resolution.match.canonicalKey, "bayane");
  assert.equal(resolution.display.latin, "Bayane");
  assert.equal(resolution.display.arabic, "بَيَان");
  assert.equal(resolution.claimPolicy.meaningAllowed, false);
  assert.equal(resolution.claimPolicy.scripturalNameAssociationAllowed, true);
});

test("catalog meanings without dedicated source keys remain claim-disabled", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-uncited-meaning-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const pagePath = path.join(directory, "page.json");
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");

  await captureConsole(() => commandCompose({
    input: intakePath,
    output: pagePath,
    select: "religious-bayane",
  }));
  const page = JSON.parse(await readFile(pagePath, "utf8"));
  const serialized = JSON.stringify(page);

  assert.equal(page.provenance.nameResolution.claimPolicy.meaningAllowed, false);
  assert.doesNotMatch(serialized, /beauté de son sens|clarté, l'expression limpide|الوضوح والبيان/);
  assert.match(page.sections.meaning.fr.displayLines.join(" "), /choisi Bayane avec amour/);
});

test("diacritic-bearing orthographies resolve only through explicit aliases", () => {
  const resolution = resolveName(intakeFor("Bayâne", "بَيَان"), catalog);
  const withoutAlias = structuredClone(catalog);
  withoutAlias.names.bayane.aliases.latin = withoutAlias.names.bayane.aliases.latin.filter(
    (alias) => alias !== "Bayâne",
  );
  const unresolved = resolveName(intakeFor("Bayâne"), withoutAlias);

  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.match.kind, "alias");
  assert.equal(resolution.display.latin, "Bayâne");
  assert.deepEqual(resolution.reviewReasons, ["name_alias_match"]);
  assert.equal(unresolved.status, "fallback");
  assert.equal(unresolved.match.kind, "unknown");
});

test("name resolution uses only explicit aliases for alternate orthographies", () => {
  const resolution = resolveName(intakeFor("Bayan", "بيان"), catalog);

  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.match.kind, "alias");
  assert.equal(resolution.match.canonicalKey, "bayane");
  assert.deepEqual(resolution.reviewReasons, ["name_alias_match"]);
});

test("name resolution requires review when Latin and Arabic forms point to different names", () => {
  const conflictingCatalog = structuredClone(catalog);
  conflictingCatalog.names.amal.aliases = { latin: [], arabic: ["أمل"] };

  const resolution = resolveName(intakeFor("Bayane", "أمل"), conflictingCatalog);

  assert.equal(resolution.status, "review_required");
  assert.equal(resolution.match.kind, "cross_script_conflict");
  assert.equal(resolution.claimPolicy.meaningAllowed, false);
  assert.equal(resolution.claimPolicy.scripturalNameAssociationAllowed, false);
  assert.deepEqual(resolution.reviewReasons, ["name_cross_script_conflict"]);
});

test("name resolution never silently chooses an ambiguous alias", () => {
  const ambiguousCatalog = structuredClone(catalog);
  ambiguousCatalog.names.bayane.aliases = { latin: ["Bayan"], arabic: [] };
  ambiguousCatalog.names.amal.aliases = { latin: ["Bayan"], arabic: [] };

  const resolution = resolveName(intakeFor("Bayan"), ambiguousCatalog);

  assert.equal(resolution.status, "review_required");
  assert.equal(resolution.match.kind, "ambiguous");
  assert.deepEqual(resolution.match.candidates.sort(), ["amal", "bayane"]);
  assert.equal(resolution.claimPolicy.meaningAllowed, false);
});

test("an unambiguous second script cannot narrow an ambiguous supplied script", () => {
  const ambiguousCatalog = structuredClone(catalog);
  ambiguousCatalog.names.amal.aliases.latin = [
    ...(ambiguousCatalog.names.amal.aliases.latin || []),
    "Bayan",
  ];

  const resolution = resolveName(intakeFor("Bayan", "بيان"), ambiguousCatalog);

  assert.equal(resolution.status, "review_required");
  assert.equal(resolution.match.kind, "ambiguous");
  assert.deepEqual(resolution.match.candidates.sort(), ["amal", "bayane"]);
  assert.deepEqual(resolution.reviewReasons, ["name_match_ambiguous"]);
  assert.equal(resolution.claimPolicy.scripturalNameAssociationAllowed, false);
});

test("supplied Arabic forms that normalize to empty cannot enable name claims", () => {
  for (const nameArabic of ["َ", "ـ", "...", "🧡"]) {
    const resolution = resolveName(intakeFor("Bayane", nameArabic), catalog);

    assert.equal(resolution.status, "review_required");
    assert.equal(resolution.match.kind, "invalid_orthography");
    assert.deepEqual(resolution.reviewReasons, ["name_arabic_normalizes_empty"]);
    assert.equal(resolution.claimPolicy.meaningAllowed, false);
    assert.equal(resolution.claimPolicy.scripturalNameAssociationAllowed, false);
  }
});

test("the evidence schema permits the invalid orthography resolver outcome", () => {
  const resolution = resolveName(intakeFor("Bayane", "ـ"), catalog);
  const allowedKinds = evidenceSchema.properties.match.properties.kind.enum;

  assert.equal(resolution.match.kind, "invalid_orthography");
  assert.equal(allowedKinds.includes(resolution.match.kind), true);
});

test("unknown religious names compose a neutral review draft without invented claims", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-name-fallback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const pagePath = path.join(directory, "page.json");
  const intake = intakeFor("Aélio-Z", "أيليو");
  await writeFile(intakePath, `${JSON.stringify(intake, null, 2)}\n`, "utf8");

  await captureConsole(() => commandCompose({ input: intakePath, output: pagePath }));
  const page = JSON.parse(await readFile(pagePath, "utf8"));
  const serialized = JSON.stringify(page);

  assert.equal(page.identity.nameLatin, "Aélio-Z");
  assert.equal(page.identity.nameArabic, "أيليو");
  assert.equal(page.sections.reveal.fr.name, "Aélio-Z");
  assert.equal(page.provenance.nameResolution.status, "fallback");
  assert.equal(page.provenance.nameResolution.match.kind, "unknown");
  assert.equal(page.provenance.nameResolution.claimPolicy.meaningAllowed, false);
  assert.equal(page.provenance.nameResolution.claimPolicy.scripturalNameAssociationAllowed, false);
  assert.deepEqual(page.review.requiredReasons, ["name_not_in_catalog"]);
  assert.doesNotMatch(serialized, /une belle signification/i);
  assert.doesNotMatch(serialized, /قال تعالى/);
  assert.doesNotMatch(serialized, /Aélio-Z[^.]{0,80}(signifie|meaning|معنى)/i);
});

test("compose cannot render scripture items after their source evidence is removed", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-unsourced-scripture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const pagePath = path.join(directory, "page.json");
  const unsafeCatalog = structuredClone(catalog);
  const suggestion = unsafeCatalog.names.bayane.religious.islam[0];
  suggestion.verses = {
    ar: [{ quote: "نص بلا مصدر", reference: "مرجع غير موثق" }],
    fr: [{ quote: "Texte sans source", reference: "Référence non vérifiée" }],
  };
  suggestion.arVersesNarration = "UNSOURCED_NARRATION_AR";
  suggestion.frVersesNarration = "UNSOURCED_NARRATION_FR";
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");

  await captureConsole(() => commandCompose(
    { input: intakePath, output: pagePath, select: "religious-bayane" },
    { catalogSnapshot: unsafeCatalog },
  ));
  const page = JSON.parse(await readFile(pagePath, "utf8"));
  const serialized = JSON.stringify(page);

  assert.equal(page.provenance.nameResolution.claimPolicy.scripturalNameAssociationAllowed, false);
  assert.deepEqual(page.provenance.nameResolution.sourceKeys, []);
  assert.equal(page.sections.verses.ar.introLine, "دعاء وأمنيات:");
  assert.equal(page.sections.verses.fr.introLine, "Vœux et bénédictions :");
  assert.doesNotMatch(
    serialized,
    /نص بلا مصدر|Texte sans source|UNSOURCED_NARRATION_(?:AR|FR)|قال تعالى|Références proposées/,
  );
});
