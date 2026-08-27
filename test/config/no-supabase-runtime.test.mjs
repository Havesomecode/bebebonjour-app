import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const activeRoots = ["api", "src", "scripts", "convex"];
const activeFiles = ["package.json", "package-lock.json", ".env.example", "LIVE_SETUP.md", "README.md"];

test("active production source has no Supabase dependency, adapter, config, or setup references", async () => {
  const offenders = [];
  for (const relative of activeRoots) {
    await scan(new URL(`${relative}/`, root), relative, offenders);
  }
  for (const relative of activeFiles) {
    const content = await readFile(new URL(relative, root), "utf8");
    if (/supabase/i.test(content)) offenders.push(relative);
  }

  assert.deepEqual(offenders, []);
  await assert.rejects(stat(new URL("supabase/", root)), (error) => error.code === "ENOENT");
});

async function scan(directory, relativeDirectory, offenders) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${relativeDirectory}/${entry.name}`;
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) {
      await scan(url, relative, offenders);
    } else if (/\.(?:js|mjs|cjs|json|md|sh)$/.test(entry.name)) {
      const content = await readFile(url, "utf8");
      if (/supabase/i.test(content)) offenders.push(relative);
    }
  }
}
