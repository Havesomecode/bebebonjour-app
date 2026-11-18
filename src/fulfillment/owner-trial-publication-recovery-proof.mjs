import { stablePrivateValue as canonicalJson } from "./private-generation-authority.mjs";

// Shared deployed-ingress/backend contract. Never accept an HTTP caller's proof.
export const PUBLICATION_ABSENCE_PROOF_KIND = "owner_trial_publication_absence";
export const PUBLICATION_ABSENCE_PROOF_MAX_AGE_MS = 60_000;
export const PUBLICATION_ABSENCE_BINDING_FIELDS = Object.freeze([
  "jobId", "expectedVersion", "sourceCommandId", "attemptId", "revisionId", "artifactManifestDigest",
  "idempotencyKey", "teamId", "projectId", "projectName", "origin",
]);
const HEX = /^[a-f0-9]{64}$/u;
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
export function publicationAbsenceBinding(args) {
  return Object.fromEntries(PUBLICATION_ABSENCE_BINDING_FIELDS.map(k => [k, args[k]]));
}
export function unsignedPublicationAbsenceProof(proof) {
  const { signature, ...unsigned } = proof;
  return unsigned;
}
export async function publicationRecoveryDigest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");
}
export async function signPublicationAbsenceProof(unsigned, token) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(`${PUBLICATION_ABSENCE_PROOF_KIND}\0${canonicalJson(unsigned)}`));
  return { ...unsigned, signature: [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("") };
}
export async function verifyPublicationAbsenceProof(proof, binding, token, { nowMs = Date.now(), fresh = true } = {}) {
  const c = proof?.census, observed = Date.parse(proof?.observedAt);
  if (!exact(proof, ["schemaVersion", "kind", "binding", "observedAt", "census", "signature"])
      || proof.schemaVersion !== "1.0" || proof.kind !== PUBLICATION_ABSENCE_PROOF_KIND
      || !exact(proof.binding, PUBLICATION_ABSENCE_BINDING_FIELDS) || canonicalJson(proof.binding) !== canonicalJson(binding)
      || !Number.isFinite(observed) || new Date(observed).toISOString() !== proof.observedAt
      || (fresh && (observed > nowMs || nowMs - observed > PUBLICATION_ABSENCE_PROOF_MAX_AGE_MS))
      || !exact(c, ["complete", "pageCount", "deploymentCount", "digest", "exactMatchCount", "ambiguousMatchCount", "errorCount", "terminalCursor"])
      || c.complete !== true || !Number.isSafeInteger(c.pageCount) || c.pageCount < 1
      || !Number.isSafeInteger(c.deploymentCount) || c.deploymentCount < 0
      || !HEX.test(c.digest || "") || c.exactMatchCount !== 0 || c.ambiguousMatchCount !== 0
      || c.errorCount !== 0 || c.terminalCursor !== null || !HEX.test(proof.signature || "")) {
    throw new Error("Owner trial publication complete fresh absence proof rejected.");
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signature = new Uint8Array(proof.signature.match(/../gu).map(x => Number.parseInt(x, 16)));
  if (!await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(
    `${PUBLICATION_ABSENCE_PROOF_KIND}\0${canonicalJson(unsignedPublicationAbsenceProof(proof))}`))) {
    throw new Error("Owner trial publication proof signature rejected.");
  }
  return publicationRecoveryDigest(proof);
}
