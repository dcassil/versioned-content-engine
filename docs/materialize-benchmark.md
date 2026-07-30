# Materialize-on-read benchmark (SVER-T-0011)

This note records the `materialize` read-cost measurement that ADR
[SVER-A-0001](./adr/0001-append-only-vs-snapshot-storage.md) defers to
("Read cost grows with log size … benchmarked in SVER-T-0011"). Run it with:

```
pnpm bench
```

The benchmark (`bench/materialize.bench.ts`) is intentionally excluded from
`pnpm test`/`pnpm coverage` and from CI so the default gates stay fast — timing
is a **measurement, not a gate** (per the ADR).

## Workload

A deliberately over-sized content-authoring log, larger than the ADR's stated
"tens to low-hundreds per target" expectation:

| Dimension | Value |
|---|---|
| Targets | 25 |
| Collections per target | 40 |
| Edits (versions) per collection | 12 |
| Tombstones | ~5% of collections' final edit |
| **Total records** | **12,000** |

Records are appended in ascending version order per collection, mirroring the
real append-only write path. `materialize` is measured at the live version, the
draft version (live + 1), and a historical mid-log version.

## Observed numbers

Measured on Node v20.20.0, Apple Silicon (darwin), via the explicit wall-clock
summary the bench prints (200 iterations, warmed):

| Read | Version | Time |
|---|---|---|
| live | v12 | ~0.40 ms/op |
| draft | v13 | ~0.35 ms/op |
| historical | v6 | ~0.44 ms/op |

vitest/tinybench throughput corroborates: ~1,100–3,000 ops/sec across the three
reads (sub-millisecond mean per op).

## Conclusion — feedback into ADR SVER-A-0001

Materializing a **12,000-record** log — well above the realistic scale the ADR
anticipates — costs **well under a millisecond per read**. This confirms the
ADR's "Read/materialization cost … is acceptable" consequence at and beyond
expected scale.

Therefore the deferred **hybrid append-only-truth + checkpoint** option
(ADR "Alternatives / Follow-up") is **not needed now**: there is no evidence
read cost is a real problem. The append-only source-of-truth with
materialize-on-read stands as decided. The hybrid remains available as a future
escape hatch *without changing the source of truth* should logs grow orders of
magnitude larger.
