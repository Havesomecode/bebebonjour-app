import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  t.after(() => rm(first, { recursive: true, force: true }));

  const firstManifest = await exportSyntheticDemo({ outputRoot: first });

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
});
