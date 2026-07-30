/**
 * `moveContent(state, args, deps)` — reposition a collection, within a target or
 * across targets (`docs/corrected-semantics.md` §3 `move`, REQ-004).
 *
 * Re-implements the source move (aliased to update in `useContent.tsx`, modeled
 * here as a first-class op mirroring `content.js` `set()`'s cross-target
 * behavior) as a pure `(state, args, deps) => newState` transition. It locates
 * the collection's current live winner in `args.source` at the live version
 * (§3.3 `winnerFor`); if the collection is absent or already tombstoned there,
 * the move is a no-op returning the SAME `state` reference. Otherwise:
 *
 *   - SAME-target move (`source === dest`): append ONE `deleted:false` record for
 *     the collection at the desired `index` (§3.1 in-target reorder). Prior
 *     records are untouched; `materialize`'s reindex (§4) normalizes final dense
 *     positions on read.
 *   - CROSS-target move (`source !== dest`): append TWO records at the SAME draft
 *     version (§3.2, mirroring `content.js` `set()`):
 *       1. a `{ ...winner, deleted: true }` TOMBSTONE that stays in `source`, so
 *          the collection stops materializing there at/after the draft version;
 *       2. a `{ ...winner, target: dest, deleted: false, index }` LIVE record in
 *          `dest`.
 *     `argmax` stays unique per `(target, collectionId)` because the two records
 *     live in different targets (§3.3 determinism note).
 *
 * Every appended record takes a FRESH `id` from `deps.idStrategy.newId()` (§6.2)
 * and the DRAFT version `nextVersion(deps.clock.live())` (§6.1). Affected targets
 * are reindexed on READ by `materialize` (§4) — this operation does NOT eagerly
 * reindex state.
 *
 * The result is structurally shared via {@link appendRecord}: only touched
 * targets are copied; `state` is never mutated (safe on deeply-frozen inputs).
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
 * Arguments to {@link moveContent}: the collection, the `source` target it
 * currently lives in, the `dest` target to move it to, and the desired provisional
 * `index` at the destination. When `source === dest` this is an in-target reorder;
 * otherwise it is a cross-target move. The moved record inherits its `type`/
 * `payload` from the collection's current winner.
 */
export interface MoveContentArgs {
  /** The collection to move. */
  readonly collectionId: ContentCollectionId;
  /** The target the collection currently lives in. */
  readonly source: TargetId;
  /** The target to move the collection to (may equal `source`). */
  readonly dest: TargetId;
  /** Desired provisional ordering position; reindex recomputes dense positions on read (§4). */
  readonly index: number;
}

/**
 * Move a collection and return a new {@link ContentState}
 * (`docs/corrected-semantics.md` §3 `move`, REQ-004).
 *
 * Same-target: appends one new live record at the new `index`. Cross-target:
 * appends a source tombstone and a destination live record at the same draft
 * version. Prior records are preserved (append-only); affected targets reindex on
 * read. If the collection has no live winner in `source`, returns `state`
 * unchanged by reference.
 *
 * @returns a new frozen `ContentState` with the move appended, or the input
 *   `state` (same reference) when there is nothing live to move.
 */
export function moveContent<
  TMap extends ContentTypeMap = AnyContentTypeMap,
>(
  state: ContentState<TMap>,
  args: MoveContentArgs,
  deps: OperationDeps,
): ContentState<TMap> {
  const live = deps.clock.live();
  const winner = winnerFor(state, args.source, args.collectionId, live);

  // Absent or already tombstoned in the source: nothing live to move.
  if (winner === null || winner.deleted) {
    return state;
  }

  const version = draftVersionFor(deps.clock);

  if (args.source === args.dest) {
    // ---- in-target reorder: one new live record at the new index (§3.1) ----
    const movedId: Id = deps.idStrategy.newId();
    const moved = Object.freeze({
      ...winner,
      id: movedId,
      version,
      index: args.index,
    }) as ContentRecord<TMap>;
    return appendRecord(state, args.dest, moved);
  }

  // ---- cross-target: tombstone in source + live record in dest (§3.2) ----
  const tombstoneId: Id = deps.idStrategy.newId();
  const tombstone = Object.freeze({
    ...winner,
    id: tombstoneId,
    version,
    deleted: true,
  }) as ContentRecord<TMap>; // stays in `source`
  const withTombstone: ContentState<TMap> = appendRecord(
    state,
    args.source,
    tombstone,
  );

  const liveId: Id = deps.idStrategy.newId();
  const moved = Object.freeze({
    ...winner,
    id: liveId,
    version,
    target: args.dest,
    deleted: false,
    index: args.index,
  }) as ContentRecord<TMap>;
  return appendRecord(withTombstone, args.dest, moved);
}
