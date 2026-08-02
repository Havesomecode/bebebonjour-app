function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function lineBlocks(lines) {
  return lines.map((line) => escapeHtml(line)).join("<br />\n            ");
}

function renderTextSection(sectionId, pageSection) {
  return `<section id="${sectionId}" class="story-section" data-section="${sectionId}">
        <div class="section-inner reveal">
${renderLanguageParagraphs(pageSection)}
        </div>
      </section>`;
}

function renderLanguageParagraphs(pageSection) {
  return Object.entries(pageSection)
    .map(
      ([language, entry]) => `          <p data-lang="${language}">
            ${lineBlocks(entry.displayLines)}
          </p>`,
    )
    .join("\n");
}

function renderRevealSection(pageSection) {
  return `<section id="reveal" class="story-section reveal-stage" data-section="reveal">
        <div class="section-inner reveal">
${Object.entries(pageSection)
  .map(
    ([language, entry]) => `          <p data-lang="${language}" class="name-intro">
            ${lineBlocks(entry.introLines)}
          </p>
          <h1 data-lang="${language}" class="name glow">${escapeHtml(entry.name)}</h1>`,
  )
  .join("\n")}
        </div>
      </section>`;
}

function renderVerseItems(language, verseSection) {
  return verseSection.items
    .map((item) => {
      const source = language === "fr" && item.sourceArabic
        ? ` — « ${escapeHtml(item.sourceArabic)} »`
        : "";
      return `            <p class="verse">${escapeHtml(item.quote)}</p>
            <p class="verse-ref">${escapeHtml(item.reference)}${source}</p>`;
    })
    .join("\n");
}

function renderVersesSection(pageSection) {
  return `<section id="verses" class="story-section verses" data-section="verses">
        <div class="section-inner reveal">
${Object.entries(pageSection)
  .map(
    ([language, entry]) => `          <div data-lang="${language}">
            <p class="line-tight">${escapeHtml(entry.introLine)}</p>
${renderVerseItems(language, entry)}
          </div>`,
  )
  .join("\n")}
        </div>
      </section>`;
}

function sectionMarkup(sectionId, pageSection) {
  if (sectionId === "reveal") return renderRevealSection(pageSection);
  if (sectionId === "verses") return renderVersesSection(pageSection);
  return renderTextSection(sectionId, pageSection);
}

export function renderHtml({ page, language, assetBasePath, transcriptUrl, ambientAudioUrl }) {
  const title = escapeHtml(page.seo.title);
  const description = escapeHtml(page.seo.description);
  const direction = language === "ar" ? "rtl" : "ltr";
  const sections = page.sectionOrder
    .map((sectionId) => sectionMarkup(sectionId, page.sections[sectionId]))
    .join("\n\n      ");

  return `<!doctype html>
<html lang="${language}" dir="${direction}" data-language="${language}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:type" content="website" />
    <meta property="og:image" content="${assetBasePath}/og-image.svg" />
    <meta name="theme-color" content="#f8efe8" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Cormorant+Garamond:wght@400;500;600;700&family=Scheherazade+New:wght@400;700&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="${assetBasePath}/styles.css" />
  </head>
  <body>
    <div class="scene" aria-hidden="true">
      <div class="parallax layer glow-one" data-depth="0.04"></div>
      <div class="parallax layer glow-two" data-depth="0.08"></div>
      <div class="parallax layer floral-texture" data-depth="0.12"></div>
      <div id="particle-field"></div>
    </div>

    <header class="controls">
      <button id="lang-toggle" type="button" class="control-btn">FR</button>
      <button id="narration-toggle" type="button" class="control-btn">
        Narration Off
      </button>
    </header>
    <button
      id="start-narration-cta"
      type="button"
      class="start-narration-cta"
      aria-hidden="true"
    >
      Tap to start narration
    </button>

    <audio id="ambient-audio" loop preload="none"></audio>

    <main id="story">
      ${sections}
    </main>

    <script>
      window.__ANNOUNCEMENT_CONFIG__ = {
        supportedLanguages: ${JSON.stringify(page.languages)},
        transcriptUrl: ${JSON.stringify(transcriptUrl)},
        assetBasePath: ${JSON.stringify(assetBasePath)},
        ambientAudioUrl: ${JSON.stringify(ambientAudioUrl || "")}
      };
    </script>
    <script src="${assetBasePath}/app.js"></script>
  </body>
</html>
`;
}
