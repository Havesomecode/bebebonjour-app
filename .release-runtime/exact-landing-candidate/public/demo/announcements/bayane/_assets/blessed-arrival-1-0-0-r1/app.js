import {
  canonicalAnnouncementPath,
  shouldLoadNarrationResources,
  visiblePhraseTargetCount,
} from "./phrase-progress.mjs";

const runtimeConfig = window.__ANNOUNCEMENT_CONFIG__ || {};
const privateReview = runtimeConfig.reviewMode === "private";

const sections = Array.from(document.querySelectorAll(".story-section"));
const revealItems = Array.from(document.querySelectorAll(".reveal"));
const parallaxLayers = Array.from(document.querySelectorAll(".parallax"));
const particleField = document.getElementById("particle-field");

const langToggle = document.getElementById("lang-toggle");
const narrationToggle = document.getElementById("narration-toggle");
const startNarrationCta = document.getElementById("start-narration-cta");
const audio = document.getElementById("ambient-audio");

const state = {
  language: runtimeConfig.defaultLanguage || "ar",
  supportedLanguages: Array.isArray(runtimeConfig.supportedLanguages)
    ? runtimeConfig.supportedLanguages
    : ["ar", "fr"],
  narrationRequested: false,
  narrationEnabled: false,
  transcriptLoaded: false,
  narrationTimingsLoaded: false,
  transcript: { ar: [], fr: [] },
  narrationTimings: { ar: {}, fr: {} },
  narrationTracks: { ar: [], fr: [] },
  narrationRetryInFlight: false,
  currentNarrationTrack: null,
  lastNarrationAutoScrollAt: 0,
  activeCueIndex: -1,
  activeSectionId: "",
  phraseTracks: new Map(),
};

function mmssToSeconds(value) {
  const [mins, secs] = value.split(":").map(Number);
  return mins * 60 + secs;
}

function parseToggleParam(value, fallback = false) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["on", "1", "true", "yes"].includes(normalized)) return true;
  if (["off", "0", "false", "no"].includes(normalized)) return false;
  return fallback;
}

function parseLanguageFromPath(pathname) {
  const normalized = pathname.replace(/\/+$/g, "").replace(/^\/+/g, "");
  if (!normalized) return null;
  const segments = normalized.split("/");
  const segment = segments[segments.length - 1];
  return segment === "ar" || segment === "fr" ? segment : null;
}

function readUrlState() {
  const url = new URL(window.location.href);
  return {
    language: parseLanguageFromPath(url.pathname) || "ar",
    narration: privateReview
      ? false
      : parseToggleParam(
        url.searchParams.get("narration") ?? url.searchParams.get("music"),
        false,
      ),
  };
}

function buildCanonicalUrl() {
  const url = new URL(window.location.origin);
  url.pathname = canonicalAnnouncementPath(window.location.pathname, state.language);
  url.searchParams.set("narration", state.narrationRequested ? "on" : "off");
  return `${url.pathname}?${url.searchParams.toString()}`;
}

function syncUrl(mode = "replace") {
  const next = buildCanonicalUrl();
  const current = `${window.location.pathname}${window.location.search}`;
  if (next === current) return;
  if (mode === "push") {
    window.history.pushState({}, "", next);
    return;
  }
  window.history.replaceState({}, "", next);
}

function trackKey(sectionId, language) {
  return `${sectionId}:${language}`;
}

function fallbackPhraseDelayMs(sectionId) {
  if (sectionId === "reveal") return 1200;
  if (sectionId === "verses") return 1400;
  return 950;
}

function normalizePublicFilePath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return "";
  let normalized = filePath.trim();
  if (normalized.startsWith("public/")) normalized = normalized.slice("public".length);
  if (!normalized.startsWith("/") && !normalized.startsWith(".")) return normalized;
  return normalized;
}

function isFinitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function readManifestStartSeconds(entry) {
  if (typeof entry?.seconds === "number" && Number.isFinite(entry.seconds)) return entry.seconds;
  if (typeof entry?.time === "string") return mmssToSeconds(entry.time);
  return null;
}

function probeAudioDurationSeconds(src) {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }

    const probe = new Audio();
    const onReady = () => {
      cleanup();
      resolve(isFinitePositive(probe.duration) ? probe.duration : null);
    };
    const onError = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      probe.removeEventListener("loadedmetadata", onReady);
      probe.removeEventListener("error", onError);
    };

    probe.preload = "metadata";
    probe.addEventListener("loadedmetadata", onReady, { once: true });
    probe.addEventListener("error", onError, { once: true });
    probe.src = src;
  });
}

async function loadNarrationTimingForLanguage(language) {
  const assetBasePath = runtimeConfig.assetBasePath || "../_assets";
  const manifestUrl = `${assetBasePath}/audio/narration/${language}/manifest.json`;
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) return;

  const manifest = await response.json();
  const entries = Array.isArray(manifest?.files) ? manifest.files : [];
  if (!entries.length) return;

  const sorted = entries
    .map((entry, index) => ({
      ...entry,
      _order: Number.isFinite(entry?.index) ? entry.index : index,
      _start: readManifestStartSeconds(entry),
      _src: normalizePublicFilePath(entry?.file),
    }))
    .sort((a, b) => a._order - b._order);

  const probes = await Promise.all(sorted.map((entry) => probeAudioDurationSeconds(entry._src)));
  const sectionTimings = {};
  const tracks = [];
  let rollingStartSec = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];
    const durationFromAudio = probes[i];
    let durationFromManifest = null;

    if (
      current &&
      next &&
      isFiniteNonNegative(current._start) &&
      isFiniteNonNegative(next._start) &&
      next._start > current._start
    ) {
      durationFromManifest = next._start - current._start;
    }

    const duration = durationFromAudio ?? durationFromManifest ?? null;
    const startSec = isFiniteNonNegative(current?._start) ? current._start : rollingStartSec;

    if (current?.section && current?._src) {
      tracks.push({
        language,
        section: current.section,
        src: current._src,
        startSec,
        durationSec: isFinitePositive(duration) ? duration : null,
      });
    }

    if (current?.section && isFinitePositive(duration)) {
      sectionTimings[current.section] = duration;
    }

    if (isFiniteNonNegative(startSec) && isFinitePositive(duration)) {
      rollingStartSec = startSec + duration;
    } else if (isFiniteNonNegative(current?._start)) {
      rollingStartSec = current._start;
    }
  }

  state.narrationTimings[language] = sectionTimings;
  state.narrationTracks[language] = tracks;
}

async function loadNarrationTimings() {
  await Promise.allSettled([loadNarrationTimingForLanguage("ar"), loadNarrationTimingForLanguage("fr")]);
  state.narrationTimingsLoaded = true;
}

function getNarrationTracks(language = state.language) {
  return state.narrationTracks[language] || [];
}

function findNarrationTrackIndexBySection(language, sectionId) {
  if (!sectionId) return -1;
  const tracks = getNarrationTracks(language);
  return tracks.findIndex((track) => track.section === sectionId);
}

function getCurrentNarrationTrackMeta() {
  if (!state.currentNarrationTrack) return null;
  const tracks = getNarrationTracks(state.currentNarrationTrack.language);
  return tracks[state.currentNarrationTrack.index] || null;
}

function getGlobalAudioSeconds() {
  const track = getCurrentNarrationTrackMeta();
  if (!track) return audio.currentTime;
  const start = isFiniteNonNegative(track.startSec) ? track.startSec : 0;
  return start + audio.currentTime;
}

function autoScrollNarrationSection(sectionId, { force = false } = {}) {
  if (!state.narrationEnabled || !sectionId) return;
  const target = document.getElementById(sectionId);
  if (!target) return;

  const now = Date.now();
  if (!force && now - state.lastNarrationAutoScrollAt < 850) return;

  const rect = target.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;
  const outOfFocus = rect.top > viewportHeight * 0.34 || rect.bottom < viewportHeight * 0.66;
  if (!force && !outOfFocus) return;

  target.scrollIntoView({ behavior: "smooth", block: "center" });
  state.lastNarrationAutoScrollAt = now;
}

function ensureAmbientSource() {
  if (privateReview) return;
  const ambientSrc = runtimeConfig.ambientAudioUrl || "";
  if (!ambientSrc) return;
  if (!audio.src.endsWith(ambientSrc)) {
    audio.src = ambientSrc;
  }
  audio.loop = true;
}

async function playNarrationTrackByIndex(language, index) {
  const tracks = getNarrationTracks(language);
  const safeIndex = Math.max(0, Math.min(index, tracks.length - 1));
  const target = tracks[safeIndex];
  if (!target?.src) return false;

  const current = state.currentNarrationTrack;
  if (
    current &&
    current.language === language &&
    current.index === safeIndex &&
    !audio.paused
  ) {
    return true;
  }

  audio.loop = false;
  audio.src = target.src;
  audio.currentTime = 0;
  await audio.play();
  state.currentNarrationTrack = { language, index: safeIndex };
  setActiveSection(target.section);
  autoScrollNarrationSection(target.section, { force: true });
  return true;
}

async function playNarrationForSection(language, sectionId) {
  const tracks = getNarrationTracks(language);
  if (!tracks.length) return false;

  if (sectionId) {
    const index = findNarrationTrackIndexBySection(language, sectionId);
    if (index < 0) return false;
    return playNarrationTrackByIndex(language, index);
  }

  return playNarrationTrackByIndex(language, 0);
}

async function playNextNarrationTrack() {
  if (!state.narrationRequested || !state.currentNarrationTrack) return;
  const { language, index } = state.currentNarrationTrack;
  const finishingTrack = getCurrentNarrationTrackMeta();
  if (finishingTrack?.section) {
    const finishingKey = trackKey(finishingTrack.section, language);
    const phraseTrack = state.phraseTracks.get(finishingKey);
    if (phraseTrack) {
      revealTrackUpTo(phraseTrack, phraseTrack.items.length);
      phraseTrack.started = false;
    }
  }
  const tracks = getNarrationTracks(language);
  const nextIndex = index + 1;

  if (nextIndex >= tracks.length) {
    const closingSection = document.getElementById("closing");
    if (closingSection) {
      setActiveSection("closing");
      closingSection.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    state.narrationRequested = false;
    state.narrationEnabled = false;
    state.currentNarrationTrack = null;
    ensureAmbientSource();
    updateNarrationButton();
    syncUrl("replace");
    return;
  }

  try {
    await playNarrationTrackByIndex(language, nextIndex);
    state.activeCueIndex = -1;
    updateCueFromTime(getGlobalAudioSeconds());
  } catch (error) {
    state.narrationEnabled = false;
    updateNarrationButton();
  }
}

function phraseDelayMs(track) {
  const languageTimings = state.narrationTimings[track.language] || {};
  const sectionDurationSec = languageTimings[track.sectionId];
  if (isFinitePositive(sectionDurationSec) && track.items.length > 0) {
    const fromAudioMs = (sectionDurationSec * 1000) / track.items.length;
    return Math.max(420, Math.min(2600, fromAudioMs));
  }
  return fallbackPhraseDelayMs(track.sectionId);
}

function createPhraseSpan(html) {
  const span = document.createElement("span");
  span.className = "phrase-item";
  span.innerHTML = html;
  return span;
}

function prepareTextPhrases(node, trackItems) {
  if (node.dataset.phrasePrepared === "true") {
    const existing = Array.from(node.querySelectorAll(":scope > .phrase-item"));
    if (existing.length) trackItems.push(...existing);
    return;
  }

  if (node.tagName === "H1") {
    node.classList.add("phrase-item");
    node.dataset.phrasePrepared = "true";
    trackItems.push(node);
    return;
  }

  if (node.tagName !== "P") return;

  const parts = node.innerHTML.split(/<br\s*\/?>/gi);
  node.innerHTML = "";
  let addedCount = 0;

  for (const part of parts) {
    const cleaned = part.replace(/\n/g, " ").trim();
    if (!cleaned) {
      const gap = document.createElement("span");
      gap.className = "phrase-gap";
      gap.setAttribute("aria-hidden", "true");
      node.appendChild(gap);
      continue;
    }
    const phrase = createPhraseSpan(cleaned);
    node.appendChild(phrase);
    trackItems.push(phrase);
    addedCount += 1;
  }

  if (addedCount === 0) {
    node.classList.add("phrase-item");
    trackItems.push(node);
  }

  node.dataset.phrasePrepared = "true";
}

function prepareVersePhrases(node, trackItems) {
  if (node.dataset.phrasePrepared === "true") {
    const existing = Array.from(node.querySelectorAll(":scope > .phrase-item"));
    if (existing.length) trackItems.push(...existing);
    return;
  }

  const children = Array.from(node.children);

  for (let i = 0; i < children.length; i += 1) {
    const current = children[i];

    if (current.classList.contains("line-tight")) {
      current.classList.add("phrase-item");
      trackItems.push(current);
      continue;
    }

    if (current.classList.contains("verse")) {
      const pair = document.createElement("div");
      pair.className = "phrase-item verse-pair";
      current.before(pair);
      pair.appendChild(current);

      const next = children[i + 1];
      if (next && next.classList.contains("verse-ref")) {
        pair.appendChild(next);
        i += 1;
      }

      trackItems.push(pair);
      continue;
    }

    if (current.classList.contains("verse-ref")) {
      const single = document.createElement("div");
      single.className = "phrase-item verse-pair";
      current.before(single);
      single.appendChild(current);
      trackItems.push(single);
      continue;
    }

    current.classList.add("phrase-item");
    trackItems.push(current);
  }

  node.dataset.phrasePrepared = "true";
}

function preparePhraseTracks() {
  state.phraseTracks = new Map();

  for (const section of sections) {
    const languageNodes = Array.from(section.querySelectorAll(".section-inner [data-lang]"));

    for (const languageNode of languageNodes) {
      const language = languageNode.getAttribute("data-lang");
      const key = trackKey(section.id, language);
      const track =
        state.phraseTracks.get(key) || {
          sectionId: section.id,
          language,
          items: [],
          started: false,
          completed: false,
          nextIndex: 0,
          timer: null,
        };

      if (section.classList.contains("verses") && languageNode.tagName === "DIV") {
        prepareVersePhrases(languageNode, track.items);
      } else if (languageNode.matches("p, h1")) {
        prepareTextPhrases(languageNode, track.items);
      }

      state.phraseTracks.set(key, track);
    }
  }

  const privateReview = runtimeConfig.reviewMode === "private";
  for (const track of state.phraseTracks.values()) {
    if (privateReview) {
      revealTrackUpTo(track, track.items.length);
    } else {
      for (const item of track.items) {
        item.classList.remove("is-visible");
      }
    }
  }

  updateSectionPinningHeights();
}

function updateSectionPinningHeights() {
  for (const section of sections) {
    const arTrack = state.phraseTracks.get(trackKey(section.id, "ar"));
    const frTrack = state.phraseTracks.get(trackKey(section.id, "fr"));
    const phraseCount = Math.max(arTrack?.items.length || 0, frTrack?.items.length || 0, 1);
    const extraVh = Math.min(210, Math.max(0, (phraseCount - 1) * 14));
    section.style.minHeight = `calc(100svh + ${extraVh}svh)`;
  }
}

function revealTrackUpTo(track, targetCount) {
  const maxItems = track.items.length;
  const clamped = Math.max(0, Math.min(targetCount, maxItems));
  if (clamped <= track.nextIndex) return;

  for (let i = track.nextIndex; i < clamped; i += 1) {
    track.items[i].classList.add("is-visible");
  }

  track.nextIndex = clamped;
  track.completed = track.nextIndex >= maxItems;
}

function stopAllPhraseTimers() {
  for (const track of state.phraseTracks.values()) {
    if (track.timer) {
      window.clearTimeout(track.timer);
      track.timer = null;
    }
    track.started = false;
  }
}

function syncPhrasesToScrollSticky() {
  if (state.narrationEnabled) return;

  const scrollY = window.scrollY || window.pageYOffset || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 1;

  for (const section of sections) {
    const key = trackKey(section.id, state.language);
    const track = state.phraseTracks.get(key);
    if (!track || !track.items.length) continue;

    const rect = section.getBoundingClientRect();
    const targetCount = visiblePhraseTargetCount({
      rectTop: rect.top,
      rectBottom: rect.bottom,
      scrollY,
      viewportHeight: vh,
      sectionStart: section.offsetTop,
      sectionHeight: section.offsetHeight,
      itemCount: track.items.length,
    });

    revealTrackUpTo(track, targetCount);
  }
}

function revealNextPhrase(track) {
  if (track.nextIndex >= track.items.length) {
    track.completed = true;
    track.started = false;
    track.timer = null;
    return;
  }

  revealTrackUpTo(track, track.nextIndex + 1);

  const delay = phraseDelayMs(track);
  track.timer = window.setTimeout(() => {
    revealNextPhrase(track);
  }, delay);
}

function syncPhraseTrackToNarrationProgress() {
  if (!state.narrationEnabled) return;
  const meta = getCurrentNarrationTrackMeta();
  if (!meta?.section) return;

  const key = trackKey(meta.section, state.language);
  const track = state.phraseTracks.get(key);
  if (!track || !track.items.length) return;
  if (!isFinitePositive(meta.durationSec)) return;

  track.started = true;
  const progress = Math.max(0, Math.min(audio.currentTime / meta.durationSec, 1));
  let targetCount = Math.ceil(progress * track.items.length);

  // Keep the revealed name hidden until the very end of the reveal narration.
  if (track.sectionId === "reveal") {
    const nameIndex = track.items.findIndex((item) => item.classList.contains("name"));
    if (nameIndex >= 0 && progress < 0.92) {
      targetCount = Math.min(targetCount, nameIndex);
    }
  }

  revealTrackUpTo(track, targetCount);
}

function startPhraseSequenceForSection(sectionId) {
  if (!state.narrationEnabled) return;
  if (!sectionId) return;
  const key = trackKey(sectionId, state.language);
  const track = state.phraseTracks.get(key);
  if (!track || track.started || track.completed) return;

  const meta = getCurrentNarrationTrackMeta();
  if (meta?.section === sectionId && isFinitePositive(meta.durationSec)) {
    syncPhraseTrackToNarrationProgress();
    return;
  }

  track.started = true;
  revealNextPhrase(track);
}

function buildParticles(count = 12) {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < count; i += 1) {
    const particle = document.createElement("span");
    particle.className = "particle";
    particle.style.left = `${Math.random() * 100}%`;
    particle.style.top = `${62 + Math.random() * 42}%`;
    particle.style.animationDuration = `${16 + Math.random() * 14}s`;
    particle.style.animationDelay = `${Math.random() * 8}s`;
    particle.style.opacity = `${0.28 + Math.random() * 0.22}`;
    fragment.appendChild(particle);
  }
  particleField.appendChild(fragment);
}

async function loadTranscript() {
  const transcriptUrl = runtimeConfig.transcriptUrl || "../transcript.json";
  const response = await fetch(transcriptUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Transcript request failed (${response.status})`);
  }
  const payload = await response.json();
  const normalize = (track) =>
    track.map((cue) => ({
      ...cue,
      seconds: typeof cue.seconds === "number" ? cue.seconds : mmssToSeconds(cue.time),
    }));

  state.transcript.ar = normalize(payload.tracks?.ar || []);
  state.transcript.fr = normalize(payload.tracks?.fr || []);
  state.transcriptLoaded = true;
}

function setLanguage(language, { syncHistory = true, mode = "replace" } = {}) {
  stopAllPhraseTimers();
  state.language = state.supportedLanguages.includes(language)
    ? language
    : state.supportedLanguages[0] || "ar";
  state.activeCueIndex = -1;

  const root = document.documentElement;
  root.dataset.language = state.language;
  root.lang = state.language;
  root.dir = state.language === "ar" ? "rtl" : "ltr";

  if (state.supportedLanguages.length > 1) {
    const alternateLanguage = state.supportedLanguages.find((value) => value !== state.language) || state.language;
    langToggle.textContent = alternateLanguage.toUpperCase();
    langToggle.setAttribute(
      "aria-label",
      alternateLanguage === "fr" ? "Passer en français" : "التحويل إلى العربية",
    );
    langToggle.disabled = false;
  } else {
    langToggle.textContent = state.language.toUpperCase();
    langToggle.setAttribute("aria-label", "Single language page");
    langToggle.disabled = true;
  }

  updateCueFromTime(getGlobalAudioSeconds());
  startPhraseSequenceForSection(state.activeSectionId || sections[0]?.id);
  if (state.narrationEnabled) {
    void playNarrationForSection(state.language, state.activeSectionId || sections[0]?.id);
  } else {
    syncPhrasesToScrollSticky();
  }

  updateStartNarrationCta();
  if (syncHistory) syncUrl(mode);
}

function setActiveSection(sectionId) {
  if (!sectionId || state.activeSectionId === sectionId) return;
  state.activeSectionId = sectionId;

  for (const section of sections) {
    section.classList.toggle("is-current", section.id === sectionId);
  }

  startPhraseSequenceForSection(sectionId);
  if (state.narrationEnabled) {
    void playNarrationForSection(state.language, sectionId);
  } else {
    syncPhrasesToScrollSticky();
  }
}

function findCueIndex(seconds) {
  const cues = state.transcript[state.language];
  if (!cues.length) return -1;

  for (let i = cues.length - 1; i >= 0; i -= 1) {
    if (seconds >= cues[i].seconds) return i;
  }
  return 0;
}

function updateCueFromTime(seconds) {
  if (!state.narrationEnabled) return;
  const cueIndex = findCueIndex(seconds);
  if (cueIndex < 0 || cueIndex === state.activeCueIndex) return;

  // Cue index changes are the trigger for highlight + optional auto-scroll.
  const cue = state.transcript[state.language][cueIndex];
  const currentTrack = getCurrentNarrationTrackMeta();
  if (currentTrack?.section && cue.section !== currentTrack.section) return;

  state.activeCueIndex = cueIndex;
  setActiveSection(cue.section);
  autoScrollNarrationSection(cue.section, { force: true });
}

function updateNarrationButton() {
  if (privateReview) {
    state.narrationRequested = false;
    state.narrationEnabled = false;
    narrationToggle.hidden = true;
    narrationToggle.disabled = true;
    updateStartNarrationCta();
    return;
  }
  narrationToggle.classList.toggle("is-active", state.narrationRequested);
  if (!state.narrationRequested) {
    narrationToggle.textContent = "Narration Off";
    updateStartNarrationCta();
    return;
  }
  narrationToggle.textContent = state.narrationEnabled ? "Narration On" : "Narration On (Tap)";
  updateStartNarrationCta();
}

function updateStartNarrationCta() {
  if (!startNarrationCta) return;
  const shouldShow =
    !privateReview &&
    state.narrationRequested &&
    !state.narrationEnabled &&
    !narrationToggle.disabled;

  startNarrationCta.classList.toggle("is-visible", shouldShow);
  startNarrationCta.setAttribute("aria-hidden", shouldShow ? "false" : "true");
  startNarrationCta.textContent =
    state.language === "ar" ? "اضغط لبدء السرد الصوتي" : "Touchez pour démarrer la narration";
}

async function setNarration(enabled, { syncHistory = true, mode = "replace" } = {}) {
  if (privateReview) {
    state.narrationRequested = false;
    state.narrationEnabled = false;
    state.currentNarrationTrack = null;
    audio.pause();
    audio.removeAttribute("src");
    updateNarrationButton();
    if (syncHistory) syncUrl(mode);
    return;
  }
  state.narrationRequested = Boolean(enabled);

  if (
    shouldLoadNarrationResources({
      privateReview,
      narrationRequested: state.narrationRequested,
    }) &&
    !state.narrationTimingsLoaded
  ) {
    await loadNarrationTimings();
  }

  if (enabled) {
    try {
      const playedTrack = await playNarrationForSection(
        state.language,
        state.activeSectionId || sections[0]?.id,
      );
      if (!playedTrack) {
        ensureAmbientSource();
        await audio.play();
        state.currentNarrationTrack = null;
      }
      state.narrationEnabled = true;
      state.lastNarrationAutoScrollAt = 0;
      state.activeCueIndex = -1;
      syncPhraseTrackToNarrationProgress();
      updateCueFromTime(getGlobalAudioSeconds());
      const current = getCurrentNarrationTrackMeta();
      autoScrollNarrationSection(current?.section || state.activeSectionId, { force: true });
    } catch (error) {
      state.narrationEnabled = false;
      state.currentNarrationTrack = null;
      stopAllPhraseTimers();
      syncPhrasesToScrollSticky();
    }
  } else {
    audio.pause();
    ensureAmbientSource();
    state.narrationEnabled = false;
    state.currentNarrationTrack = null;
    state.activeCueIndex = -1;
    stopAllPhraseTimers();
    syncPhrasesToScrollSticky();
  }

  updateNarrationButton();
  if (syncHistory) syncUrl(mode);
}

function setupParallax() {
  // rAF throttling keeps transforms smooth without flooding layout on scroll.
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(() => {
      const y = window.scrollY;
      for (const layer of parallaxLayers) {
        const depth = Number(layer.dataset.depth || 0);
        layer.style.transform = `translate3d(0, ${y * depth}px, 0)`;
      }
      syncPhrasesToScrollSticky();
      ticking = false;
    });
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

function setupRevealObserver() {
  // Reveal content once it enters view to preserve the cinematic pacing.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
        }
      }
    },
    { threshold: 0.2, rootMargin: "0px 0px -8% 0px" },
  );

  for (const item of revealItems) {
    observer.observe(item);
  }
}

function setupSectionObserver() {
  // In manual mode, section focus follows viewport instead of audio time.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !state.narrationEnabled) {
          setActiveSection(entry.target.id);
        }
      }
    },
    { threshold: 0.6 },
  );

  for (const section of sections) {
    observer.observe(section);
  }
}

function setupControls() {
  langToggle.addEventListener("click", () => {
    const alternateLanguage = state.supportedLanguages.find((language) => language !== state.language);
    if (!alternateLanguage) return;
    setLanguage(alternateLanguage, { mode: "push" });
  });

  if (privateReview) return;

  narrationToggle.addEventListener("click", async () => {
    await setNarration(!state.narrationRequested);
  });
  startNarrationCta?.addEventListener("click", async () => {
    await setNarration(true);
  });

  audio.addEventListener("timeupdate", () => {
    if (!state.narrationEnabled) return;
    syncPhraseTrackToNarrationProgress();
    updateCueFromTime(getGlobalAudioSeconds());
  });

  audio.addEventListener("play", () => {
    if (!state.narrationRequested) return;
    state.narrationEnabled = true;
    updateNarrationButton();
  });

  audio.addEventListener("pause", () => {
    if (audio.ended) return;
    state.narrationEnabled = false;
    updateNarrationButton();
  });

  audio.addEventListener("ended", () => {
    if (!state.narrationRequested) return;
    void playNextNarrationTrack();
  });

  audio.addEventListener("error", () => {
    state.narrationRequested = false;
    state.narrationEnabled = false;
    state.currentNarrationTrack = null;
    narrationToggle.textContent = "Narration Unavailable";
    narrationToggle.disabled = true;
    updateStartNarrationCta();
    syncUrl("replace");
  });

  const attemptNarrationRetry = async () => {
    if (state.narrationRetryInFlight) return;
    if (!state.narrationRequested || state.narrationEnabled || narrationToggle.disabled) return;
    state.narrationRetryInFlight = true;
    try {
      await setNarration(true, { syncHistory: false });
    } finally {
      state.narrationRetryInFlight = false;
    }
  };

  // Browsers may block autoplay; retry once users interact while narration mode is requested.
  window.addEventListener(
    "pointerdown",
    () => {
      void attemptNarrationRetry();
    },
    { passive: true },
  );
  window.addEventListener("keydown", () => {
    void attemptNarrationRetry();
  });

  window.addEventListener("popstate", async () => {
    const urlState = readUrlState();
    setLanguage(urlState.language, { syncHistory: false });
    await setNarration(urlState.narration, { syncHistory: false });
  });
}

async function init() {
  if (privateReview) {
    narrationToggle.hidden = true;
    narrationToggle.disabled = true;
  }
  if (state.supportedLanguages.length < 2) {
    langToggle.hidden = true;
  }
  buildParticles();
  preparePhraseTracks();
  if (privateReview) {
    state.narrationTimingsLoaded = true;
  }
  setupParallax();
  setupRevealObserver();
  setupSectionObserver();
  setupControls();
  updateNarrationButton();

  if (!privateReview) {
    try {
      await loadTranscript();
    } catch (error) {
      // Narration can still play without transcript-driven cue updates.
    }
  } else {
    state.transcriptLoaded = true;
  }

  const urlState = readUrlState();
  setLanguage(urlState.language, { syncHistory: false });
  if (!privateReview) {
    await setNarration(urlState.narration, { syncHistory: false });
  }

  setActiveSection("intro");
  syncUrl("replace");
}

init();
