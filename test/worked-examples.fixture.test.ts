/**
 * Self-check for the SVER-T-0005 worked-example fixtures.
 *
 * This does NOT test `materialize` (owned by SVER-I-0002). It only asserts the
 * fixture table is internally well-formed and typed, so a broken fixture is
 * caught here rather than surfacing as a confusing failure in SVER-I-0002.
 */

import { describe, expect, it } from "vitest";

import {
  EVENT_LOG,
  EVENT_LOG_RECORDS,
  EVENT_LOG_STATE,
  workedExamples,
} from "../src/__fixtures__/worked-examples.js";

describe("worked-example fixtures are well-formed", () => {
  it("the canonical event log covers every operation kind", () => {
    const kinds = new Set(EVENT_LOG.map((op) => op.kind));
    for (const kind of ["create", "update", "move", "delete", "publish"]) {
      expect(kinds.has(kind as never)).toBe(true);
    }
  });

  it("spans at least two targets and multiple collections", () => {
    expect(new Set(EVENT_LOG_RECORDS.map((r) => String(r.target))).size).toBeGreaterThanOrEqual(2);
    expect(new Set(EVENT_LOG_RECORDS.map((r) => String(r.collectionId))).size).toBeGreaterThanOrEqual(3);
  });

  it("EVENT_LOG_STATE is keyed by target and append-only (records match the flat list)", () => {
    const flat = [...EVENT_LOG_STATE.values()].flatMap((rs) => [...rs]);
    expect(flat).toHaveLength(EVENT_LOG_RECORDS.length);
  });

  it("record ids are unique", () => {
    const ids = EVENT_LOG_RECORDS.map((r) => String(r.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every fixture row has a name, traces, and a defined snapshot", () => {
    for (const ex of workedExamples) {
      expect(ex.name.length).toBeGreaterThan(0);
      expect(ex.traces.length).toBeGreaterThan(0);
      expect(ex.expectedSnapshot).toBeInstanceOf(Map);
    }
  });

  it("covers all five required edge cases across the table", () => {
    const all = workedExamples.flatMap((ex) => ex.edgeCases).join(" | ");
    for (const needle of [
      "empty-target",
      "single-collection-multiple-updates",
      "cross-target-move",
      "delete-then-materialize",
      "reindex-tie-break",
    ]) {
      expect(all).toContain(needle);
    }
  });

  it("has a strictly-before-delete row where X is present and an at-delete row where A is absent", () => {
    const v3 = workedExamples.find((ex) => Number(ex.version) === 3);
    const v4 = workedExamples.find((ex) => Number(ex.version) === 4);
    expect(v3).toBeDefined();
    expect(v4).toBeDefined();

    // NFR-004: at v3 (before the v4 delete) X is still present in target A.
    const aAtV3 = v3?.expectedSnapshot.get([...v3.expectedSnapshot.keys()].find((k) => String(k) === "target-a")!);
    expect(aAtV3?.some((r) => String(r.collectionId) === "col-x")).toBe(true);

    // At v4 target A resolves to no survivors -> omitted from the snapshot.
    expect([...v4!.expectedSnapshot.keys()].map(String)).not.toContain("target-a");
  });

  it("v3 tie-break: equal-index survivors in B are ordered Y (col-y) before Z (col-z)", () => {
    const v3 = workedExamples.find((ex) => Number(ex.version) === 3)!;
    const bKey = [...v3.expectedSnapshot.keys()].find((k) => String(k) === "target-b")!;
    const b = v3.expectedSnapshot.get(bKey)!;
    expect(b.map((r) => String(r.collectionId))).toEqual(["col-y", "col-z"]);
    // dense reindex assigns positions 0,1
    expect(b.map((r) => r.index)).toEqual([0, 1]);
  });
});
