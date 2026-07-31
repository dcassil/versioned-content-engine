/**
 * SVER-T-0008 — `createContent` / `updateContent` (append-only) + purity tests.
 *
 * Drives both write operations with a deterministic injected `IdStrategy`
 * (`createSequenceIdStrategy`) and a deterministic `IntegerVersionClock`, and
 * asserts, against `docs/corrected-semantics.md` §5/§6:
 *   - appended records carry the correct version/collectionId/id/index/target/payload;
 *   - `materialize` at the DRAFT version reflects the change while the prior LIVE
 *     version does not (draft = live + 1, §6.1);
 *   - purity: deeply-`Object.freeze`d input state is never mutated, a NEW state
 *     object is returned, and untouched targets are `===` to the input (NFR-004);
 *   - append-only: after `updateContent`, ALL prior records for the collection
 *     survive in the new state (REQ-003).
 */

import { describe, expect, it } from "vitest";

import { createContent } from "../src/operations/create.js";
import { updateContent } from "../src/operations/update.js";
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
function makeDeps(
  ids: readonly string[],
  colIds: readonly string[],
  live: number,
): OperationDeps {
  return {
    idStrategy: createSequenceIdStrategy(ids, colIds),
    clock: new IntegerVersionClock(live),
  };
}

const v = (n: number): Version => n as unknown as Version;

// ---------------------------------------------------------------------------
// createContent
// ---------------------------------------------------------------------------

describe("createContent (§5 create, REQ-002)", () => {
  it("appends a new record with fresh collectionId+id at the draft version", () => {
    const state = deepFreeze(stateFrom([]));
    const deps = makeDeps(["id-1"], ["col-1"], /* live */ 0);

    const next = createContent(
      state,
      { target: A, index: 0, type: "text", payload: { value: "hello" } },
      deps,
    );

    const records = next.get(A)!;
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(String(r.collectionId)).toBe("col-1");
    expect(String(r.id)).toBe("id-1");
    expect(Number(r.version)).toBe(1); // draft = live(0) + 1
    expect(r.index).toBe(0);
    expect(String(r.target)).toBe("target-a");
    expect(r.deleted).toBe(false);
    expect(r.type).toBe("text");
    expect(r.payload).toEqual({ value: "hello" });
  });

  it("materialize at DRAFT reflects the create; prior LIVE version does not", () => {
    const state = deepFreeze(stateFrom([]));
    const deps = makeDeps(["id-1"], ["col-1"], 0);

    const next = createContent(
      state,
      { target: A, index: 0, type: "text", payload: { value: "hello" } },
      deps,
    );

    // live = 0: nothing created yet (created at draft v1).
    expect(materialize(next, v(0)).size).toBe(0);
    // draft = 1: the created content is visible.
    const draft = materialize(next, v(1));
    expect(draft.get(A)?.map((r) => r.payload)).toEqual([{ value: "hello" }]);
  });

  it("is pure on deeply-frozen input and returns a new state object", () => {
    const state = deepFreeze(stateFrom([]));
    const deps = makeDeps(["id-1"], ["col-1"], 0);

    const next = createContent(
      state,
      { target: A, index: 0, type: "text", payload: { value: "x" } },
      deps,
    );

    expect(next).not.toBe(state); // new object identity
    expect(state.size).toBe(0); // input untouched
  });

  it("structurally shares untouched targets (untouched array is ===)", () => {
    const seed = rec({
      collectionId: "col-existing",
      id: "seed-1",
      version: 1,
      index: 0,
      target: B,
      deleted: false,
      value: "B-content",
    });
    const state = deepFreeze(stateFrom([seed]));
    const deps = makeDeps(["id-1"], ["col-1"], 0);

    const next = createContent(
      state,
      { target: A, index: 0, type: "text", payload: { value: "in-A" } },
      deps,
    );

    // Target A is new; target B was untouched -> same array reference.
    expect(next.get(B)).toBe(state.get(B));
  });
});

// ---------------------------------------------------------------------------
// updateContent
// ---------------------------------------------------------------------------

describe("updateContent (§5 update, REQ-003)", () => {
  /** Seed: collection C created at v1 in target A, live version = 1. */
  function seededState(): TestState {
    return deepFreeze(
      stateFrom([
        rec({
          collectionId: "C",
          id: "orig",
          version: 1,
          index: 3,
          target: A,
          deleted: false,
          value: "v1",
        }),
      ]),
    );
  }

  it("appends a new record for the existing collection at the draft version", () => {
    const state = seededState();
    const deps = makeDeps(["id-2"], [], /* live */ 1);

    const next = updateContent(
      state,
      { collectionId: col("C"), type: "text", payload: { value: "v2" } },
      deps,
    );

    const records = next.get(A)!;
    expect(records).toHaveLength(2); // prior + new
    const appended = records[1]!;
    expect(String(appended.collectionId)).toBe("C"); // reused collectionId
    expect(String(appended.id)).toBe("id-2"); // fresh id
    expect(Number(appended.version)).toBe(2); // draft = live(1) + 1
    expect(appended.index).toBe(3); // inherited from current winner
    expect(String(appended.target)).toBe("target-a"); // inherited target
    expect(appended.deleted).toBe(false);
    expect(appended.payload).toEqual({ value: "v2" });
  });

  it("preserves ALL prior records for the collection (append-only)", () => {
    const state = seededState();
    const deps = makeDeps(["id-2"], [], 1);

    const next = updateContent(
      state,
      { collectionId: col("C"), type: "text", payload: { value: "v2" } },
      deps,
    );

    const ids = next.get(A)!.map((r) => String(r.id));
    expect(ids).toContain("orig"); // prior record survives
    expect(ids).toContain("id-2");
  });

  it("materialize at DRAFT shows the update; prior LIVE shows the old value", () => {
    const state = seededState();
    const deps = makeDeps(["id-2"], [], 1);

    const next = updateContent(
      state,
      { collectionId: col("C"), type: "text", payload: { value: "v2" } },
      deps,
    );

    // live = 1: still the original value.
    expect(materialize(next, v(1)).get(A)?.map((r) => r.payload)).toEqual([
      { value: "v1" },
    ]);
    // draft = 2: the updated value wins.
    expect(materialize(next, v(2)).get(A)?.map((r) => r.payload)).toEqual([
      { value: "v2" },
    ]);
  });

  it("is pure on deeply-frozen input; new state object; untouched targets ===", () => {
    const seed = rec({
      collectionId: "C",
      id: "orig",
      version: 1,
      index: 0,
      target: A,
      deleted: false,
      value: "v1",
    });
    const other = rec({
      collectionId: "D",
      id: "d1",
      version: 1,
      index: 0,
      target: B,
      deleted: false,
      value: "d",
    });
    const state = deepFreeze(stateFrom([seed, other]));
    const deps = makeDeps(["id-2"], [], 1);

    const next = updateContent(
      state,
      { collectionId: col("C"), type: "text", payload: { value: "v2" } },
      deps,
    );

    expect(next).not.toBe(state);
    expect(state.get(A)).toHaveLength(1); // input target array untouched
    expect(next.get(B)).toBe(state.get(B)); // untouched target shared by reference
  });

  it("is a no-op (same state reference) when the collection does not exist", () => {
    const state = seededState();
    const deps = makeDeps(["unused"], [], 1);

    const next = updateContent(
      state,
      { collectionId: col("missing"), type: "text", payload: { value: "x" } },
      deps,
    );

    expect(next).toBe(state); // nothing live to update
  });
});
