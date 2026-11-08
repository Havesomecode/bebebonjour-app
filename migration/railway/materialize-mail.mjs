import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CORRECTED_MAIL_COMMIT = "bf94f9a01057664b996a41ddde4ed94717b3fa03";
const paths = ["src/fulfillment/cloudflare-delivery-adapter.mjs", "src/fulfillment/cloudflare-email-transport.mjs"];

// Read immutable Git objects; never checkout, patch, or edit a peer worktree.
export async function materializeCorrectedMail() {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const git = (...args) => execFileSync("git", ["--no-optional-locks", ...args], {
    cwd: repository, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  git("verify-commit", CORRECTED_MAIL_COMMIT);
  const tree = git("rev-parse", `${CORRECTED_MAIL_COMMIT}^{tree}`).toString().trim();
  const entries = git("ls-tree", "-rlz", CORRECTED_MAIL_COMMIT, "--", ...paths).toString().split("\0").filter(Boolean).map((line) => {
    const match = /^(100644) blob ([a-f0-9]{40})\s+(\d+)\t(.+)$/.exec(line);
    assert.ok(match, "Only accepted regular source blobs can be materialized.");
    return { mode: match[1], blob: match[2], size: Number(match[3]), path: match[4] };
  });
  assert.deepEqual(entries.map((e) => e.path).sort(), [...paths].sort());
  const archive = git("archive", "--format=tar", CORRECTED_MAIL_COMMIT, "--", ...paths);
  const members = execFileSync("tar", ["-tf", "-"], { input: archive }).toString().trim().split("\n");
  assert.ok(members.every((member) => ["src/", "src/fulfillment/", ...paths].includes(member)), "Archive boundary must remain exact.");
  const parent = fileURLToPath(new URL(".verification/", import.meta.url));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(parent, "mail-r1-"));
  execFileSync("tar", ["-xf", "-", "-C", root], { input: archive });
  const files = [];
  for (const entry of entries) {
    const destination = path.join(root, entry.path);
    const stat = await lstat(destination);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const bytes = await readFile(destination);
    assert.equal(bytes.length, entry.size);
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    assert.equal(blob, entry.blob, "Materialized bytes must match the accepted Git blob.");
    files.push({ ...entry, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const receipt = { commit: CORRECTED_MAIL_COMMIT, tree, files };
  await writeFile(path.join(root, "materialization.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return { root, receipt };
}
