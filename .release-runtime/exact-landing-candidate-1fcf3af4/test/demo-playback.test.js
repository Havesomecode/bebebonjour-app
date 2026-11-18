import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createDemoPlayback } from "../src/demo-playback.js";

const manifest = JSON.parse(await readFile(
  new URL("../public/demo/workflow.json", import.meta.url),
  "utf8",
));

test("demo playback advances only through canonical projections and resets deterministically", () => {
  const playback = createDemoPlayback(manifest);

  assert.equal(playback.snapshot().announcement.slug, "amal");
  assert.equal(playback.snapshot().step.key, "intake");
  assert.equal(playback.snapshot().completed, false);
  assert.throws(() => playback.select("not-built-in"), /built-in synthetic profile/i);

  for (let index = 0; index < 20; index += 1) playback.advance();
  const completed = playback.snapshot();
  assert.equal(completed.completed, true);
  assert.equal(completed.step.status, "complete");
  assert.equal(completed.announcementPath, "demo/announcements/amal/fr/");

  playback.reset();
  assert.equal(playback.snapshot().announcement.slug, "amal");
  assert.equal(playback.snapshot().step.key, "intake");
  assert.equal(playback.snapshot().completed, false);

  playback.select("bayane");
  assert.equal(playback.snapshot().announcement.slug, "bayane");
  assert.equal(playback.snapshot().step.key, "intake");
});
