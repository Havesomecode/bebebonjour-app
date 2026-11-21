// Plain strings only: The server minifies its bundle and hashes this script for the page CSP,
// so nothing here may depend on Function.prototype.toString or bundler output.
export const SCREEN_INDEX_AT_SOURCE = `function screenIndexAt(starts, seconds) {
  let index = 0;
  for (let i = 1; i < starts.length && starts[i] <= seconds; i++) index = i;
  return index;
}`;

export const SLIDESHOW_SCRIPT = `(() => {
  const screenIndexAt = ${SCREEN_INDEX_AT_SOURCE};
  document.documentElement.classList.add('js');
  const panels = [...document.querySelectorAll('[data-slideshow]')];
  const links = [...document.querySelectorAll('[data-language]')];
  let active;
  const states = panels.map(panel => {
    const screens = [...panel.querySelectorAll('[data-screen]')], bars = [...panel.querySelectorAll('.bars b')];
    const stage = panel.querySelector('.stage'), audio = panel.querySelector('audio'), button = panel.querySelector('[data-play]');
    const error = panel.querySelector('[data-audio-error]'), starts = screens.every(s => s.hasAttribute('data-start')) ? screens.map(s => Number(s.dataset.start)) : null;
    const reveal = screens.findIndex(s => s.hasAttribute('data-name-screen'));
    let index = 0, failed = false;
    const paint = (next, manual = false) => {
      next = Math.max(0, Math.min(screens.length - 1, next));
      const changed = index !== next; index = next;
      screens.forEach((s, i) => { s.hidden = i !== index; });
      const s = screens[index], chapter = Number(s.dataset.chapterIndex), position = Number(s.dataset.chapterPosition), count = Number(s.dataset.chapterCount);
      bars.forEach((b, i) => { b.style.width = (i < chapter ? 100 : i > chapter ? 0 : 100 * (position + 1) / count) + '%'; });
      panel.querySelector('[data-chapter-label]').textContent = s.dataset.label;
      panel.querySelector('[data-chapter-counter]').textContent = (chapter + 1) + ' / ' + bars.length;
      const chip = panel.querySelector('[data-name-chip]');
      chip.hidden = reveal < 0 || index <= reveal;
      panel.querySelector('[data-chapter-counter]').hidden = !chip.hidden;
      panel.querySelector('[data-screen-counter]').textContent = (index + 1) + '/' + screens.length;
      panel.querySelector('.track b').style.width = (100 * (index + 1) / screens.length) + '%';
      if (active === panel) document.body.classList.toggle('rev', reveal >= 0 && index >= reveal);
      if (changed) { const p = s.querySelector('.phrase, .verse-ar, h1'); if (p) { p.classList.remove('fade'); void p.offsetWidth; p.classList.add('fade'); } }
      if (manual && starts && audio && !failed) audio.currentTime = starts[index];
    };
    const toggle = async () => { if (!audio) return; if (!audio.paused) { audio.pause(); return; } error.hidden = true; if (audio.ended) { audio.currentTime = 0; paint(0); } try { await audio.play(); } catch { failed = true; error.hidden = false; } };
    const sync = () => { if (audio && !audio.paused && !failed && starts) paint(screenIndexAt(starts, audio.currentTime)); };
    if (audio) {
      audio.controls = false;
      button.addEventListener('click', toggle);
      audio.addEventListener('play', () => { button.setAttribute('aria-pressed', 'true'); button.setAttribute('aria-label', panel.lang === 'ar' ? 'إيقاف مؤقت' : 'Mettre en pause'); const tick = () => { if (!audio.paused) { sync(); requestAnimationFrame(tick); } }; requestAnimationFrame(tick); });
      audio.addEventListener('pause', () => { button.setAttribute('aria-pressed', 'false'); button.setAttribute('aria-label', panel.lang === 'ar' ? 'تشغيل' : 'Écouter'); });
      audio.addEventListener('timeupdate', sync);
      audio.addEventListener('ended', () => paint(screens.length - 1));
      audio.addEventListener('error', () => { failed = true; error.hidden = false; button.setAttribute('aria-pressed', 'false'); });
    }
    stage.addEventListener('click', event => { const rect = stage.getBoundingClientRect(); const x = (event.clientX - rect.left) / rect.width; const previous = panel.dir === 'rtl' ? x > .7 : x < .3; paint(index + (previous ? -1 : 1), true); });
    paint(0);
    return { panel, paint, toggle, get index() { return index; }, audio };
  });
  const select = language => { states.forEach(state => { const on = state.panel.dataset.languagePanel === language; state.panel.hidden = !on; if (!on) state.audio?.pause(); else active = state.panel; }); links.forEach(link => link.setAttribute('aria-current', String(link.dataset.language === language))); document.documentElement.lang = language; document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr'; states.find(s => s.panel === active)?.paint(states.find(s => s.panel === active).index); };
  links.forEach(link => link.addEventListener('click', event => { event.preventDefault(); select(link.dataset.language); }));
  document.addEventListener('keydown', event => { if (event.target.closest('button,a,input,textarea,select')) return; const state = states.find(s => s.panel === active); if (!state) return; let n = state.index; if (event.key === 'ArrowRight') n += active.dir === 'rtl' ? -1 : 1; else if (event.key === 'ArrowLeft') n += active.dir === 'rtl' ? 1 : -1; else if (event.key === 'Home') n = 0; else if (event.key === 'End') n = Infinity; else if (event.key === ' ' || event.key.toLowerCase() === 'k') { event.preventDefault(); state.toggle(); return; } else return; event.preventDefault(); state.paint(n, true); });
  const requested = location.hash.replace('#story-', ''); select(panels.some(p => p.dataset.languagePanel === requested) ? requested : panels[0].dataset.languagePanel);
})();`;
