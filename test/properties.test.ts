/**
 * SVER-T-0011 — Property tests over randomly-generated event logs.
 *
 * Where the fixture suites (SVER-T-0006..0010) pin exact snapshots for the
 * SVER-I-0001 worked examples, this suite asserts the engine's INVARIANTS across
 * thousands of `fast-check`-generated inputs. It hardens confidence beyond the
 * hand-written examples by exercising shapes no fixture enumerates.
 *
 * Invariants asserted (all seeded for reproducible shrinking):
 *   1. Determinism / referential transparency — same state + version => a
 *      structurally identical snapshot (materialize is a pure function of its
 *      arguments).
 *   2. Idempotence — re-materializing the snapshot's winners at the same version
 *      is a fixed point of the ordering/reindex logic.
 *   3. Immutability — deep-frozen state + args are never mutated by ANY operation
 *      or by materialize (NFR-004); untouched targets are shared by reference.
 *   4. Historical fidelity (NFR-004) — for any log, a version strictly before a
 *      collection's delete still materializes that collection's then-live record.
 *   5. Reindex totality — reindex yields dense, 0-based, contiguous indices per
 *      target, ordered by the canonical rule (index asc, collectionId asc), and
 *      is a permutation of its input winners.
 *
 * PURITY: this test imports only the core surface + fast-check (a DEV dep). It
 * never introduces a runtime dependency into `src/`.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { materialize } from "../src/materialize.js";
import { reindex, canonicalCompare } from "../src/reindex.js";
import { createContent } from "../src/operations/create.js";
import { updateContent } from "../src/operations/update.js";
import { moveContent } from "../src/operations/move.js";
import { deleteContent } from "../src/operations/delete.js";
import { publish, getLive, getDraft } from "../src/operations/publish.js";
import type { OperationDeps } from "../src/operations/create.js";
import {
  IntegerVersionClock,
  createSequenceIdStrategy,
  createDefaultVersionClock,
} from "../src/strategies.js";
import type { IdStrategy } from "../src/strategies.js";
import type {
  ContentCollectionId,
  ContentRecord,
  ContentSnapshot,
  ContentState,
  Id,
  TargetId,
  Version,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Test content map + branded helpers
// ---------------------------------------------------------------------------

interface TestMap {
  text: { readonly value: string };
}
type TestRecord = ContentRecord<TestMap>;
type TestState = ContentState<TestMap>;

const asTarget = (s: string): TargetId => s as unknown as TargetId;
const asCol = (s: string): ContentCollectionId =>
  s as unknown as ContentCollectionId;
const asVersion = (n: number): Version => n as unknown as Version;

/** A deterministic, monotonically-counting id strategy for generated runs. */
function counterIdStrategy(prefix: string): IdStrategy {
  let n = 0;
  return {
    newId(): Id {
      n += 1;
      return `${prefix}-id-${n}` as Id;
    },
    newCollectionId(): ContentCollectionId {
      n += 1;
      return `${prefix}-col-${n}` as ContentCollectionId;
    },
  };
}

/** Recursively `Object.freeze` a whole ContentState (map, arrays, records). */
function deepFreezeState(state: TestState): TestState {
  for (const records of state.values()) {
    for (const r of records) {
      Object.freeze(r.payload);
      Object.freeze(r);
    }
    Object.freeze(records);
  }
  return Object.freeze(state) as TestState;
}

// ---------------------------------------------------------------------------
// Arbitraries: random append-only logs
// ---------------------------------------------------------------------------

const TARGETS = ["t-a", "t-b", "t-c"] as const;
const COLLECTIONS = ["c-0", "c-1", "c-2", "c-3"] as const;

/** Branded arbitraries so generated values carry the opaque id types. */
const targetArb: fc.Arbitrary<TargetId> = fc
  .constantFrom(...TARGETS)
  .map(asTarget);
const collectionArb: fc.Arbitrary<ContentCollectionId> = fc
  .constantFrom(...COLLECTIONS)
  .map(asCol);

/** A single generated record (fields chosen from small domains so groups overlap). */
const recordArb: fc.Arbitrary<TestRecord> = fc
  .record({
    collectionId: fc.constantFrom(...COLLECTIONS),
    target: fc.constantFrom(...TARGETS),
    version: fc.integer({ min: 0, max: 8 }),
    index: fc.integer({ min: 0, max: 6 }),
    deleted: fc.boolean(),
    value: fc.string({ maxLength: 6 }),
    idSuffix: fc.integer({ min: 0, max: 1_000_000 }),
  })
  .map(
    (r): TestRecord =>
      ({
        collectionId: asCol(r.collectionId),
        id: `id-${r.collectionId}-${r.version}-${r.idSuffix}` as Id,
        version: asVersion(r.version),
        index: r.index,
        target: asTarget(r.target),
        deleted: r.deleted,
        type: "text" as const,
        payload: { value: r.value },
      }) as TestRecord,
  );

/**
 * A random append-only ContentState: for each target, an ordered list of
 * records (append order preserved, mirroring the real write path).
 */
const stateArb: fc.Arbitrary<TestState> = fc
  .array(recordArb, { maxLength: 40 })
  .map((records): TestState => {
    const map = new Map<TargetId, TestRecord[]>();
    for (const r of records) {
      const bucket = map.get(r.target);
      if (bucket === undefined) {
        map.set(r.target, [r]);
      } else {
        bucket.push(r);
      }
    }
    return map as TestState;
  });

const versionArb: fc.Arbitrary<Version> = fc
  .integer({ min: -1, max: 10 })
  .map(asVersion);

// Reproducible: a fixed seed so any failure shrinks to the same counter-example.
const RUN = { seed: 0xc0ffee, numRuns: 300 } as const;

/** Flatten a snapshot into a comparable, order-preserving plain structure. */
function snapshotShape(snap: ContentSnapshot<TestMap>): unknown {
  return [...snap.entries()].map(([t, recs]) => [
    String(t),
    recs.map((r) => ({
      collectionId: String(r.collectionId),
      id: String(r.id),
      version: Number(r.version),
      index: r.index,
      target: String(r.target),
      deleted: r.deleted,
    })),
  ]);
}

// ---------------------------------------------------------------------------
// 1. Determinism / referential transparency
// ---------------------------------------------------------------------------

describe("property: materialize determinism", () => {
  it("same state + version => structurally identical snapshot", () => {
    fc.assert(
      fc.property(stateArb, versionArb, (state, version) => {
        const a = snapshotShape(materialize(state, version));
        const b = snapshotShape(materialize(state, version));
        expect(a).toEqual(b);
      }),
      RUN,
    );
  });

  it("winners are always live (never a tombstone) and version-eligible", () => {
    fc.assert(
      fc.property(stateArb, versionArb, (state, version) => {
        const snap = materialize(state, version);
        for (const recs of snap.values()) {
          for (const r of recs) {
            expect(r.deleted).toBe(false);
            expect(Number(r.version)).toBeLessThanOrEqual(Number(version));
          }
        }
      }),
      RUN,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotence / fixed point of ordering
// ---------------------------------------------------------------------------

describe("property: reindex is a fixed point over already-ordered winners", () => {
  it("re-reindexing the survivors of one target is stable", () => {
    fc.assert(
      fc.property(stateArb, versionArb, (state, version) => {
        const snap = materialize(state, version);
        for (const recs of snap.values()) {
          const again = reindex(recs);
          // dense indices and identical ordering are preserved
          expect(again.map((r) => String(r.collectionId))).toEqual(
            recs.map((r) => String(r.collectionId)),
          );
          expect(again.map((r) => r.index)).toEqual(recs.map((r) => r.index));
        }
      }),
      RUN,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Immutability under deep-frozen inputs, across every operation
// ---------------------------------------------------------------------------

describe("property: operations never mutate deep-frozen input state", () => {
  const deps = (seed: string): OperationDeps => ({
    idStrategy: counterIdStrategy(seed),
    clock: new IntegerVersionClock(3),
  });

  it("materialize on frozen state does not throw or mutate", () => {
    fc.assert(
      fc.property(stateArb, versionArb, (state, version) => {
        const frozen = deepFreezeState(state);
        const before = snapshotShape(materialize(frozen, version));
        // Any hidden mutation of a frozen object would throw in strict mode.
        const after = snapshotShape(materialize(frozen, version));
        expect(after).toEqual(before);
      }),
      RUN,
    );
  });

  it("create/update/move/delete/publish leave frozen input untouched", () => {
    fc.assert(
      fc.property(
        stateArb,
        collectionArb,
        targetArb,
        targetArb,
        fc.integer({ min: 0, max: 5 }),
        (state, colId, src, dest, index) => {
          const frozen = deepFreezeState(state);
          const snapshotBefore = snapshotShape(materialize(frozen, asVersion(4)));

          // Every operation must run on frozen state without throwing.
          createContent(
            frozen,
            { target: dest, index, type: "text", payload: { value: "x" } },
            deps("cr"),
          );
          updateContent(
            frozen,
            { collectionId: colId, type: "text", payload: { value: "y" } },
            deps("up"),
          );
          moveContent(
            frozen,
            {
              collectionId: colId,
              source: src,
              dest,
              index,
            },
            deps("mv"),
          );
          deleteContent(
            frozen,
            { target: src, collectionId: colId },
            deps("dl"),
          );
          publish(frozen, new IntegerVersionClock(3));

          // Input state's observable content is unchanged after all ops.
          const snapshotAfter = snapshotShape(materialize(frozen, asVersion(4)));
          expect(snapshotAfter).toEqual(snapshotBefore);
        },
      ),
      RUN,
    );
  });

  it("append-only: an operation never shrinks the total record count", () => {
    const count = (s: TestState): number => {
      let n = 0;
      for (const recs of s.values()) n += recs.length;
      return n;
    };
    fc.assert(
      fc.property(
        stateArb,
        targetArb,
        (state, dest) => {
          const before = count(state);
          const next = createContent(
            state,
            { target: dest, index: 0, type: "text", payload: { value: "z" } },
            deps("app"),
          );
          expect(count(next)).toBe(before + 1);
          // untouched targets are shared by reference (structural sharing)
          for (const t of state.keys()) {
            if (t !== dest) {
              expect(next.get(t)).toBe(state.get(t));
            }
          }
        },
      ),
      RUN,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Historical fidelity (NFR-004) — the corrected delete semantics
// ---------------------------------------------------------------------------

describe("property: a version before a delete still materializes the content", () => {
  it("create @draft(v1), publish, delete @draft(v2): v1 still shows content", () => {
    fc.assert(
      fc.property(
        targetArb,
        fc.string({ maxLength: 8 }),
        (target, value) => {
          const idStrategy = counterIdStrategy("h");
          const clock0 = new IntegerVersionClock(0); // live 0, draft 1

          // create at draft version 1
          const s1 = createContent(
            new Map() as TestState,
            { target, index: 0, type: "text", payload: { value } },
            { idStrategy, clock: clock0 },
          );
          const created = [...s1.get(target)!][0]!;
          const colId = created.collectionId;

          // publish -> live becomes 1
          const { clock: clock1 } = publish(s1, clock0);

          // delete at draft version 2
          const s2 = deleteContent(
            s1,
            { target, collectionId: colId },
            { idStrategy, clock: clock1 },
          );

          // At/after the delete (draft v2) the collection is gone...
          const atDelete = materialize(s2, asVersion(2));
          expect(atDelete.get(target)?.some((r) => r.collectionId === colId))
            .not.toBe(true);

          // ...but strictly BEFORE the delete (v1) it still materializes.
          const beforeDelete = materialize(s2, asVersion(1));
          const survivor = beforeDelete
            .get(target)
            ?.find((r) => r.collectionId === colId);
          expect(survivor).toBeDefined();
          expect(survivor?.deleted).toBe(false);
        },
      ),
      { seed: RUN.seed, numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Reindex totality: dense, contiguous, canonically ordered permutation
// ---------------------------------------------------------------------------

describe("property: reindex produces dense 0-based canonical ordering", () => {
  // Distinct-collection survivors within one target (materialize's precondition).
  const survivorsArb: fc.Arbitrary<TestRecord[]> = fc
    .uniqueArray(fc.constantFrom(...COLLECTIONS), { maxLength: COLLECTIONS.length })
    .chain((cols) =>
      fc.tuple(
        ...cols.map((c) =>
          fc.record({ index: fc.integer({ min: 0, max: 20 }) }).map(
            ({ index }): TestRecord =>
              ({
                collectionId: asCol(c),
                id: `id-${c}` as Id,
                version: asVersion(1),
                index,
                target: asTarget("t-a"),
                deleted: false,
                type: "text" as const,
                payload: { value: c },
              }) as TestRecord,
          ),
        ),
      ),
    )
    .map((recs) => [...recs]);

  it("indices are dense 0..n-1, contiguous, and canonically ordered", () => {
    fc.assert(
      fc.property(survivorsArb, (survivors) => {
        const out = reindex(survivors);
        // dense contiguous 0-based
        expect(out.map((r) => r.index)).toEqual(out.map((_r, i) => i));
        // ordering matches the canonical compare over the same set
        const expectedOrder = [...survivors]
          .sort(canonicalCompare)
          .map((r) => String(r.collectionId));
        expect(out.map((r) => String(r.collectionId))).toEqual(expectedOrder);
        // permutation: same multiset of collections in, same out
        expect(new Set(out.map((r) => String(r.collectionId)))).toEqual(
          new Set(survivors.map((r) => String(r.collectionId))),
        );
      }),
      RUN,
    );
  });
});

// ---------------------------------------------------------------------------
// canonicalCompare — both tie-break directions at equal index (reindex §4.1)
// ---------------------------------------------------------------------------

describe("canonicalCompare exercises both collectionId tie-break directions", () => {
  const at = (index: number, collectionId: string): TestRecord =>
    ({
      collectionId: asCol(collectionId),
      id: `id-${collectionId}` as Id,
      version: asVersion(1),
      index,
      target: asTarget("t-a"),
      deleted: false,
      type: "text" as const,
      payload: { value: collectionId },
    }) as TestRecord;

  it("primary key is index; equal index tie-breaks ascending collectionId", () => {
    // primary: ascending index
    expect(canonicalCompare(at(0, "z"), at(1, "a"))).toBeLessThan(0);
    expect(canonicalCompare(at(2, "a"), at(1, "z"))).toBeGreaterThan(0);
    // tie-break at equal index, both directions (covers reindex.ts §4.1)
    expect(canonicalCompare(at(3, "a"), at(3, "b"))).toBe(-1);
    expect(canonicalCompare(at(3, "b"), at(3, "a"))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Strategy edge cases (exhaustion + default-argument branches)
// ---------------------------------------------------------------------------

describe("strategy edge cases", () => {
  it("createSequenceIdStrategy throws when collectionIds are exhausted", () => {
    const s = createSequenceIdStrategy(["id-1"], []);
    expect(() => s.newCollectionId()).toThrow(/ran out of collectionIds/);
  });

  it("createDefaultVersionClock defaults its start version to 0", () => {
    expect(Number(createDefaultVersionClock().live())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Draft/live relationship holds across random logs
// ---------------------------------------------------------------------------

describe("property: getLive/getDraft agree with materialize at live/live+1", () => {
  it("getLive == materialize(live), getDraft == materialize(live+1)", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.integer({ min: 0, max: 6 }),
        (state, live) => {
          const clock = new IntegerVersionClock(live);
          expect(snapshotShape(getLive(state, clock))).toEqual(
            snapshotShape(materialize(state, asVersion(live))),
          );
          expect(snapshotShape(getDraft(state, clock))).toEqual(
            snapshotShape(materialize(state, asVersion(live + 1))),
          );
        },
      ),
      RUN,
    );
  });
});
