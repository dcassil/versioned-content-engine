/**
 * In-memory StorageAdapter subpath entry (`versioned-content-engine/memory`).
 *
 * The default, zero-dependency {@link StorageAdapter} (SVER-I-0003 REQ-002).
 * It holds the append-only {@link ContentState} and the {@link VersionClock} in
 * closure variables and satisfies the contract SYNCHRONOUSLY (every method
 * returns a plain value; callers `await` uniformly). Used by the SVER-I-0002
 * core tests, by the demo's default mode, and as the default backing store for
 * the `useVersionedContent` hook (SVER-T-0016).
 *
 * This replaces Stardust's untested, mutation-heavy in-memory `db`
 * (`server/data/content.js`) with a clean, contract-verified implementation.
 *
 * ## Append-only write path (ADR SVER-A-0001)
 * `append` is the ONLY write path. It folds each new record into a NEW
 * structurally-shared state via the core's {@link appendRecord} helper — the
 * same primitive every core write operation funnels through — so the adapter's
 * persisted state stays consistent with what the operations produce. Records
 * are never mutated or removed; a tombstone is just an appended `deleted: true`
 * record.
 *
 * ## Immutability (NFR-002)
 * The adapter never mutates previously-returned state in place. Each `append`
 * replaces the held reference with a freshly-built, frozen state; a `load()`
 * snapshot captured before an `append` therefore keeps observing the older log
 * (no aliasing). The initial state passed in is defensively copied so a caller
 * that later mutates their own map cannot corrupt the adapter.
 *
 * ## Purity / layering (NFR-001)
 * Imports ONLY the core (types, strategies, and the append helper) and the
 * adapter interface — no React, no `fs`. Dependencies flow adapter -> core.
 */

import type {
  ContentRecord,
  ContentState,
  ContentTypeMap,
  VersionClock,
} from "#core";
import { createDefaultVersionClock } from "#core";
import { appendRecord } from "#core/internal";
import type { StorageAdapter } from "../types.js";

export type { StorageAdapter } from "../types.js";

/**
 * Optional seed for {@link createMemoryAdapter}: a starting append-only log
 * and/or a starting clock. Both default to empty (an empty state and a fresh
 * clock at version 0). The provided `state` is defensively copied into the
 * adapter's own map, so the adapter never aliases (or is corrupted by later
 * mutation of) the caller's map.
 */
export interface MemoryAdapterInit<TMap extends ContentTypeMap = ContentTypeMap> {
  /** Initial append-only state; defaults to an empty, frozen state. */
  readonly state?: ContentState<TMap>;
  /** Initial version clock; defaults to `createDefaultVersionClock()` (v0). */
  readonly clock?: VersionClock;
}

/**
 * Build a fresh, frozen {@link ContentState} that is a shallow copy of `source`
 * (target arrays are shared by reference — they are already immutable/frozen —
 * but the map itself is a new object the adapter owns). An empty source yields
 * an empty frozen state.
 */
function copyState<TMap extends ContentTypeMap>(
  source: ContentState<TMap> | undefined,
): ContentState<TMap> {
  const next = new Map(source ?? []);
  return Object.freeze(next);
}

/**
 * Create the default in-memory {@link StorageAdapter} (SVER-I-0003 REQ-002).
 *
 * Holds `ContentState` + `VersionClock` in closure variables:
 *   - `load()` returns the current held state (frozen, never aliased to mutable
 *     internal storage — the held reference is itself the frozen result of the
 *     last `append`).
 *   - `append(records)` folds each record into a NEW state via the core's
 *     append-only {@link appendRecord} contract and replaces the held reference,
 *     so prior `load()` snapshots are untouched (NFR-002).
 *   - `getClock()` / `setClock(clock)` read/replace the held immutable clock.
 *
 * Every method resolves synchronously; the return types remain
 * `T | Promise<T>` only to satisfy the shared interface.
 *
 * @typeParam TMap - the caller's content-type map (NFR-004: strict, no `any`).
 * @param init - optional initial state and/or clock.
 * @returns a `StorageAdapter<TMap>` backed by in-memory closure state.
 */
export function createMemoryAdapter<
  TMap extends ContentTypeMap = ContentTypeMap,
>(init: MemoryAdapterInit<TMap> = {}): StorageAdapter<TMap> {
  // Own, frozen copies so the caller cannot mutate our internals after construction.
  let state: ContentState<TMap> = copyState(init.state);
  let clock: VersionClock = init.clock ?? createDefaultVersionClock();

  return {
    load(): ContentState<TMap> {
      return state;
    },

    append(records: readonly ContentRecord<TMap>[]): void {
      // Fold every record through the core's single write path. Each call
      // returns a NEW structurally-shared, frozen state; we only replace the
      // held reference at the end, so any earlier `load()` snapshot is untouched.
      let next = state;
      for (const record of records) {
        next = appendRecord(next, record.target, record);
      }
      state = next;
    },

    getClock(): VersionClock {
      return clock;
    },

    setClock(nextClock: VersionClock): void {
      clock = nextClock;
    },
  };
}
