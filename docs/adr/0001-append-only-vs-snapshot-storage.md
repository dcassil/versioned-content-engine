# ADR 0001: Append-Only Version Records vs Per-Version Snapshot Storage

**Status:** Decided
**Decision maker:** Daniel Cassil
**Metis ADR:** SVER-A-0001
**Parent initiative:** SVER-I-0001 (Data Model And Semantics) — satisfies REQ-008
**Related requirements:** REQ-001..REQ-008, NFR-001..NFR-004
**Downstream consumers:** SVER-I-0002 (Pure Core Implementation), SVER-I-0003 (Storage And React Adapters)

## Context

The Versioned Content Engine (`SVER`) extracts Stardust's draft/live content-versioning algorithm into a headless, pure TypeScript package. Before any code is written, the initiative SVER-I-0001 must fix the *storage model* for versioned content, because that choice constrains both the core materialization algorithm (SVER-I-0002) and the storage adapter schema (SVER-I-0003). This ADR records that decision.

The behaviour being formalized comes from the original Stardust source:

- `client/builder/src/hooks/useContent.tsx` — the client-side materializer and operation surface (`getContentAtVersion`, `_getUniqueNonDeletedTargetContents`, `addContent`, `updateVersionedContent`, `deleteContent`, `moveContent`, `publish`, `goBackVersion`/`goForwardVersion`, `reIndexContent`).
- `client/builder/server/data/content.js` — the server-side `set()` writer and a near-duplicate materializer.
- `client/builder/server/data/version.js` — the global version clock (`publish` bumps `version` and `version_next`).

The status quo is an **append-only version-record log**: content lives in flat arrays keyed by target id, each record carries a stable `collectionId` (logical identity across versions), a per-record `id`, an integer `version`, an `index`, a `target`, a `type`, a `deleted` flag, and a payload. An edit never mutates a prior record — it appends a new record with the same `collectionId` at a higher version. Reads are computed on demand by `_getUniqueNonDeletedTargetContents` (materialize-on-read): for a requested `_version`, for each `collectionId` group take the record with the highest `version <= _version`, keep it iff it is not a tombstone, then reindex the survivors.

SVER-T-0003 corrected the delete semantics of that materializer: the source's top-of-filter `if (c.deleted) return false` short-circuit made historical versions un-materializable after any later delete. The corrected semantics evaluate deletion *relative to the requested version* — a tombstone is just another versioned record, and deletion is decided by whether the winning record (highest `version <= _version`) is a tombstone. This ADR must be consistent with those corrected materialize-on-read semantics.

Two storage models are available to carry that semantics, and SVER-I-0001's Detailed Design §6 and Alternatives Considered explicitly deferred the choice to this ADR rather than pre-judging it:

- **Append-only version records** (the source's approach): every operation appends one or more immutable records; the state is the full log; the current/any-version view is *derived* by materialize-on-read. Cheap incremental writes, full history retained for free, but every read pays a materialization cost proportional to log size.
- **Per-version immutable snapshots**: each `publish` (or each write) persists a complete materialized `ContentSnapshot` for that version; reads are a direct lookup with no computation. Cheap reads, explicit history, but storage is amplified (every version stores the full content set, largely duplicated) and writes must project the whole snapshot.

The vision's principles — purity, determinism, historical fidelity (NFR-004: no operation may make a previously-materializable version un-materializable), and an injectable clock/id strategy — bias strongly toward preserving a complete, replayable event log rather than materialized derivatives.

## Decision

**We adopt append-only version records as the canonical storage model for the Versioned Content Engine.**

The authoritative state (`ContentState`) is a per-target append-only log of immutable `ContentRecord`s. Every operation (`create`, `update`, `move`, `delete`, `publish`) is expressed as one or more record appends — append is the *only* write path; records are never mutated or removed. Any materialized view (`ContentSnapshot`) — live (`materialize(state, liveVersion)`), draft (`materialize(state, liveVersion + 1)`), or any historical version — is a **pure, derived** value computed by `materialize(records, version)` at read time, using the SVER-T-0003–corrected version-relative tombstone semantics. Snapshots are never persisted as source of truth; if an adapter caches them, the cache is derived and disposable.

This is stated definitively: SVER-I-0002 implements materialize-on-read, and SVER-I-0003's `StorageAdapter` exposes append + log-read as its primitives, not snapshot upsert.

## Alternatives Considered

| Option | Pros | Cons | Risk | Cost |
|--------|------|------|------|------|
| **Append-only version records (CHOSEN)** | Cheap O(1)-append writes; full history retained for free; native `goBackVersion`/`goForwardVersion` and rollback; historical fidelity (NFR-004) is structural; single deterministic source of truth; matches corrected materialize-on-read semantics (SVER-T-0003); smallest storage footprint | Every read pays materialization cost (group-by-`collectionId` + argmax + reindex) growing with log size; unbounded log growth needs eventual compaction; read correctness depends entirely on the materialize algorithm | Low | Low — matches source; core is a pure `materialize` fn; adapter is append + range-read |
| **Per-version immutable snapshots** | O(1) reads (direct lookup); trivial read code; explicit self-describing history; read perf independent of edit count | Storage amplification (each version duplicates the full content set); writes must project a whole snapshot; history fidelity becomes a storage guarantee, not structural; rollback/diffing non-trivial; diverges from source (port risk); harder to keep clock/id injection pure | Medium | Medium/High — write-time projection engine + snapshot schema + amplification management |
| **Hybrid (append-only truth + periodic snapshot checkpoints)** | Bounds read cost by materializing from nearest checkpoint forward; keeps append-only as source of truth | Adds checkpoint-invalidation/consistency machinery; premature without evidence read cost is a real problem; two code paths to keep correct | Medium | Medium — only justified by benchmark data |

**Per-version snapshots (primary alternative) — rejected.** Storage amplification and write-time projection cost outweigh the read simplicity for incrementally-edited content, and it makes historical fidelity a storage-enforcement problem rather than a structural property. It also diverges from the source and re-freezes the version-relative tombstone logic at write time, increasing the surface for the exact regression SVER-T-0003 fixed.

**Hybrid — deferred, not rejected outright.** It is the correct escape hatch if read cost ever becomes a real problem, but it is the wrong starting point: it adds machinery to solve a cost we have no evidence exists. Deferred behind the SVER-T-0011 benchmark; it can be adopted later *without changing the source of truth*.

## Rationale

Append-only records win on every axis the vision cares about:

- **Write cost:** append is O(1) per operation; snapshots require projecting and persisting the entire content set per write.
- **Read/materialization cost:** the one real cost of append-only. But `materialize` is a pure group-by + argmax + reindex over records for a single target, and expected version/record counts for a content-authoring surface are modest (tens to low-hundreds per target), so read cost is acceptable and, if it ever isn't, is addressable by the hybrid checkpoint option *without changing the source of truth*.
- **Storage footprint:** append-only stores each change once; snapshots duplicate the full set per version.
- **History fidelity / rollback (`goBackVersion`):** with append-only, history and rollback are structural — any version is just `materialize(state, v)`; NFR-004 is guaranteed by construction once the corrected tombstone semantics are in place.
- **Consistency with SVER-T-0003:** version-relative tombstone evaluation is inherently a materialize-on-read concept; append-only is its natural home.
- **Fidelity to the source and lower port risk:** the source is already append-only; adopting it minimizes translation risk while we correct the delete bug and remove hidden mutation.

## Consequences

### Positive
- **SVER-I-0002** implements a single pure `materialize(records, version)` (group-by-`collectionId` → argmax `version <= requested` → version-relative tombstone check → deterministic reindex). Historical fidelity and `goBackVersion`/`goForwardVersion` fall out for free.
- **SVER-I-0003**'s `StorageAdapter` has a minimal, obviously-correct write surface: **append is the only write path**; reads return the record log (optionally range-filtered by target/version) and hand it to `materialize`. No snapshot upsert, no write-time projection.
- Storage footprint stays minimal; full audit history is retained with no extra work; determinism/purity (NFR-002) and historical fidelity (NFR-004) are structural.

### Negative
- **Read cost grows with log size.** SVER-I-0002's `materialize` is on the hot path for every read (live, draft, historical). It must be efficient (single pass, no accidental O(n²), no hidden mutation) and is correctness-critical — a bug there corrupts *all* reads. Mitigation: exercised by SVER-I-0001 worked-example fixtures and benchmarked in SVER-T-0011.
- **Unbounded log growth.** Without compaction the log grows forever. Accepted for now; the append-only-truth + checkpoint hybrid remains available if SVER-T-0011 shows read cost or storage growth is a real problem at expected scale.
- **Adapters may not shortcut reads by persisting snapshots as truth.** Any snapshot an adapter keeps is a derived, disposable cache that must be invalidated on append — an explicit constraint on SVER-I-0003.

### Neutral
- Adapters may still cache materialized snapshots for performance, provided the append-only log remains the single source of truth and the cache is derived from it.
- Draft/live is modeled purely as two materialization versions (`liveVersion` and `liveVersion + 1`); `publish` advances the injected `VersionClock`. Unaffected by the storage choice.

## Follow-up Actions

- **SVER-T-0011** — benchmark materialize-on-read cost against representative version/record counts; the result decides whether the hybrid checkpoint option is ever needed.
- **SVER-T-0012 / SVER-T-0014** — define the `StorageAdapter` schema and in-memory/persistent implementations with append as the only write path and log-read + `materialize` as the read path.
- **SVER-I-0002** — implement `materialize` per the corrected SVER-T-0003 semantics; treat it as the correctness-critical hot path.

## Review

Triggers a revisit if: SVER-T-0011 shows materialize-on-read cost is unacceptable at expected scale; unbounded log growth becomes a practical problem for a target adapter; or a new requirement (cross-version diffing at scale, multi-writer) changes the cost profile. In any of those cases, adopt the append-only-truth + periodic-snapshot-checkpoint hybrid **without changing the source of truth**. Append-only remains the source of truth; only the read-optimization strategy is subject to revision.

---

*This document mirrors Metis ADR **SVER-A-0001** (phase: decided) under initiative SVER-I-0001. The Metis document is authoritative.*
