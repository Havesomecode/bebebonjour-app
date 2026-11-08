import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".verification", ".tools"].includes(entry.name)) continue;
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) await check(path);
    else if (/\.(mjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ["--check", fileURLToPath(path)], { stdio: "inherit" });
      if (result.status !== 0) throw new Error("Candidate syntax check failed.");
    }
  }
}
await check(new URL("./", import.meta.url));
console.log("candidate_syntax_ok");
