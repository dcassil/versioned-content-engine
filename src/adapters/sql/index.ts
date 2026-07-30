/**
 * SQL/Supabase StorageAdapter subpath entry (`versioned-content-engine/sql`).
 *
 * SKETCH — NOT IMPLEMENTED (SVER-T-0015, SVER-I-0003 REQ-004).
 *
 * This module is a DESIGN-ONLY conformance sketch: it pins down the intended
 * `createSqlAdapter(config)` signature returning a {@link StorageAdapter<TMap>}
 * and a throwing stub, WITHOUT building an implementation. There is deliberately
 * NO SQL/pg/Supabase runtime dependency here (core deps stay empty, no drivers).
 * Its only job is to prove the {@link StorageAdapter} boundary generalizes to a
 * relational/Supabase backend and to de-risk a future backend initiative.
 *
 * The append-only table shape, the `content_version` clock row, and the exact
 * mapping of `load` / `append` / `getClock` / `setClock` onto SQL (plus Supabase
 * specifics — RLS, `jsonb` payload, materialize-on-read indexes) are documented
 * in `docs/adapters/sql-supabase-sketch.md`. Read that doc before implementing.
 *
 * ## What a future implementation initiative MUST add (all deferred here)
 * - A real driver (`@supabase/supabase-js` or `pg`) as a dependency of ONLY this
 *   subpath — never the core; extend the dependency-cruiser purity gate to
 *   confine it to `src/adapters/sql/` (mirroring the `fs`/`react` confinement).
 * - Connection/config handling (URL, key, schema/table names, RLS context).
 * - The migration for `content_records` + `content_version` (see the doc).
 * - Async I/O bodies for the four methods per the doc's mapping.
 * - RLS policies keyed on `collection_id` ownership, and batching for `append`.
 *
 * ## Append-only write path (ADR SVER-A-0001)
 * As with every adapter, `append` is the ONLY write path: rows are INSERTed,
 * never UPDATEd or DELETEd (a delete is an appended `deleted: true` tombstone
 * row). `load` is an ordered SELECT of the log; the clock lives in its own row.
 */

import type { ContentTypeMap } from "../../types.js";
import type { StorageAdapter } from "../types.js";

export type { StorageAdapter } from "../types.js";

/**
 * Config shape a future `createSqlAdapter` is intended to take. Documented as a
 * TYPE-LEVEL sketch only — no field here implies any runtime behavior yet, and
 * no driver type is referenced (so nothing is pulled in). The concrete client
 * type (e.g. a Supabase client or a `pg` pool) is intentionally modeled as an
 * opaque `unknown` here; the future implementation initiative replaces it with
 * the real driver type, confined to this subpath.
 */
export interface SqlAdapterConfig {
  /**
   * The backend client the future adapter will issue queries through — e.g. a
   * `SupabaseClient` or a `pg` pool. Left opaque (`unknown`) on purpose so this
   * sketch imports NO runtime driver; the real type lands with the driver.
   */
  readonly client: unknown;
  /**
   * Table holding the append-only record log. Defaults to `content_records`
   * in the sketched schema. See `docs/adapters/sql-supabase-sketch.md`.
   */
  readonly recordsTable?: string;
  /**
   * Table/row holding the single {@link StorageAdapter.getClock | version clock}.
   * Defaults to `content_version` in the sketched schema.
   */
  readonly versionTable?: string;
  /**
   * The collection/tenant scope this adapter reads and writes. In Supabase this
   * is the value RLS policies key ownership on (see the doc's RLS note). A
   * future implementation uses it to scope every SELECT/INSERT.
   */
  readonly collectionId?: string;
}

/**
 * Intended factory signature for the SQL/Supabase adapter. It is a TYPE-LEVEL
 * SKETCH: the signature is real (it type-checks against {@link StorageAdapter}),
 * but the body only throws — matching the throwing-stub convention of the other
 * adapter subpaths (SVER-T-0012). This is NOT usable; a future initiative
 * replaces the throwing body with the async SQL implementation described in
 * `docs/adapters/sql-supabase-sketch.md`.
 *
 * @typeParam TMap - the caller's content-type map (threaded through the log).
 * @param _config - see {@link SqlAdapterConfig}.
 * @throws Always — this is a design sketch, not an implementation.
 */
export function createSqlAdapter<
  TMap extends ContentTypeMap = ContentTypeMap,
>(_config: SqlAdapterConfig): StorageAdapter<TMap> {
  throw new Error(
    "createSqlAdapter is a design-only sketch and is not implemented " +
      "(SVER-T-0015). See docs/adapters/sql-supabase-sketch.md; a future " +
      "backend initiative must add a driver, migrations, RLS, and method bodies.",
  );
}
