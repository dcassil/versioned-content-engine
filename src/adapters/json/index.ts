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
 * Node `fs`/`path` are imported ONLY in this module. The dependency-cruiser rule
 * `fs-confined-to-json-adapter` fails the build if any `src/**` module outside
 * `src/adapters/json/` imports them; the core never touches the filesystem.
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
 *
 * ## Serialization of branded ids / Version (NFR-004)
 * `Id`, `ContentCollectionId`, `TargetId`, and `Version` are branded PRIMITIVES
 * (strings / numbers) at runtime, so JSON round-trips their values faithfully.
 * The (de)serializers below re-attach the brands with explicit, typed casts —
 * the only place casting the raw JSON back to the opaque types is permitted — so
 * the reloaded state is byte-for-byte identical in observable behavior.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  ContentRecord,
  ContentState,
  ContentTypeMap,
  TargetId,
} from "../../types.js";
import type { VersionClock } from "../../strategies.js";
import { createDefaultVersionClock } from "../../strategies.js";
import { appendRecord } from "../../operations/internal.js";
import type { StorageAdapter } from "../types.js";

export type { StorageAdapter } from "../types.js";

/** Options for the JSON/file adapter. */
export interface JsonAdapterOptions {
  /** Absolute path to the JSON file backing the append-only log + clock. */
  readonly filePath: string;
}

// ---------------------------------------------------------------------------
// On-disk schema
// ---------------------------------------------------------------------------

/**
 * The persisted shape. The append-only state is stored as an array of
 * `[targetKey, records]` entries (a plain, JSON-friendly encoding of the
 * `ReadonlyMap`), and the clock as its single live-version integer. `version`
 * documents the on-disk format so a future migration is unambiguous.
 */
interface PersistedFile {
  /** On-disk schema version (bump on any breaking format change). */
  readonly version: 1;
  /** The append-only log, encoded as ordered map entries. */
  readonly state: ReadonlyArray<readonly [string, readonly unknown[]]>;
  /** The persisted version clock's live version. */
  readonly clock: number;
}

/** The currently supported on-disk schema version. */
const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// (De)serialization — brands are re-attached here, the only permitted place.
// ---------------------------------------------------------------------------

/**
 * Encode a live {@link ContentState} into the JSON-friendly persisted form.
 * Records are plain readonly objects, so they serialize directly; only the
 * `ReadonlyMap` needs flattening into entries.
 */
function serializeState<TMap extends ContentTypeMap>(
  state: ContentState<TMap>,
): ReadonlyArray<readonly [string, readonly ContentRecord<TMap>[]]> {
  return [...state.entries()].map(
    ([target, records]) => [target as unknown as string, records] as const,
  );
}

/**
 * Rebuild a DEEPLY-frozen {@link ContentState} from the persisted entries.
 * Each record is re-frozen and each target array is re-frozen, so the reloaded
 * state cannot be mutated in place (NFR-002). Branded ids/`Version` survive the
 * round-trip unchanged (they are the same primitive values); the cast only
 * re-attaches the compile-time brand to the parsed data.
 */
function deserializeState<TMap extends ContentTypeMap>(
  entries: ReadonlyArray<readonly [string, readonly unknown[]]>,
): ContentState<TMap> {
  const map = new Map<TargetId, readonly ContentRecord<TMap>[]>();
  for (const [targetKey, rawRecords] of entries) {
    const records = rawRecords.map((r) =>
      Object.freeze(r as ContentRecord<TMap>),
    );
    map.set(targetKey as unknown as TargetId, Object.freeze(records));
  }
  return Object.freeze(map) as ContentState<TMap>;
}

/** Reconstruct an immutable-value {@link VersionClock} from its live integer. */
function deserializeClock(live: number): VersionClock {
  return createDefaultVersionClock(live);
}

// ---------------------------------------------------------------------------
// Atomic file I/O (confined to this module)
// ---------------------------------------------------------------------------

/**
 * Read + parse the backing file. A missing file (first load) yields an empty,
 * frozen state and a fresh clock at version 0 — never an error (graceful
 * first-load, matching the source's implicit empty-`db` start).
 */
function readFile(filePath: string): {
  state: ReadonlyArray<readonly [string, readonly unknown[]]>;
  clock: number;
} {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return { state: [], clock: 0 };
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as PersistedFile;
  return { state: parsed.state, clock: parsed.clock };
}

/**
 * Persist the whole store ATOMICALLY: write to a sibling temp file, then rename
 * it over the target. `rename` is atomic on POSIX, so a reader (or a crash) sees
 * either the old file or the fully-written new file — never a partial write.
 * This replaces the source's unguarded `_save()` (SVER-T-0014 acceptance).
 */
function writeFileAtomic(filePath: string, contents: PersistedFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(contents), "utf8");
  renameSync(tempPath, filePath);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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
    writeFileAtomic(filePath, {
      version: SCHEMA_VERSION,
      state: serializeState(state),
      clock: clock.live() as unknown as number,
    });
  }

  return {
    async load(): Promise<ContentState<TMap>> {
      return ensureLoaded().state;
    },

    async append(records: readonly ContentRecord<TMap>[]): Promise<void> {
      const { state } = ensureLoaded();
      let next = state;
      for (const record of records) {
        next = appendRecord(next, record.target, record);
      }
      cachedState = next;
      persist();
    },

    async getClock(): Promise<VersionClock> {
      return ensureLoaded().clock;
    },

    async setClock(nextClock: VersionClock): Promise<void> {
      // Read state (if not cached) before replacing the clock, so `persist`
      // writes the full, consistent store.
      ensureLoaded();
      cachedClock = nextClock;
      persist();
    },
  };
}
