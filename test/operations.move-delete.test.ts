/**
 * SVER-T-0009 — `moveContent` / `deleteContent` (tombstoning) + the
 * historical-fidelity regression + purity tests.
 *
 * Drives both operations with a deterministic injected `IdStrategy`
 * (`createSequenceIdStrategy`) and a deterministic `IntegerVersionClock`, and
 * asserts, against `docs/corrected-semantics.md` §2 (delete) and §3 (move):
 *   - deleteContent appends a `deleted:true` tombstone at the draft version and
 *     hides the collection at/after the delete ONLY — materializing STRICTLY
 *     BEFORE the delete still yields the (then-live) content (NFR-004);
 *   - moveContent same-target appends one live record at the new index (reorder);
 *   - moveContent cross-target appends a SOURCE tombstone + a DEST live record, so
 *     materialize shows the item moved and the source target loses it;
 *   - both operations are pure on deeply-frozen input (new state object; untouched
 *     targets `===` the input; input never mutated);
 *   - both are no-ops (same state reference) when the collection is absent/tombstoned;
 *   - the worked-example fixture (which already contains a cross-target move + a
 *     delete) reproduces exactly when replayed through these operations.
 */

import { describe, expect, it } from "vitest";

import { moveContent } from "../src/operations/move.js";
import { deleteContent } from "../src/operations/delete.js";
import type { OperationDeps } from "../src/operations/create.js";
import { materialize } from "../src/materialize.js";
import {
  IntegerVersionClock,
  createSequenceIdStrategy,
} from "../src/strategies.js";
import type {
  ContentCollectionId,
  ContentRecord,
  ContentState,
  TargetId,
  Version,
} from "../src/types.js";
import {
  EVENT_LOG_STATE,
  workedExamples,
} from "../src/__fixtures__/worked-examples.js";

// ---------------------------------------------------------------------------
// Fixture content map + tiny branded helpers (kept local to the test)
// ---------------------------------------------------------------------------

interface TestMap {
  text: { readonly value: string };
}
type TestRecord = ContentRecord<TestMap>;
type TestState = ContentState<TestMap>;

const target = (s: string): TargetId => s as unknown as TargetId;
const col = (s: string): ContentCollectionId => s as unknown as ContentCollectionId;
const v = (n: number): Version => n as unknown as Version;

const A = target("target-a");
const B = target("target-b");

/** A text record builder for seeding pre-existing state. */
function rec(args: {
  collectionId: string;
  id: string;
  version: number;
  index: number;
  target: TargetId;
  deleted: boolean;
  value: string;
}): TestRecord {
  return Object.freeze({
    collectionId: col(args.collectionId),
    id: args.id as unknown as TestRecord["id"],
    version: args.version as unknown as Version,
    index: args.index,
    target: args.target,
    deleted: args.deleted,
    type: "text" as const,
    payload: { value: args.value } as const,
  });
}

/** Build a frozen state from a flat record list (grouped by target). */
function stateFrom(records: readonly TestRecord[]): TestState {
  const map = new Map<TargetId, readonly TestRecord[]>();
  for (const r of records) {
    const prev = map.get(r.target) ?? [];
    map.set(r.target, [...prev, r]);
  }
  return map;
}

/** Deep-freeze a state: the map, each target array, and each record. */
function deepFreeze(state: TestState): TestState {
  for (const records of state.values()) {
    for (const r of records) {
      Object.freeze(r);
      Object.freeze((r as { payload: unknown }).payload);
    }
    Object.freeze(records);
  }
  return Object.freeze(state);
}

/** Deterministic deps: sequence ids + a clock whose `live()` is `live`. */
function makeDeps(ids: readonly string[], live: number): OperationDeps {
  return {
    idStrategy: createSequenceIdStrategy(ids, []),
    clock: new IntegerVersionClock(live),
  };
}

// ---------------------------------------------------------------------------
// deleteContent — tombstone + historical fidelity (§2, REQ-005, NFR-004)
// ---------------------------------------------------------------------------

describe("deleteContent (§2 tombstone, REQ-005)", () => {
  /** Seed: X created at v1 in A, updated at v2; live version = 2. */
  function seededState(): TestState {
    return deepFreeze(
      stateFrom([
        rec({ collectionId: "X", id: "r1", version: 1, index: 0, target: A, deleted: false, value: "X1" }),
        rec({ collectionId: "X", id: "r2", version: 2, index: 0, target: A, deleted: false, value: "X2" }),
      ]),
    );
  }

  it("appends a deleted:true tombstone at the draft version, inheriting type/payload", () => {
    const state = seededState();
    const next = deleteContent(state, { target: A, collectionId: col("X") }, makeDeps(["tomb"], 2));

    const records = next.get(A)!;
    expect(records).toHaveLength(3); // r1, r2, tombstone
    const tomb = records[2]!;
    expect(String(tomb.collectionId)).toBe("X");
    expect(String(tomb.id)).toBe("tomb"); // fresh id
    expect(Number(tomb.version)).toBe(3); // draft = live(2) + 1
    expect(tomb.deleted).toBe(true);
    expect(tomb.type).toBe("text");
    expect(tomb.payload).toEqual({ value: "X2" }); // inherited from current winner
  });

  it("HISTORICAL FIDELITY (NFR-004): delete at vN hides at/after vN, but v<N still shows the item", () => {
    const state = seededState();
    const next = deleteContent(state, { target: A, collectionId: col("X") }, makeDeps(["tomb"], 2));

    // Strictly before the delete (v1): the original create still materializes.
    expect(materialize(next, v(1)).get(A)?.map((r) => r.payload)).toEqual([{ value: "X1" }]);
    // Strictly before the delete (v2): the update still materializes.
    expect(materialize(next, v(2)).get(A)?.map((r) => r.payload)).toEqual([{ value: "X2" }]);
    // At/after the delete (v3): X is gone; target A has no survivors -> omitted.
    expect(materialize(next, v(3)).has(A)).toBe(false);
    expect(materialize(next, v(3)).size).toBe(0);
  });

  it("is pure on deeply-frozen input; new state object; untouched targets ===", () => {
    const seed = seededState();
    const other = rec({ collectionId: "D", id: "d1", version: 1, index: 0, target: B, deleted: false, value: "d" });
    const state = deepFreeze(stateFrom([...seed.get(A)!, other]));

    const next = deleteContent(state, { target: A, collectionId: col("X") }, makeDeps(["tomb"], 2));

    expect(next).not.toBe(state);
    expect(state.get(A)).toHaveLength(2); // input target array untouched
    expect(next.get(B)).toBe(state.get(B)); // untouched target shared by reference
  });

  it("is a no-op (same state reference) when the collection is absent", () => {
    const state = seededState();
    const next = deleteContent(state, { target: A, collectionId: col("missing") }, makeDeps(["unused"], 2));
    expect(next).toBe(state);
  });

  it("is a no-op (same state reference) when the collection is already tombstoned", () => {
    const state = deepFreeze(
      stateFrom([
        rec({ collectionId: "X", id: "r1", version: 1, index: 0, target: A, deleted: false, value: "X1" }),
        rec({ collectionId: "X", id: "r2", version: 2, index: 0, target: A, deleted: true, value: "X1" }),
      ]),
    );
    const next = deleteContent(state, { target: A, collectionId: col("X") }, makeDeps(["unused"], 2));
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// moveContent — same-target reorder + cross-target tombstoning (§3, REQ-004)
// ---------------------------------------------------------------------------

describe("moveContent (§3 move, REQ-004)", () => {
  it("same-target reorder: appends one live record at the new index; reindex normalizes on read", () => {
    const state = deepFreeze(
      stateFrom([
        rec({ collectionId: "P", id: "p1", version: 1, index: 0, target: A, deleted: false, value: "P" }),
        rec({ collectionId: "Q", id: "q1", version: 1, index: 1, target: A, deleted: false, value: "Q" }),
      ]),
    );
    // Move P to index 5 (after Q). live = 1 -> draft = 2.
    const next = moveContent(state, { collectionId: col("P"), source: A, dest: A, index: 5 }, makeDeps(["p2"], 1));

    const records = next.get(A)!;
    expect(records).toHaveLength(3); // p1, q1, p2
    const moved = records[2]!;
    expect(String(moved.collectionId)).toBe("P");
    expect(String(moved.id)).toBe("p2");
    expect(Number(moved.version)).toBe(2);
    expect(moved.index).toBe(5);
    expect(String(moved.target)).toBe("target-a");
    expect(moved.deleted).toBe(false);

    // At draft v2: Q (index 1) then P (index 5) -> dense reindex to [Q, P].
    const snap = materialize(next, v(2)).get(A)!;
    expect(snap.map((r) => String(r.collectionId))).toEqual(["Q", "P"]);
    // At v1 (before the move): original order preserved [P, Q].
    expect(materialize(next, v(1)).get(A)!.map((r) => String(r.collectionId))).toEqual(["P", "Q"]);
  });

  it("cross-target move: source tombstone + dest live record; materialize shows the item moved", () => {
    const state = deepFreeze(
      stateFrom([
        rec({ collectionId: "M", id: "m1", version: 1, index: 0, target: A, deleted: false, value: "M" }),
        rec({ collectionId: "N", id: "n1", version: 1, index: 0, target: B, deleted: false, value: "N" }),
      ]),
    );
    // Move M from A to B at index 3. live = 1 -> draft = 2. Two ids consumed: tombstone, dest.
    const next = moveContent(
      state,
      { collectionId: col("M"), source: A, dest: B, index: 3 },
      makeDeps(["m-tomb", "m-live"], 1),
    );

    // Source A gains a tombstone for M.
    const aRecords = next.get(A)!;
    expect(aRecords).toHaveLength(2); // m1, tombstone
    const tomb = aRecords[1]!;
    expect(tomb.deleted).toBe(true);
    expect(String(tomb.collectionId)).toBe("M");
    expect(String(tomb.id)).toBe("m-tomb");
    expect(Number(tomb.version)).toBe(2);

    // Dest B gains a live record for M.
    const bRecords = next.get(B)!;
    expect(bRecords).toHaveLength(2); // n1, m-live
    const dest = bRecords[1]!;
    expect(dest.deleted).toBe(false);
    expect(String(dest.collectionId)).toBe("M");
    expect(String(dest.id)).toBe("m-live");
    expect(String(dest.target)).toBe("target-b");
    expect(dest.index).toBe(3);

    // At draft v2: A no longer materializes M (only M was there -> A omitted);
    // B materializes both N and M.
    const snap = materialize(next, v(2));
    expect(snap.has(A)).toBe(false);
    expect(snap.get(B)!.map((r) => String(r.collectionId)).sort()).toEqual(["M", "N"]);

    // At v1 (before the move): M still lives in A, B has only N (historical fidelity).
    const before = materialize(next, v(1));
    expect(before.get(A)!.map((r) => String(r.collectionId))).toEqual(["M"]);
    expect(before.get(B)!.map((r) => String(r.collectionId))).toEqual(["N"]);
  });

  it("cross-target move is pure: new state; source array untouched; unrelated target ===", () => {
    const unrelated = rec({ collectionId: "U", id: "u1", version: 1, index: 0, target: target("target-c"), deleted: false, value: "U" });
    const state = deepFreeze(
      stateFrom([
        rec({ collectionId: "M", id: "m1", version: 1, index: 0, target: A, deleted: false, value: "M" }),
        unrelated,
      ]),
    );

    const next = moveContent(
      state,
      { collectionId: col("M"), source: A, dest: B, index: 0 },
      makeDeps(["m-tomb", "m-live"], 1),
    );

    expect(next).not.toBe(state);
    expect(state.get(A)).toHaveLength(1); // input source array untouched
    expect(next.get(target("target-c"))).toBe(state.get(target("target-c"))); // unrelated target shared
  });

  it("is a no-op (same state reference) when the collection is absent in the source", () => {
    const state = deepFreeze(
      stateFrom([rec({ collectionId: "M", id: "m1", version: 1, index: 0, target: A, deleted: false, value: "M" })]),
    );
    const next = moveContent(state, { collectionId: col("missing"), source: A, dest: B, index: 0 }, makeDeps(["unused"], 1));
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Replay against the worked-example oracle (cross-target move + delete)
// ---------------------------------------------------------------------------

describe("worked-example replay (SVER-T-0005 oracle)", () => {
  /**
   * Replay the canonical scenario's move + delete through the real operations
   * and assert the resulting state materializes identically to the hand-derived
   * EVENT_LOG_STATE at every fixture version. The scenario before the move:
   *   A: X@v1(r1), Y@v1(r2), X@v2(r3);  B: Z@v2(r4). live = 2.
   * Then: move Y A->B @ draft v3, then delete X in A @ draft v4.
   */
  it("move(Y,A->B) then delete(X,A) reproduces the fixture snapshots", () => {
    const preMove = deepFreeze(
      stateFrom([
        rec({ collectionId: "col-x", id: "r1", version: 1, index: 0, target: A, deleted: false, value: "X1" }),
        rec({ collectionId: "col-y", id: "r2", version: 1, index: 1, target: A, deleted: false, value: "Y1" }),
        rec({ collectionId: "col-x", id: "r3", version: 2, index: 0, target: A, deleted: false, value: "X2" }),
        rec({ collectionId: "col-z", id: "r4", version: 2, index: 0, target: B, deleted: false, value: "Z1" }),
      ]),
    );

    // move Y A->B at index 0, draft v3 (live = 2). ids r5 (tombstone), r6 (dest).
    const afterMove = moveContent(
      preMove,
      { collectionId: col("col-y"), source: A, dest: B, index: 0 },
      makeDeps(["r5", "r6"], 2),
    );
    // delete X in A, draft v4 (live = 3). id r7 (tombstone).
    const afterDelete = deleteContent(
      afterMove,
      { target: A, collectionId: col("col-x") },
      makeDeps(["r7"], 3),
    );

    // The reconstructed state must materialize identically to the oracle at every
    // fixture version — including the pre-delete v3 cross-target + tie-break case.
    for (const example of workedExamples) {
      if (example.state !== EVENT_LOG_STATE) continue;
      expect(materialize(afterDelete, example.version)).toEqual(
        materialize(EVENT_LOG_STATE, example.version),
      );
    }
  });
});
