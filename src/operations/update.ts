/**
 * `updateContent(state, args, deps)` — append a new record for an EXISTING
 * collection (`docs/corrected-semantics.md` §5 `update`, REQ-003).
 *
 * Re-implements the source `updateVersionedContent`
 * (`client/builder/src/hooks/useContent.tsx`) as a pure
 * `(state, args, deps) => newState` transition, stripped of React state and
 * socket emits. It appends ONE `deleted:false` {@link ContentRecord} that:
 *   - REUSES the caller's existing `collectionId` (the group-by key is
 *     unchanged, so this becomes the collection's new winner at/after the draft
 *     version) and takes a FRESH `id` from `deps.idStrategy.newId()` (§6.2),
 *   - is stamped with the DRAFT version `nextVersion(deps.clock.live())` (§6.1),
 *   - carries the caller's new `payload`, while inheriting the collection's
 *     current `target`, `index`, and `type` from its current winning record so
 *     the update lands in place and stays a well-typed member of the
 *     discriminated union.
 *
 * APPEND-ONLY (REQ-003): every prior record for the collection is preserved
 * untouched. Materializing a version strictly before the update still selects
 * the earlier winner; the update is only visible at/after its draft version.
 *
 * The current winner is located across ALL targets (a collection lives in one
 * target at a time but its history may have moved), so callers supply only the
 * `collectionId`. If the collection has no live winner at the current live
 * version (never created, or currently tombstoned), the update is a no-op that
 * returns the SAME `state` by reference — there is nothing to update.
 *
 * The result is structurally shared via {@link appendRecord}: only the touched
 * target is copied; `state` is never mutated (safe on deeply-frozen inputs).
 *
 * PURITY (NFR-001): imports only the type/strategy/helper surface. No React,
 * fs/path, DOM, or runtime deps.
 */

import type {
  AnyContentTypeMap,
  ContentCollectionId,
  ContentRecord,
  ContentState,
  ContentTypeMap,
  Id,
} from "./../types.js";
import { appendRecord, draftVersionFor, winnerForAcrossTargets } from "./internal.js";
import type { OperationDeps } from "./create.js";

/**
 * Arguments to {@link updateContent}, distributed over the caller's content-type
 * map. The caller identifies the collection by `collectionId` and supplies the
 * new `payload` for its `type`; `target`, `index`, and `type` are inherited from
 * the collection's current winner. The `type` is included so `payload` is
 * type-checked against the intended content type — it must match the
 * collection's current type (an update does not change a collection's type).
 */
export type UpdateContentArgs<TMap extends ContentTypeMap = AnyContentTypeMap> = {
  readonly [K in keyof TMap & string]: {
    /** The existing collection to append a new version for. */
    readonly collectionId: ContentCollectionId;
    /** The content-type discriminant of the collection (unchanged by update). */
    readonly type: K;
    /** The new payload for this `type`. */
    readonly payload: TMap[K];
  };
}[keyof TMap & string];

/**
 * Append a new version of an existing collection at the draft version and return
 * a new {@link ContentState} (`docs/corrected-semantics.md` §5 `update`,
 * REQ-003).
 *
 * Locates the collection's current winner (across targets) at the live version,
 * inherits its `target`/`index`, mints a fresh `id`, stamps the draft version,
 * and appends the new record. Prior records are preserved (append-only). If the
 * collection has no live winner, returns `state` unchanged by reference.
 *
 * @returns a new frozen `ContentState` with the update appended, or the input
 *   `state` (same reference) when there is nothing live to update.
 */
export function updateContent<
  TMap extends ContentTypeMap = AnyContentTypeMap,
>(
  state: ContentState<TMap>,
  args: UpdateContentArgs<TMap>,
  deps: OperationDeps,
): ContentState<TMap> {
  const live = deps.clock.live();
  const current = winnerForAcrossTargets(state, args.collectionId, live);

  // Nothing live to update (absent or currently tombstoned): no-op, same state.
  if (current === null || current.deleted) {
    return state;
  }

  const version = draftVersionFor(deps.clock);
  const id: Id = deps.idStrategy.newId();

  const record = Object.freeze({
    collectionId: args.collectionId,
    id,
    version,
    index: current.index, // inherit placement; reindex recomputes dense positions on read (§4)
    target: current.target, // stay in the collection's current target
    deleted: false,
    type: args.type,
    payload: args.payload,
  }) as ContentRecord<TMap>;

  return appendRecord(state, current.target, record);
}
