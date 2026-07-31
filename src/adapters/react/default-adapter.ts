/**
 * The React hook's zero-config default {@link StorageAdapter}.
 *
 * When a caller uses {@link useVersionedContent} without supplying an adapter,
 * the hook backs itself with this fresh, process-local in-memory store so the
 * binding works with zero configuration. It is defined HERE (in the React
 * adapter package) rather than imported from the in-memory adapter package
 * because an adapter must never import a SIBLING adapter — the guard-rails
 * boundary allows `adapter → core` only. This default therefore depends solely
 * on the pure core (`appendRecord`, `createDefaultVersionClock`) and duplicates
 * no sibling; it is the minimal append-only store the hook needs as a fallback.
 *
 * It is intentionally NOT exported from the React subpath's public barrel: it is
 * an internal default, not part of the package's public API. Consumers who want
 * a shared in-memory store import the dedicated `versioned-content-engine/memory`
 * subpath.
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

/**
 * Create a fresh, empty in-memory {@link StorageAdapter} for the hook's
 * zero-config path. Each call yields an isolated store; state and clock are held
 * in closure variables and every write REPLACES (never mutates) the prior frozen
 * reference, preserving the append-only immutability contract (NFR-002).
 *
 * @typeParam TMap - the caller's content-type map (NFR-004: strict, no `any`).
 * @returns a synchronous, isolated in-memory adapter.
 */
export function createDefaultAdapter<
  TMap extends ContentTypeMap = ContentTypeMap,
>(): StorageAdapter<TMap> {
  let state: ContentState<TMap> = Object.freeze(
    new Map(),
  ) as ContentState<TMap>;
  let clock: VersionClock = createDefaultVersionClock();

  return {
    load(): ContentState<TMap> {
      return state;
    },
    append(records: readonly ContentRecord<TMap>[]): void {
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
