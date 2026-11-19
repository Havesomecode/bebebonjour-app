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

Narration produces, per language, the start time (seconds) of every displayed phrase. Engine-agnostic method: synthesize phrase by phrase, concatenate, record each start. The page reads these starts to switch screens. The voice engine is expected to change (VoiceStudio), the timing contract does not.
