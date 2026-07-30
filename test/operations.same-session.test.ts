/**
 * SVER-T-0022 — draft-session winner resolution.
 *
 * Regression tests for the "create-then-edit within one unpublished draft
 * session is a silent no-op" defect (Defect 3). Before the fix, `updateContent`,
 * `moveContent`, and `deleteContent` resolved the record they edit at the LIVE
 * version (`clock.live()`) while `createContent` stamped at the DRAFT version
 * (`nextVersion(clock.live())`). So a create followed — in the SAME session, with
 * NO intervening `publish` (the clock is not advanced) — by an update/move/delete
 * of that same collection could not see the just-created (still-unpublished)
 * record, and the second op became a no-op.
 *
 * The fix resolves the winner at the DRAFT version in all three write ops, so
 * these sequences build on each other coherently (the SVER-I-0004 demo flow:
 * edit several things → preview draft → publish). See `docs/corrected-semantics.md`
 * §1.1 step 2 (same-version last-write-wins tie-break) and §5 (winner resolved at
 * draft).
 *
 * NOTE: every sequence below shares ONE `IntegerVersionClock` at live = 0 across
 * the whole session — NO `publish`/`advance` happens between ops — so all records
 * are stamped at draft version 1 and the later ops must see the earlier ones.
 */

import { describe, expect, it } from "vitest";

import { createContent } from "../src/operations/create.js";
import { updateContent } from "../src/operations/update.js";
import { moveContent } from "../src/operations/move.js";
import { deleteContent } from "../src/operations/delete.js";
import type { OperationDeps } from "../src/operations/create.js";
import { materialize } from "../src/materialize.js";
import { getDraft } from "../src/operations/publish.js";
import {
  IntegerVersionClock,
  createSequenceIdStrategy,
} from "../src/strategies.js";
import type {
  ContentCollectionId,
  ContentState,
  TargetId,
  Version,
} from "../src/types.js";

interface TestMap {
  text: { readonly value: string };
}
type TestState = ContentState<TestMap>;

const target = (s: string): TargetId => s as unknown as TargetId;
const col = (s: string): ContentCollectionId => s as unknown as ContentCollectionId;
const v = (n: number): Version => n as unknown as Version;

const A = target("target-a");
const B = target("target-b");
const EMPTY: TestState = new Map() as TestState;

/**
 * Deterministic deps sharing ONE clock across a session. `ids` feeds `newId()`
 * and `collectionIds` feeds `newCollectionId()`. The single shared `clock` (live
 * = 0, never advanced) is what makes every op in a session write at draft v1.
 */
function makeSessionDeps(
  clock: IntegerVersionClock,
  ids: readonly string[],
  collectionIds: readonly string[],
): OperationDeps {
  return {
    idStrategy: createSequenceIdStrategy(ids, collectionIds),
    clock,
  };
}

describe("SVER-T-0022 draft-session: write ops see same-session unpublished edits", () => {
  it("create → UPDATE (same session, no publish): the update is visible in the draft", () => {
    const clock = new IntegerVersionClock(0); // live = 0; draft = 1
    const deps = makeSessionDeps(clock, ["r-create", "r-update"], ["C"]);

    const s1 = createContent(EMPTY, { target: A, index: 0, type: "text", payload: { value: "V1" } }, deps);
    // Same session: same clock, NOT advanced. Resolve winner at DRAFT so it is seen.
    const s2 = updateContent(s1, { collectionId: col("C"), type: "text", payload: { value: "V2" } }, deps);

    // Update must NOT be a no-op: a second record for C exists.
    expect(s2).not.toBe(s1);
    expect(s2.get(A)).toHaveLength(2); // create + update, both at draft v1

    // Draft snapshot reflects the update; last-write-wins picks "V2".
    const draft = getDraft(s2, clock); // materialize at nextVersion(live) = v1
    expect(draft.get(A)?.map((r) => r.payload)).toEqual([{ value: "V2" }]);
    expect(materialize(s2, v(1)).get(A)?.map((r) => r.payload)).toEqual([{ value: "V2" }]);
  });

  it("create → MOVE (cross-target, same session, no publish): the move is visible in the draft", () => {
    const clock = new IntegerVersionClock(0);
    const deps = makeSessionDeps(clock, ["r-create", "r-tomb", "r-live"], ["C"]);

    const s1 = createContent(EMPTY, { target: A, index: 0, type: "text", payload: { value: "V1" } }, deps);
    const s2 = moveContent(s1, { collectionId: col("C"), source: A, dest: B, index: 0 }, deps);

    // Move must NOT be a no-op: source tombstone in A + live record in B appended.
    expect(s2).not.toBe(s1);
    expect(s2.get(A)).toHaveLength(2); // create + source tombstone
    expect(s2.get(B)).toHaveLength(1); // dest live record

    const draft = getDraft(s2, clock);
    expect(draft.has(A)).toBe(false); // C left A (source tombstone wins at draft v1)
    expect(draft.get(B)?.map((r) => r.payload)).toEqual([{ value: "V1" }]); // C now in B
  });

  it("create → DELETE (same session, no publish): the delete is visible in the draft", () => {
    const clock = new IntegerVersionClock(0);
    const deps = makeSessionDeps(clock, ["r-create", "r-tomb"], ["C"]);

    const s1 = createContent(EMPTY, { target: A, index: 0, type: "text", payload: { value: "V1" } }, deps);
    const s2 = deleteContent(s1, { target: A, collectionId: col("C") }, deps);

    // Delete must NOT be a no-op: a tombstone for C is appended.
    expect(s2).not.toBe(s1);
    expect(s2.get(A)).toHaveLength(2); // create + tombstone

    const draft = getDraft(s2, clock);
    expect(draft.has(A)).toBe(false); // C absent in the draft (tombstone wins at draft v1)
  });

  it("create → update → move → delete chained in ONE session all compose at draft v1", () => {
    const clock = new IntegerVersionClock(0);
    const deps = makeSessionDeps(
      clock,
      ["r-create", "r-update", "r-tomb-move", "r-live-move", "r-tomb-del"],
      ["C"],
    );

    const s1 = createContent(EMPTY, { target: A, index: 0, type: "text", payload: { value: "V1" } }, deps);
    const s2 = updateContent(s1, { collectionId: col("C"), type: "text", payload: { value: "V2" } }, deps);
    // move sees the update (V2) and carries it to B
    const s3 = moveContent(s2, { collectionId: col("C"), source: A, dest: B, index: 0 }, deps);
    expect(getDraft(s3, clock).get(B)?.map((r) => r.payload)).toEqual([{ value: "V2" }]);
    // delete in B sees the moved record and tombstones it
    const s4 = deleteContent(s3, { target: B, collectionId: col("C") }, deps);
    const draft = getDraft(s4, clock);
    expect(draft.has(A)).toBe(false);
    expect(draft.has(B)).toBe(false); // fully removed within the session
  });

  it("same-version LAST-WRITE-WINS: two same-session updates, the last appended wins", () => {
    const clock = new IntegerVersionClock(0);
    const deps = makeSessionDeps(clock, ["r-create", "r-u1", "r-u2"], ["C"]);

    const s1 = createContent(EMPTY, { target: A, index: 0, type: "text", payload: { value: "V1" } }, deps);
    const s2 = updateContent(s1, { collectionId: col("C"), type: "text", payload: { value: "V2" } }, deps);
    const s3 = updateContent(s2, { collectionId: col("C"), type: "text", payload: { value: "V3" } }, deps);

    // Three records for C, all at draft v1; the LAST appended ("V3") must win.
    expect(s3.get(A)).toHaveLength(3);
    expect(getDraft(s3, clock).get(A)?.map((r) => r.payload)).toEqual([{ value: "V3" }]);
  });

  it("PURITY: the sequence is pure on a frozen created state (no input mutation)", () => {
    const clock = new IntegerVersionClock(0);
    const deps = makeSessionDeps(clock, ["r-create", "r-update"], ["C"]);

    const s1 = createContent(EMPTY, { target: A, index: 0, type: "text", payload: { value: "V1" } }, deps);
    // Deep-freeze the created state before the second op.
    for (const records of s1.values()) {
      for (const r of records) {
        Object.freeze(r);
        Object.freeze((r as { payload: unknown }).payload);
      }
      Object.freeze(records);
    }
    Object.freeze(s1);

    const before = s1.get(A)!;
    const s2 = updateContent(s1, { collectionId: col("C"), type: "text", payload: { value: "V2" } }, deps);

    expect(s2).not.toBe(s1);
    expect(s1.get(A)).toBe(before); // input target array reference untouched
    expect(s1.get(A)).toHaveLength(1); // input never mutated
  });
});
