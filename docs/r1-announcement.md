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

## Timing

Narration synthesizes each displayed phrase separately, then concatenates MP3 frames with 0.5 seconds of silence between phrases in a section and 1.0 second between sections (rounded to whole frames). Receipts and published `audioFiles` carry `phraseStarts`: seconds, one per displayed phrase in order, first 0 and strictly increasing. Each displayed phrase exposes its start as `data-start` when narration is enabled. The current page exposes timing; a future slideshow can use it to switch screens. The voice engine is expected to change (VoiceStudio); the timing contract does not.
