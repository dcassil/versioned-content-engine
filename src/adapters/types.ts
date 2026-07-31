/**
 * StorageAdapter — the adapter boundary contract (SVER-T-0012, SVER-I-0003 REQ-001).
 *
 * This module defines the SINGLE interface every persistence adapter (in-memory,
 * JSON/file, SQL/Supabase sketch) implements. It lives under `src/adapters/` and
 * is published on its own subpath so that a consumer of the pure core never
 * resolves an adapter, React, or `fs`.
 *
 * ## Purity / layering (NFR-001)
 * This file imports ONLY the core's public *types* (`ContentState`,
 * `VersionClock`, `ContentRecord`, `ContentTypeMap`). It is interface-only —
 * zero runtime, no React, no `fs`. Dependencies flow adapter → core, NEVER
 * core → adapter; the dependency-cruiser `core-independence-no-adapter-imports`
 * rule enforces that no `src/**` module outside `src/adapters/**` imports this.
 *
 * ## Append-only write path (ADR SVER-A-0001)
 * Per the append-only storage decision, `append` is the ONLY write path. The
 * canonical state is an append-only log of immutable {@link ContentRecord}s;
 * adapters never mutate or delete records, and never persist a materialized
 * snapshot as source of truth (a derived cache, if any, is disposable). This
 * mirrors the source's push-based `set()` (`server/data/content.js`) but
 * transport-free and immutable.
 *
 * ## Immutability (NFR-002)
 * Implementations MUST NOT mutate loaded state in place. `load` returns a
 * `ContentState` consistent with the core's contract; `append` produces
 * persisted state by adding records only. Callers may freeze inputs; adapters
 * must tolerate frozen data.
 *
 * ## Async tolerance
 * Every method may return synchronously or via a `Promise`, so a JSON/SQL
 * adapter (async I/O) and an in-memory adapter (synchronous) both satisfy the
 * same interface. Callers `await` the result unconditionally.
 */

import type {
  ContentRecord,
  ContentState,
  ContentTypeMap,
  VersionClock,
} from "#core";

/**
 * A pluggable persistence boundary for the append-only content log and the
 * version clock, generic over the caller's {@link ContentTypeMap} so adapters
 * stay content-agnostic and type-safe (NFR-004: strict, no `any`).
 *
 * @typeParam TMap - the caller's content-type map; threads payload typing
 *   through {@link ContentState} and {@link ContentRecord}.
 */
export interface StorageAdapter<TMap extends ContentTypeMap = ContentTypeMap> {
  /**
   * Read the full append-only state (all targets, all record history). The
   * result is the log the core's `materialize(state, version)` consumes — never
   * a pre-materialized snapshot (ADR SVER-A-0001). Returned state MUST be
   * immutable and not aliased to internal mutable storage.
   */
  load(): ContentState<TMap> | Promise<ContentState<TMap>>;

  /**
   * Persist newly appended records — the ONLY write path (append-only, ADR
   * SVER-A-0001). Implementations append these immutable records to the log;
   * they MUST NOT mutate or remove existing records, nor mutate the argument.
   * A tombstone (a `deleted: true` record) is itself just an appended record.
   *
   * @param records - the immutable records produced by a core operation.
   */
  append(records: readonly ContentRecord<TMap>[]): void | Promise<void>;

  /**
   * Read the persisted {@link VersionClock} (the live/draft version boundary).
   * Generalizes the global counter in `server/data/version.js`.
   */
  getClock(): VersionClock | Promise<VersionClock>;

  /**
   * Persist the {@link VersionClock} (e.g. after `publish` advances it).
   * Immutable-value semantics: the clock is stored by value, never mutated.
   *
   * @param clock - the clock to persist.
   */
  setClock(clock: VersionClock): void | Promise<void>;
}
