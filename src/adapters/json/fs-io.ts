/**
 * JSON/file adapter I/O + (de)serialization — the fs-confined internals.
 *
 * Split out of `./index.ts` (SVER guard-rails size limit) so the adapter entry
 * stays a thin factory over these cohesive helpers. This module owns:
 *   - the on-disk schema (`PersistedFile`);
 *   - (de)serialization, where branded ids/`Version` are re-attached — the only
 *     permitted place to cast raw JSON back to the opaque core types (NFR-004);
 *   - the atomic file read/write primitives.
 *
 * ## fs confinement (SVER-I-0003 REQ-003)
 * Node `fs`/`path` are imported ONLY within `src/adapters/json/`; the
 * dependency-cruiser `fs-confined-to-json-adapter` rule fails the build if any
 * module outside this directory imports them. The core never touches the
 * filesystem.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  ContentRecord,
  ContentState,
  ContentTypeMap,
  TargetId,
  VersionClock,
} from "#core";
import { createDefaultVersionClock } from "#core";

/**
 * The persisted shape. The append-only state is stored as an array of
 * `[targetKey, records]` entries (a plain, JSON-friendly encoding of the
 * `ReadonlyMap`), and the clock as its single live-version integer. `version`
 * documents the on-disk format so a future migration is unambiguous.
 */
export interface PersistedFile {
  /** On-disk schema version (bump on any breaking format change). */
  readonly version: 1;
  /** The append-only log, encoded as ordered map entries. */
  readonly state: readonly (readonly [string, readonly unknown[]])[];
  /** The persisted version clock's live version. */
  readonly clock: number;
}

/** The currently supported on-disk schema version. */
export const SCHEMA_VERSION = 1 as const;

/**
 * Encode a live {@link ContentState} into the JSON-friendly persisted form.
 * Records are plain readonly objects, so they serialize directly; only the
 * `ReadonlyMap` needs flattening into entries.
 */
export function serializeState<TMap extends ContentTypeMap>(
  state: ContentState<TMap>,
): readonly (readonly [string, readonly ContentRecord<TMap>[]])[] {
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
export function deserializeState<TMap extends ContentTypeMap>(
  entries: readonly (readonly [string, readonly unknown[]])[],
): ContentState<TMap> {
  const map = new Map<TargetId, readonly ContentRecord<TMap>[]>();
  for (const [targetKey, rawRecords] of entries) {
    const records = rawRecords.map((r) =>
      Object.freeze(r as ContentRecord<TMap>),
    );
    map.set(targetKey as unknown as TargetId, Object.freeze(records));
  }
  return Object.freeze(map);
}

/** Reconstruct an immutable-value {@link VersionClock} from its live integer. */
export function deserializeClock(live: number): VersionClock {
  return createDefaultVersionClock(live);
}

/**
 * Read + parse the backing file. A missing file (first load) yields an empty,
 * frozen state and a fresh clock at version 0 — never an error (graceful
 * first-load, matching the source's implicit empty-`db` start).
 */
export function readFile(filePath: string): {
  state: readonly (readonly [string, readonly unknown[]])[];
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
export function writeFileAtomic(
  filePath: string,
  contents: PersistedFile,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
  writeFileSync(tempPath, JSON.stringify(contents), "utf8");
  renameSync(tempPath, filePath);
}
