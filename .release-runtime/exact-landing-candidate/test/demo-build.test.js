import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [config, vercel] = await Promise.all([
  readFile(new URL("../vite.config.js", import.meta.url), "utf8"),
  readFile(new URL("../vercel.json", import.meta.url), "utf8"),
]);

test("production build includes the landing and synthetic demo entrypoints", () => {
  assert.match(config, /index:\s*resolve\(__dirname,\s*"index\.html"\)/);
  assert.match(config, /demo:\s*resolve\(__dirname,\s*"demo\.html"\)/);
  assert.match(vercel, /"source": "\/demo",\s*"destination": "\/demo\.html"/s);
});
