/**
 * Core type layer for the Versioned Content Engine (SVER-T-0002, authoritative).
 *
 * This module defines the complete, framework-free type surface every
 * downstream initiative programs against (SVER-I-0002 core, SVER-I-0003
 * adapters, SVER-I-0004 integration). It generalizes the loose object shapes
 * observed in the original Stardust source:
 *   - `client/builder/src/hooks/useContent.tsx` — client materializer / op surface
 *   - `client/builder/server/data/content.js`   — server `set()` writer / materializer
 *   - `client/builder/server/data/version.js`   — the global integer version clock
 * into strict, opaque-typed, immutable declarations.
 *
 * NFR-001 (purity): this module imports NOTHING effectful — no React,
 * Socket.IO, storage lib, DOM, or Node fs/path. It is enforced by the
 * dependency-cruiser purity gate. NFR-003: compiles under `strict` +
 * `noUncheckedIndexedAccess` with no `any`; opaque id types prevent mixing
 * `TargetId` / `ContentCollectionId` / record `Id`.
 */

// ---------------------------------------------------------------------------
// Branded / opaque id alias types
// ---------------------------------------------------------------------------

declare const brand: unique symbol;

/**
 * Opaque brand helper. A `Branded<T, 'X'>` is assignment-incompatible with a
 * `Branded<T, 'Y'>` and with the bare underlying `T`, so ids of different kinds
 * cannot be interchanged without an explicit cast (which only the id strategy /
 * adapters are permitted to perform).
 */
type Branded<T, B extends string> = T & { readonly [brand]: B };

/**
 * Identity of a single content record instance.
 * Generalizes the per-record `id` field in `useContent.tsx` / `content.js`
 * (source: `Math.random() + Date.now()`; here it is minted by an injected
 * {@link IdStrategy} so core stays deterministic).
 */
export type Id = Branded<string, "Id">;

/**
 * Identity of a logical content item across ALL of its versions. The
 * append-only history is grouped by this key during materialization: an edit
 * appends a new {@link ContentRecord} sharing this `collectionId` at a higher
 * `version`. Generalizes `collectionId` in `useContent.tsx` / `content.js`.
 */
export type ContentCollectionId = Branded<string, "ContentCollectionId">;

/**
 * Identity of a render target / slot that records belong to. Content state is
 * keyed by this id. Generalizes `target` in `useContent.tsx` / `content.js`.
 */
export type TargetId = Branded<string, "TargetId">;

/**
 * A monotonic version stamp. Generalizes the global integer counter in
 * `server/data/version.js` (`version` live / `version_next` draft), but made an
 * opaque value so callers cannot do arbitrary arithmetic on it outside the
 * injected {@link VersionClock}.
 */
export type Version = Branded<number, "Version">;

// ---------------------------------------------------------------------------
// Branded value constructors
// ---------------------------------------------------------------------------

/** Attach the engine's opaque `Id` brand to a boundary string. */
export function asId(value: string): Id {
  return value as Id;
}

/** Attach the engine's opaque `ContentCollectionId` brand to a boundary string. */
export function asCollectionId(value: string): ContentCollectionId {
  return value as ContentCollectionId;
}

/** Attach the engine's opaque `TargetId` brand to a boundary string. */
export function asTargetId(value: string): TargetId {
  return value as TargetId;
}

/** Attach the engine's opaque `Version` brand to a boundary number. */
export function asVersion(value: number): Version {
  return value as Version;
}

// ---------------------------------------------------------------------------
// Content-type map
// ---------------------------------------------------------------------------

/**
 * A caller-supplied content-type map: keys are the content `type` discriminant
 * strings, values are the corresponding payload shapes. The engine is generic
 * over this map so it stays content-agnostic — core never names a concrete
 * payload type. When no map is supplied, the permissive default treats `type`
 * as an arbitrary string and `payload` as `unknown`.
 *
 * The constraint is `object` (not `Record<string, unknown>`) so ordinary
 * `interface` declarations — which lack an implicit index signature — satisfy
 * it; the record type maps only over the `string` keys of the supplied map.
 *
 * @example
 * interface MyContent {
 *   heading: { text: string };
 *   image: { src: string; alt: string };
 * }
 * type MyRecord = ContentRecord<MyContent>; // payload is discriminated by `type`
 */
export type ContentTypeMap = object;

/** The permissive default map: any string `type`, `unknown` payload. */
export type AnyContentTypeMap = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * The fields common to every content record, independent of the payload
 * discriminant. Kept `readonly` throughout: an edit never mutates an existing
 * record, it appends a new one (see {@link ContentState}).
 */
interface ContentRecordBase {
  /** Logical identity shared by every version of this content item. */
  readonly collectionId: ContentCollectionId;
  /** Identity of this specific record instance. */
  readonly id: Id;
  /** The version at which this record was appended. */
  readonly version: Version;
  /** Ordering position within its `target` (recomputed on immutable reindex). */
  readonly index: number;
  /** The target / slot this record belongs to. */
  readonly target: TargetId;
  /**
   * Tombstone flag. A record with `deleted: true` is a version-scoped tombstone:
   * it hides the collection at/after its `version` only, never retroactively
   * (SVER-I-0001 REQ-004). It is NOT a global short-circuit.
   */
  readonly deleted: boolean;
}

/**
 * A single immutable, versioned content record, discriminated over a
 * caller-supplied {@link ContentTypeMap}. For each key `K` of the map, `type`
 * is `K` and `payload` is `TMap[K]`, so narrowing on `type` narrows `payload`.
 *
 * Appending a new record (rather than mutating an existing one) is how all
 * edits are represented; a tombstone is a record with `deleted: true`.
 * Generalizes the loose record objects (`collectionId`, `id`, `version`,
 * `index`, `target`, `type`, `deleted`, `defaultValue`-derived payload) in
 * `useContent.tsx` / `content.js`.
 */
export type ContentRecord<TMap extends ContentTypeMap = AnyContentTypeMap> = {
  readonly [K in keyof TMap & string]: ContentRecordBase & {
    /** The content-type discriminant; a key of the caller's content-type map. */
    readonly type: K;
    /** Payload for this `type`, sourced from the caller's content-type map. */
    readonly payload: TMap[K];
  };
}[keyof TMap & string];

// ---------------------------------------------------------------------------
// State (append-only log) and snapshots (materialized view)
// ---------------------------------------------------------------------------

/**
 * The append-only engine state: a readonly map from {@link TargetId} to the
 * ordered, readonly history of records appended for that target. No mutating
 * members are exposed; operations return a NEW `ContentState` rather than
 * mutating this one (NFR-002 determinism). Generalizes the flat per-target
 * arrays in `useContent.tsx` / `content.js`.
 */
export type ContentState<TMap extends ContentTypeMap = AnyContentTypeMap> =
  ReadonlyMap<TargetId, readonly ContentRecord<TMap>[]>;

/**
 * The materialized, per-target ordered view at a specific version — the result
 * of `materialize(state, version)` (SVER-I-0001 REQ-003): for each target, the
 * reindexed list of live records that survive materialization. Distinct from
 * {@link ContentState}: this is a read result (post-reindex, tombstones
 * resolved), not the append-only log. Readonly throughout.
 */
export type ContentSnapshot<TMap extends ContentTypeMap = AnyContentTypeMap> =
  ReadonlyMap<TargetId, readonly ContentRecord<TMap>[]>;
