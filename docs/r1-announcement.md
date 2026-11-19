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

Narration produces, per language, the start time (seconds) of every displayed phrase. Engine-agnostic method: synthesize phrase by phrase, concatenate, record each start. The page reads these starts to switch screens. The voice engine is expected to change (VoiceStudio), the timing contract does not.

## Render

`renderAnnouncement({ chapters, languages, publicUrl, revision, phraseStarts? })` (`src/delivery-loop/render.mjs`) takes the per-language chapter list above and emits one `<section data-screen>` per phrase, one bar per chapter. A phrase with `name` is the reveal screen; a phrase with `reference` is a verse screen (Arabic RTL, translation, reference). `phraseStarts[lang]` (seconds, strictly increasing, one per phrase) becomes `data-start`; while the audio plays the page shows the last screen whose start has passed. Without starts, audio or with playback paused, tap or arrows advance. Space/k toggles play.

The page has one inline script, `SLIDESHOW_SCRIPT` (`src/delivery-loop/slideshow-script.mjs`). The Convex announcement route allows exactly its SHA-256 (`script-src 'sha256-…'`, `sandbox allow-scripts`). Changing the script changes the hash automatically; never add another inline script.

Until the composition card ships chapters, the worker maps the schema 1.0 composition with `chaptersFromLegacyComposition` (intro, dua, reveal, closing). Fixture preview: `npm run render:r1-bayane` → `out/r1-bayane/index.html` (23 screens in French).
