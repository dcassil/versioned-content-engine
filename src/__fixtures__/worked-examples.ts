/**
 * Worked-example fixture table — the executable acceptance oracle (SVER-T-0005).
 *
 * This module encodes ONE canonical, deterministic append-only event log
 * (`create → update → move (cross-target) → delete → publish`, across two
 * targets and multiple collections) together with the expected
 * {@link ContentSnapshot} at several requested versions. Every expected snapshot
 * is hand-derived from the authoritative algorithm spec
 * `docs/corrected-semantics.md` (SVER-T-0003) — NOT from the buggy Stardust
 * source — using:
 *
 *   - the argmax-with-tombstone winner rule (spec §1: winner = greatest
 *     `version <= requested`; absent if the winner is a `deleted:true`
 *     tombstone, "at this version only"), and
 *   - the single canonical order (spec §4.1: ascending `index`, tie-break
 *     ascending `collectionId` lexicographically) with immutable dense reindex.
 *
 * SVER-I-0002's unit tests import {@link workedExamples} and assert that its
 * `materialize(EVENT_LOG_STATE, version)` reproduces each `expectedSnapshot`
 * exactly. See the trace comments on each row for line-by-line spec grounding.
 *
 * PURITY (NFR-001): imports only the type surface from `../types.js`. No React,
 * no fs/path, no runtime deps — safe under the dependency-cruiser purity gate.
 */

import type {
  ContentCollectionId,
  ContentRecord,
  ContentSnapshot,
  ContentState,
  Id,
  TargetId,
  Version,
} from "../types.js";

// ---------------------------------------------------------------------------
// Content-type map for the worked examples
// ---------------------------------------------------------------------------

/**
 * The concrete content-type map used by every fixture record. A single `text`
 * content type keeps the fixtures focused on version/tombstone/ordering
 * semantics rather than payload shape.
 */
export interface FixtureContentMap {
  text: { readonly value: string };
}

/** Convenience alias for a fixture record over {@link FixtureContentMap}. */
export type FixtureRecord = ContentRecord<FixtureContentMap>;
/** Convenience alias for fixture state. */
export type FixtureState = ContentState<FixtureContentMap>;
/** Convenience alias for a fixture snapshot. */
export type FixtureSnapshot = ContentSnapshot<FixtureContentMap>;

// ---------------------------------------------------------------------------
// Tiny pure branded-id / record helpers (kept inside the purity boundary)
// ---------------------------------------------------------------------------

/** Brand a raw string as a {@link TargetId}. */
const target = (s: string): TargetId => s as unknown as TargetId;
/** Brand a raw string as a {@link ContentCollectionId}. */
const col = (s: string): ContentCollectionId => s as unknown as ContentCollectionId;
/** Brand a raw string as a record {@link Id}. */
const rid = (s: string): Id => s as unknown as Id;
/** Brand a raw number as a {@link Version}. */
const ver = (n: number): Version => n as unknown as Version;

/**
 * Construct a single immutable `text` {@link FixtureRecord}. Pure: returns a new
 * frozen object; performs no I/O and reads no global state.
 */
function rec(args: {
  readonly collectionId: string;
  readonly id: string;
  readonly version: number;
  readonly index: number;
  readonly target: string;
  readonly deleted: boolean;
  readonly value: string;
}): FixtureRecord {
  return Object.freeze({
    collectionId: col(args.collectionId),
    id: rid(args.id),
    version: ver(args.version),
    index: args.index,
    target: target(args.target),
    deleted: args.deleted,
    type: "text" as const,
    payload: { value: args.value } as const,
  });
}

/** Build a frozen {@link FixtureState} from a flat list of records. */
function stateFrom(records: readonly FixtureRecord[]): FixtureState {
  const map = new Map<TargetId, FixtureRecord[]>();
  for (const r of records) {
    const bucket = map.get(r.target);
    if (bucket === undefined) {
      map.set(r.target, [r]);
    } else {
      bucket.push(r);
    }
  }
  const frozen = new Map<TargetId, readonly FixtureRecord[]>();
  for (const [t, rs] of map) {
    frozen.set(t, Object.freeze([...rs]));
  }
  return frozen;
}

/** Build a frozen {@link FixtureSnapshot} from per-target survivor arrays. */
function snapshotFrom(
  entries: readonly (readonly [string, readonly FixtureRecord[]])[],
): FixtureSnapshot {
  const map = new Map<TargetId, readonly FixtureRecord[]>();
  for (const [t, rs] of entries) {
    map.set(target(t), Object.freeze([...rs]));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Named identifiers used throughout the canonical scenario
// ---------------------------------------------------------------------------

/** Target A. */
const A = "target-a";
/** Target B. */
const B = "target-b";

// Collection ids are chosen so the lexicographic tie-break (§4.1) is obvious:
//   "col-x" < "col-y" < "col-z" < "col-w"?  NOTE: "col-w" > "col-z" lexically,
// so we rely on the y<z ordering for the documented equal-index tie-break.
const X = "col-x";
const Y = "col-y";
const Z = "col-z";
/** Collection W — used only by the same-session LWW fixture (SVER-T-0022). */
const W = "col-w";

// ---------------------------------------------------------------------------
// The canonical append-only event log (records + a human-readable op trace)
// ---------------------------------------------------------------------------

/**
 * A human-readable description of one operation in the canonical scenario. This
 * is documentation/traceability only; the authoritative state is
 * {@link EVENT_LOG_STATE}, whose records carry the versions each op appended at.
 *
 * The `publish` op appends no record — it advances the injected clock
 * (spec §6.3), shifting which version `live()` materializes. It is included so
 * the log exercises every operation in the vocabulary.
 */
export interface EventLogOp {
  readonly kind: "create" | "update" | "move" | "delete" | "publish";
  /** Versions this op wrote records at (empty for `publish`). */
  readonly appendedVersions: readonly number[];
  readonly description: string;
}

/**
 * The ordered operation trace. Every op is grounded in `corrected-semantics.md`.
 *
 * Draft-version convention (spec §6.1): edits write at `nextVersion(live)`. The
 * scenario starts at live = 0, so the first draft is version 1. A `publish`
 * (spec §6.3) advances live, so the next draft is one higher. The versions
 * below are the concrete result of threading that clock.
 */
export const EVENT_LOG: readonly EventLogOp[] = [
  {
    kind: "create",
    appendedVersions: [1],
    description:
      "create X in A (draft v1). §5 create: one deleted:false record, fresh collectionId+id.",
  },
  {
    kind: "create",
    appendedVersions: [1],
    description:
      "create Y in A (draft v1). Same draft version as X -> two collections share version 1 (spec §4.1: version is NOT a valid tie-break; collectionId is).",
  },
  {
    kind: "publish",
    appendedVersions: [],
    description:
      "publish (spec §6.3): advances the clock, live 0 -> 1. No record appended; next draft becomes v2.",
  },
  {
    kind: "update",
    appendedVersions: [2],
    description:
      "update X in A (draft v2). §5 update: new deleted:false record, same collectionId X, new id, value 'X2'.",
  },
  {
    kind: "create",
    appendedVersions: [2],
    description: "create Z in B (draft v2). First record in target B.",
  },
  {
    kind: "move",
    appendedVersions: [3],
    description:
      "move Y from A to B at index 0 (draft v3). §3.2 cross-target: tombstone in A + live record in B (same collectionId Y). Lands Y in B alongside Z at equal index 0 -> §4.1 tie-break case.",
  },
  {
    kind: "delete",
    appendedVersions: [4],
    description:
      "delete X in A (draft v4). §2 tombstone: appends deleted:true record for X; hides X at/after v4 ONLY (NFR-004). Materializing v<=3 still shows X.",
  },
] as const;

/**
 * The concrete append-only record log produced by {@link EVENT_LOG}, as a flat
 * list (ordering within a target is irrelevant to `materialize`, which groups by
 * collectionId). Record ids `r1..r8` are assigned in append order.
 *
 * | id | col | version | index | target | deleted | value | appended by            |
 * |----|-----|---------|-------|--------|---------|-------|------------------------|
 * | r1 | X   | 1       | 0     | A      | false   | X1    | create X               |
 * | r2 | Y   | 1       | 1     | A      | false   | Y1    | create Y               |
 * | r3 | X   | 2       | 0     | A      | false   | X2    | update X               |
 * | r4 | Z   | 2       | 0     | B      | false   | Z1    | create Z               |
 * | r5 | Y   | 3       | 1     | A      | true    | Y1    | move Y (source tomb.)  |
 * | r6 | Y   | 3       | 0     | B      | false   | Y1    | move Y (dest live)     |
 * | r7 | X   | 4       | 0     | A      | true    | X2    | delete X (tombstone)   |
 */
export const EVENT_LOG_RECORDS: readonly FixtureRecord[] = [
  rec({ collectionId: X, id: "r1", version: 1, index: 0, target: A, deleted: false, value: "X1" }),
  rec({ collectionId: Y, id: "r2", version: 1, index: 1, target: A, deleted: false, value: "Y1" }),
  rec({ collectionId: X, id: "r3", version: 2, index: 0, target: A, deleted: false, value: "X2" }),
  rec({ collectionId: Z, id: "r4", version: 2, index: 0, target: B, deleted: false, value: "Z1" }),
  // move Y A->B: source-side tombstone in A (spec §3.2 step 1)
  rec({ collectionId: Y, id: "r5", version: 3, index: 1, target: A, deleted: true, value: "Y1" }),
  // move Y A->B: dest-side live record in B at index 0 (spec §3.2 step 2)
  rec({ collectionId: Y, id: "r6", version: 3, index: 0, target: B, deleted: false, value: "Y1" }),
  // delete X in A: tombstone at v4 (spec §2)
  rec({ collectionId: X, id: "r7", version: 4, index: 0, target: A, deleted: true, value: "X2" }),
] as const;

/** The canonical append-only {@link FixtureState} the fixtures materialize. */
export const EVENT_LOG_STATE: FixtureState = stateFrom(EVENT_LOG_RECORDS);

// ---------------------------------------------------------------------------
// Expected reindexed survivor records (post-materialize, dense canonical index)
// ---------------------------------------------------------------------------
//
// Expected snapshots carry the SURVIVING WINNER record with its index rewritten
// to its dense 0-based canonical position (spec §4.2/§4.3). We therefore build
// fresh records mirroring the winner but with the reindexed `index`. The `id`
// preserved is the WINNER's id (materialize copies the winning record and only
// rewrites `index`), so tests can assert exact record identity if desired.

/** X live winner at v1 (r1, "X1") reindexed to dense position 0. */
const X_at_v1: FixtureRecord = rec({ collectionId: X, id: "r1", version: 1, index: 0, target: A, deleted: false, value: "X1" });
/** Y live winner at v1 (r2, "Y1") reindexed to dense position 1. */
const Y_at_v1: FixtureRecord = rec({ collectionId: Y, id: "r2", version: 1, index: 1, target: A, deleted: false, value: "Y1" });

/** X live winner at v2/v3 (r3, "X2") reindexed to dense position 0 in A. */
const X_at_v2: FixtureRecord = rec({ collectionId: X, id: "r3", version: 2, index: 0, target: A, deleted: false, value: "X2" });
/** Y live winner at v2 (still r2 in A) reindexed to dense position 1. */
const Y_at_v2: FixtureRecord = rec({ collectionId: Y, id: "r2", version: 1, index: 1, target: A, deleted: false, value: "Y1" });
/** Z live winner at v2 (r4, "Z1") reindexed to dense position 0 in B. */
const Z_at_v2: FixtureRecord = rec({ collectionId: Z, id: "r4", version: 2, index: 0, target: B, deleted: false, value: "Z1" });

/** X live winner at v3 (r3, "X2") sole survivor in A -> dense position 0. */
const X_at_v3: FixtureRecord = rec({ collectionId: X, id: "r3", version: 2, index: 0, target: A, deleted: false, value: "X2" });
// In B at v3: Z (r4, index 0) and Y (r6, index 0) BOTH have index 0. Tie-break
// on ascending collectionId: "col-y" < "col-z" => Y first (dense 0), Z second (dense 1).
/** Y live winner at v3 in B (r6) reindexed to dense position 0 (tie-break winner). */
const Y_at_v3_B: FixtureRecord = rec({ collectionId: Y, id: "r6", version: 3, index: 0, target: B, deleted: false, value: "Y1" });
/** Z live winner at v3 in B (r4) reindexed to dense position 1 (loses tie-break). */
const Z_at_v3_B: FixtureRecord = rec({ collectionId: Z, id: "r4", version: 2, index: 1, target: B, deleted: false, value: "Z1" });

/** Y in B at v4 (r6) — unchanged by the v4 delete of X — dense position 0. */
const Y_at_v4_B: FixtureRecord = rec({ collectionId: Y, id: "r6", version: 3, index: 0, target: B, deleted: false, value: "Y1" });
/** Z in B at v4 (r4) — dense position 1 (same tie-break as v3). */
const Z_at_v4_B: FixtureRecord = rec({ collectionId: Z, id: "r4", version: 2, index: 1, target: B, deleted: false, value: "Z1" });

// ---------------------------------------------------------------------------
// Same-session last-write-wins fixture (SVER-T-0022)
// ---------------------------------------------------------------------------
//
// This models TWO edits of the same collection W within ONE unpublished draft
// session: both records are stamped at the SAME draft version (v1) because no
// `publish` advanced the clock between them. Append order (w1 then w2) is the
// write order, so the WINNER-SELECTION last-write-wins tie-break (§1.1) must pick
// w2 ("W2"), the LAST-appended record at the winning version. Before SVER-T-0022
// the argmax used strict `<` and would have kept w1 (first-write-wins), which is
// exactly the same-session defect this task fixes.
//
// | id  | col | version | index | target | deleted | value | appended by         |
// |-----|-----|---------|-------|--------|---------|-------|---------------------|
// | w1  | W   | 1       | 0     | A      | false   | W1    | create W (draft v1) |
// | w2  | W   | 1       | 0     | A      | false   | W2    | update W (same v1)  |
export const SAME_SESSION_LWW_RECORDS: readonly FixtureRecord[] = [
  rec({ collectionId: W, id: "w1", version: 1, index: 0, target: A, deleted: false, value: "W1" }),
  rec({ collectionId: W, id: "w2", version: 1, index: 0, target: A, deleted: false, value: "W2" }),
] as const;

/** State for the same-session LWW row: two same-version edits of W (SVER-T-0022). */
export const SAME_SESSION_LWW_STATE: FixtureState = stateFrom(SAME_SESSION_LWW_RECORDS);

/** Expected winner at v1: the LAST-appended same-version record w2 ("W2"), dense 0. */
const W_lww_at_v1: FixtureRecord = rec({ collectionId: W, id: "w2", version: 1, index: 0, target: A, deleted: false, value: "W2" });

// ---------------------------------------------------------------------------
// The fixture table
// ---------------------------------------------------------------------------

/**
 * One row of the acceptance oracle: `materialize(EVENT_LOG_STATE, version)` must
 * deep-equal `expectedSnapshot`. `traces` explains the derivation against
 * `docs/corrected-semantics.md` so a failing assertion points at a specific rule.
 */
export interface WorkedExample {
  /** Stable, human-readable case name (usable as a `test.each` title). */
  readonly name: string;
  /** The requested version to materialize at. */
  readonly version: Version;
  /** The state to materialize (the shared canonical log unless noted). */
  readonly state: FixtureState;
  /** The expected snapshot, hand-derived from the spec. */
  readonly expectedSnapshot: FixtureSnapshot;
  /** The edge case(s) this row exercises. */
  readonly edgeCases: readonly string[];
  /** Per-rule derivation notes tracing to corrected-semantics.md sections. */
  readonly traces: readonly string[];
}

/**
 * The canonical worked-example table. SVER-I-0002 iterates this directly, e.g.
 *
 * ```ts
 * describe.each(workedExamples)("$name", ({ state, version, expectedSnapshot }) => {
 *   it("materializes to the expected snapshot", () => {
 *     expect(materialize(state, version)).toEqual(expectedSnapshot);
 *   });
 * });
 * ```
 */
export const workedExamples: readonly WorkedExample[] = [
  {
    name: "empty state @ v0 -> empty snapshot",
    version: ver(0),
    state: stateFrom([]),
    expectedSnapshot: snapshotFrom([]),
    edgeCases: ["empty-target"],
    traces: [
      "§1.1 step 3: no version-eligible record anywhere -> every target absent -> {}.",
    ],
  },
  {
    name: "before-any-record @ v0 on canonical log -> empty snapshot",
    version: ver(0),
    state: EVENT_LOG_STATE,
    expectedSnapshot: snapshotFrom([]),
    edgeCases: ["empty-target"],
    traces: [
      "§1.1 step 3: earliest record is v1; no group has version <= 0 -> all absent -> {}.",
    ],
  },
  {
    name: "v1: two collections created same draft (single target, tie by version resolved by index)",
    version: ver(1),
    state: EVENT_LOG_STATE,
    expectedSnapshot: snapshotFrom([[A, [X_at_v1, Y_at_v1]]]),
    edgeCases: ["single-collection-multiple-updates (setup)"],
    traces: [
      "§1.2 A/X: winner argmax(v<=1) = r1 (v1), live -> survives.",
      "§1.2 A/Y: winner r2 (v1), live -> survives.",
      "§4.1 order: X.index 0 < Y.index 1 -> X, Y; reindex dense to 0,1 (already dense).",
      "B: no record v<=1 -> absent (§1.1 step 3).",
    ],
  },
  {
    name: "v2: update X visible, Z created in B (multiple updates, second target)",
    version: ver(2),
    state: EVENT_LOG_STATE,
    expectedSnapshot: snapshotFrom([
      [A, [X_at_v2, Y_at_v2]],
      [B, [Z_at_v2]],
    ]),
    edgeCases: ["single-collection-multiple-updates"],
    traces: [
      "§1.2 A/X: candidates r1(v1),r3(v2); argmax(v<=2)=r3 ('X2'), live -> survives (update won).",
      "§1.2 A/Y: winner r2(v1) live -> survives.",
      "§4.1 A order: X.index 0, Y.index 1 -> [X,Y] dense 0,1.",
      "§1.2 B/Z: winner r4(v2) live -> survives; sole survivor dense 0.",
    ],
  },
  {
    name: "v3: PRE-DELETE historical case + cross-target move + equal-index tie-break",
    version: ver(3),
    state: EVENT_LOG_STATE,
    expectedSnapshot: snapshotFrom([
      [A, [X_at_v3]],
      [B, [Y_at_v3_B, Z_at_v3_B]],
    ]),
    edgeCases: [
      "cross-target-move",
      "reindex-tie-break",
      "delete-then-materialize-earlier (X still present here; deleted at v4)",
    ],
    traces: [
      "NFR-004 / §2.2: X is deleted at v4 but v3 < v4, so X's winner is still r3 ('X2', live) -> X PRESENT in A. This is the regression guard.",
      "§3.2 / §1.2 A/Y: Y group in A = r2(v1,live), r5(v3,tombstone); argmax(v<=3)=r5 deleted -> Y ABSENT in A (source-side tombstone of the move, version-scoped).",
      "§1.2 B/Z: winner r4(v2) index 0, live.",
      "§3.2 / §1.2 B/Y: winner r6(v3) index 0, live (dest-side live record of the move).",
      "§4.1 tie-break: Z and Y BOTH have index 0 in B -> ascending collectionId: 'col-y' < 'col-z' => Y at dense 0, Z at dense 1.",
    ],
  },
  {
    name: "v4: AT/AFTER-DELETE case + empty target A omitted",
    version: ver(4),
    state: EVENT_LOG_STATE,
    expectedSnapshot: snapshotFrom([[B, [Y_at_v4_B, Z_at_v4_B]]]),
    edgeCases: ["delete-then-materialize (content absent)", "empty-target"],
    traces: [
      "§1.2 A/X: candidates r1,r3,r7; argmax(v<=4)=r7 (v4) deleted -> X ABSENT (§1.1 step 4, tombstone winner).",
      "§1.2 A/Y: winner r5(v3) deleted -> Y ABSENT.",
      "§1.1 step 6: A has zero survivors -> target A OMITTED from snapshot (empty-target => absent key).",
      "B unchanged from v3: Y (dense 0), Z (dense 1) by the §4.1 tie-break.",
    ],
  },
  {
    name: "same-session LWW: two edits of W at one draft version -> last-appended (W2) wins",
    version: ver(1),
    state: SAME_SESSION_LWW_STATE,
    expectedSnapshot: snapshotFrom([[A, [W_lww_at_v1]]]),
    edgeCases: ["same-session-two-edits", "same-version-last-write-wins"],
    traces: [
      "§1.1 winner-selection tie-break (SVER-T-0022): W group in A = w1(v1,'W1'), w2(v1,'W2'), both version-eligible at v<=1 and TIED at the greatest version 1.",
      "LWW: append order is w1 then w2, so w2 is the last write and wins the tie -> winner is w2 ('W2'). (The pre-fix strict-`<` argmax would have wrongly kept w1.)",
      "This is the WINNER-SELECTION tie-break, NOT the §4.1 display-ordering tie-break: there is exactly one surviving collection (W), so reindex just places it at dense 0.",
    ],
  },
] as const;

export default workedExamples;
