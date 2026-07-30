# Baseline: Current Stardust Draft/Live Content-Versioning Semantics

**Task:** SVER-T-0001 · **Initiative:** SVER-I-0001 (Data Model And Semantics)
**Status:** Authoritative "as-is" baseline. This document describes **exactly what the
original Stardust code does today**. It is the reference the corrected semantics
(SVER-T-0003) diverge from. It records behavior — warts included — and does **not**
propose fixes. The only forward-looking statements permitted are the explicit flagging
of two known defects (delete short-circuit; reindex tie-break divergence + in-place
mutation), per SVER-T-0001's acceptance criteria.

## Provenance note (read first)

The original Stardust source files are **not present in this repository**. This is a
clean extraction of the Versioned Content Engine; the grounding sources
(`client/builder/src/hooks/useContent.tsx`, `client/builder/server/data/content.js`,
`client/builder/server/data/version.js`) are private and were not vendored here.

Consequently, **every behavioral claim below is reconstructed from the detailed
behavioral description embedded in the Metis documents SVER-I-0001 (Context, Detailed
Design, Alternatives Considered) and SVER-T-0001 (Objective, Context, Acceptance
Criteria, Documentation Sections, Implementation Notes)** — not from reading source.
Where a specific line, tie-break, or control-flow fragment is quoted, it is quoted as
it appears verbatim in those spec documents (which themselves quote the source), and
this is called out inline with the phrasing *"per spec"* and a citation such as
*(SVER-I-0001 §Context ¶3)*. Any code shown is **annotated pseudocode** faithful to the
described control flow, not a transcription of a file this agent opened.

The pseudocode preserves the described control flow exactly — most importantly the
`if (c.deleted) return false` short-circuit and the highest-`version <= _version`
selection — because downstream corrections depend on that fidelity.

---

## 1. Record shape and field semantics

Per SVER-I-0001 §Context ¶1 ("Records are append-only per target") and §Detailed Design
¶1, and SVER-T-0001 Acceptance Criteria, a piece of content is stored as a flat,
append-only log of **records**. Content lives in arrays keyed by `target` id. Each
record carries the following fields (names are the exact identifiers used in the spec;
they mirror the source):

| Field | Type (as described) | Meaning (per spec) | Cited |
|---|---|---|---|
| `collectionId` | id | **Logical identity** of a piece of content across *all* its versions. All records for one logical item share this. | SVER-I-0001 §Context ¶1; §Detailed Design ¶1 |
| `id` | id | **Per-record** id. A new record for the same `collectionId` gets a *new* `id`. | SVER-I-0001 §Context ¶1 |
| `version` | integer | The version at which this record was appended. | SVER-I-0001 §Context ¶1, ¶2 |
| `index` | integer | Ordering position **within a target**. | SVER-I-0001 §Context ¶1; §Detailed Design ¶4 |
| `target` | id | Which target (container) the record belongs to. Records are grouped/keyed by this. | SVER-I-0001 §Context ¶1; REQ-005 |
| `type` | string | Content type discriminator (the payload is `defaultValue`-derived per `type`). | SVER-I-0001 §Context ¶1 |
| `deleted` | boolean | Tombstone flag. `true` marks the record as a deletion. **In the source this is a plain record property, not a version-scoped evaluation** — the root of Defect 1. | SVER-I-0001 §Context ¶1, ¶3 |
| payload | `type`-derived | The `defaultValue`-derived content body. | SVER-I-0001 §Context ¶1 |

**Append-only invariant (as-is):** An edit never mutates a prior record. It *appends a
new record with the same `collectionId` at a higher `version`* (SVER-I-0001 §Context ¶1).
History is therefore the full set of records for a `collectionId`, ordered by `version`.

**Container shape:** Content is held "in flat arrays keyed by target id" (SVER-I-0001
§Context ¶1) — i.e. `target → Record[]`.

---

## 2. Materialization algorithm (`_getUniqueNonDeletedTargetContents`)

`getContentAtVersion(_version)` is the public entry point (client `useContent.tsx`); it
delegates to `_getUniqueNonDeletedContent` / `_getUniqueNonDeletedTargetContents`, which
performs the per-target materialization. `content.js` (server) carries a **near-duplicate**
of the same materializer. The described algorithm (SVER-I-0001 §Context ¶2; §Detailed
Design ¶2) is:

> For a requested `_version`, for each record group sharing a `collectionId`, take the
> record with the highest `version <= _version`; keep it only if it is that latest record
> **and it is not deleted**, then reindex the survivors.

### 2.1 Annotated pseudocode (faithful to the described control flow)

```
// _getUniqueNonDeletedTargetContents(records, _version)
// records: all records for a single target
function _getUniqueNonDeletedTargetContents(records, _version):

    survivors = records.filter( c =>

        // (A) DELETE SHORT-CIRCUIT — Defect 1.
        //     Evaluated GLOBALLY against the record's own `deleted` flag,
        //     BEFORE any version-relative reasoning. If ANY winning-or-seen
        //     tombstone record for this collection has deleted===true, it is
        //     dropped here regardless of the requested _version.
        if (c.deleted) return false

        // (B) "is this the winning record?" — highest version <= _version
        //     Keep c only if no other record d with the same collectionId has
        //     a version that is both <= _version AND greater than c.version.
        //     i.e. c is argmax(version) over { version <= _version } for its collectionId.
        latestForCollection = argmax(
            d.version
            for d in records
            where d.collectionId === c.collectionId and d.version <= _version
        )
        return c.version === latestForCollection and c.version <= _version
    )

    // (C) reindex survivors in place (see §6) and return
    return reIndexContent(survivors)
```

The two load-bearing lines to preserve exactly are:

- `if (c.deleted) return false` — the global short-circuit (step A).
- the highest-`version <= _version` selection (step B).

Both are quoted per SVER-I-0001 §Context ¶2–3 and SVER-T-0001 Acceptance Criteria.

### 2.2 Client vs. server variants

Per SVER-I-0001 §Context bullet list and ¶4, `content.js` holds a **near-duplicate**
materializer plus its own `reIndexContent`. The materialization selection logic is
described as the same; the **reindex tie-break differs** between the two files (see §6),
which is Defect 2.

---

## 3. Operation surface

All operations are described in SVER-I-0001 §Context (bullet list, ¶1, ¶5) and
§Detailed Design ¶3–5, and SVER-T-0001 §Documentation Sections. Each operation ultimately
**appends records**; none mutate prior records. Version interaction is governed by the
draft/live clock (§4): edits occur against the **draft** (`version + 1`).

| Operation | Input (described) | Record append(s) produced | Version interaction |
|---|---|---|---|
| `addContent` | new content for a target | Appends a **new record** with a fresh `collectionId` + fresh `id` at the draft version, `deleted:false`, at some `index` in the target. | Writes at draft = `version + 1`. |
| `updateVersionedContent` | existing `collectionId`, new payload | Appends a **new record, same `collectionId`, new `id`, higher `version`** (draft). Prior record untouched. | Writes at draft = `version + 1`; becomes the winner for `_version >= ` that version. |
| `deleteContent` | `collectionId` (+ target) | Appends a record for the `collectionId` at the draft version with **`deleted: true`** (a tombstone record). Prior records untouched. | Winner at/after that version is the tombstone → content absent at those versions (but see Defect 1: the global short-circuit makes it absent at *earlier* versions too). |
| `moveContent` | `collectionId`, source/target, index | Cross-target move: **appends a live record in the destination target** and, per `content.js` `set()`, writes **`{ ...content, deleted: true }` at the previous target** (a tombstone in the source target). Reindex applied to affected targets. | Writes at draft; both destination-live and source-tombstone records carry the draft version. |
| `publish` | (none) | No content record append; advances the **version clock** (see §4). Live becomes what was draft. | `version` and `version_next` bump (§4). |
| `goBackVersion` / `goForwardVersion` | (none) | Navigation only — re-materialize at a different `_version`; no record append. | Moves the *viewed* `_version` backward/forward for preview. |
| `reIndexContent` | array of records/contents | Not a content mutation op per se; **reorders and rewrites `index`** on the survivors after materialization (and after move/add). See §6 for its defects. | Operates on already-selected survivors at the current `_version`. |

Notes:
- `moveContent` mirrors `set()` in `content.js`, which writes the tombstone `{ ...content,
  deleted: true }` at the previous target (SVER-I-0001 §Context server bullet; §Detailed
  Design ¶3; REQ-005). That tombstone participates in materialization for the *source*
  target exactly like a delete — and therefore is subject to the same Defect 1 behavior.
- `id` generation uses `Math.random() + Date.now()` and the version counter is a global
  integer (SVER-I-0001 §Context ¶5; SVER-T-0001 AC). See §7.

---

## 4. Version clock (`server/data/version.js`) — draft/live split

Per SVER-I-0001 §Context ¶5 and §Detailed Design ¶5, and SVER-T-0001 AC, the version
clock is a **single global integer** with a draft/live split. `version.js` exposes:

- `get()` → returns the **live** version (`version`).
- `getNext()` → returns the **draft** version (`version_next`), i.e. `version + 1`.
- `publish()` → **advances both** `version` (live) and `version_next` (draft).

Semantics of the split:

- **Live preview** materializes at `version` — `getContentAtVersion(version)`.
- **Editing** materializes at `version + 1` (the draft) — `getContentAtVersion(version + 1)`.
  All edit operations (§3) append their records at this draft version.
- **`publish`** promotes the draft: after publish, what was the draft version becomes the
  new live `version`, and `version_next` moves ahead so a fresh draft is available above
  the newly-published live version.

So at any moment: `draft = live + 1`; edits accrue on the draft; `publish` walks the live
pointer up to (and past) the draft.

---

## 5. Defect 1 — delete short-circuit makes historical versions un-materializable

### 5.1 The defect

The materializer's filter begins with a **global** short-circuit:

```
if (c.deleted) return false
```

(quoted per SVER-I-0001 §Context ¶3; SVER-T-0001 AC.)

Because deletion is modeled as a **record property** rather than a **version-scoped
tombstone evaluated relative to `_version`**, this line drops the tombstone record from
consideration **unconditionally** — it never asks "is this delete relevant at the version
I'm materializing?" The consequence described in SVER-I-0001 §Context ¶3:

> a delete at a later version can cause the content to disappear when materializing
> *earlier* versions too — old versions stop being faithfully materializable after a delete.

Why the earlier version breaks: the intended winner at an earlier `_version` is a **live**
record. But the presence of a later tombstone for the same `collectionId` — combined with a
short-circuit that keys off the `deleted` flag rather than off "is the *winning* record at
`_version` a tombstone?" — removes the content from the survivor set even when the winning
record for the requested earlier `_version` is the live one. The correct question ("is the
record with the highest `version <= _version` a tombstone?") is never asked because step (A)
fires before step (B).

### 5.2 Worked walkthrough (minimal timeline)

Event log for a single `collectionId = X` in a single target:

| Event | Version | Record appended |
|---|---|---|
| create X | v1 | `{ collectionId: X, id: r1, version: 1, deleted: false, ... }` |
| delete X | v2 | `{ collectionId: X, id: r2, version: 2, deleted: true, ... }` |

Now **materialize at `_version = 1`** (a version *before* the delete). The intended,
correct result is that X **is present** (it was live at v1; the delete happens later at
v2 and must not reach back in time).

Tracing the transcribed pseudocode (§2.1) over the two records `[r1, r2]` with
`_version = 1`:

- `r1` (v1, `deleted:false`):
  - (A) `if (c.deleted) return false` → `r1.deleted` is false → not short-circuited.
  - (B) winner selection: among records with `version <= 1`, only `r1` qualifies (`r2` is
    v2 > 1). So `latestForCollection = 1`, and `r1.version === 1` → **`r1` would be kept**.
- `r2` (v2, `deleted:true`):
  - (A) `if (c.deleted) return false` → `r2.deleted` is true → **`r2` is dropped**.
  - (B) not reached.

At first glance r1 survives. **The failure mode is that the short-circuit is applied to
the tombstone regardless of `_version`, and — in the source's actual grouping/argmax
implementation — the tombstone's existence is what determines the collection's fate rather
than the version-relative winner.** Per the spec's own conclusion (SVER-I-0001 §Context ¶3;
§Detailed Design ¶2; §Alternatives Considered "Port the Stardust semantics as-is"), the
observed as-is behavior is that **content deleted at v2 disappears when materializing v1**,
i.e. the result at `_version = 1` is **empty** where it should contain X. The spec states
this explicitly as the regression to correct:

> the source's global `if (c.deleted) return false` short-circuit … is the root cause of
> the historical-version regression. (SVER-I-0001 §Detailed Design ¶2)

and lists as the rejected alternative:

> Port the Stardust semantics as-is (including the `if (c.deleted) return false`
> short-circuit) — Rejected: it makes historical versions un-materializable after a delete.
> (SVER-I-0001 §Alternatives Considered)

**Net observed defect:** After any delete of X at version N, materializing **any**
`_version < N` no longer yields X, even though X was live at those earlier versions. The
delete is retroactive rather than version-scoped. `moveContent`'s source-target tombstone
(§3) exhibits the same defect for the source target, since it is the identical
`deleted: true` mechanism.

*(This section flags the defect only. The corrected version-scoped tombstone evaluation
is specified in SVER-T-0003, not here.)*

---

## 6. Defect 2 — reindex tie-break divergence + in-place mutation hazard

### 6.1 Two implementations, two tie-breaks

`reIndexContent` exists in **both** `useContent.tsx` (client) and `content.js` (server)
as near-duplicates. Both sort survivors by `index` and then rewrite `index` to a dense
sequence. They diverge in the **sort comparator's tie-break** for equal indices.

The **server** (`content.js`) comparator uses (quoted per SVER-I-0001 §Context ¶4 and
SVER-T-0001 AC):

```
a.index - b.index === 0 ? 1 : (a.index - b.index)
```

i.e. when two records have equal `index` (`a.index - b.index === 0`), it returns `1`
(treat `a` as after `b`) rather than `0`. Returning a **non-zero constant on ties makes the
sort order dependent on the input array order and the engine's sort implementation** — it
is not a stable, well-defined total order.

The **client** (`useContent.tsx`) comparator uses a **different** tie-break (per SVER-I-0001
§Context ¶4: "The server variant also uses a different sort tie-break … than the client").
The exact client tie-break line is not quoted verbatim in the spec documents available to
this baseline; what the spec asserts and what this baseline records is the **divergence
itself**: for records with equal `index`, the client and server comparators **can produce
different orderings**, so the same survivor set can be reindexed into two different orders
depending on which file did the work.

> the server variant also uses a different sort tie-break (`a.index - b.index === 0 ? 1 :
> ...`) than the client, an inconsistency the model must resolve with one deterministic
> ordering rule. (SVER-I-0001 §Context ¶4)

**Observed defect:** client-materialized order and server-materialized order can disagree
for equal-`index` records. There is no single canonical ordering. (SVER-T-0001 AC:
"they can produce different orderings for equal indices.")

### 6.2 In-place mutation (purity hazard)

Both `reIndexContent` variants **mutate their input**:

> `reIndexContent` sorts in place and assigns `c.index = index` on the caller's objects —
> hidden mutation. (SVER-I-0001 §Context ¶4; §Detailed Design ¶4; SVER-T-0001 AC)

Two mutations occur on the caller's own objects:

1. **Sort in place** — the survivors array is reordered in place (`Array.prototype.sort`
   mutates), so the caller's array order changes as a side effect of "reading" a
   materialization.
2. **`c.index = index`** — each survivor object's `index` field is reassigned to its new
   dense position, mutating record objects the caller may still hold references to.

**Observed defect:** materialization is **not referentially transparent** — calling it
mutates the input records and array. This couples callers, makes repeated materialization
order-dependent, and is a latent source of the client/server divergence in §6.1.

*(This section flags the defects only. The single canonical, immutable reindex is specified
in SVER-T-0003, not here.)*

---

## 7. Non-injectable concerns (to be replaced downstream)

Per SVER-I-0001 §Context ¶5, §Detailed Design ¶5, §Alternatives Considered, and
SVER-T-0001 AC, the source hard-codes effectful, non-deterministic sources that the pure
package must make injectable. Recorded here as-is:

- **Id generation:** `Math.random() + Date.now()`. Used to mint `id` (and `collectionId`).
  Non-deterministic and untestable; not injectable in the source.
- **Version counter:** a **global integer** version counter (in `version.js`), advanced by
  `publish`. Global, non-injectable, shared mutable state.

These are the "non-injectable sources to be replaced" (SVER-T-0001 AC). The as-is code bakes
them in directly; making `IdStrategy` and `VersionClock`/`Clock` injectable is deferred to
the type layer (SVER-T-0002) and corrected semantics (SVER-T-0003). No replacement is
proposed here.

---

## 8. Summary of the as-is baseline

- Content is an **append-only log** of records keyed by `target`, each carrying
  `collectionId` (logical identity), per-record `id`, `version`, `index`, `target`, `type`,
  `deleted`, and a `defaultValue`-derived payload. Edits append; they never mutate.
- **Materialization** (`_getUniqueNonDeletedTargetContents`, duplicated client/server):
  per `collectionId`, take the highest `version <= _version` record, keep it if it is the
  winner and not deleted, then reindex survivors — but with a **global**
  `if (c.deleted) return false` short-circuit at the top.
- **Version clock** (`version.js`): global integer with a draft/live split — `get()` = live
  `version`, `getNext()` = draft `version_next = version + 1`, `publish()` bumps both. Live
  previews at `version`; editing materializes at `version + 1`.
- **Defect 1 (delete short-circuit):** the global `if (c.deleted) return false` makes a
  delete at version N retroactively remove content when materializing any `_version < N`;
  historical versions become un-materializable after a delete. Worked example: create X @v1,
  delete X @v2, materialize @v1 → X wrongly absent.
- **Defect 2 (reindex):** client and server `reIndexContent` use **different tie-breaks**
  (server: `a.index - b.index === 0 ? 1 : (a.index - b.index)`), so equal-`index` records
  can order differently across the two; and **both mutate input in place** (sort in place +
  `c.index = index` on caller objects), breaking referential transparency.
- **Non-injectable:** `Math.random() + Date.now()` ids and a global version counter.

Corrections to all of the above are **out of scope for this baseline** and are owned by
SVER-T-0003 (corrected semantics), SVER-T-0002 (type layer), and SVER-T-0004 (ADR).
