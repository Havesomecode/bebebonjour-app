import assert from "node:assert/strict";
import test from "node:test";
import { renderAnnouncement, narrationText } from "../../src/delivery-loop/render.mjs";
import { reviewedNarrationText } from "../../src/delivery-loop/reviewed-narration.mjs";

export function compositionFixture() {
  return {
    schemaVersion: "2.0",
    languages: {
      fr: {
        description: "Une naissance et beaucoup de douceur.",
        introLines: ["Bienvenue.", "Une nouvelle joie."],
        introNarration: "Bienvenue. Une nouvelle joie.",
        blessingLines: ["Que tes jours soient doux."],
        blessingNarration: "Que tes jours soient doux.",
        meaningLines: ["Douceur."], revealLines: ["Notre enfant."],
        closingLines: ["Nous t’aimons déjà."],
        closingNarration: "Nous t’aimons déjà.",
      },
      ar: {
        description: "فرح هادئ في بيتنا.",
        introLines: ["أهلاً بك بيننا."],
        introNarration: "أهلاً بك بيننا.",
        blessingLines: ["نتمنى لك أياماً جميلة."],
        blessingNarration: "نتمنى لك أياماً جميلة.",
        meaningLines: ["Douceur."], revealLines: ["Notre enfant."],
        closingLines: ["لك كل الحب."],
        closingNarration: "لك كل الحب.",
      },
    },
  };
}

test("renderer publishes readable bilingual prose and revision-bound narration, not private inputs", () => {
  const composition = compositionFixture();
  const html = renderAnnouncement({
    composition, baby: { firstName: "Aélio-Z", gender: "neutral" }, languages: ["fr", "ar"],
    revision: 2, publicToken: "public-synthetic-123", publicUrl: "https://announcements.example.test/announcements/public-synthetic-123",
    intake: { customer: { email: "private@example.test" } }, feedback: "PRIVATE_FEEDBACK",
    reviewToken: "PRIVATE_REVIEW_TOKEN", receipt: { provider: "PRIVATE_RECEIPT" },
  });
  assert.match(html, /lang="fr" dir="ltr"/);
  assert.match(html, /lang="ar" dir="rtl"/);
  assert.match(html, /Bienvenue\./);
  assert.match(html, /أهلاً بك بيننا\./);
  assert.match(html, /https:\/\/announcements\.example\.test\/announcements\/public-synthetic-123\/audio\/2\/fr/);
  assert.match(html, /https:\/\/announcements\.example\.test\/announcements\/public-synthetic-123\/audio\/2\/ar/);
  assert.match(html, /<audio[^>]+controls/);
  assert.match(html, /data-draft-marker/);
  assert.match(html, /AI|artificielle|اصطناعي/);
  assert.doesNotMatch(html, /PRIVATE_|private@example|storageId|customer|compositionReceipt/);
  assert.doesNotMatch(html, /autoplay|opacity:\s*0[;}]|<section[^>]+hidden/);
});

test("renderer escapes markup and rejects unsafe audio origins and capability tokens", () => {
  const composition = compositionFixture();
  composition.languages.fr.introLines = ["<script>alert('x')</script> & amour"];
  const options = { composition, baby: { firstName: "<img src=x onerror=alert(1)>" }, languages: ["fr"], revision: 1, publicToken: "safe-token", publicUrl: "https://example.test/announcements/safe-token" };
  const html = renderAnnouncement(options);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<script>alert|<img src=x/);
  assert.throws(() => renderAnnouncement({ ...options, publicUrl: "javascript:alert(1)" }), /render_input_rejected/);
  assert.throws(() => renderAnnouncement({ ...options, publicToken: "../private?review=secret" }), /render_input_rejected/);
  assert.throws(() => renderAnnouncement({ ...options, revision: 0 }), /render_input_rejected/);
  assert.equal(narrationText(composition, "fr"), [composition.languages.fr.introNarration, composition.languages.fr.blessingNarration, composition.languages.fr.closingNarration].join("\n\n"));
});

test("paid speech projects displayed raw prose while complimentary narration stays unchanged", () => {
  const composition = compositionFixture();
  const content = composition.languages.fr;
  content.introNarration = "Independent complimentary intro.";
  content.blessingNarration = "Independent complimentary blessing.";
  content.closingNarration = "Independent complimentary closing.";
  content.closingLines = ["Amour & douceur <pour toi>.", "Notre joie."];
  assert.equal(reviewedNarrationText(content), "Bienvenue.\nUne nouvelle joie.\n\nQue tes jours soient doux.\n\nAmour & douceur <pour toi>.\nNotre joie.");
  assert.equal(narrationText(composition, "fr"), "Independent complimentary intro.\n\nIndependent complimentary blessing.\n\nIndependent complimentary closing.");
  for (const invalid of [null, {}, { ...content, introLines: [] }, { ...content, closingLines: [" "] }, { ...content, blessingLines: [42] }]) {
    assert.throws(() => reviewedNarrationText(invalid), /approved_content_mismatch/);
  }
});

test("approved render has no draft marker and a single-language page needs no switch", () => {
  const html = renderAnnouncement({ composition: compositionFixture(), baby: { firstName: "Aélio-Z" }, languages: ["ar"], revision: 1, publicToken: "safe-token", publicUrl: "https://example.test/announcements/safe-token", pendingReview: false });
  assert.doesNotMatch(html, /data-draft-marker|data-language-switch/);
  assert.match(html, /<html lang="ar" dir="rtl"/);
});
