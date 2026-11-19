import { assertValidCodexSubscriptionComposition } from "../../scripts/lib/codex-subscription-composition.mjs";
import { SLIDESHOW_SCRIPT } from "./slideshow-script.mjs";

const labels = {
  fr: { welcome: 'Bienvenue au monde', description: 'Un faire-part de naissance à écouter.', voice: 'Une narration créée avec une voix artificielle.', draft: 'Première version · en attente de votre validation', error: 'La narration est indisponible pour le moment. Réessayez plus tard.', play: 'Écouter', chapters: ['La bonne nouvelle', 'Nos vœux', 'Le sens de son prénom', 'Son prénom', 'Dans le Coran', 'Avec tout notre amour'] },
  ar: { welcome: 'أهلاً بك في العالم', description: 'إعلان ولادة للاستماع.', voice: 'سرد بصوت مولّد بالذكاء الاصطناعي.', draft: 'نسخة أولى · بانتظار موافقتكم', error: 'السرد غير متاح الآن. يرجى المحاولة لاحقاً.', play: 'تشغيل', chapters: ['الخبر السعيد', 'دعواتنا', 'معنى الاسم', 'الاسم', 'في القرآن الكريم', 'بكل حبنا'] },
};
const order = ['intro', 'dua', 'meaning', 'reveal', 'verses', 'closing'];
const escapeHtml = value => String(value).replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const validString = value => typeof value === 'string' && value.trim().length > 0;
const reject = () => { throw new Error('render_input_rejected'); };

export function narrationText(composition, language) {
  assertValidCodexSubscriptionComposition(composition);
  if (!Object.hasOwn(labels, language)) reject();
  const content = composition.languages[language];
  return [content.introNarration, content.blessingNarration, content.closingNarration].join('\n\n');
}
export function renderAnnouncement({ chapters, languages, publicUrl, publicToken, revision, pendingReview = true, narrationEnabled = true, phraseStarts }) {
  if (publicToken === undefined) { try { publicToken = /^\/announcements\/([A-Za-z0-9_-]{1,256})\/?$/u.exec(new URL(publicUrl).pathname)?.[1]; } catch { reject(); } }
  if (!Array.isArray(languages) || languages.length < 1 || languages.length > 2 || new Set(languages).size !== languages.length || languages.some(l => !Object.hasOwn(labels, l)) || !Number.isSafeInteger(revision) || revision < 1 || typeof publicToken !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(publicToken)) reject();
  try { const url = new URL(publicUrl); if (url.protocol !== 'https:' || url.username || url.password) reject(); } catch { reject(); }
  if (!chapters || typeof chapters !== 'object' || (phraseStarts !== undefined && (!phraseStarts || typeof phraseStarts !== 'object' || Array.isArray(phraseStarts)))) reject();
  const panels = languages.map(lang => {
    const list = chapters[lang]; if (!Array.isArray(list) || !list.length) reject();
    let last = -1, count = 0, namePhrase;
    for (const chapter of list) {
      const pos = order.indexOf(chapter?.section); if (pos <= last || !Array.isArray(chapter.phrases) || !chapter.phrases.length) reject(); last = pos;
      for (const phrase of chapter.phrases) {
        if (!phrase || !validString(phrase.text) || phrase.text.length > 600 || (phrase.reference !== undefined && !validString(phrase.reference)) || (phrase.arabic !== undefined && !validString(phrase.arabic)) || (phrase.name !== undefined && (!phrase.name || !validString(phrase.name.latin) || (phrase.name.arabic !== undefined && !validString(phrase.name.arabic))))) reject();
        if (phrase.name) { if (namePhrase) reject(); namePhrase = phrase; } count++;
      }
    }
    if (count > 80) reject();
    const starts = phraseStarts?.[lang]; if (starts !== undefined && (!Array.isArray(starts) || starts.length !== count || starts.some((v, i) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (i && v <= starts[i-1])))) reject();
    let index = 0;
    const screens = list.map((chapter, ci) => chapter.phrases.map((p, pi) => {
      const i = index++, previous = chapter.phrases[pi-1], text = escapeHtml(p.text); let body;
      if (p.name) {
        const main = lang === 'ar' ? (p.name.arabic || p.name.latin) : p.name.latin, other = lang === 'ar' ? p.name.latin : p.name.arabic;
        body = `${previous ? `<p class="prev namelead">${escapeHtml(previous.text)}</p>` : ''}<h1 class="rise">${escapeHtml(main)}</h1>${other ? `<p class="other rise" ${lang === 'fr' ? 'lang="ar" dir="rtl"' : 'lang="fr" dir="ltr"'}>${escapeHtml(other)}</p>` : ''}`;
      } else if (p.reference) body = `${lang === 'ar' || p.arabic ? `<p class="verse-ar" lang="ar" dir="rtl">${escapeHtml(lang === 'ar' ? p.text : p.arabic)}</p>` : ''}${lang === 'fr' ? `<p class="verse-fr">${text}</p>` : ''}<p class="ref">${escapeHtml(p.reference)}</p>`;
      else body = `${previous && chapter.section !== 'reveal' ? `<p class="prev">${escapeHtml(previous.text)}</p>` : ''}<p class="phrase${chapter.section === 'reveal' ? ' leadin' : ''}">${text}</p>`;
      return `<section data-screen data-index="${i}" data-chapter="${chapter.section}" data-chapter-index="${ci}" data-chapter-position="${pi}" data-chapter-count="${chapter.phrases.length}" data-label="${escapeHtml(labels[lang].chapters[order.indexOf(chapter.section)])}"${p.name ? ' data-name-screen' : ''}${starts ? ` data-start="${starts[i]}"` : ''}>${body}</section>`;
    }).join('')).join('');
    const chip = namePhrase ? (lang === 'ar' ? namePhrase.name.arabic || namePhrase.name.latin : namePhrase.name.latin) : '';
    return `<article id="story-${lang}" data-language-panel="${lang}" lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}" data-slideshow><div class="bars">${list.map(() => '<i><b></b></i>').join('')}</div><div class="chap"><span class="eyebrow" data-chapter-label>${labels[lang].chapters[order.indexOf(list[0].section)]}</span><span class="meta" data-chapter-counter>1 / ${list.length}</span><span class="namechip" data-name-chip hidden>${escapeHtml(chip)}</span></div><div class="stage" aria-live="polite">${screens}</div><div class="player">${narrationEnabled ? `<button class="play" type="button" data-play="${lang}" aria-pressed="false" aria-label="${labels[lang].play}">▶</button>` : ''}<div class="track"><b></b></div><span class="meta" data-screen-counter>1/${count}</span></div>${narrationEnabled ? `<audio controls preload="none" src="/announcements/${publicToken}/audio/${revision}/${lang}" aria-label="${labels[lang].play}"></audio><p class="voice-note">${labels[lang].voice}</p><p data-audio-error hidden role="status">${labels[lang].error}</p>` : ''}</article>`;
  }).join('');
  const first = languages[0];
  const switcher = languages.length > 1 ? `<nav data-language-switch>${languages.map(lang => `<a href="#story-${lang}" data-language="${lang}" lang="${lang}" aria-controls="story-${lang}">${lang === 'fr' ? 'Français' : 'العربية'}</a>`).join('')}</nav>` : '';
  const draft = pendingReview ? `<!--delivery-loop-draft:start--><aside data-draft-marker class="draft" role="status">${languages.map(lang => `<span lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">${labels[lang].draft}</span>`).join(' ')}</aside><!--delivery-loop-draft:end-->` : '';
  return `<!doctype html><html lang="${first}" dir="${first === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${labels[first].welcome} · Bébé Bonjour</title><meta name="description" content="${labels[first].description}"><style>${STYLES}</style></head><body><div class="wrap"><div class="top"><span class="logo"><em>Bébé</em> Bonjour</span>${switcher}</div>${draft}<main>${panels}</main></div><script>${SLIDESHOW_SCRIPT}</script></body></html>`;
}
const STYLES = `
html[lang=fr] .draft [lang=ar],html[lang=ar] .draft [lang=fr]{display:none}[dir=rtl] .leadin,[dir=rtl] .namelead{font-style:normal}:root{--paper:#F5F0E6;--card:#FFFDF8;--ink:#20251F;--muted:#575B52;--forest:#2F5443;--clay:#94432F;--rule:#E2DBCB;--ivory:#FFFDF8;--sage:#CFDCD3}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Instrument Sans","Avenir Next",system-ui,sans-serif;transition:background-color 700ms,color 700ms}.wrap{max-width:720px;margin:auto;min-height:100svh;display:flex;flex-direction:column;padding:0 20px}.top{display:flex;align-items:center;justify-content:space-between;padding:18px 0;gap:12px}.logo{font:500 1.125rem/1 "Newsreader",Georgia,serif}.logo em{color:var(--forest)}nav{display:flex;gap:1rem}nav a{color:inherit;font-size:.85rem}.draft{text-align:center;font-size:.75rem;color:var(--muted)}main{flex:1;display:flex;flex-direction:column}article{flex:1;display:flex;flex-direction:column;min-width:0}.bars{display:flex;gap:4px;padding:14px 0 0}.bars i{flex:1;height:3px;border-radius:3px;background:var(--rule);overflow:hidden}.bars b{display:block;height:100%;width:0;background:var(--forest)}.chap{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 2px 0;min-height:30px}.eyebrow{font-size:.75rem;letter-spacing:.05em;text-transform:uppercase;color:var(--clay);font-weight:600}.meta,.ref,.voice-note{font-size:.8125rem;color:var(--muted)}.stage{flex:1;display:grid;align-content:center;gap:18px;padding:20px 2px}.stage section{min-width:0;overflow-wrap:anywhere}.stage p,.stage h1{margin:0}.stage section>*+*{margin-top:18px}.phrase{font:400 clamp(1.75rem,4.5vw,2.75rem)/1.25 "Newsreader",Georgia,serif;text-wrap:balance}.prev{font:400 1.0625rem/1.4 "Newsreader",Georgia,serif;color:var(--muted)}.leadin{text-align:center;font-style:italic}.stage section:has(h1){text-align:center}.namelead{font-style:italic}.stage h1{font:400 clamp(3.5rem,12vw,6rem)/1.25 "Newsreader",Georgia,serif}.other,.verse-ar{font:400 2rem/1.7 "Noto Naskh Arabic","Traditional Arabic",serif;text-align:center}.verse-fr{font:italic 400 1.25rem/1.4 "Newsreader",Georgia,serif;text-align:center}.ref{text-align:center}.namechip{font:italic 400 1rem/1 "Newsreader",Georgia,serif}.player{display:flex;align-items:center;gap:12px;padding:14px 0 18px}.play{width:40px;height:40px;border:0;border-radius:50%;background:var(--clay);color:var(--ivory);cursor:pointer}.track{height:2px;background:var(--rule);flex:1}.track b{display:block;height:100%;background:var(--clay);width:0}audio{max-width:100%}.voice-note{margin:0 0 15px}.rev{background:var(--forest);color:var(--ivory)}.rev .logo em{color:var(--ivory)}.rev .bars i,.rev .track{background:#ffffff33}.rev .bars b,.rev .track b{background:var(--ivory)}.rev .meta,.rev .prev,.rev .ref,.rev .voice-note,.rev .draft{color:var(--sage)}.rev .eyebrow{color:#F2C9B4}.rev .play{background:var(--ivory);color:var(--forest)}.fade{animation:fadein 420ms both}.rise{animation:rise 900ms 250ms both}@keyframes fadein{from{opacity:0;transform:translateY(8px)}}@keyframes rise{from{opacity:0;transform:translateY(14px)}}[hidden]{display:none!important}@media(prefers-reduced-motion:reduce){.fade,.rise{animation:none}body{transition:none}}
`;
