import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { exportSyntheticDemo } from "../../src/demo/synthetic-demo.mjs";

const EXPECTED_PUBLIC_STATES = [
  "payment_pending",
  "payment_pending",
  "generation_pending",
  "review_required",
  "publication_ready",
  "delivery_ready",
  "complete",
];

test("synthetic demo exports two deterministic canonical workflows and reachable announcement slugs", async (t) => {
  const first = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-demo-first-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-demo-second-"));
  t.after(() => rm(first, { recursive: true, force: true }));
  t.after(() => rm(second, { recursive: true, force: true }));

  const previousUrl = path.join(first, "announcements", "previously-delivered", "fr", "index.html");
  const previousBytes = Buffer.from([0x3c, 0x68, 0x31, 0x3e, 0xc3, 0xa9, 0x3c, 0x2f, 0x68, 0x31, 0x3e]);
  await mkdir(path.dirname(previousUrl), { recursive: true });
  await writeFile(previousUrl, previousBytes);

  const staleGeneratedFile = path.join(first, "announcements", "amal", "stale.txt");
  await mkdir(path.dirname(staleGeneratedFile), { recursive: true });
  await writeFile(staleGeneratedFile, "stale partial export\n", "utf8");

  const firstManifest = await exportSyntheticDemo({ outputRoot: first });
  const secondManifest = await exportSyntheticDemo({ outputRoot: second });

  assert.equal(firstManifest.mode, "synthetic-demo");
  assert.deepEqual(firstManifest.price, { amountMinor: 3900, currency: "EUR", display: "39 €" });
  assert.equal(firstManifest.announcements.length, 2);
  assert.equal(new Set(firstManifest.announcements.map(({ slug }) => slug)).size, 2);

  for (const announcement of firstManifest.announcements) {
    assert.match(announcement.intake.customer.email, /^[^@]+@[^@]+\.test$/);
    assert.equal(announcement.intake.customer.consent, true);
    assert.equal(announcement.simulated, true);
    assert.deepEqual(
      announcement.timeline.map(({ status }) => status),
      EXPECTED_PUBLIC_STATES,
    );
    assert.deepEqual(
      announcement.timeline.map((entry) => entry.label),
      [
        "Intake reçu",
        "Checkout simulé",
        "Paiement confirmé",
        "Brouillon généré",
        "Révision éditoriale",
        "Publication simulée",
        "Livraison confirmée",
      ],
    );
    assert.equal(announcement.timeline.at(-1).revisionId, "r1");
    assert.equal(announcement.timeline.at(-1).publishedRevisionId, "r1");
    assert.equal(announcement.timeline.at(-1).stableUrl, announcement.path);
    const announcementHtml = await readFile(path.join(first, announcement.path, "index.html"), "utf8");
    assert.doesNotMatch(announcementHtml, /fonts\.(?:googleapis|gstatic)\.com/i);
    const styles = await readFile(path.join(
      first,
      "announcements",
      announcement.slug,
      "_assets",
      "blessed-arrival-1-0-0-r1",
      "styles.css",
    ), "utf8");
    assert.doesNotMatch(styles, /fonts\.(?:googleapis|gstatic)\.com/i);
  }

  assert.deepEqual(
    JSON.parse(await readFile(path.join(first, "workflow.json"), "utf8")),
    firstManifest,
  );
  assert.deepEqual(await readFile(previousUrl), previousBytes);
  await assert.rejects(readFile(staleGeneratedFile), { code: "ENOENT" });
  assert.deepEqual(secondManifest, firstManifest);
  assert.equal(
    await readFile(path.join(second, "workflow.json"), "utf8"),
    await readFile(path.join(first, "workflow.json"), "utf8"),
  );
  for (const { slug } of firstManifest.announcements) {
    assert.deepEqual(
      await snapshotTree(path.join(second, "announcements", slug)),
      await snapshotTree(path.join(first, "announcements", slug)),
    );
  }
});

test("a failed staged export restores every generated slug without partial writes", async (t) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-demo-rollback-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  const priorAnnouncement = path.join(outputRoot, "announcements", "amal", "fr", "index.html");
  const priorBytes = Buffer.from("previous Amal delivery\n", "utf8");
  const manifestBlocker = path.join(outputRoot, "workflow.json", "keep.txt");
  await mkdir(path.dirname(priorAnnouncement), { recursive: true });
  await writeFile(priorAnnouncement, priorBytes);
  await mkdir(path.dirname(manifestBlocker), { recursive: true });
  await writeFile(manifestBlocker, "existing manifest path\n", "utf8");

  await assert.rejects(exportSyntheticDemo({ outputRoot }));

  assert.deepEqual(await readFile(priorAnnouncement), priorBytes);
  assert.equal(await readFile(manifestBlocker, "utf8"), "existing manifest path\n");
  await assert.rejects(
    readFile(path.join(outputRoot, "announcements", "bayane", "fr", "index.html")),
    { code: "ENOENT" },
  );
});

test("exports reject a symlinked announcements root without touching its target", async (t) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-demo-symlink-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-demo-outside-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));

  const outsideAnnouncement = path.join(outsideRoot, "previously-delivered", "fr", "index.html");
  const outsideBytes = Buffer.from("outside the export root\n", "utf8");
  await mkdir(path.dirname(outsideAnnouncement), { recursive: true });
  await writeFile(outsideAnnouncement, outsideBytes);
  await symlink(outsideRoot, path.join(outputRoot, "announcements"), "dir");

  await assert.rejects(
    exportSyntheticDemo({ outputRoot }),
    /announcements root must be a real directory/,
  );

  assert.deepEqual(await readFile(outsideAnnouncement), outsideBytes);
  await assert.rejects(readFile(path.join(outsideRoot, "amal", "fr", "index.html")), {
    code: "ENOENT",
  });
});

test("exports reject a nonexistent output beneath a symlinked ancestor before writing", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-demo-ancestor-"));
  const physicalParent = path.join(directory, "physical");
  const linkedParent = path.join(directory, "alias");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(physicalParent);
  await symlink(physicalParent, linkedParent, "dir");

  await assert.rejects(
    exportSyntheticDemo({ outputRoot: path.join(linkedParent, "demo") }),
    /output path contains a symbolic link/,
  );

  assert.deepEqual(await readdir(physicalParent), []);
});

test("concurrent exports are serialized before either can clobber rollback state", async (t) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-demo-concurrent-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  const results = await Promise.allSettled([
    exportSyntheticDemo({ outputRoot }),
    exportSyntheticDemo({ outputRoot }),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = results.find(({ status }) => status === "rejected");
  assert.match(rejected.reason.message, /export is already in progress/);

  const manifest = JSON.parse(await readFile(path.join(outputRoot, "workflow.json"), "utf8"));
  assert.equal(manifest.announcements.length, 2);
  for (const announcement of manifest.announcements) {
    await readFile(path.join(outputRoot, announcement.path, "index.html"));
  }
  assert.deepEqual(await exportSyntheticDemo({ outputRoot }), manifest);
});

async function snapshotTree(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
  return Promise.all(files.map(async (file) => ({
    file,
    bytes: (await readFile(path.join(root, file))).toString("base64"),
  })));
}
