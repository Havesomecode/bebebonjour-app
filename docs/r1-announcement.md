# R1 "Chapitres" announcement (owner decision, 19/11/2026)

Mockup with the real Bayane example: [design/r1-chapitres.html](design/r1-chapitres.html) (open in a browser).

## The idea

The announcement is a slideshow, one narrated phrase per screen, switched at the moment that phrase starts in the audio. The family discovers the first name near the end:

1. `intro` — the good news
2. `dua` — wishes or invocations (faith-compatible when religion is islam)
3. `meaning` — what the name means, **without ever saying the name**
4. `reveal` — "Nous avons accueilli notre fille…" then the name (Latin + Arabic)
5. `verses` — verified religious references where the word appears (they contain the name, so they come after the reveal)
6. `closing` — blessing

Chapters are variable: one progress bar per section actually present. No verified reference → no `verses` chapter. Order follows the original prototype `sectionOrder` (`template/runtime`, `data/examples/*/page.json`).

## Rules

- `meaning` text must not contain the first name, its Arabic form or catalogue aliases. Reject the composition otherwise.
- Verses only from `data/reference-catalog.json` (verified quote, translation, reference). Never generated.
- After the reveal the page turns forest green (#2F5443) and the name stays in the top bar.
- Without audio, paused, or before timings exist: tap/arrow to advance. `prefers-reduced-motion`: no animation.
- Visual base: direction A (paper #F5F0E6, card #FFFDF8, ink #20251F, forest #2F5443, clay #94432F; Newsreader titles, Instrument Sans UI, Noto Naskh Arabic). Text contrast ≥ 4.5:1.

## Composition and phrase list

Codex composes only prose (`schemas/codex-subscription-composition.schema.json`, `schemaVersion` `2.0`). Per language it returns `introLines`, `blessingLines`, `meaningLines`, `revealLines` (lead-in phrases such as "Nous avons accueilli notre fille…", never the name) and `closingLines`, plus the legacy `description` and `*Narration` fields. The request carries the brief and, when the name resolves in `data/reference-catalog.json`, its verified meaning (`nameReference`). Without a catalog meaning, `meaningLines` speak of what the parents put into the name and claim no etymology.

The composer rejects (`composition_output_rejected`, retryable: another attempt can succeed) any composition whose `introLines`, `blessingLines`, `meaningLines`, `revealLines`, `introNarration` or `blessingNarration` contain the first name, its Arabic form, or a catalog canonical form or alias. Latin matching ignores case and accents and needs whole words; Arabic matching ignores diacritics and alef variants and also catches clitics (`ال`, `و`, `ب`, `ل`…) and common suffixes. Arabic meaning lines must therefore use synonyms (Amal → الرجاء, not الأمل).

`buildAnnouncementChapters({ composition, brief })` (`src/delivery-loop/chapters.mjs`) is the single phrase list for render and narration:

```js
{ fr: [
  { section: "intro",   phrases: [{ text }] },
  { section: "dua",     phrases: [{ text }] },        // blessingLines, whatever the religion
  { section: "meaning", phrases: [{ text }] },
  { section: "reveal",  phrases: [{ text }, …, { text: "Bayane", name: { latin: "Bayane", arabic: "بَيَان" } }] },
  { section: "verses",  phrases: [{ text: quote, reference, arabic, sourceKey }] }, // fr: arabic = source verse
  { section: "closing", phrases: [{ text }] },
], ar: [...] }
```

- One phrase = one screen = one narrated segment. `text` is both displayed and spoken; `reference`, `arabic` and `name` are display-only.
- Only the brief's languages are present. The name phrase says the Latin name in `fr`, the Arabic name in `ar` (brief `nameArabic`, else catalog canonical Arabic, else the Latin name).
- `verses` exists only when the brief's religion is `islam` and the name resolves to a catalog entry with verses for that language; it is copied from the catalog, never generated. Note: the paid route currently forces `religion: general`, so paid announcements get 5 chapters.

## Timing

The worker speaks the same phrase list it renders: `chapterNarrationText(chapters[language])` (`src/delivery-loop/narration-timing.mjs`) joins phrases with `\n` inside a chapter and `\n\n` between chapters (the name phrase and verse quotes included; `reference`, `arabic` and `name` stay display-only).

Narration synthesizes each phrase separately (`synthesizePhrase` in `src/delivery-loop/provider-transport.mjs`, the only engine-specific function), then concatenates the MP3 frames with 0.5 s of silence between phrases of a chapter and 1.0 s between chapters, rounded to whole frames. Each start is computed from frame counts, not estimated. Narration receipts and published `audioFiles` carry `phraseStarts`: seconds, one per screen in order, first 0, strictly increasing, rounded to the millisecond. Convex rejects a receipt whose count does not match the text's phrases, and a publication whose starts differ from its receipt. The render turns them into `data-start`.

The voice engine is expected to change (VoiceStudio): replace `synthesizePhrase`; the timing contract does not change.

## Render

`renderAnnouncement({ chapters, languages, publicUrl, revision, phraseStarts? })` (`src/delivery-loop/render.mjs`) takes the per-language chapter list above and emits one `<section data-screen>` per phrase, one bar per chapter. A phrase with `name` is the reveal screen; a phrase with `reference` is a verse screen (Arabic RTL, translation, reference). `phraseStarts[lang]` (seconds, strictly increasing, one per phrase) becomes `data-start`; while the audio plays the page shows the last screen whose start has passed. Without starts, audio or with playback paused, tap or arrows advance. Space/k toggles play.

The page has one inline script, `SLIDESHOW_SCRIPT` (`src/delivery-loop/slideshow-script.mjs`). The Convex announcement route allows exactly its SHA-256 (`script-src 'sha256-…'`, `sandbox allow-scripts`). Changing the script changes the hash automatically; never add another inline script. Keep the script built from plain strings: Convex minifies its bundle, so anything derived from `Function.prototype.toString` differs between the worker's page and the Convex hash and the browser blocks the slideshow (`render.test.mjs` checks a minified bundle). The audio route answers single byte ranges (206/416, `accept-ranges: bytes`): without them browsers cannot seek, and tapping a screen while the voice plays would snap back to the current phrase.

The worker renders `buildAnnouncementChapters` output. Fixture preview (prototype `page.json`, via `page-fixture-chapters.mjs`): `npm run render:r1-bayane` → `out/r1-bayane/index.html` (23 screens in French).
