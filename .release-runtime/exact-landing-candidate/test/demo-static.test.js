import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, javascript, css] = await Promise.all([
  readFile(new URL("../demo.html", import.meta.url), "utf8"),
  readFile(new URL("../src/demo.js", import.meta.url), "utf8"),
  readFile(new URL("../src/demo.css", import.meta.url), "utf8"),
]);

test("synthetic demo is unmistakable, closed to arbitrary personal data, and resettable", () => {
  assert.match(html, /Démonstration synthétique/i);
  assert.match(html, /Aucun paiement réel/i);
  assert.match(html, /id="profile-select"/);
  assert.match(html, /<option value="amal">Amal — profil fictif<\/option>/);
  assert.match(html, /<option value="bayane">Bayane — profil fictif<\/option>/);
  assert.doesNotMatch(html, /<input|<textarea/i);
  assert.match(html, /id="reset-demo"/);
  assert.match(html, /id="advance-demo"/);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(javascript, /https?:\/\//i);
  assert.match(javascript, /fetch\("\.\/demo\/workflow\.json"/);
  assert.match(javascript, /playback\.reset\(\)/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /:focus-visible/);
});
