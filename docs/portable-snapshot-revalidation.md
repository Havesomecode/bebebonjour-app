# Portable snapshot revalidation

## Reproduced failure

Task `t_467b572c` investigates the unchanged portable collection test reported by
`t_71831cb5`, not the static terms route. Snapshot source, test and Python helper
are byte-identical in signed base `5f9e63928b7489f92b4d5e5e8f2807e4c1edbc7d`
and terms candidate `3093791a174a91b9468481cea01be78d974108c4`.

Clean Node 22.23.3 probes on both versions reproduced a real late-mutation blind
window. Collection captures `a.txt` and `b.txt`, then rereads both. At the start
of `b.txt`'s reread, the test overwrites `a.txt` with different, same-length bytes.
The final sweep checks metadata only. On accepted runs, all eight compared fields
(`dev`, `ino`, `mode`, `uid`, `nlink`, `size`, `mtimeNs`, `ctimeNs`) were identical
before and after that write. All four `a.txt` reads (data/EOF twice) preceded the
mutation; the injected mutation ran, and the returned digest matched the original
bytes rather than the bytes then on disk. This is filesystem timestamp aliasing,
not a skipped hook or a terms-route change. Exact kernel/filesystem mechanics
behind the timestamp alias were not established.

Thirty standalone snapshot-suite runs per version passed before the looped probe
reproduced acceptance on candidate iteration 33 and base iteration 92. Those
counts are observations, not failure-rate estimates. Raw logs and the standalone
probe are retained with this task's handoff.

## Narrow correction

The Linux native fallback performs two bounded content-revalidation passes,
each comparing size, digest and metadata to the original capture, followed by
the existing final metadata and directory-handle checks. The second pass detects
persistent same-size changes introduced during the first pass even when the
checked timestamps are unchanged. File descriptors still close after each
capture; no per-file descriptor retention or new runtime dependency is added.
The extra cost is one full additional read/hash of all collected files, with
one-file-at-a-time memory use. Existing file/count/total/request limits remain.

The original rejection test stays intact. A deterministic regression masks only
regular-file timestamps in both descriptor and pathname metadata, injects the
same write during the first revalidation pass, proves the earlier file was
already reread, and requires rejection. It does not wait for a clock tick or
make the mutation a different length.

## Boundary that remains

This is schedule-specific hardening, **not an atomic snapshot or a write lock**.
A mutation after a file's final byte check can still escape if metadata also
aliases; transient changes restored before validation can escape too. Adding
more passes cannot prove absence of arbitrary concurrent writes. Callers must
not treat this collector as authority for an actively hostile mutable tree or
as proof of the current pathname bytes after it returns. Existing digest-bound
approval and subsequent effect checks remain necessary.

The Python helper is unchanged and retains its existing single content pass
and final metadata sweep; it has the same general sequential limitation. This
change does not strengthen its guarantee, alter paid flags/terms/workers, or
authorize release/provider/customer actions. The previously approved terms
candidate remains independently consumable under its own release authority.

## Verification

Run `node --test test/fulfillment/secure-filesystem-snapshot.test.mjs`, including
the 112-file bounded-descriptor case. Repeat under `ulimit -n 64`, replay the
deterministic regression against the unmodified candidate to observe failure,
and run repository `npm run verify` under Node 22. No lint/type/format scripts
are separately configured. Refresh the established source-audit evidence with
its repository generator when implementation bytes change.
