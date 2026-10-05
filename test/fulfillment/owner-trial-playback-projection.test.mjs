import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { projectOwnerTrialPlayback } from "../../src/fulfillment/owner-trial-playback-projection.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const sections = ["intro", "dua"];
  const config = `window.__ANNOUNCEMENT_CONFIG__ = {supportedLanguages: ["fr","ar"], transcriptUrl: "", assetBasePath: "../_assets/bundle-r1", reviewMode: "private", ambientAudioUrl: ""};`;
  const files = ["fr", "ar"].map(language => ({ path: `deploy/${language}/index.html`, publicPath: `${language}/index.html`, bytes: Buffer.from(`<html><head></head><body><p>${language} approved text</p><script>${config}</script></body></html>`) }));
  for (const language of ["fr", "ar"]) for (const section of sections) {
    files.push({ path: `artifacts/audio/${language}/${section}.mp3`, publicPath: `artifacts/audio/${language}/${section}.mp3`, bytes: Buffer.from(`approved-${language}-${section}`) });
  }
  for (const name of ["app.js", "phrase-progress.mjs", "styles.css", "og-image.svg"]) {
    files.push({ path: `deploy/_assets/bundle-r1/${name}`, publicPath: `_assets/bundle-r1/${name}`, bytes: Buffer.from(`approved-${name}`) });
  }
  for (const file of files) file.sha256 = sha(file.bytes);
  const transcript = { version: 1, tracks: Object.fromEntries(["fr", "ar"].map(language => [language, sections.map((section, index) => ({ section, text: `${language} approved ${section}`, time: `00:0${index * 3}`, seconds: index * 3 }))])) };
  return { files, transcriptBytes: Buffer.from(JSON.stringify(transcript)), transcript };
}

test("public playback projects approved cues, exact audio and public controls without altering input", () => {
  const f = fixture(), original = structuredClone(f.files);
  const result = projectOwnerTrialPlayback(f);
  assert.equal(result.length, f.files.length + 3);
  for (const file of result) assert.equal(file.sha256, sha(file.bytes));
  for (const language of ["fr", "ar"]) {
    const html = result.find(file => file.publicPath === `${language}/index.html`).bytes.toString();
    assert.match(html, /"reviewMode":null/u);
    assert.match(html, /"transcriptUrl":"\.\.\/transcript.json"/u);
    assert.match(html, new RegExp(`${language} approved text`));
    const manifest = JSON.parse(result.find(file => file.publicPath === `_assets/bundle-r1/audio/narration/${language}/manifest.json`).bytes);
    assert.deepEqual(manifest.files.map(file => file.file), ["intro", "dua"].map(section => `../artifacts/audio/${language}/${section}.mp3`));
    for (const file of manifest.files) assert.equal(file.sha256, result.find(item => item.publicPath === file.file.slice(3)).sha256);
  }
  assert.deepEqual(JSON.parse(result.find(file => file.publicPath === "transcript.json").bytes), f.transcript);
  for (let index = 0; index < original.length; index++) assert.deepEqual(f.files[index], { ...original[index], bytes: Buffer.from(original[index].bytes) });
});

for (const mode of ["privateField", "externalText", "scriptText", "unknownLanguage", "extraCue", "duplicateCue", "missingAudio", "extraAudio", "configMissing", "configDuplicate", "foreignRuntime", "trackOrder", "badTime", "invalidUtf8"]) {
  test(`public playback rejects ${mode}`, () => {
    const f = fixture();
    if (mode === "privateField") f.transcript.tracks.fr[0].customerEmail = "private@example.test";
    if (mode === "externalText") f.transcript.tracks.fr[0].text = "https://offline.convex.site/completion/artifact?token=private";
    if (mode === "scriptText") f.transcript.tracks.fr[0].text = "</script><script>alert(1)</script>";
    if (mode === "unknownLanguage") f.transcript.tracks.en = [];
    if (mode === "extraCue") f.transcript.tracks.fr.push({ section: "private", text: "unknown", time: "00:09", seconds: 9 });
    if (mode === "duplicateCue") f.transcript.tracks.fr[1].section = "intro";
    if (mode === "missingAudio") f.files.splice(f.files.findIndex(file => file.publicPath === "artifacts/audio/ar/dua.mp3"), 1);
    if (mode === "extraAudio") f.files.push({ path: "artifacts/audio/ar/private.mp3", publicPath: "artifacts/audio/ar/private.mp3", bytes: Buffer.from("extra"), sha256: sha(Buffer.from("extra")) });
    if (mode === "configMissing") f.files[0].bytes = Buffer.from("<html><head></head><body>no config</body></html>");
    if (mode === "configDuplicate") f.files[0].bytes = Buffer.concat([f.files[0].bytes, f.files[0].bytes]);
    if (mode === "foreignRuntime") f.files[0].bytes = Buffer.from(f.files[0].bytes.toString().replace("../_assets/bundle-r1", "https://attacker.example.test/assets"));
    if (mode === "trackOrder") f.transcript.tracks.ar.reverse();
    if (mode === "badTime") f.transcript.tracks.fr[0].seconds = -1;
    f.transcriptBytes = mode === "invalidUtf8" ? Buffer.from([255]) : Buffer.from(JSON.stringify(f.transcript));
    assert.throws(() => projectOwnerTrialPlayback(f), /Owner trial public playback/u);
  });
}
