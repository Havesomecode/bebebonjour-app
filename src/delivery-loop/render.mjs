import { assertValidCodexSubscriptionComposition } from "../../scripts/lib/codex-subscription-composition.mjs";
import { REVIEWED_STORY_SECTIONS } from "./reviewed-narration.mjs";
import { validPhraseStarts } from "./narration-timing.mjs";

const LABELS = Object.freeze({
  fr: { welcome: "Bienvenue au monde", listen: "Écouter le récit", voice: "Une narration créée avec une voix artificielle.", draft: "Première version · en attente de votre validation", introduction: "Une nouvelle présence", blessing: "Pour les jours à venir", closing: "Avec tout notre amour", error: "La narration est indisponible pour le moment. Réessayez plus tard." },
  ar: { welcome: "أهلاً بك في العالم", listen: "استمع إلى الحكاية", voice: "سرد بصوت مولّد بالذكاء الاصطناعي.", draft: "نسخة أولى · بانتظار موافقتكم", introduction: "حضور جديد", blessing: "للأيام القادمة", closing: "بكل حبنا", error: "السرد غير متاح الآن. يرجى المحاولة لاحقاً." },
});

// This renderer intentionally accepts only a public projection. Never serialize a
// claim/intake, provider receipt, or review capability into the page or its script.
export function renderAnnouncement({ composition, baby, languages, publicUrl, publicToken, revision, pendingReview = true, narrationEnabled = true, phraseStarts = {} }) {
  if (publicToken === undefined) {
    try { publicToken = /^\/announcements\/([A-Za-z0-9_-]{1,256})\/?$/u.exec(new URL(publicUrl).pathname)?.[1]; } catch { throw new Error("render_input_rejected"); }
  }
  assertValidCodexSubscriptionComposition(composition);
  if (!Array.isArray(languages) || languages.length < 1 || languages.length > 2 || new Set(languages).size !== languages.length || languages.some((lang) => !Object.hasOwn(LABELS, lang)) || typeof baby?.firstName !== "string" || !Number.isSafeInteger(revision) || revision < 1 || typeof publicToken !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(publicToken)) {
    throw new Error("render_input_rejected");
  }
  let origin;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    origin = url.origin;
  } catch {
    throw new Error("render_input_rejected");
  }
  const first = languages[0];
  const panels = languages.map((lang) => {
    const labels = LABELS[lang];
    const content = composition.languages[lang];
    const audioUrl = `${origin}/announcements/${publicToken}/audio/${revision}/${lang}`;
    const count = REVIEWED_STORY_SECTIONS.reduce((sum, [, field]) => sum + content[field].length, 0);
    if (narrationEnabled && !validPhraseStarts(phraseStarts[lang], count)) throw new Error("render_input_rejected");
    let phrase = 0;
    const sections = REVIEWED_STORY_SECTIONS.map(([title, field], index) => `<section class="story"><span class="chapter" aria-hidden="true">0${index + 1}</span><h2>${labels[title]}</h2>${content[field].map((line) => `<p${narrationEnabled ? ` data-start="${phraseStarts[lang][phrase++]}"` : ""}>${escapeHtml(line)}</p>`).join("")}</section>`).join("");
    return `<article id="story-${lang}" data-language-panel="${lang}" lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}">
      <header class="welcome"><p class="eyebrow">${labels.welcome}</p><h1>${escapeHtml(lang === "ar" && baby.nameArabic ? baby.nameArabic : baby.firstName)}</h1><p class="description">${escapeHtml(content.description)}</p></header>
      ${narrationEnabled ? `<div class="narration"><button type="button" data-play="${lang}" aria-controls="audio-${lang}" aria-pressed="false">▷ ${labels.listen}</button><audio id="audio-${lang}" controls preload="none" src="${escapeHtml(audioUrl)}" aria-label="${labels.listen}"></audio><p class="voice-note">${labels.voice}</p><p data-audio-error hidden role="status">${labels.error}</p></div>` : ""}
      ${sections}
    </article>`;
  }).join("\n");
  const switcher = languages.length > 1 ? `<nav class="language-switch" aria-label="Language / اللغة" data-language-switch>${languages.map((lang) => `<a href="#story-${lang}" data-language="${lang}" lang="${lang}" aria-controls="story-${lang}">${lang === "fr" ? "Français" : "العربية"}</a>`).join("")}</nav>` : "";
  const draft = pendingReview ? `<!--delivery-loop-draft:start--><aside data-draft-marker class="draft" role="status">${languages.map((lang) => `<span lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}">${LABELS[lang].draft}</span>`).join(" ")}</aside><!--delivery-loop-draft:end-->` : "";
  return `<!doctype html>
<html lang="${first}" dir="${first === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${escapeHtml(baby.firstName)} · Bébé Bonjour</title><meta name="description" content="${escapeHtml(composition.languages[first].description)}"><style>${STYLES}</style></head><body><div class="topbar"><span class="brand">Bébé Bonjour</span>${switcher}</div>${draft}<main>${panels}</main><footer>Bébé Bonjour <span aria-hidden="true">·</span> Une histoire à partager</footer><script>${SCRIPT}</script></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

const STYLES = `
:root{color-scheme:light;--paper:#f9f4ec;--ink:#352c2a;--forest:#304c3b;--muted:#6e665e;--line:#ddd5c8}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:radial-gradient(ellipse at 50% 0,#fffdf9,transparent 70%),var(--paper);font-family:Georgia,"Times New Roman",serif;line-height:1.7}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;max-width:1080px;margin:auto;padding:1.5rem 2rem;border-bottom:1px solid var(--line)}.brand{font-size:1rem;letter-spacing:.04em;color:var(--forest)}.language-switch{display:flex;gap:.7rem;flex-wrap:wrap}.language-switch a{font:inherit;font-size:.9rem;text-decoration:none;color:var(--forest);padding:.3rem .7rem;border:1px solid transparent;border-radius:2rem}.language-switch a[aria-current="true"]{border-color:var(--forest)}
.draft{max-width:52rem;margin:1.25rem auto 0;padding:.6rem 1.2rem;color:var(--muted);font-size:.82rem;text-align:center}.draft span{display:inline-block;margin-inline:.4rem}main{max-width:760px;margin:auto;padding:0 1.5rem}.welcome{text-align:center;padding:clamp(3rem,9vh,7rem) 0 2rem}.eyebrow{color:var(--forest);font-size:.85rem;letter-spacing:.14em}h1{font-weight:400;font-size:clamp(2.5rem,9vw,5.8rem);line-height:1.2;margin:1.2rem 0;overflow-wrap:anywhere}.description{max-width:34rem;margin:1.5rem auto;color:var(--muted);font-size:1.1rem}.narration{display:flex;flex-direction:column;align-items:center;gap:.8rem;padding:1rem 0 3.5rem}.narration button{font:inherit;background:var(--forest);color:#fffdf9;border:0;border-radius:3rem;padding:.8rem 1.6rem;cursor:pointer}.narration audio{max-width:100%;width:320px}.voice-note{font-size:.75rem;color:var(--muted);margin:0}.story{position:relative;text-align:center;border-top:1px solid var(--line);padding:clamp(3rem,8vh,6rem) 1rem}.chapter{font-size:.72rem;letter-spacing:.16em;color:var(--muted)}h2{font-weight:400;font-size:1rem;letter-spacing:.04em;color:var(--forest);margin:.5rem 0 2rem}.story p{font-size:clamp(1.2rem,3.5vw,1.7rem);line-height:1.9;margin:1rem auto;max-width:38rem}.story:last-child{padding-bottom:5rem}article[lang="ar"]{font-family:"Noto Naskh Arabic","Traditional Arabic",Georgia,serif}article[lang="ar"] p{letter-spacing:normal}article[lang="ar"] .eyebrow{letter-spacing:normal}footer{text-align:center;padding:2rem;border-top:1px solid var(--line);font-size:.8rem;color:var(--muted)}[hidden]{display:none!important}a:focus-visible,button:focus-visible,audio:focus-visible{outline:3px solid #8f7751;outline-offset:4px}@media(max-width:480px){.topbar{padding:1rem}.draft{margin-top:.6rem}.welcome{padding-top:3rem}main{padding-inline:1rem}.story{padding-inline:0}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;

// No JSON bootstrap: the only dynamic values live in escaped HTML attributes.
const SCRIPT = `(() => {
  const panels = Array.from(document.querySelectorAll('[data-language-panel]'));
  const links = Array.from(document.querySelectorAll('[data-language]'));
  const select = (language) => {
    panels.forEach((panel) => {
      const active = panel.dataset.languagePanel === language;
      panel.hidden = !active;
      if (!active) panel.querySelector('audio')?.pause();
    });
    links.forEach((link) => link.setAttribute('aria-current', String(link.dataset.language === language)));
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  };
  links.forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); select(link.dataset.language); }));
  panels.forEach((panel) => {
    const audio = panel.querySelector('audio');
    if (!audio) return;
    const button = panel.querySelector('[data-play]');
    const error = panel.querySelector('[data-audio-error]');
    button.addEventListener('click', async () => {
      if (!audio.paused) { audio.pause(); return; }
      error.hidden = true;
      try { await audio.play(); } catch { error.hidden = false; }
    });
    audio.addEventListener('play', () => button.setAttribute('aria-pressed', 'true'));
    ['pause', 'ended'].forEach((event) => audio.addEventListener(event, () => button.setAttribute('aria-pressed', 'false')));
    audio.addEventListener('error', () => { error.hidden = false; button.setAttribute('aria-pressed', 'false'); });
  });
  if (panels.length > 1) {
    const requested = location.hash.replace('#story-', '');
    select(panels.some((panel) => panel.dataset.languagePanel === requested) ? requested : panels[0].dataset.languagePanel);
  }
})();`;
