import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const fulfillmentClient = await readFile(
  new URL("../src/fulfillment-client.js", import.meta.url),
  "utf8",
);
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const vercel = JSON.parse(
  await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
);

const hostedOrigin = "https://bebebonjour-fulfillment.vercel.app";

test("static landing cannot expose legacy provider links or hidden gated actions", () => {
  assert.doesNotMatch(html, /tally\.so|buy\.stripe\.com/i);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(css, /https?:\/\//i);
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
  assert.match(main, /const delivered = status\.status === "complete"/);
  assert.match(main, /announcementLink\.hidden\s*=\s*!delivered/);
});

test("landing exposes the synthetic workflow without replacing the TEST-A intake", () => {
  assert.match(html, /href="\/demo"[^>]*>Voir la démo du parcours<\/a>/);
  assert.match(html, /id="intake-form"/);
});

test("hosted TEST-A configuration pins the API base in executable source", () => {
  assert.doesNotMatch(main, /VITE_FULFILLMENT_API_APPROVED_HOSTED_ORIGIN/);
  assert.match(fulfillmentClient, new RegExp(
    `const CANONICAL_HOSTED_API_BASE_URL = ${JSON.stringify(`${hostedOrigin}/api/customer-flow`)}`,
  ));
  assert.match(main, /getTestAccessToken:\s*requestTestAccessToken/);
  assert.match(main, /window\.prompt\(/);
  assert.doesNotMatch(main, /VITE_[A-Z_]*TEST_ACCESS_TOKEN/);
});

test("hosted TEST-A configuration remains pinned to the canonical API origin", () => {
  const assignments = [...readme.matchAll(
    /^VITE_FULFILLMENT_API_[A-Z_]+=\S+$/gm,
  )].map(([assignment]) => assignment);

  assert.deepEqual(assignments, [
    `VITE_FULFILLMENT_API_BASE_URL=${hostedOrigin}/api/customer-flow`,
  ]);
});

test("Vercel CSP permits only self and the canonical hosted API connection", () => {
  const cspHeaders = vercel.headers
    .flatMap(({ headers }) => headers)
    .filter(({ key }) => key === "Content-Security-Policy");
  assert.equal(cspHeaders.length, 1);

  const directiveEntries = cspHeaders[0].value.split(";").map((directive) => {
    const [name, ...sources] = directive.trim().split(/\s+/);
    return [name, sources];
  });
  assert.equal(
    new Set(directiveEntries.map(([name]) => name)).size,
    directiveEntries.length,
  );

  const directives = Object.fromEntries(directiveEntries);

  assert.deepEqual(directives, {
    "default-src": ["'self'"],
    "base-uri": ["'self'"],
    "connect-src": ["'self'", hostedOrigin],
    "font-src": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "img-src": ["'self'", "data:"],
    "object-src": ["'none'"],
    "script-src": ["'self'"],
    "style-src": ["'self'", "'unsafe-inline'"],
  });
});

test("hosted TEST-A operating notes preserve the synthetic-only privacy boundary", () => {
  assert.match(html, /uniquement des informations synthétiques/);
  assert.match(html, /Aucun paiement réel ni email client n’est envoyé/);
  assert.doesNotMatch(readme, /VITE_FULFILLMENT_API_APPROVED_HOSTED_ORIGIN/);
  assert.match(readme, /memory only/i);
  assert.match(readme, /Content-Security-Policy/);
});
