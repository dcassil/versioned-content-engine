/**
 * In-memory adapter tests (SVER-T-0013).
 *
 * Wires `createMemoryAdapter` through the shared cross-adapter parity/contract
 * suite ({@link runStorageAdapterParitySuite}) — the SAME suite JSON
 * (SVER-T-0014) and the hook default (SVER-T-0016) reuse — proving the in-memory
 * adapter satisfies the authoritative `StorageAdapter` contract (materialize
 * parity, append-only, immutability/no-aliasing, clock round-trip).
 *
 * Also:
 *   - Proves the parity factory is genuinely REUSABLE by running a second,
 *     trivially-different dummy adapter (an array-log store) through it, so a
 *     divergent-but-correct adapter is validated by one authoritative contract.
 *   - Adds in-memory-specific unit tests for the `init` seed (state + clock) and
 *     defensive copying, to reach the ≥90% coverage bar on the adapter code.
 */

import { describe, expect, it } from "vitest";

import { createMemoryAdapter } from "../../src/adapters/memory/index.js";
import type { StorageAdapter } from "../../src/adapters/memory/index.js";
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
import type { VersionClock } from "../../src/index.js";
import {
  createContent,
  createDefaultVersionClock,
  createSequenceIdStrategy,
} from "../../src/index.js";
import { appendRecord } from "../../src/operations/internal.js";

// ---------------------------------------------------------------------------
// 1. The in-memory adapter must pass the authoritative parity contract.
// ---------------------------------------------------------------------------

runStorageAdapterParitySuite("in-memory", () =>
  createMemoryAdapter<ParityContentMap>(),
);

// ---------------------------------------------------------------------------
// 2. Reusability proof: a second, structurally-different dummy adapter passes
//    the SAME suite, demonstrating the factory validates any conformant adapter.
// ---------------------------------------------------------------------------

/**
 * A deliberately-different in-memory adapter that stores the append-only log as
 * a FLAT array of records (not a per-target map) and rebuilds `ContentState` on
 * `load`. Structurally divergent from `createMemoryAdapter`, yet must produce
 * identical observable `materialize` output — exactly what the parity suite
 * guards. This stands in for future adapters (JSON, SQL) at test time.
 */
function createArrayLogAdapter<
  TMap extends ParityContentMap = ParityContentMap,
>(): StorageAdapter<TMap> {
  const log: ContentRecord<TMap>[] = [];
  let clock: VersionClock = createDefaultVersionClock();

  return {
    load(): ContentState<TMap> {
      // Rebuild the per-target map from the flat log on every read.
      let state: ContentState<TMap> = Object.freeze(
        new Map(),
      ) as ContentState<TMap>;
      for (const r of log) state = appendRecord(state, r.target, r);
      return state;
    },
    append(records: readonly ContentRecord<TMap>[]): void {
      for (const r of records) log.push(r);
    },
    getClock: (): VersionClock => clock,
    setClock(next: VersionClock): void {
      clock = next;
    },
  };
}

runStorageAdapterParitySuite("array-log dummy (reusability proof)", () =>
  createArrayLogAdapter<ParityContentMap>(),
);

// ---------------------------------------------------------------------------
// 3. In-memory-specific unit tests (init seed, defensive copy, empty defaults).
// ---------------------------------------------------------------------------

describe("createMemoryAdapter — init seed & defensive copy", () => {
  const target = (s: string): TargetId => s as unknown as TargetId;
  const HEADER = target("header");

  function seedState(): ContentState<ParityContentMap> {
    const d = {
      idStrategy: createSequenceIdStrategy(["id-0"], ["col-0"]),
      clock: createDefaultVersionClock(),
    };
    return createContent(
      new Map() as ContentState<ParityContentMap>,
      { target: HEADER, index: 0, type: "text", payload: { value: "seed" } },
      d,
    );
  }

  it("defaults to an empty state and a clock at version 0", () => {
    const adapter = createMemoryAdapter<ParityContentMap>();
    expect([...(adapter.load() as ContentState<ParityContentMap>).keys()]).toEqual([]);
    expect((adapter.getClock() as VersionClock).live()).toBe(
      0 as unknown as Version,
    );
  });

  it("seeds from an initial state and clock", () => {
    const adapter = createMemoryAdapter<ParityContentMap>({
      state: seedState(),
      clock: createDefaultVersionClock(7),
    });
    const loaded = adapter.load() as ContentState<ParityContentMap>;
    expect(loaded.get(HEADER)?.length).toBe(1);
    expect((adapter.getClock() as VersionClock).live()).toBe(
      7 as unknown as Version,
    );
  });

  it("defensively copies the initial state (caller mutation cannot corrupt it)", () => {
    // A mutable map handed in must not alias the adapter's internal state.
    const mutable = new Map() as unknown as ContentState<ParityContentMap>;
    const adapter = createMemoryAdapter<ParityContentMap>({ state: mutable });

    // Mutate the caller's map AFTER construction.
    (mutable as unknown as Map<TargetId, readonly ContentRecord<ParityContentMap>[]>).set(
      HEADER,
      [],
    );

    // The adapter's state is unaffected — it copied on construction.
    expect([...(adapter.load() as ContentState<ParityContentMap>).keys()]).toEqual([]);
  });

  it("appending an empty record list is a no-op", () => {
    const adapter = createMemoryAdapter<ParityContentMap>();
    const before = adapter.load();
    adapter.append([]);
    expect(adapter.load()).toBe(before);
  });
});
