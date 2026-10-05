import { createHash } from "node:crypto";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw new Error("Owner trial public playback projection rejected."); };
const privateText = /z@havesomecode\.io|specificDemands|customerEmail|intakeDigest|approvalId|providerReceiptId|ticketSecret|storageId|private-preview|https?:\/\/|<\/script|<script/iu;
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) => plain(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
function decode(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail(); }
}
function configuration(html) {
  const matches = [...html.matchAll(/window\.__ANNOUNCEMENT_CONFIG__\s*=\s*(\{[^{}]*\})\s*;/gu)];
  if (matches.length !== 1) fail();
  // The approved renderer emits JSON values with identifier-shaped keys. Parse
  // only that format; never execute caller-supplied JavaScript.
  let value;
  try { value = JSON.parse(matches[0][1].replace(/([{,]\s*)([A-Za-z][A-Za-z0-9]*)\s*:/gu, '$1"$2":')); } catch { fail(); }
  if (!keys(value, ["supportedLanguages", "transcriptUrl", "assetBasePath", "reviewMode", "ambientAudioUrl"])
    || JSON.stringify(value.supportedLanguages) !== '["fr","ar"]'
    || !/^\.\.\/_assets\/[a-z0-9]+(?:-[a-z0-9]+){0,30}$/u.test(value.assetBasePath)
    || !["private", null].includes(value.reviewMode)
    || typeof value.transcriptUrl !== "string" || typeof value.ambientAudioUrl !== "string") fail();
  return { match: matches[0][0], value };
}

export function projectOwnerTrialPlayback({ files, transcriptBytes }) {
  if (!Array.isArray(files) || !Buffer.isBuffer(transcriptBytes)) fail();
  let transcript;
  try { transcript = JSON.parse(decode(transcriptBytes)); } catch { fail(); }
  if (!keys(transcript, ["version", "tracks"]) || transcript.version !== 1 || !keys(transcript.tracks, ["fr", "ar"])) fail();
  const paths = new Set(), audio = new Map();
  for (const file of files) {
    if (typeof file?.publicPath !== "string" || !Buffer.isBuffer(file.bytes) || paths.has(file.publicPath)
      || !/^[A-Za-z0-9_][A-Za-z0-9/_.-]*$/u.test(file.publicPath) || file.publicPath.split("/").some(part => part === ".." || part === "." || !part)) fail();
    paths.add(file.publicPath);
    if (file.publicPath.startsWith("artifacts/audio/")) {
      if (!/^artifacts\/audio\/(fr|ar)\/[a-z0-9]+(?:-[a-z0-9]+)*\.mp3$/u.test(file.publicPath)) fail();
      audio.set(file.publicPath, file);
    }
  }
  const output = [], languageConfigs = new Map();
  for (const file of files) {
    if (!/^(fr|ar)\/index\.html$/u.test(file.publicPath)) { output.push({ ...file }); continue; }
    const language = file.publicPath.split("/")[0], html = decode(file.bytes), parsed = configuration(html);
    languageConfigs.set(language, parsed.value);
    const value = { ...parsed.value, transcriptUrl: "../transcript.json", reviewMode: null, ambientAudioUrl: "" };
    const bytes = Buffer.from(html.replace(parsed.match, `window.__ANNOUNCEMENT_CONFIG__ = ${JSON.stringify(value)};`));
    output.push({ ...file, bytes, sha256: sha(bytes) });
  }
  if (languageConfigs.size !== 2 || languageConfigs.get("fr").assetBasePath !== languageConfigs.get("ar").assetBasePath) fail();
  const runtime = languageConfigs.get("fr").assetBasePath.slice(3), order = [];
  let audioCount = 0;
  for (const language of ["fr", "ar"]) {
    const cues = transcript.tracks[language];
    if (!Array.isArray(cues) || cues.length === 0 || cues.length > 50) fail();
    const sections = new Set(), manifest = [], languageOrder = [];
    let previous = -1;
    for (const cue of cues) {
      if (!keys(cue, ["section", "text", "time", "seconds"]) || typeof cue.section !== "string"
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(cue.section) || sections.has(cue.section)
        || typeof cue.text !== "string" || !cue.text.trim() || privateText.test(cue.text)
        || typeof cue.time !== "string" || !/^\d{2,3}:\d{2}$/u.test(cue.time)
        || typeof cue.seconds !== "number" || !Number.isFinite(cue.seconds) || cue.seconds < 0 || cue.seconds < previous) fail();
      const [minutes, seconds] = cue.time.split(":").map(Number);
      if (seconds >= 60 || Math.floor(cue.seconds) !== minutes * 60 + seconds) fail();
      previous = cue.seconds; sections.add(cue.section); languageOrder.push(cue.section);
      const path = `artifacts/audio/${language}/${cue.section}.mp3`, file = audio.get(path);
      if (!file) fail();
      manifest.push({ section: cue.section, file: `../${path}`, startSec: cue.seconds, sha256: sha(file.bytes), bytes: file.bytes.length });
      audioCount++;
    }
    if (language === "fr") order.push(...languageOrder);
    else if (JSON.stringify(order) !== JSON.stringify(languageOrder)) fail();
    const publicPath = `${runtime}/audio/narration/${language}/manifest.json`;
    if (paths.has(publicPath)) fail();
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, language, files: manifest }, null, 2)}\n`);
    output.push({ path: publicPath, publicPath, bytes, sha256: sha(bytes) });
  }
  if (audioCount !== audio.size || paths.has("transcript.json")) fail();
  const bytes = Buffer.from(`${JSON.stringify(transcript, null, 2)}\n`);
  output.push({ path: "transcript.json", publicPath: "transcript.json", bytes, sha256: sha(bytes) });
  return output;
}
