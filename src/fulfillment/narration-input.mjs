import { TextEncoder } from "node:util";

import { SECTION_IDS, SUPPORTED_LANGUAGES, sectionNarrationText } from "../../scripts/lib/common.mjs";
import { assertValidPage } from "../../scripts/lib/validators.mjs";

export const CANONICAL_NARRATION_INPUT_SCHEMA_VERSION = "1.0";
export const CANONICAL_NARRATION_INPUT_PATH = "deploy/narration-input.json";
export const CANONICAL_NARRATION_PROVIDER = "openai";
export const CANONICAL_NARRATION_MODEL = "gpt-4o-mini-tts";
export const MAX_NARRATION_SEGMENTS = SUPPORTED_LANGUAGES.length * SECTION_IDS.length;
export const MAX_NARRATION_SEGMENT_TEXT_BYTES = 8 * 1024;
export const MAX_NARRATION_TOTAL_TEXT_BYTES = 48 * 1024;

const APPROVED_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "cedar",
]);
const DIGEST = /^[a-f0-9]{64}$/u;
const REVISION_ID = /^r[1-9][0-9]*$/u;
const NONEMPTY_TEXT = /\S/u;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

export function buildCanonicalNarrationInput(page) {
  assertValidPage(page);
  const input = {
    schemaVersion: CANONICAL_NARRATION_INPUT_SCHEMA_VERSION,
    pageId: page.pageId,
    revisionId: page.pageRevision,
    provider: CANONICAL_NARRATION_PROVIDER,
    model: page.audioPlan?.model,
    languages: [...page.languages],
    sectionOrder: [...page.sectionOrder],
    segments: page.languages.flatMap((language) => page.sectionOrder.map((section, index) => ({
      language,
      section,
      ordinal: index + 1,
      voice: page.audioPlan?.voiceByLanguage?.[language],
      instructions: page.audioPlan?.instructionsByLanguage?.[language],
      text: sectionNarrationText(page.sections?.[section], language),
    }))),
  };
  assertValidCanonicalNarrationInput(input);
  return input;
}

export function assertValidCanonicalNarrationInput(input, expected = null) {
  assertExactObject(
    input,
    ["schemaVersion", "pageId", "revisionId", "provider", "model", "languages", "sectionOrder", "segments"],
    "canonical narration input",
  );
  if (input.schemaVersion !== CANONICAL_NARRATION_INPUT_SCHEMA_VERSION) {
    throw new Error("Canonical narration input schema version is invalid.");
  }
  if (!nonEmptyString(input.pageId) || !REVISION_ID.test(input.revisionId || "")) {
    throw new Error("Canonical narration input page identity is invalid.");
  }
  if (input.provider !== CANONICAL_NARRATION_PROVIDER || input.model !== CANONICAL_NARRATION_MODEL) {
    throw new Error("Canonical narration input provider or model is not approved.");
  }
  if (!validOrderedSubset(input.languages, SUPPORTED_LANGUAGES) || !validExactOrder(input.sectionOrder, SECTION_IDS)) {
    throw new Error("Canonical narration input language or section ordering is invalid.");
  }
  if (!Array.isArray(input.segments) || input.segments.length < 1 || input.segments.length > MAX_NARRATION_SEGMENTS) {
    throw new Error("Canonical narration input segment count is invalid.");
  }

  const expectedLanguages = expected?.languages || input.languages;
  const expectedSections = expected?.sectionOrder || input.sectionOrder;
  const expectedVoices = expected?.voiceByLanguage || null;
  const seenLanguages = new Set();
  const seenPairs = new Set();
  let totalBytes = 0;
  let previous = null;

  for (const segment of input.segments) {
    assertExactObject(
      segment,
      ["language", "section", "ordinal", "voice", "instructions", "text"],
      "canonical narration segment",
    );
    if (!SUPPORTED_LANGUAGES.includes(segment.language) || !SECTION_IDS.includes(segment.section)) {
      throw new Error("Canonical narration segment language or section is invalid.");
    }
    if (!Number.isSafeInteger(segment.ordinal) || segment.ordinal < 1 || segment.ordinal > SECTION_IDS.length) {
      throw new Error("Canonical narration segment ordinal is invalid.");
    }
    if (!APPROVED_VOICES.has(segment.voice)) {
      throw new Error("Canonical narration segment voice is not approved.");
    }
    if (!nonEmptyString(segment.instructions) || hasUnsafeControl(segment.instructions)) {
      throw new Error("Canonical narration segment instructions are invalid.");
    }
    if (!nonEmptyString(segment.text) || hasUnsafeControl(segment.text)) {
      throw new Error("Canonical narration segment text is invalid.");
    }
    const textBytes = byteLength(segment.text);
    if (textBytes > MAX_NARRATION_SEGMENT_TEXT_BYTES) {
      throw new Error("Canonical narration segment text exceeds its byte limit.");
    }
    totalBytes += textBytes;
    if (totalBytes > MAX_NARRATION_TOTAL_TEXT_BYTES) {
      throw new Error("Canonical narration input text exceeds its total byte limit.");
    }
    const pair = `${segment.language}\u0000${segment.section}`;
    if (seenPairs.has(pair)) throw new Error("Canonical narration input contains duplicate language-section segments.");
    seenPairs.add(pair);
    seenLanguages.add(segment.language);

    if (!expectedLanguages.includes(segment.language)) {
      throw new Error("Canonical narration input enables a language not approved by the page.");
    }
    const ordinal = expectedSections.indexOf(segment.section) + 1;
    if (ordinal === 0 || segment.ordinal !== ordinal) {
      throw new Error("Canonical narration input segment ordering does not match the approved page.");
    }
    if (expectedVoices && segment.voice !== expectedVoices[segment.language]) {
      throw new Error("Canonical narration input voice does not match the approved page.");
    }
    if (previous && compareSegments(previous, segment) >= 0) {
      throw new Error("Canonical narration input segments are not in deterministic order.");
    }
    previous = segment;
  }

  const exactLanguages = expectedLanguages.length === seenLanguages.size
    && expectedLanguages.every((language) => seenLanguages.has(language));
  if (!exactLanguages) throw new Error("Canonical narration input languages do not match the approved page.");
  if (input.segments.length !== expectedLanguages.length * expectedSections.length) {
    throw new Error("Canonical narration input does not contain every approved language-section segment.");
  }
  return structuredClone(input);
}

export function assertBoundCanonicalNarrationInput(input, expected) {
  const normalized = assertValidCanonicalNarrationInput(input, expected);
  if (
    normalized.pageId !== expected.pageId
    || normalized.revisionId !== expected.revisionId
    || normalized.provider !== expected.provider
    || normalized.model !== expected.model
  ) {
    throw new Error("Canonical narration input does not bind the approved page identity or TTS policy.");
  }
  for (const segment of normalized.segments) {
    const expectedText = sectionNarrationText(expected.sections?.[segment.section], segment.language);
    const expectedInstructions = expected.instructionsByLanguage?.[segment.language];
    if (segment.text !== expectedText || segment.instructions !== expectedInstructions) {
      throw new Error("Canonical narration input text or instructions do not match the approved page.");
    }
  }
  return normalized;
}

export function isDigest(value) {
  return typeof value === "string" && DIGEST.test(value);
}

function assertExactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unexpected fields.`);
  }
}

function compareSegments(left, right) {
  const language = SUPPORTED_LANGUAGES.indexOf(left.language) - SUPPORTED_LANGUAGES.indexOf(right.language);
  if (language !== 0) return language;
  return left.ordinal - right.ordinal;
}

function validOrderedSubset(values, allowed) {
  return Array.isArray(values)
    && values.length >= 1
    && values.length <= allowed.length
    && new Set(values).size === values.length
    && values.every((value, index) => allowed.indexOf(value) === index);
}

function validExactOrder(values, expected) {
  return Array.isArray(values)
    && values.length === expected.length
    && values.every((value, index) => value === expected[index]);
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function nonEmptyString(value) {
  return typeof value === "string" && NONEMPTY_TEXT.test(value);
}

function hasUnsafeControl(value) {
  return UNSAFE_CONTROL.test(value);
}
