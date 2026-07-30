/**
 * Core type layer for the Versioned Content Engine.
 *
 * NOTE (SVER-T-0006): These declarations are a minimal, self-consistent surface
 * that mirrors the shapes specified in SVER-T-0002 (the authoritative type-layer
 * task under SVER-I-0001). SVER-T-0002 is not yet merged; when it lands it
 * FINALIZES the branded id / Version / ContentRecord / ContentState /
 * ContentSnapshot definitions and this module should be reconciled against it.
 * The shapes here are intentionally chosen to match that task's acceptance
 * criteria so downstream drift is minimized.
 *
 * This module imports NOTHING effectful (no React / Socket.IO / storage / DOM /
 * fs) — enforced by the dependency-cruiser purity gate.
 */

// ---------------------------------------------------------------------------
// Branded / opaque id alias types
// ---------------------------------------------------------------------------

declare const brand: unique symbol;

/** Opaque brand helper. A `Branded<string, 'X'>` is assignment-incompatible with `Branded<string, 'Y'>`. */
type Branded<T, B extends string> = T & { readonly [brand]: B };

/**
 * Identity of a single content record instance.
 * Generalizes the `id` field on records in `client/builder/src/hooks/useContent.tsx`.
 */
export type Id = Branded<string, "Id">;

/**
 * Identity of a logical content item across all its versions (the append-only
 * history is grouped by this key during materialization).
 * Generalizes `collectionId` in `useContent.tsx` / `server/data/content.js`.
 */
export type ContentCollectionId = Branded<string, "ContentCollectionId">;

/**
 * Identity of a render target / slot a record belongs to.
 * Generalizes `target` in `useContent.tsx` / `content.js`.
 */
export type TargetId = Branded<string, "TargetId">;

/**
 * A monotonic version stamp. Generalizes the global integer counter in
 * `server/data/version.js`, but made an opaque value so callers cannot do
 * arbitrary arithmetic on it outside the clock.
 */
export type Version = Branded<number, "Version">;

// ---------------------------------------------------------------------------
// Records, state, snapshots
// ---------------------------------------------------------------------------

/**
 * A single immutable, versioned content record. Appending a new record (rather
 * than mutating an existing one) is how all edits are represented.
 *
 * `payload` is generic over a caller-supplied content-type map so the core
 * stays content-agnostic. A tombstone is a record with `deleted: true`.
 */
export interface ContentRecord<TPayload = unknown> {
  readonly collectionId: ContentCollectionId;
  readonly id: Id;
  readonly version: Version;
  readonly index: number;
  readonly target: TargetId;
  readonly type: string;
  readonly deleted: boolean;
  readonly payload: TPayload;
}

/**
 * The append-only engine state: a readonly map from target to the ordered,
 * readonly history of records appended for that target. No mutating members are
 * exposed; operations return a new `ContentState`.
 */
export type ContentState<TPayload = unknown> = ReadonlyMap<
  TargetId,
  readonly ContentRecord<TPayload>[]
>;

/**
 * The materialized (post-reindex) view at a specific version: for each target,
 * the ordered list of live records that survive materialization. Distinct from
 * `ContentState` — this is a read result, not the append-only log.
 */
export type ContentSnapshot<TPayload = unknown> = ReadonlyMap<
  TargetId,
  readonly ContentRecord<TPayload>[]
>;
