/**
 * SVER-T-0010 — `publish` / `getLive` / `getDraft` on the injected clock, plus
 * `goBack` / `goForward` navigation, and an end-to-end OPERATION-SEQUENCE test.
 *
 * Asserts, against `docs/corrected-semantics.md` §6:
 *   - `publish(state, clock)` advances the live pointer via the injected
 *     immutable `VersionClock.advance()`, returns `{ state, clock }` with the
 *     SAME state (no content append) and a NEW advanced clock, and mutates
 *     neither the input state nor the input clock (§6.3, REQ-006);
 *   - `getLive(state, clock)` === `materialize(state, clock.live())` (§6.1);
 *   - `getDraft(state, clock)` === `materialize(state, clock.live() + 1)` (§6.1,
 *     draft = live + 1);
 *   - the draft→publish→live round-trip: a draft edit is INVISIBLE to live until
 *     publish, then VISIBLE (live advances on publish);
 *   - a full create → update → move → delete → publish sequence materializes
 *     correctly across the whole version range (draft vs live behavior);
 *   - purity: deeply-`Object.freeze`d inputs are never mutated.
 *
 * Determinism comes from an injected `createSequenceIdStrategy` + `IntegerVersionClock`.
 */

import { describe, expect, it } from "vitest";

import { createContent } from "../src/operations/create.js";
import { updateContent } from "../src/operations/update.js";
import { moveContent } from "../src/operations/move.js";
import { deleteContent } from "../src/operations/delete.js";
import {
  publish,
  getLive,
  getDraft,
  goBack,
  goForward,
} from "../src/operations/publish.js";
import type { OperationDeps } from "../src/operations/create.js";
import { materialize } from "../src/materialize.js";
import {
  IntegerVersionClock,
  createSequenceIdStrategy,
} from "../src/strategies.js";
import type { VersionClock } from "../src/strategies.js";
import type {
  ContentCollectionId,
  ContentRecord,
  ContentState,
  TargetId,
  Version,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixture content map + tiny branded helpers
// ---------------------------------------------------------------------------

interface TestMap {
  text: { readonly value: string };
}
type TestRecord = ContentRecord<TestMap>;
type TestState = ContentState<TestMap>;

const target = (s: string): TargetId => s as unknown as TargetId;
const col = (s: string): ContentCollectionId => s as unknown as ContentCollectionId;
const ver = (n: number): Version => n as unknown as Version;

const A = target("target-a");
const B = target("target-b");

/** Deep-freeze a `ContentState` (map + every target array + every record). */
function deepFreeze(state: TestState): TestState {
  for (const records of state.values()) {
    for (const r of records) Object.freeze(r);
    Object.freeze(records);
  }
  return Object.freeze(state) as TestState;
}

const EMPTY: TestState = deepFreeze(new Map());

/** Read the single record's payload value for a target in a snapshot. */
function values(
  snapshot: ReadonlyMap<TargetId, readonly TestRecord[]>,
  t: TargetId,
): readonly string[] {
  return (snapshot.get(t) ?? []).map((r) => r.payload.value);
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

describe("publish", () => {
  it("advances the live pointer via the injected clock and does not append content", () => {
    const clock = new IntegerVersionClock(0);
    const result = publish(EMPTY, clock);

    // NEW advanced clock; live moved 0 -> 1.
    expect(result.clock.live()).toBe(ver(1));
    // Input clock untouched (immutable value).
    expect(clock.live()).toBe(ver(0));
    // No content append: same state reference returned.
    expect(result.state).toBe(EMPTY);
  });

  it("does not mutate deeply-frozen input state or the input clock", () => {
    const clock = new IntegerVersionClock(5);
    const frozen = deepFreeze(new Map());
    const result = publish(frozen, clock);

    expect(result.state).toBe(frozen);
    expect(clock.live()).toBe(ver(5));
    expect(result.clock.live()).toBe(ver(6));
    // Chaining publish advances again without touching earlier clocks.
    const again = publish(result.state, result.clock);
    expect(again.clock.live()).toBe(ver(7));
    expect(result.clock.live()).toBe(ver(6));
  });
});

// ---------------------------------------------------------------------------
// getLive / getDraft
// ---------------------------------------------------------------------------

describe("getLive / getDraft", () => {
  it("getLive === materialize(state, clock.live()); getDraft === materialize(state, live+1)", () => {
    const clock = new IntegerVersionClock(3);
    // Seed a record live at version 3 and another appearing at version 4 (draft).
    let state: TestState = deepFreeze(new Map());
    // create at draft (live 3 -> writes at 4)
    const ids = createSequenceIdStrategy(["id-1"], ["col-1"]);
    const deps: OperationDeps = { idStrategy: ids, clock };
    state = createContent(state, { target: A, index: 0, type: "text", payload: { value: "draft-only" } }, deps);

    // getLive at v3: draft edit (v4) invisible.
    expect(getLive(state, clock).get(A)).toBeUndefined();
    expect(getLive(state, clock)).toEqual(materialize(state, ver(3)));

    // getDraft at v4: draft edit visible.
    expect(values(getDraft(state, clock), A)).toEqual(["draft-only"]);
    expect(getDraft(state, clock)).toEqual(materialize(state, ver(4)));
  });
});

// ---------------------------------------------------------------------------
// goBack / goForward navigation (version-selecting, never mutating)
// ---------------------------------------------------------------------------

describe("goBack / goForward", () => {
  it("select adjacent versions over materialize without mutating state", () => {
    // v1: "a"; v2: "b" (update). Built via ops.
    const ids = createSequenceIdStrategy(["id-1", "id-2"], ["col-1"]);
    let clock: VersionClock = new IntegerVersionClock(0);
    let state: TestState = deepFreeze(new Map());
    state = createContent(state, { target: A, index: 0, type: "text", payload: { value: "a" } }, { idStrategy: ids, clock });
    // publish so live=1, then update writes at v2
    clock = publish(state, clock).clock;
    state = updateContent(state, { collectionId: col("col-1"), type: "text", payload: { value: "b" } }, { idStrategy: ids, clock });

    const frozen = deepFreeze(state);

    // At version 2, goBack -> version 1 ("a"), goForward -> version 3 ("b" persists).
    expect(values(goBack(frozen, ver(2)), A)).toEqual(["a"]);
    expect(values(goForward(frozen, ver(1)), A)).toEqual(["b"]);
    // frozen state untouched.
    expect(frozen).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: draft edit invisible in live until publish
// ---------------------------------------------------------------------------

describe("draft/publish/live round-trip", () => {
  it("a created draft is invisible to live until publish, then visible", () => {
    const ids = createSequenceIdStrategy(["id-1"], ["col-1"]);
    let clock: VersionClock = new IntegerVersionClock(0); // live = 0
    let state: TestState = deepFreeze(new Map());

    // create at draft (writes at v1)
    state = createContent(state, { target: A, index: 0, type: "text", payload: { value: "hello" } }, { idStrategy: ids, clock });

    // Before publish: live (v0) empty, draft (v1) shows it.
    expect(getLive(state, clock).get(A)).toBeUndefined();
    expect(values(getDraft(state, clock), A)).toEqual(["hello"]);

    // publish: live advances 0 -> 1.
    const pub = publish(state, clock);
    clock = pub.clock;
    state = pub.state;

    // After publish: live (v1) now shows it; draft (v2) also shows it (no new edit yet).
    expect(values(getLive(state, clock), A)).toEqual(["hello"]);
    expect(values(getDraft(state, clock), A)).toEqual(["hello"]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end OPERATION SEQUENCE: create -> update -> move -> delete -> publish
// ---------------------------------------------------------------------------

describe("end-to-end sequence: create -> update -> move -> delete -> publish", () => {
  it("materializes correctly across the version range with draft vs live behavior", () => {
    // Each write op (update/move/delete) resolves the collection's winner at the
    // LIVE version (§5), so an edit only "sees" records that have been published.
    // The sequence therefore publishes between edit batches — exactly the
    // draft→publish→edit workflow an adapter drives. Id sequence:
    //   create col-1/id-1, col-2/id-2; update id-3; cross-target move draws a
    //   source tombstone id-4 + dest id-5; delete tombstone id-6;
    //   post-publish draft create col-3/id-7.
    const ids = createSequenceIdStrategy(
      ["id-1", "id-2", "id-3", "id-4", "id-5", "id-6", "id-7"],
      ["col-1", "col-2", "col-3"],
    );
    let clock: VersionClock = new IntegerVersionClock(0); // live = 0, draft = 1
    let state: TestState = deepFreeze(new Map());
    const deps = (): OperationDeps => ({ idStrategy: ids, clock });

    // --- Batch 1 @ draft v1: CREATE two items in A ---
    state = createContent(state, { target: A, index: 0, type: "text", payload: { value: "one" } }, deps());   // col-1
    state = createContent(state, { target: A, index: 1, type: "text", payload: { value: "two" } }, deps());   // col-2

    // Pre-publish: live (v0) empty; draft (v1) shows both.
    expect(materialize(state, ver(0)).size).toBe(0);
    expect(getLive(state, clock).size).toBe(0);
    expect(values(getDraft(state, clock), A)).toEqual(["one", "two"]);

    // PUBLISH: live 0 -> 1.
    ({ state, clock } = publish(state, clock));
    expect(values(getLive(state, clock), A)).toEqual(["one", "two"]);

    // --- Batch 2 @ draft v2: UPDATE col-1 -> "one!" and MOVE col-2 A -> B ---
    state = updateContent(state, { collectionId: col("col-1"), type: "text", payload: { value: "one!" } }, deps());
    state = moveContent(state, { collectionId: col("col-2"), source: A, dest: B, index: 0 }, deps());

    // These draft (v2) edits are INVISIBLE in live (v1) until published.
    expect(values(getLive(state, clock), A)).toEqual(["one", "two"]);  // live unchanged
    expect(values(getLive(state, clock), B)).toEqual([]);
    const draft2 = getDraft(state, clock);
    expect(values(draft2, A)).toEqual(["one!"]);   // col-1 updated, col-2 moved out
    expect(values(draft2, B)).toEqual(["two"]);    // col-2 now in B
    expect(draft2).toEqual(materialize(state, ver(2)));

    // PUBLISH: live 1 -> 2.
    ({ state, clock } = publish(state, clock));
    expect(values(getLive(state, clock), A)).toEqual(["one!"]);
    expect(values(getLive(state, clock), B)).toEqual(["two"]);

    // --- Batch 3 @ draft v3: DELETE col-1 in A ---
    state = deleteContent(state, { target: A, collectionId: col("col-1") }, deps());

    // Draft (v3) hides col-1; live (v2) still shows it (invisible until publish).
    expect(values(getLive(state, clock), A)).toEqual(["one!"]);
    expect(values(getDraft(state, clock), A)).toEqual([]); // tombstoned in draft
    expect(values(getDraft(state, clock), B)).toEqual(["two"]);

    // PUBLISH: live 2 -> 3.
    ({ state, clock } = publish(state, clock));
    expect(getLive(state, clock).get(A)).toBeUndefined(); // col-1 gone live
    expect(values(getLive(state, clock), B)).toEqual(["two"]);

    // --- Batch 4 @ draft v4: a fresh draft CREATE, invisible in live until publish ---
    state = createContent(state, { target: A, index: 0, type: "text", payload: { value: "three" } }, deps()); // col-3
    expect(getLive(state, clock).get(A)).toBeUndefined();            // live (v3) unchanged
    expect(values(getDraft(state, clock), A)).toEqual(["three"]);    // draft (v4) shows it

    // --- Historical fidelity across the full version range ---
    expect(materialize(state, ver(0)).size).toBe(0);                       // before anything
    expect(values(materialize(state, ver(1)), A)).toEqual(["one", "two"]); // both created
    expect(values(materialize(state, ver(2)), A)).toEqual(["one!"]);       // updated + col-2 moved
    expect(values(materialize(state, ver(2)), B)).toEqual(["two"]);
    expect(materialize(state, ver(3)).get(A)).toBeUndefined();             // col-1 deleted
    expect(values(materialize(state, ver(3)), B)).toEqual(["two"]);
    expect(values(materialize(state, ver(4)), A)).toEqual(["three"]);      // new draft item
    expect(values(materialize(state, ver(4)), B)).toEqual(["two"]);
  });
});
