# Corrected Semantics: Materialize, Tombstone, Move, Reindex, Draft/Live

**Task:** SVER-T-0003 · **Initiative:** SVER-I-0001 (Data Model And Semantics)
**Status:** Authoritative algorithm specification. This is the load-bearing contract that
SVER-I-0002 (Pure Core Implementation) implements 1:1 and that SVER-T-0005's fixtures
encode as the acceptance oracle. It **corrects** the two defects catalogued in the
baseline (`docs/baseline-stardust-semantics.md`, SVER-T-0001): the delete short-circuit
(historical-version regression, Defect 1) and the client/server reindex tie-break
divergence + in-place mutation (Defect 2).

Every rule below is expressed as prose followed by language-agnostic pseudocode that
references the **exact** type names finalized in `src/types.ts` (SVER-T-0002) and
`src/strategies.ts`. The pseudocode is side-effect-free and returns new values; it is
implementable verbatim.

> **Storage model (ADR SVER-A-0001, decided).** State is an append-only log; every
> operation appends immutable records and returns a new `ContentState`. Every view
> (`ContentSnapshot`) is a *derived*, pure value computed by `materialize` at read time.
> Snapshots are never persisted as truth. This spec is written to that decision.

---

## 0. Type vocabulary (from `src/types.ts` / `src/strategies.ts`)

The spec references these names exactly. It introduces **no** new field or type.

| Name | Definition (SVER-T-0002) | Role here |
|---|---|---|
| `Id` | `Branded<string, "Id">` | per-record identity |
| `ContentCollectionId` | `Branded<string, "ContentCollectionId">` | logical identity across versions; the group-by key |
| `TargetId` | `Branded<string, "TargetId">` | slot/container; `ContentState` is keyed by it |
| `Version` | `Branded<number, "Version">` | opaque monotonic stamp |
| `ContentRecord<TMap>` | readonly `{ collectionId, id, version, index, target, deleted, type, payload }` | one immutable append |
| `ContentState<TMap>` | `ReadonlyMap<TargetId, readonly ContentRecord<TMap>[]>` | the append-only log (truth) |
| `ContentSnapshot<TMap>` | `ReadonlyMap<TargetId, readonly ContentRecord<TMap>[]>` | materialized, reindexed, tombstone-resolved view |
| `IdStrategy` | `{ newId(): Id; newCollectionId(): ContentCollectionId }` | injected; no `Math.random`/`Date.now` in core |
| `VersionClock` | `{ live(): Version; advance(): VersionClock }` | injected; immutable-value clock |

Every `ContentRecord.deleted === true` record is a **version-scoped tombstone**: it hides
the collection **at/after its own `version`, never retroactively** (SVER-T-0002 doc-comment
on `deleted`; SVER-I-0001 REQ-004). This is the pivotal reinterpretation that fixes Defect 1.

### 0.1 Version helpers (opaque arithmetic)

`Version` is opaque, so the spec never does raw `v + 1` on it in caller code. Two total,
pure helpers are the only permitted `Version` arithmetic and both are trivially derivable
from the branded numeric representation:

```
// compare two versions (underlying numbers). Total order.
function versionLte(a: Version, b: Version): boolean
    return (a as number) <= (b as number)

// the next version after v (the draft version relative to a live v).
// Equivalent to what an injected VersionClock.advance() would yield; used
// for read-side draft materialization, which must not mutate the clock.
function nextVersion(v: Version): Version
    return ((v as number) + 1) as Version
```

`nextVersion` exists purely for the read-side draft view (§6). The **write-side** clock is
never advanced by materialization; only `publish` advances it, via the injected
`VersionClock.advance()` (§6.3). No global counter, `Date.now`, or `Math.random` appears
anywhere in core (SVER-I-0001 REQ-007, NFR-001).

---

## 1. `materialize(state, version)` — corrected (REQ-003, fixes Defect 1)

### 1.1 Rule (prose)

`materialize` computes the `ContentSnapshot` visible at a requested `Version`. For each
target independently:

1. **Group** that target's records by `collectionId`.
2. For each group, **select the winner**: the record with the greatest `version` among
   those with `version <= requested` (`argmax(version)` over the version-eligible subset).
   **Same-version tie-break — LAST-WRITE-WINS (SVER-T-0022):** when two or more
   version-eligible records for the collection share that greatest `version` — which
   happens for two edits made in one unpublished draft session, both stamped at the same
   draft version — the **last-appended** record wins. Append order within a target's log is
   the write order, so the argmax uses `<=` (not strict `<`): a candidate tying the
   incumbent's version replaces it, leaving the last write as the winner. This is the
   **winner-selection** tie-break and is kept strictly separate from the §4.1
   **display-ordering** tie-break (`index` asc, then `collectionId` asc).
3. If a group has **no** version-eligible record, the collection is **absent** at this
   version (it was created later).
4. If the winner's **`deleted === true`** (it is a tombstone), the collection is **absent
   at this version only** — the tombstone hides it because it is the *winning* record here,
   not because a tombstone exists somewhere in the log.
5. Otherwise the winner **survives**.
6. **Order** the survivors for the target by the single canonical rule (§4) and
   **immutable-reindex** them into fresh record objects (§4). Targets with no survivors
   are omitted from the snapshot (empty target ⇒ absent key).

The corrected step 4 **replaces** the baseline's global `if (c.deleted) return false`
short-circuit (baseline §2.1 step A, §5). Deletion is now decided *per requested version*
by "is the winner a tombstone?", never by "does any tombstone record exist?". This is the
entire fix for Defect 1.

> **Explicit removal.** The baseline line
> `survivors = records.filter(c => { if (c.deleted) return false; ... })`
> is **deleted**. A tombstone is an ordinary versioned record that only participates as a
> possible *winner*; it is never filtered out before winner selection.

### 1.2 Pseudocode

```
// materialize<TMap>(state: ContentState<TMap>, requested: Version): ContentSnapshot<TMap>
// Pure: does not read or mutate `state`; returns a NEW ReadonlyMap of NEW arrays/records.
function materialize(state, requested):
    result = new Map<TargetId, ContentRecord[]>()   // built locally, frozen on return

    for (targetId, records) in state:               // records: readonly ContentRecord[]
        // ---- group by collectionId ----
        groups = new Map<ContentCollectionId, ContentRecord[]>()
        for c in records:
            groups.get(c.collectionId).push(c)       // append into per-collection bucket

        // ---- select winner per collection, apply version-scoped tombstone ----
        survivors = []                               // ContentRecord[]
        for (collectionId, group) in groups:
            winner = null
            for c in group:
                if versionLte(c.version, requested):           // version-eligible only
                    if winner == null
                       or (winner != null and lte(winner.version, c.version)):
                        winner = c              // argmax(version <= requested), LAST-WRITE-WINS on ties
            if winner == null:
                continue                              // (3) never existed at `requested` -> absent
            if winner.deleted == true:
                continue                              // (4) winner is a tombstone -> absent HERE only
            survivors.push(winner)                    // (5) live winner survives

        // ---- deterministic order + immutable reindex (see §4) ----
        if survivors.length > 0:
            result.set(targetId, reindex(survivors)) // (6) fresh, reordered, index-rewritten

    return freeze(result)                             // ReadonlyMap<TargetId, readonly ContentRecord[]>

// helper: less-than-or-equal on opaque Version (LWW argmax uses <= so the
// last-appended same-version record replaces the incumbent — SVER-T-0022)
function lte(a: Version, b: Version): boolean
    return (a as number) <= (b as number)
```

**Complexity / purity.** Single pass to group, single pass to pick winners, one sort in
`reindex` — no O(n²), no mutation of `state` or any record it contains (ADR SVER-A-0001
"Negative": hot path, must stay single-pass and pure).

**Winner-selection ties are possible and resolved by LWW (corrected, SVER-T-0022).** The
earlier claim that "at most one record per `collectionId` exists at any given `version`" is
**false** across a single unpublished draft session: because every edit writes at
`nextVersion(clock.live())` and `publish` is what advances the clock, *n* edits of one
collection with no intervening publish produce *n* records all sharing the same draft
`version`. The winner-selection `argmax` therefore breaks same-`version` ties by **append
order (last-write-wins)** — see §1.1 step 2. This is distinct from the §4.1
display-ordering tie-break, which orders *distinct collections sharing an `index`* and only
ever runs on the already-selected winners.

---

## 2. `delete` / tombstone semantics (REQ-004, fixes Defect 1)

### 2.1 Rule (prose)

`delete(state, target, collectionId, clock, ids)` **appends** one new `ContentRecord` for
`collectionId` in `target` with `deleted: true` at the **draft** version
(`nextVersion(clock.live())`). It:

- **never removes or mutates** any prior record (append-only, ADR SVER-A-0001);
- carries the collection's own `collectionId`, a fresh `id` from `ids.newId()`, the draft
  `version`, the same `target`, and `deleted: true`;
- `type`/`payload` are copied from the collection's current winning record so the record is
  well-typed (the payload is irrelevant to materialization once `deleted` is true, but the
  discriminated-union type still requires a valid `type`+`payload` pair).

Because deletion is a version-scoped tombstone (§1 step 4), it **hides the collection at/
after its version only**. Materializing any earlier version still selects the earlier live
winner and yields the content — the historical-fidelity invariant below.

### 2.2 Invariant NFR-004 (historical fidelity) — the regression guard

> **NFR-004.** No operation may make a previously-materializable version un-materializable.
> Formally: for any state `S`, version `v`, and any subsequent append producing `S'`,
> `materialize(S', v)` ⊇ `materialize(S, v)` for every collection whose winner at `v` is
> unchanged. A `delete` at version `n > v` must not alter `materialize(·, v)`.

**Version-timeline example (the mandatory worked invariant).**
Single target `T`, single collection `X`:

| Event | Appended record |
|---|---|
| create X (draft over live 0) | `{ collectionId:X, id:r1, version:1, index:0, target:T, deleted:false, type,payload }` |
| delete X (draft over live 1) | `{ collectionId:X, id:r2, version:2, index:0, target:T, deleted:true,  type,payload }` |

Log for `T` = `[r1, r2]`.

- **`materialize(state, 1)`** — trace §1.2 with `requested = 1`:
  - group `X = [r1, r2]`.
  - winner: `r1` (`version 1 <= 1`) is eligible; `r2` (`version 2 <= 1`? no) is **not**
    eligible → `winner = r1`.
  - `r1.deleted == false` → **X survives**. Snapshot `{ T: [X@r1 reindexed to index 0] }`.
  - ✅ Content present at v1 — the delete at v2 does **not** reach back. (Under the baseline
    short-circuit this returned empty; that was Defect 1.)
- **`materialize(state, 2)`** — `requested = 2`:
  - winner: both eligible (`1<=2`, `2<=2`); `argmax` = `r2` (version 2).
  - `r2.deleted == true` → **X absent**. Snapshot `{}` (empty target omitted).
  - ✅ Content correctly hidden at/after the tombstone.

This trace is hand-verifiable against §1.2 line-for-line and is the regression guard
SVER-T-0005 must encode.

### 2.3 Pseudocode

```
// delete<TMap>(state, target, collectionId, clock, ids): ContentState<TMap>
function delete(state, target, collectionId, clock, ids):
    draft = nextVersion(clock.live())                 // edits write to the draft version
    current = winnerFor(state, target, collectionId, draft)   // resolve at DRAFT (SVER-T-0022)
    // `current` gives us a valid (type,payload) to satisfy the record's union type;
    // resolving at `draft` (not `live`) lets delete see same-session unpublished edits;
    // if the collection is already absent/tombstoned at draft, delete is a no-op:
    if current == null or current.deleted == true:
        return state
    tombstone = {
        collectionId: collectionId,
        id:           ids.newId(),
        version:      draft,
        index:        current.index,                  // provisional; reindex recomputes on read
        target:       target,
        deleted:      true,
        type:         current.type,
        payload:      current.payload,
    }
    return appendRecord(state, target, tombstone)     // returns NEW ContentState

// appendRecord: pure append into the per-target log, returns a new ReadonlyMap.
function appendRecord(state, target, record):
    next = new Map(state)                             // shallow copy of the map
    prev = state.get(target) ?? []
    next.set(target, freeze([...prev, record]))       // NEW array, old untouched
    return freeze(next)

// winnerFor: the §1 winner for one collection at a version (no reindex).
function winnerFor(state, target, collectionId, version):
    winner = null
    for c in (state.get(target) ?? []):
        if c.collectionId == collectionId and versionLte(c.version, version):
            if winner == null or lte(winner.version, c.version):   // LWW on ties (SVER-T-0022)
                winner = c
    return winner
```

`create` and `update` are the append duals of `delete` (stated for completeness in §5);
they append `deleted:false` records — `create` with `ids.newCollectionId()` + `ids.newId()`,
`update` reusing the `collectionId` with a fresh `ids.newId()`.

---

## 3. `move` semantics (REQ-005)

### 3.1 In-target reorder (prose)

Moving a collection to a new position **within the same target** appends a new
`deleted:false` record for that `collectionId` at the draft version with the desired
`index`. Prior records are untouched. On the next `materialize`, the winner for that
collection is the new record, and `reindex` (§4) normalizes all survivors' `index` to a
dense sequence in canonical order. The provisional `index` on the appended record only
needs to sort into the intended slot relative to peers; §4 makes the final positions dense
and deterministic.

### 3.2 Cross-target move (prose) — mirrors `content.js` `set()`

Moving a collection from `source` to `dest` appends **two** records at the same draft
version (ADR SVER-A-0001: append is the only write path):

1. a **tombstone** in `source` (`{ ...winner, deleted:true }`), mirroring the source
   `content.js` `set()` writing `{ ...content, deleted: true }` at the previous target
   (baseline §3, REQ-005); and
2. a **live** record in `dest` (`deleted:false`) carrying the same `collectionId`, a fresh
   `id`, the draft `version`, `target: dest`, and the desired `index`.

Both affected targets are immutable-reindexed on read via §4. Because the source-side
tombstone is version-scoped (§1 step 4, §2), materializing a version **before** the move
still shows the collection in `source` — the cross-target move is subject to the *same
corrected* tombstone rule and thus the *same* Defect-1 fix, not the old regression.

### 3.3 Pseudocode

```
// move<TMap>(state, collectionId, source, dest, index, clock, ids): ContentState<TMap>
function move(state, collectionId, source, dest, index, clock, ids):
    draft = nextVersion(clock.live())
    winner = winnerFor(state, source, collectionId, draft)   // resolve at DRAFT (SVER-T-0022)
    if winner == null or winner.deleted == true:
        return state                                  // nothing to move (at draft)

    if source == dest:
        // ---- in-target reorder: one new live record at the new index ----
        moved = { ...winner, id: ids.newId(), version: draft, index: index }
        return appendRecord(state, dest, moved)

    // ---- cross-target: tombstone in source + live record in dest ----
    tombstone = { ...winner, id: ids.newId(), version: draft, deleted: true }   // stays in `source`
    s1 = appendRecord(state, source, tombstone)
    live = { ...winner, id: ids.newId(), version: draft, target: dest,
             deleted: false, index: index }
    return appendRecord(s1, dest, live)               // reindex of both targets happens on read (§4)
```

Determinism note: both appends carry the **same** `draft` version. For a cross-target move
they live in different targets, so each target's argmax is unambiguous. For an in-target
reorder (or any same-session re-edit) the new record can share the `draft` version with the
collection's earlier record in the same target; §1's argmax then resolves the tie by
**last-write-wins** (§1.1 step 2, SVER-T-0022) — append order makes the just-appended record
the winner — so the result is still fully deterministic.

---

## 4. Deterministic ordering & immutable reindex (REQ-006, fixes Defect 2)

### 4.1 The one canonical ordering rule (authoritative)

Survivors within a target are ordered by a **single total order**:

> **Canonical order:** ascending `index`; **tie-break** on equal `index` by ascending
> `collectionId` (lexicographic on the underlying string). This total order is the sole
> authority and **supersedes both** source variants — the client comparator and the server
> comparator `a.index - b.index === 0 ? 1 : (a.index - b.index)` (baseline §6.1).

Rationale for the tie-break choice (`collectionId`, not `version` and not "return 1"):

- **`collectionId` is stable and total.** Every survivor has a distinct `collectionId`
  within a target (one winner per collection), so the tie-break is a *strict* total order —
  no residual ambiguity, unlike the source's `return 1` which depends on input array order
  and the engine's sort stability (baseline §6.1) and was therefore not a well-defined
  order at all.
- **It is input-order-independent and engine-independent**, so client and server can never
  diverge again — the defect cannot recur by construction.
- **`version` was rejected** as a tie-break: winners at the same requested version can share
  a version (e.g. two collections created in the same draft), so `version` is *not*
  guaranteed distinct and would leave ties unresolved; `collectionId` always resolves them.

The baseline flagged the client comparator as an **unknown** (its exact tie-break line was
not recoverable, baseline §6.1). This section makes the corrected rule **authoritative and
independent of that unknown**: whatever either source did, the canonical order above is the
only order the engine uses.

### 4.2 Immutable reindex (prose)

`reindex(survivors)`:

1. Sorts a **copy** by the §4.1 canonical order (never sorts the input in place — the
   source's in-place `Array.prototype.sort` mutation is eliminated, baseline §6.2).
2. Rewrites each survivor's `index` to its **dense** 0-based position in that order, by
   constructing a **new** record object (`{ ...record, index: position }`) — never
   assigning `c.index = index` on the caller's object (the source's second mutation,
   baseline §6.2).
3. Returns a **new array of new records**. The input array and its records are untouched
   (NFR-002 determinism / referential transparency).

### 4.3 Pseudocode

```
// reindex<TMap>(survivors: readonly ContentRecord<TMap>[]): readonly ContentRecord<TMap>[]
// Pure: input untouched; returns NEW array of NEW records with dense canonical index.
function reindex(survivors):
    sorted = [...survivors]                           // COPY — never sort input in place
    sorted.sort(canonicalCompare)                     // total order, deterministic
    out = []
    for position in 0 .. sorted.length - 1:
        out.push({ ...sorted[position], index: position })   // NEW record, dense index
    return freeze(out)

// canonicalCompare: the single canonical total order (supersedes both source variants).
function canonicalCompare(a: ContentRecord, b: ContentRecord): number
    if a.index != b.index:
        return a.index - b.index                      // primary: ascending index
    // tie-break: ascending collectionId (lexicographic on underlying string). Total & stable.
    ca = a.collectionId as string
    cb = b.collectionId as string
    if ca < cb: return -1
    if ca > cb: return 1
    return 0                                           // unreachable: collectionIds distinct per target
```

`canonicalCompare` returns `0` only for identical `collectionId`, which cannot occur among
distinct survivors in one target — so the order is a genuine strict total order and the
result is independent of the underlying sort's stability.

---

## 5. Operation-by-operation summary (all pure over SVER-T-0002 types)

Every operation is a **pure function**: inputs are `(state, args..., clock, ids)`, output is
a new `ContentState` (writes) or a `ContentSnapshot` (reads). None mutate inputs; none read
`Date.now`/`Math.random`/global state (NFR-001, NFR-002, REQ-007).

| Operation | Signature (over SVER-T-0002 types) | Appends | Version written | Winner resolved at | Purity / notes | Fixes |
|---|---|---|---|---|---|---|
| `create` | `(state, target, type, payload, index, clock, ids) → ContentState` | 1 live record, fresh `ids.newCollectionId()` + `ids.newId()`, `deleted:false` | draft = `nextVersion(clock.live())` | n/a (mints a new collection) | new state; no mutation | — |
| `update` | `(state, target, collectionId, payload, clock, ids) → ContentState` | 1 live record, same `collectionId`, fresh `id` | draft | **draft** `nextVersion(clock.live())` (SVER-T-0022) | prior record untouched; sees same-session edits | Defect 3 |
| `move` (in-target) | `(state, collectionId, target, target, index, clock, ids) → ContentState` | 1 live record at new `index` | draft | **draft** (SVER-T-0022) | §3.1 | Defect 3 |
| `move` (cross-target) | `(state, collectionId, source, dest, index, clock, ids) → ContentState` | tombstone in `source` + live in `dest` | draft (both) | **draft** (SVER-T-0022) | §3.2; mirrors `content.js` `set()` | Defect 1 (source tombstone is version-scoped) & Defect 3 |
| `delete` | `(state, target, collectionId, clock, ids) → ContentState` | 1 tombstone (`deleted:true`) | draft | **draft** (SVER-T-0022) | never removes prior records | Defect 1 & Defect 3 |
| `publish` | `(clock) → VersionClock` | none | advances via `clock.advance()` | n/a | §6.3; no record append | — |
| `materialize` | `(state, version) → ContentSnapshot` | none (read) | reads at `version` | argmax at `version`, LWW on same-version ties (§1.1, SVER-T-0022) | §1; single-pass, immutable reindex | Defect 1, 2 & 3 |

**Winner-resolution version (SVER-T-0022):** `update`/`move`/`delete` resolve the record
they edit at the **draft** version `nextVersion(clock.live())`, *not* `live`. Resolving at
`live` was the same-session no-op defect (Defect 3): a `create` earlier in an unpublished
draft session was stamped at draft but invisible to a subsequent `update`/`move`/`delete`
that looked at `live`. Only `publish`/`getLive` legitimately read at `clock.live()`.

`winnerFor`, `appendRecord`, `reindex`, `versionLte`, `nextVersion`, `lte`,
`canonicalCompare` are the shared pure helpers used above (the winner-selection argmax uses
`lte` for the LWW tie-break; `create`'s draft stamp uses `nextVersion`).

---

## 6. Draft/live model + injected clock/id (REQ-007)

### 6.1 Live and draft as two materializations

The draft/live split is modeled **entirely** as two `materialize` reads against the
injected `VersionClock` — there is no separate draft store (ADR SVER-A-0001 "Neutral"):

```
// live view: what published viewers see.
function live(state, clock): ContentSnapshot
    return materialize(state, clock.live())

// draft view: what the editor sees; edits accrue here.
function draft(state, clock): ContentSnapshot
    return materialize(state, nextVersion(clock.live()))
```

So invariantly `draftVersion = liveVersion + 1`. All edit operations (§5) write at the
**draft** version `nextVersion(clock.live())`; they become the winner for any
`materialize` at that version or higher, and are invisible to `live(...)` until published.
This is the corrected, injectable restatement of the source's `get()` = live,
`getNext()` = `version + 1` draft split (baseline §4).

### 6.2 Injected `IdStrategy`

All record ids come from the injected `IdStrategy` (`ids.newId()`,
`ids.newCollectionId()`); core never calls `Math.random()`/`Date.now()`. The source's
`Math.random() + Date.now()` becomes the *default* strategy an adapter supplies
(`DefaultIdStrategy` / `createSequenceIdStrategy` in `src/strategies.ts`), not core
(baseline §7, REQ-007). Tests inject `createSequenceIdStrategy(...)` for determinism.

### 6.3 `publish` advances the injected clock

`publish` performs **no content append**; it advances the live pointer purely through the
injected clock's immutable-value `advance()`:

```
// publish(clock: VersionClock): VersionClock
function publish(clock):
    return clock.advance()      // NEW clock; live moves up to what was the draft. No mutation.
```

After `publish`, `clock.live()` returns the previously-draft version, so `live(...)` now
materializes what the editor had been drafting, and `draft(...)` opens a fresh draft one
above it. No global integer counter is involved (baseline §4/§7 corrected): the clock is an
immutable value threaded by the caller, exactly `IntegerVersionClock` in `src/strategies.ts`.

---

## 7. Defect cross-reference

| Corrected rule (here) | Baseline defect fixed |
|---|---|
| §1 step 4 winner-tombstone check; removal of `if (c.deleted) return false` | Defect 1 — delete short-circuit / historical-version regression (baseline §5) |
| §2.2 NFR-004 invariant + version-timeline trace | Defect 1 — regression guard (baseline §5.2) |
| §3.2 cross-target move source tombstone is version-scoped | Defect 1 as it manifests for `moveContent`'s source-target tombstone (baseline §3, §5) |
| §4.1 single canonical order (`index` asc, `collectionId` tie-break) | Defect 2 — client/server tie-break divergence (baseline §6.1); supersedes both variants |
| §4.2/§4.3 immutable `reindex` (copy-sort + new records) | Defect 2 — in-place mutation hazard (baseline §6.2) |
| §6.2 injected `IdStrategy`; §6.3 injected `VersionClock` | Non-injectable `Math.random()+Date.now()` ids + global version counter (baseline §7) |
| §1.1 step 2 same-version last-write-wins tie-break; §5 winner resolved at **draft** for `update`/`move`/`delete` | **Defect 3 (SVER-T-0022)** — draft-session no-op: write ops resolved the winner at `live` instead of `draft`, so a create-then-{update,move,delete} of one collection within a single unpublished draft session was silently lost; and the argmax had no defined tie-break for same-version records produced by same-session edits |

---

*This document is the SVER-T-0003 deliverable under initiative SVER-I-0001. The pseudocode
references `src/types.ts` and `src/strategies.ts` (SVER-T-0002) verbatim and is implementable
1:1 by SVER-I-0002.*
