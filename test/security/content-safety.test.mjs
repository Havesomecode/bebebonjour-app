import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderHtml } from "../../scripts/lib/render-html.mjs";

test("renderer treats hostile customer/model text as text across SEO, story, reveal and verse fields", async () => {
  const page = JSON.parse(await readFile(new URL("../../data/examples/bayane/page.json", import.meta.url)));
  const hostile = '<script>alert("owned")</script><img src=x onerror="alert(1)">';
  page.seo.title = hostile;
  page.seo.description = hostile;
  for (const section of Object.values(page.sections)) for (const entry of Object.values(section)) {
    for (const key of ["displayLines", "introLines"]) if (entry[key]) entry[key] = [hostile];
    for (const key of ["name", "introLine"]) if (entry[key]) entry[key] = hostile;
    for (const item of entry.items || []) for (const key of ["quote", "reference", "sourceArabic"]) item[key] = hostile;
  }
  const html = renderHtml({ page, language: "fr", assetBasePath: "./assets",
    transcriptUrl: "./transcript.json", ambientAudioUrl: "", reviewMode: "private" });
  assert.equal(html.includes(hostile), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<script>alert'), false);
  assert.match(html, /&lt;script&gt;alert\(&quot;owned&quot;\)&lt;\/script&gt;/);
  assert.equal((html.match(/<script(?:\s|>)/g) || []).length, 2);
});
