# Production source recovery — PASS, not release approval

Task: t_d4980810. Consumer: t_cc8af52d. Scope: existing local retained source/build artifacts only. No provider request, deployment, dry-run, push, customer record read, credential access/mutation, cron change, or host-service change was performed.

## Recovered inputs

The retained backend source snapshot is:

`/home/hermes/.hermes/ops/bebe-private-generation/owner-trial-launch/release-public-playback-op3-continuation-v1`

Every one of its 339 entries still matches `op3-continuation-reviewed-release-manifest.json`; 137 build-relevant source/configuration files are preserved in this packet's `reconstruction/backend`. This is the installed owner-trial/private-generation baseline, not the accepted paid implementation and not a new installation candidate.

The historical provider-source capture is `op3-continuation-backend-after-source.json`, SHA-256 `0a1297e0a0423999885d5a3b3028b10a4db1fcf2c4e0cfb77883479c231a95da`. Its 39 module/schema/root-config source-plus-sourceMap hashes exactly match packet996. The capture was found locally; no new provider retrieval was needed.

The host entrypoint, worker and renderer recorded in packet996 match signed commit `e82b3e6a8503fc2aad06256f8774b849b1ad06d3`. Eight files are preserved in `reconstruction/host-worker`: five transitive source modules, their composition schema, and package/lock files. `worker-signed-commit.txt` retains the exact signed commit object; its Git object identity and successful signature verification are recorded. The three host-observed hashes match exactly. Packet996 did not hash all host dependencies or in-memory loaded code; the remaining signed dependency source is a reconstruction, not fresh host-runtime parity proof.

## Executed offline reproduction

Run, from an extracted packet:

`bash replay-offline.sh /home/hermes/repos/bebebonjour-app/node_modules`

Default Node is `/opt/node-v24.21.0-linux-x64/bin/node` (24.21.0); override NODE_BIN if necessary. Convex is locked at 1.44.0, esbuild at 0.27.0, and 41 build dependency files are SHA-256/size pinned. The script uses bubblewrap with no network, an empty environment/HOME, read-only host mounts, and writes only to the extracted workspace. It never invokes the Convex CLI main entrypoint; the shim exports only local schema/component/build functions.

Build layout is part of this historical byte identity. Inside the mount namespace only, the backend is mounted at its historical frozen path, with dependencies at `/home/hermes/repos/bebebonjour-private-generation-retry-repair/node_modules`. No canonical path was recreated or modified on the host. Source-map paths and esbuild chunk hashes reproduce only with this geometry.

Final execution returned:

`SOURCE_RECOVERY_PASS modules=39/39 raw_bytes=39/39 schema=23/23 worker=3/3 root_dependencies=0 child_components=0; NO_RELEASE_APPROVAL`

All replayed source and sourceMap bytes, including schema and convex.config.js, match the retained capture exactly. Hashing uses SHA-256(source UTF-8 || sourceMap UTF-8), exactly as Convex 1.44.0 does. The reconstructed root definition has no dependencies or child component definitions. Its definition bytes match the packet996 convex.config.js fingerprint; this is not a separate new provider component-tree observation. All 23 active declared table validators/indexes match after removing only null stagedDocumentType, runtime-added trailing _creationTime index fields, and index ordering differences. No stored-row inference is made.

Worker syntax checks and its --help import path ran in the same no-network sandbox, with no credentials. A missing composition-schema asset found on the first replay was recovered from the same signed commit before the final passing replay.

## Why previous replay was 7/39

A replay from the recovered source at a new dependency path also returned only 7/39. Replaying the same bytes with historical source/dependency geometry returned 39/39. Relative dependency paths affect source comments, source maps, and transitive chunk names.

Across the 137 recovered backend files, retained c52518d has 135 exact matches and two EOF-newline-only differences: `convex/ownerTrialPublicationPresent.js` and `convex/privateGeneration.js` each have one additional final newline in the frozen snapshot. Preserve the recovered bytes; do not assume raw c52518d alone reproduces the installed bundle. `c52518d-source-comparison.json` records every result.

## Packet996 digest correction

The actual registered attachment996 file is 8,899 bytes and SHA-256 `7f953fdb778fcf3897987ea5f35eb5b414742a94cfc591c18f79a5c22be41586`. Both Python and sha256sum independently returned this value. Earlier installation prose claims `0f8b79fb3f65d2d913e505154eb0e2858e699d5082fdc4bf3481b3f9ca517c1a`; that is not the digest of the currently stored attachment996 archive. No replacement or normalization was performed.

The archive's proof.json remains SHA-256 `f3cb9eff0c87176052c7fa208fe3ec386ddc6be6c1b8104796dc69fc68cd1ec8`; its embedded integrity verifier passes. This correction concerns the observed outer-archive digest, not an assertion that a previously hashed archive changed or that accepted inner evidence is invalid. Withdrawn attachment995 and attachment951 were not read or applied.

## Handoff boundary

Resume t_cc8af52d using this source/build artifact for the forward-compatible installation repair, paired-worker transition, cron rehearsal and compatible rollback. Preserve paid candidate f64d2f8030ee8a574f87491db5aa1368194b52cf and its scoped reviews. No release review or live payment-flow proof is issued here. Stripe binding and Vercel readiness remain independent.

The final archive and its SHA-256 sidecar are durable task attachments. `source-recovery-verification.json` supplies executed UTC time, exact hashes, counts, module fingerprints, and unverified boundaries. `replay-offline.log` records the final successful invocation.
