/**
 * SVER-T-0007 — unit tests for `materialize` and the immutable `reindex` helper.
 *
 * The primary acceptance oracle is the SVER-T-0005 worked-example fixture table:
 * `materialize(state, version)` must deep-equal each row's `expectedSnapshot`.
 * Targeted tests then pin the load-bearing edge cases individually:
 *   - pre-delete historical fidelity (NFR-004),
 *   - tombstone-winner drop,
 *   - equal-index tie-break ordering,
 *   - empty / absent target,
 *   - argmax across multiple updates,
 * and a deep-frozen-input test proving no mutation (purity / NFR-004).
 */

import { describe, expect, it } from "vitest";

import { materialize, reindex } from "../src/index.js";
import type {
  ContentCollectionId,
  ContentRecord,
  ContentState,
  Id,
  TargetId,
  Version,
} from "../src/index.js";
import {
  EVENT_LOG_STATE,
  workedExamples,
  type FixtureRecord,
  type FixtureState,
} from "../src/__fixtures__/worked-examples.js";

// ---------------------------------------------------------------------------
// Local branded-id / record helpers (kept minimal, mirror the fixture helpers)
// ---------------------------------------------------------------------------

const target = (s: string): TargetId => s as unknown as TargetId;
const col = (s: string): ContentCollectionId => s as unknown as ContentCollectionId;
const rid = (s: string): Id => s as unknown as Id;
const ver = (n: number): Version => n as unknown as Version;

function rec(args: {
  collectionId: string;
  id: string;
  version: number;
  index: number;
  target: string;
  deleted: boolean;
  value: string;
}): FixtureRecord {
  return {
    collectionId: col(args.collectionId),
    id: rid(args.id),
    version: ver(args.version),
    index: args.index,
    target: target(args.target),
    deleted: args.deleted,
    type: "text",
    payload: { value: args.value },
  };
}

function stateOf(records: readonly FixtureRecord[]): FixtureState {
  const map = new Map<TargetId, FixtureRecord[]>();
  for (const r of records) {
    const bucket = map.get(r.target);
    if (bucket === undefined) {
      map.set(r.target, [r]);
    } else {
      bucket.push(r);
    }
  }
  return map as unknown as FixtureState;
}

// ---------------------------------------------------------------------------
// 1. The worked-example fixture table is the acceptance oracle
// ---------------------------------------------------------------------------

describe.each(workedExamples)(
  "materialize fixture: $name",
  ({ state, version, expectedSnapshot }) => {
    it("materializes to the expected snapshot", () => {
      expect(materialize(state, version)).toEqual(expectedSnapshot);
    });
  },
);

// ---------------------------------------------------------------------------
// 2. Targeted edge cases
// ---------------------------------------------------------------------------

describe("materialize — pre-delete historical fidelity (NFR-004)", () => {
  it("a version strictly before a delete still materializes the then-live content", () => {
    // Canonical log: X is deleted at v4. At v3 (< v4) X must still be present.
    const snap = materialize(EVENT_LOG_STATE, ver(3));
    const a = snap.get(target("target-a"))!;
    expect(a.map((r) => String(r.collectionId))).toContain("col-x");
    // the winning payload at v3 is the update "X2", not the original "X1"
    const x = a.find((r) => String(r.collectionId) === "col-x")!;
    expect((x.payload as { value: string }).value).toBe("X2");
  });

  it("does NOT short-circuit on the mere existence of a tombstone in the log", () => {
    // A single collection: live at v1, tombstoned at v2. v1 must survive.
    const state = stateOf([
      rec({ collectionId: "c", id: "a", version: 1, index: 0, target: "t", deleted: false, value: "v1" }),
      rec({ collectionId: "c", id: "b", version: 2, index: 0, target: "t", deleted: true, value: "v1" }),
    ]);
    const atV1 = materialize(state, ver(1));
    expect(atV1.get(target("t"))?.map((r) => String(r.collectionId))).toEqual(["c"]);
  });
});

describe("materialize — tombstone winner drops the collection at/after the tombstone", () => {
  it("winner is a tombstone => collection absent at that version", () => {
    const state = stateOf([
      rec({ collectionId: "c", id: "a", version: 1, index: 0, target: "t", deleted: false, value: "v1" }),
      rec({ collectionId: "c", id: "b", version: 2, index: 0, target: "t", deleted: true, value: "v1" }),
    ]);
    // at v2 the tombstone wins -> c absent -> target t has no survivors -> omitted
    expect(materialize(state, ver(2)).has(target("t"))).toBe(false);
  });
});

describe("materialize — equal-index tie-break (§4.1)", () => {
  it("orders equal-index survivors by ascending collectionId, dense-reindexed", () => {
    const state = stateOf([
      rec({ collectionId: "col-z", id: "z", version: 1, index: 0, target: "t", deleted: false, value: "Z" }),
      rec({ collectionId: "col-y", id: "y", version: 1, index: 0, target: "t", deleted: false, value: "Y" }),
      rec({ collectionId: "col-x", id: "x", version: 1, index: 0, target: "t", deleted: false, value: "X" }),
    ]);
    const t = materialize(state, ver(1)).get(target("t"))!;
    expect(t.map((r) => String(r.collectionId))).toEqual(["col-x", "col-y", "col-z"]);
    expect(t.map((r) => r.index)).toEqual([0, 1, 2]); // dense
  });
});

describe("materialize — empty / absent target", () => {
  it("empty state => empty snapshot", () => {
    expect(materialize(stateOf([]), ver(5)).size).toBe(0);
  });

  it("no version-eligible record => target omitted", () => {
    const state = stateOf([
      rec({ collectionId: "c", id: "a", version: 5, index: 0, target: "t", deleted: false, value: "v" }),
    ]);
    // requested 4 < earliest record 5 => nothing eligible => empty
    expect(materialize(state, ver(4)).size).toBe(0);
  });
});

describe("materialize — argmax across multiple updates", () => {
  it("picks the greatest version <= requested (latest update wins)", () => {
    const state = stateOf([
      rec({ collectionId: "c", id: "a", version: 1, index: 0, target: "t", deleted: false, value: "v1" }),
      rec({ collectionId: "c", id: "b", version: 2, index: 0, target: "t", deleted: false, value: "v2" }),
      rec({ collectionId: "c", id: "d", version: 3, index: 0, target: "t", deleted: false, value: "v3" }),
    ]);
    const atV2 = materialize(state, ver(2)).get(target("t"))!;
    expect((atV2[0]!.payload as { value: string }).value).toBe("v2");
    expect(atV2[0]!.id).toBe(rid("b")); // winner's id preserved

    const atV3 = materialize(state, ver(3)).get(target("t"))!;
    expect((atV3[0]!.payload as { value: string }).value).toBe("v3");
  });
});

// ---------------------------------------------------------------------------
// 3. Purity — deep-frozen input must not be mutated
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      deepFreeze(v);
    }
    Object.freeze(value);
  }
  return value;
}

function deepFreezeState(state: FixtureState): FixtureState {
  for (const records of state.values()) {
    for (const r of records) {
      deepFreeze(r);
    }
    Object.freeze(records);
  }
  Object.freeze(state);
  return state;
}

describe("materialize / reindex — purity on deeply-frozen input (NFR-004)", () => {
  it("materialize succeeds and returns new objects without mutating frozen input", () => {
    const state = deepFreezeState(
      stateOf([
        rec({ collectionId: "col-b", id: "b", version: 1, index: 1, target: "t", deleted: false, value: "B" }),
        rec({ collectionId: "col-a", id: "a", version: 1, index: 1, target: "t", deleted: false, value: "A" }),
      ]),
    );
    const snap = materialize(state, ver(1));
    const t = snap.get(target("t"))!;
    // tie-break on equal index 1 -> a then b; dense reindex 0,1
    expect(t.map((r) => String(r.collectionId))).toEqual(["col-a", "col-b"]);
    expect(t.map((r) => r.index)).toEqual([0, 1]);
    // returned records are NEW objects (index rewritten from 1 -> 0/1)
    const originalA = [...state.get(target("t"))!].find((r) => String(r.collectionId) === "col-a")!;
    expect(originalA.index).toBe(1); // input untouched
    expect(t[0]).not.toBe(originalA); // new object
  });

  it("reindex does not mutate its frozen input array or records", () => {
    const input: readonly FixtureRecord[] = Object.freeze([
      deepFreeze(rec({ collectionId: "col-b", id: "b", version: 1, index: 5, target: "t", deleted: false, value: "B" })),
      deepFreeze(rec({ collectionId: "col-a", id: "a", version: 1, index: 5, target: "t", deleted: false, value: "A" })),
    ]);
    const out = reindex(input);
    expect(out.map((r) => String(r.collectionId))).toEqual(["col-a", "col-b"]);
    expect(out.map((r) => r.index)).toEqual([0, 1]);
    // input untouched
    expect(input.map((r) => r.index)).toEqual([5, 5]);
    expect(input.map((r) => String(r.collectionId))).toEqual(["col-b", "col-a"]);
  });
});

// ---------------------------------------------------------------------------
// 4. The specific NFR-004 version-timeline invariant (spec §2.2)
// ---------------------------------------------------------------------------

describe("materialize — spec §2.2 version-timeline invariant", () => {
  const state: ContentState = stateOf([
    rec({ collectionId: "X", id: "r1", version: 1, index: 0, target: "T", deleted: false, value: "X" }),
    rec({ collectionId: "X", id: "r2", version: 2, index: 0, target: "T", deleted: true, value: "X" }),
  ]) as unknown as ContentState;

  it("materialize(state, 1) shows X (delete at v2 does not reach back)", () => {
    const t = (materialize(state, ver(1)) as ContentState).get(target("T"));
    expect(t?.map((r: ContentRecord) => String(r.collectionId))).toEqual(["X"]);
  });

  it("materialize(state, 2) hides X (tombstone winner) and omits the empty target", () => {
    expect((materialize(state, ver(2)) as ContentState).has(target("T"))).toBe(false);
  });
});
