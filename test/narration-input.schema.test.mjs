import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertValidCanonicalNarrationInput,
  buildCanonicalNarrationInput,
} from "../src/fulfillment/narration-input.mjs";

const fixturePage = JSON.parse(
  await readFile(new URL("../data/examples/bayane/page.json", import.meta.url), "utf8"),
);

function pageFixture() {
  return structuredClone(fixturePage);
}

test("canonical narration input is deterministic and binds every approved segment", () => {
  const input = buildCanonicalNarrationInput(pageFixture());

  assert.deepEqual(Object.keys(input), [
    "schemaVersion", "pageId", "revisionId", "provider", "model", "languages", "sectionOrder", "segments",
  ]);
  assert.equal(input.schemaVersion, "1.0");
  assert.equal(input.provider, "openai");
  assert.equal(input.model, "gpt-4o-mini-tts");
  assert.deepEqual(input.languages, fixturePage.languages);
  assert.deepEqual(input.sectionOrder, fixturePage.sectionOrder);
  assert.equal(input.segments.length, fixturePage.languages.length * fixturePage.sectionOrder.length);
  assert.deepEqual(
    input.segments.map(({ language, section, ordinal }) => [language, section, ordinal]),
    [
      ...fixturePage.sectionOrder.map((section, index) => ["ar", section, index + 1]),
      ...fixturePage.sectionOrder.map((section, index) => ["fr", section, index + 1]),
    ],
  );
  assert.deepEqual(buildCanonicalNarrationInput(pageFixture()), input);
  assert.doesNotThrow(() => assertValidCanonicalNarrationInput(input));
});

test("canonical narration input rejects caller-shaped or unsafe segments", () => {
  const input = buildCanonicalNarrationInput(pageFixture());

  assert.throws(
    () => assertValidCanonicalNarrationInput({ ...input, sourcePath: "private-preview/page.json" }),
    /unexpected fields/i,
  );
  assert.throws(
    () => assertValidCanonicalNarrationInput({
      ...input,
      segments: [...input.segments, structuredClone(input.segments[0])],
    }),
    /duplicate|ordering|count/i,
  );
  assert.throws(
    () => assertValidCanonicalNarrationInput({
      ...input,
      segments: input.segments.map((segment, index) => index === 0
        ? { ...segment, voice: "unapproved-voice" }
        : segment),
    }),
    /voice/i,
  );
  assert.throws(
    () => assertValidCanonicalNarrationInput({
      ...input,
      segments: input.segments.map((segment, index) => index === 0
        ? { ...segment, text: "unsafe\u0000text" }
        : segment),
    }),
    /control|text/i,
  );
});

test("canonical narration builder rejects unsupported approved-page TTS values", () => {
  const page = pageFixture();
  page.audioPlan.voiceByLanguage.fr = "unapproved-voice";

  assert.throws(() => buildCanonicalNarrationInput(page), /voice/i);
});
