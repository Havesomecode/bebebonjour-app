import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalAnnouncementPath,
  shouldLoadNarrationResources,
  visiblePhraseTargetCount,
} from "../template/runtime/phrase-progress.mjs";

test("manual narration-off mode reveals the first phrase at zero scroll", () => {
  assert.equal(visiblePhraseTargetCount({
    rectTop: 0,
    rectBottom: 658,
    scrollY: 0,
    viewportHeight: 577,
    sectionStart: 0,
    sectionHeight: 658,
    itemCount: 2,
  }), 1);
});

test("manual mode keeps later off-screen phrases hidden and completes passed sections", () => {
  assert.equal(visiblePhraseTargetCount({
    rectTop: 658,
    rectBottom: 1316,
    scrollY: 0,
    viewportHeight: 577,
    sectionStart: 658,
    sectionHeight: 658,
    itemCount: 2,
  }), 0);
  assert.equal(visiblePhraseTargetCount({
    rectTop: -658,
    rectBottom: 0,
    scrollY: 658,
    viewportHeight: 577,
    sectionStart: 0,
    sectionHeight: 658,
    itemCount: 2,
  }), 2);
});

test("narration-off startup does not probe narration media", () => {
  assert.equal(shouldLoadNarrationResources({
    privateReview: false,
    narrationRequested: false,
  }), false);
  assert.equal(shouldLoadNarrationResources({
    privateReview: false,
    narrationRequested: true,
  }), true);
  assert.equal(shouldLoadNarrationResources({
    privateReview: true,
    narrationRequested: true,
  }), false);
});

test("canonical language routes keep a trailing slash for relative narration assets", () => {
  assert.equal(canonicalAnnouncementPath("/bayane/fr/", "fr"), "/bayane/fr/");
  assert.equal(canonicalAnnouncementPath("/bayane/fr", "ar"), "/bayane/ar/");
  assert.equal(canonicalAnnouncementPath("/nested/bayane/ar/", "fr"), "/nested/bayane/fr/");
});
