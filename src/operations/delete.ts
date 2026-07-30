/**
 * `deleteContent(state, args, deps)` — append a tombstone for an existing
 * collection (`docs/corrected-semantics.md` §2 `delete`, REQ-005).
 *
 * Re-implements the source delete (`useContent.tsx` `deleteContent` /
 * `content.js`) as a pure `(state, args, deps) => newState` transition, stripped
 * of React state and socket emits. CRITICALLY, it fixes Defect 1: delete is NOT
 * an in-place `deleted` flag combined with a global read short-circuit. It is a
 * version-scoped tombstone APPEND:
 *
 *   - locate the collection's current live winner in `args.target` at the live
 *     version (§2.3 `winnerFor`); if the collection is absent or already
 *     tombstoned there, delete is a no-op returning the SAME `state` reference;
 *   - otherwise append ONE `{ ...winner, deleted: true }` record carrying the
 *     collection's `collectionId`, a FRESH `id` from `deps.idStrategy.newId()`
 *     (§6.2), the DRAFT version `nextVersion(deps.clock.live())` (§6.1), the same
 *     `target`, and the winner's `type`/`payload` (kept so the record is a
 *     well-typed member of the discriminated union — the payload is irrelevant
 *     once `deleted` is true).
 *
 * HISTORICAL FIDELITY (NFR-004): because the tombstone is an ordinary versioned
 * record that participates only as a possible *winner* (never a filter),
 * `materialize` at a version STRICTLY BEFORE the delete still selects the earlier
 * live winner and yields the content; only at/after the tombstone's version does
 * the collection disappear. No prior record is removed or mutated (append-only,
 * ADR SVER-A-0001).
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
  TargetId,
} from "./../types.js";
import { appendRecord, draftVersionFor, winnerFor } from "./internal.js";
import type { OperationDeps } from "./create.js";

/**
 * Arguments to {@link deleteContent}: the `target` the collection currently lives
 * in and its `collectionId`. The tombstone's `type`/`payload` are inherited from
 * the collection's current winner, so the caller need not resupply them.
 */
export interface DeleteContentArgs {
  /** The target the collection currently lives in. */
  readonly target: TargetId;
  /** The collection to tombstone. */
  readonly collectionId: ContentCollectionId;
}

/**
 * Append a tombstone for an existing collection at the draft version and return a
 * new {@link ContentState} (`docs/corrected-semantics.md` §2 `delete`, REQ-005).
 *
 * Locates the collection's current live winner in `args.target`, mints a fresh
 * `id`, stamps the draft version, and appends a `deleted:true` record. Prior
 * records are preserved (append-only), so earlier versions remain materializable
 * (NFR-004). If the collection is absent or already tombstoned in the target,
 * returns `state` unchanged by reference.
 *
 * @returns a new frozen `ContentState` with the tombstone appended, or the input
 *   `state` (same reference) when there is nothing live to delete.
 */
export function deleteContent<
  TMap extends ContentTypeMap = AnyContentTypeMap,
>(
  state: ContentState<TMap>,
  args: DeleteContentArgs,
  deps: OperationDeps,
): ContentState<TMap> {
  // SVER-T-0022: resolve the current winner at the DRAFT version, not `live`, so a
  // same-session unpublished edit (e.g. a create earlier in this draft) can be
  // deleted. Winner lookup and the new tombstone share this draft version.
  const version = draftVersionFor(deps.clock);
  const current = winnerFor(state, args.target, args.collectionId, version);

  // Absent or already tombstoned in this target (at draft): no-op, same state.
  if (current === null || current.deleted) {
    return state;
  }
  const id: Id = deps.idStrategy.newId();

  const tombstone = Object.freeze({
    ...current,
    id,
    version,
    deleted: true,
  }) as ContentRecord<TMap>;

  return appendRecord(state, args.target, tombstone);
}
