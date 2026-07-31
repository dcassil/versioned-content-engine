/**
 * JSON/file StorageAdapter subpath entry (`versioned-content-engine/json`).
 *
 * The persistence adapter that backs the append-only content log + version clock
 * with a single JSON file on disk (SVER-I-0003 REQ-003, SVER-T-0014). It cleanly
 * re-does Stardust's `server/data/content.js` file-`db` / `_save()` idea WITHOUT
 * its in-place `Object.assign`/splice mutations: `load()` deserializes the file
 * into an IMMUTABLE, frozen {@link ContentState}, and `append`/`setClock`
 * rewrite the file ATOMICALLY (temp file + rename) so a crash mid-write can never
 * corrupt the store (replacing the source's unguarded `_save()`).
 *
 * ## fs confinement (SVER-I-0003 REQ-003)
 * Node `fs`/`path` are imported ONLY within `src/adapters/json/` (here via the
 * `./fs-io.js` helpers). The dependency-cruiser rule `fs-confined-to-json-adapter`
 * fails the build if any `src/**` module outside `src/adapters/json/` imports
 * them; the core never touches the filesystem.
 *
 * ## Append-only write path (ADR SVER-A-0001)
 * `append` is the ONLY content write path. It folds new records into a fresh
 * frozen state via the core's {@link appendRecord} helper — the same primitive
 * every core write funnels through — then persists the whole log. Records are
 * never mutated or removed; a tombstone is just an appended `deleted: true`
 * record.
 *
 * ## Immutability (NFR-002)
 * `load()` reconstructs a DEEPLY-frozen `ContentState` from the parsed JSON and
 * caches it; the cached reference is what every `load()` returns until the next
 * write, and a write REPLACES (never mutates) that reference. A snapshot captured
 * before an `append` therefore keeps observing the older log (no aliasing).
 */

import type {
  ContentRecord,
  ContentState,
  ContentTypeMap,
  VersionClock,
} from "#core";
import { appendRecord } from "#core/internal";

import type { StorageAdapter } from "../types.js";
import {
  SCHEMA_VERSION,
  deserializeClock,
  deserializeState,
  readFile,
  serializeState,
  writeFileAtomic,
  type PersistedFile,
} from "./fs-io.js";

export type { StorageAdapter } from "../types.js";

/** Options for the JSON/file adapter. */
export interface JsonAdapterOptions {
  /** Absolute path to the JSON file backing the append-only log + clock. */
  readonly filePath: string;
}

/**
 * Create a JSON/file-backed {@link StorageAdapter} (SVER-I-0003 REQ-003).
 *
 *   - `load()` reads + deserializes the file into a DEEPLY-frozen
 *     {@link ContentState}; a missing file yields an empty state. The result is
 *     cached and returned by reference until the next write, and a write replaces
 *     (never mutates) that reference — so earlier `load()` snapshots are never
 *     aliased or mutated (NFR-002).
 *   - `append(records)` folds each record into a NEW frozen state via the core's
 *     append-only {@link appendRecord} contract, then persists the whole log
 *     atomically.
 *   - `getClock()` / `setClock(clock)` read/persist the clock's live version.
 *
 * Every method is `async` — the interface tolerates `Promise` returns, so the
 * shared parity suite `await`s them uniformly alongside the synchronous
 * in-memory adapter.
 *
 * @typeParam TMap - the caller's content-type map (NFR-004: strict, no `any`).
 * @param options - the backing `filePath`.
 * @returns a `StorageAdapter<TMap>` persisted to `filePath`.
 */
export function createJsonAdapter<
  TMap extends ContentTypeMap = ContentTypeMap,
>(options: JsonAdapterOptions): StorageAdapter<TMap> {
  const { filePath } = options;

  // Cache of the last-loaded frozen state, so repeated `load()`s return a stable
  // reference and a write can atomically swap it (no in-place mutation).
  let cachedState: ContentState<TMap> | undefined;
  let cachedClock: VersionClock | undefined;

  /** Load state + clock from disk into the cache if not already present. */
  function ensureLoaded(): {
    state: ContentState<TMap>;
    clock: VersionClock;
  } {
    if (cachedState === undefined || cachedClock === undefined) {
      const { state, clock } = readFile(filePath);
      cachedState = deserializeState<TMap>(state);
      cachedClock = deserializeClock(clock);
    }
    return { state: cachedState, clock: cachedClock };
  }

  /** Persist the current cached state + clock atomically. */
  function persist(): void {
    const { state, clock } = ensureLoaded();
    const contents: PersistedFile = {
      version: SCHEMA_VERSION,
      state: serializeState(state),
      clock: clock.live(),
    };
    writeFileAtomic(filePath, contents);
  }

  // The adapter contract tolerates synchronous OR Promise returns; the file I/O
  // here is synchronous (`readFileSync`/atomic `renameSync`), so these methods
  // return plain values. Callers `await` uniformly, so behavior is unchanged.
  return {
    load(): ContentState<TMap> {
      return ensureLoaded().state;
    },

    append(records: readonly ContentRecord<TMap>[]): void {
      const { state } = ensureLoaded();
      let next = state;
      for (const record of records) {
        next = appendRecord(next, record.target, record);
      }
      cachedState = next;
      persist();
    },

    getClock(): VersionClock {
      return ensureLoaded().clock;
    },

    setClock(nextClock: VersionClock): void {
      // Read state (if not cached) before replacing the clock, so `persist`
      // writes the full, consistent store.
      ensureLoaded();
      cachedClock = nextClock;
      persist();
    },
  };
}
