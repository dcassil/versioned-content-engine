/**
 * Public type surface for the React binding (`versioned-content-engine/react`),
 * split out of the hook module. These are the argument/return contracts for
 * {@link useVersionedContent}; they are re-exported from the subpath barrel.
 */

import type {
  AnyContentTypeMap,
  ContentSnapshot,
  ContentTypeMap,
  Version,
  VersionClock,
  IdStrategy,
} from "#core";

import type { StorageAdapter } from "../types.js";
import type {
  CreateContentArgs,
  UpdateContentArgs,
  MoveContentArgs,
  DeleteContentArgs,
} from "#core";

/**
 * Which version the hook's `snapshot` reflects.
 *
 *   - `"live"`   — the published version (`clock.live()`); draft edits are
 *     invisible until {@link UseVersionedContent.publish}.
 *   - `"draft"`  — the editor's working version (`live + 1`); where edits accrue.
 *   - a numeric {@link Version} — a pinned historical version selected via
 *     {@link UseVersionedContent.goBack}/{@link UseVersionedContent.goForward}
 *     for READ-ONLY navigation (viewing a previous, incl. pre-delete, version).
 */
export type ViewSelection = "live" | "draft" | Version;

/**
 * Arguments to {@link useVersionedContent}.
 *
 * @typeParam TMap - the caller's content-type map (NFR-004: strict, no `any`);
 *   threads payload typing through every operation callback and `snapshot`.
 */
export interface UseVersionedContentArgs<
  TMap extends ContentTypeMap = AnyContentTypeMap,
> {
  /**
   * The persistence boundary backing the hook. Defaults to a fresh, isolated
   * in-memory store when omitted, so a consumer can use the hook with zero
   * configuration. The adapter may be sync (in-memory) or async (JSON/SQL); the
   * hook `await`s uniformly.
   */
  readonly adapter?: StorageAdapter<TMap>;
  /**
   * The initial injected {@link VersionClock}. Defaults to the core's default
   * clock (v0). The adapter's persisted clock, once loaded, supersedes this; it
   * is only the pre-load seed.
   */
  readonly clock?: VersionClock;
  /**
   * The injected {@link IdStrategy} threaded into every op. Defaults to the
   * core's default id strategy. Tests inject a deterministic sequence strategy
   * for reproducibility.
   */
  readonly idStrategy?: IdStrategy;
}

/**
 * The value returned by {@link useVersionedContent}: the derived read view plus
 * the memoized write/navigation surface. All logic delegates to the pure core.
 *
 * @typeParam TMap - the caller's content-type map.
 */
export interface UseVersionedContent<
  TMap extends ContentTypeMap = AnyContentTypeMap,
> {
  /**
   * The materialized read view at the currently-selected version
   * ({@link view}). `materialize(state, selectedVersion)` — recomputed
   * (memoized) whenever the state, clock, or selection changes.
   */
  readonly snapshot: ContentSnapshot<TMap>;
  /** The current view selection driving {@link snapshot}. */
  readonly view: ViewSelection;
  /** `true` until the initial adapter `load()` has resolved. */
  readonly loading: boolean;

  /** Append a brand-new collection at the draft version (delegates to `createContent`). */
  readonly create: (args: CreateContentArgs<TMap>) => Promise<void>;
  /** Append a new version of an existing collection (delegates to `updateContent`). */
  readonly update: (args: UpdateContentArgs<TMap>) => Promise<void>;
  /** Move/reorder a collection (delegates to `moveContent`). */
  readonly move: (args: MoveContentArgs) => Promise<void>;
  /** Tombstone a collection at the draft version (delegates to `deleteContent`). */
  readonly delete: (args: DeleteContentArgs) => Promise<void>;

  /**
   * Advance the live pointer to the current draft (delegates to core `publish`):
   * previously-draft edits become live and a fresh draft opens above. Persists
   * the advanced clock via `adapter.setClock`.
   */
  readonly publish: () => Promise<void>;

  /** Show the LIVE version in `snapshot` (published viewers' view). */
  readonly showLive: () => void;
  /** Show the DRAFT version in `snapshot` (editor's view; where edits accrue). */
  readonly showDraft: () => void;
  /**
   * Read-only navigation: pin `snapshot` to one version BEFORE the currently
   * shown version (echoes core `goBack` semantics). Lets a UI walk back through
   * history, including a version prior to a delete.
   */
  readonly goBack: () => void;
  /**
   * Read-only navigation: pin `snapshot` to one version AFTER the currently
   * shown version (echoes core `goForward` semantics).
   */
  readonly goForward: () => void;
}
