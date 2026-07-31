/**
 * JSON/file adapter tests (SVER-T-0014).
 *
 * Wires `createJsonAdapter` through the shared cross-adapter parity/contract
 * suite ({@link runStorageAdapterParitySuite}) — the SAME authoritative suite the
 * in-memory adapter (SVER-T-0013) uses — proving the JSON adapter satisfies the
 * `StorageAdapter` contract (materialize parity, append-only retention,
 * immutability/no-aliasing, clock round-trip) with NO modification to that suite.
 *
 * On top of the shared suite it adds the JSON-specific guarantees the task calls
 * out:
 *   - **Reload fidelity** — persist a full create -> update -> publish workflow,
 *     construct a FRESH adapter pointed at the SAME file, and assert the reloaded
 *     state materializes IDENTICALLY (persistence correctness across instances).
 *   - **Immutability of loaded data** (NFR-002) — a `load()` result is deeply
 *     frozen; a subsequent `append` does not mutate the earlier snapshot in place.
 *   - **Graceful first load** — a missing file yields an empty state / v0 clock.
 *   - **Atomic write** — no stray temp file remains after a write.
 *
 * Every backing file is an ephemeral temp file under the OS temp dir, created
 * per test and removed in `afterEach` (Data Management: cleaned per test).
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJsonAdapter } from "../../src/adapters/json";
import {
  runStorageAdapterParitySuite,
  type ParityContentMap,
} from "./parity.js";
import type {
  ContentRecord,
  ContentState,
  TargetId,
  Version,
} from "../../src/types.js";
import type { VersionClock } from "../../src";
import {
  createContent,
  updateContent,
  publish,
  materialize,
  createSequenceIdStrategy,
  createDefaultVersionClock,
} from "../../src";
import type { OperationDeps } from "../../src";

// ---------------------------------------------------------------------------
// Ephemeral temp-file management — a fresh dir per test, cleaned in afterEach.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

/** Allocate a unique backing file path inside a fresh temp dir (tracked). */
function tempFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "vce-json-"));
  tempDirs.push(dir);
  return join(dir, "store.json");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. The JSON adapter must pass the authoritative parity contract UNCHANGED.
//    Each factory call gets its OWN fresh temp file (empty state, v0 clock).
// ---------------------------------------------------------------------------

runStorageAdapterParitySuite("json/file", () =>
  createJsonAdapter<ParityContentMap>({ filePath: tempFilePath() }),
);

// ---------------------------------------------------------------------------
// 2. JSON-specific tests: reload fidelity, immutability, first-load, atomicity.
// ---------------------------------------------------------------------------

describe("createJsonAdapter — JSON-specific behavior", () => {
  const target = (s: string): TargetId => s as unknown as TargetId;
  const HEADER = target("header");

  function deps(): OperationDeps {
    return {
      idStrategy: createSequenceIdStrategy(
        Array.from({ length: 20 }, (_, i) => `id-${i}`),
        Array.from({ length: 20 }, (_, i) => `col-${i}`),
      ),
      clock: createDefaultVersionClock(),
    };
  }

  /** Flatten a state's per-target logs into a flat record list. */
  function allRecords(
    state: ContentState<ParityContentMap>,
  ): readonly ContentRecord<ParityContentMap>[] {
    const out: ContentRecord<ParityContentMap>[] = [];
    for (const records of state.values()) for (const r of records) out.push(r);
    return out;
  }

  /** Materialize-parity comparison across a span of versions. */
  function normalize(
    state: ContentState<ParityContentMap>,
    v: Version,
  ): readonly (readonly [string, readonly ContentRecord<ParityContentMap>[]])[] {
    return [...materialize(state, v).entries()]
      .map(([t, records]) => [t as unknown as string, [...records]] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  it("reload fidelity: a fresh adapter on the same file materializes identically", async () => {
    const filePath = tempFilePath();
    const d = deps();

    // --- Persist a full create -> update -> publish workflow via adapter #1 ---
    const writer = createJsonAdapter<ParityContentMap>({ filePath });

    // create
    let state = createContent(
      new Map() as ContentState<ParityContentMap>,
      { target: HEADER, index: 0, type: "text", payload: { value: "v1" } },
      d,
    );
    await writer.append(allRecords(state));

    // update the same collection (col-0)
    const c0 = "col-0" as unknown as import("../../src/types.js").ContentCollectionId;
    const afterUpdate = updateContent(
      state,
      { collectionId: c0, type: "text", payload: { value: "v2" } },
      d,
    );
    // append only the newly produced records
    const updateRecords = allRecords(afterUpdate).filter(
      (r) => !allRecords(state).some((p) => p.id === r.id),
    );
    await writer.append(updateRecords);
    state = afterUpdate;

    // publish: advance the clock and persist it
    const published = publish(state, await writer.getClock());
    await writer.setClock(published.clock);

    // --- Reload with a FRESH adapter instance pointed at the SAME file ---
    const reader = createJsonAdapter<ParityContentMap>({ filePath });
    const reloaded = await reader.load();

    // Materialization is identical across every relevant version...
    for (const n of [0, 1, 2, 3]) {
      const v = n as unknown as Version;
      expect(normalize(reloaded, v)).toEqual(normalize(state, v));
    }
    // ...and the clock survived the round-trip.
    expect((await reader.getClock()).live()).toBe(published.clock.live());
    // ...with the full append-only log preserved (nothing lost on reload).
    expect(allRecords(reloaded).length).toBe(allRecords(state).length);
  });

  it("immutability: loaded state is deeply frozen and not mutated by a later append", async () => {
    const filePath = tempFilePath();
    const d = deps();
    const adapter = createJsonAdapter<ParityContentMap>({ filePath });

    await adapter.append(
      allRecords(
        createContent(
          new Map() as ContentState<ParityContentMap>,
          { target: HEADER, index: 0, type: "text", payload: { value: "a" } },
          d,
        ),
      ),
    );

    const snapshot = await adapter.load();
    const countBefore = allRecords(snapshot).length;
    expect(countBefore).toBe(1);

    // Loaded state (map, target arrays, records) must be frozen (NFR-002).
    expect(Object.isFrozen(snapshot)).toBe(true);
    for (const records of snapshot.values()) {
      expect(Object.isFrozen(records)).toBe(true);
      for (const r of records) expect(Object.isFrozen(r)).toBe(true);
    }

    // A subsequent append must not mutate the earlier snapshot in place.
    await adapter.append(
      allRecords(
        createContent(
          snapshot,
          { target: HEADER, index: 1, type: "text", payload: { value: "b" } },
          d,
        ),
      ).filter((r) => !allRecords(snapshot).some((p) => p.id === r.id)),
    );
    expect(allRecords(snapshot).length).toBe(countBefore);
    expect(allRecords(await adapter.load()).length).toBe(2);
  });

  it("first load: a missing file yields an empty state and a v0 clock", async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "vce-json-")), "absent.json");
    tempDirs.push(join(filePath, ".."));
    const adapter = createJsonAdapter<ParityContentMap>({ filePath });

    expect([...(await adapter.load()).keys()]).toEqual([]);
    expect((await adapter.getClock()).live()).toBe(0 as unknown as Version);
  });

  it("atomic write: no stray temp file remains after a write", async () => {
    const filePath = tempFilePath();
    const d = deps();
    const adapter = createJsonAdapter<ParityContentMap>({ filePath });
    await adapter.append(
      allRecords(
        createContent(
          new Map() as ContentState<ParityContentMap>,
          { target: HEADER, index: 0, type: "text", payload: { value: "x" } },
          d,
        ),
      ),
    );

    const dir = join(filePath, "..");
    const entries = readdirSync(dir);
    expect(entries).toContain("store.json");
    expect(entries.some((e: string) => e.endsWith(".tmp"))).toBe(false);
  });

  it("round-trips the clock through a fresh instance", async () => {
    const filePath = tempFilePath();
    const writer = createJsonAdapter<ParityContentMap>({ filePath });
    let clock: VersionClock = createDefaultVersionClock();
    clock = clock.advance().advance().advance();
    await writer.setClock(clock);

    const reader = createJsonAdapter<ParityContentMap>({ filePath });
    expect((await reader.getClock()).live()).toBe(3 as unknown as Version);
  });
});
