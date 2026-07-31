/**
 * `createContent(state, args, deps)` — append a brand-new content collection
 * (`docs/corrected-semantics.md` §5 `create`, REQ-002).
 *
 * Re-implements the source `addContent` (`client/builder/src/hooks/useContent.tsx`)
 * as a pure `(state, args, deps) => newState` transition, stripped of React
 * state and socket emits. It appends ONE `deleted:false` {@link ContentRecord}
 * carrying:
 *   - a FRESH `collectionId` from `deps.idStrategy.newCollectionId()` and a fresh
 *     `id` from `deps.idStrategy.newId()` (all id nondeterminism is injected —
 *     core calls no `Math.random`/`Date.now`, §6.2),
 *   - the DRAFT version `nextVersion(deps.clock.live())` (§6.1),
 *   - the caller's `target`, `index`, `type`, and `payload`.
 *
 * The record is appended via the shared {@link appendRecord} helper, so the
 * result is a structurally-shared new {@link ContentState}: only the touched
 * target is copied, every other target array is shared by reference (NFR-004).
 * The input `state` is never mutated (safe on deeply-frozen inputs).
 *
 * The appended `index` is provisional — `materialize`'s reindex (§4) recomputes
 * dense canonical positions on read — but is preserved so callers can request a
 * specific slot ordering.
 *
 * PURITY (NFR-001): imports only the type/strategy/helper surface. No React,
 * fs/path, DOM, or runtime deps.
 */

import type {
  AnyContentTypeMap,
  ContentRecord,
  ContentState,
  ContentTypeMap,
  Id,
  ContentCollectionId,
  TargetId,
} from "../types.js";
import type { IdStrategy, VersionClock } from "../strategies.js";
import { appendRecord, draftVersionFor } from "./internal.js";

/**
 * The injected effect strategies threaded into every operation
 * (`docs/corrected-semantics.md` §5/§6): `idStrategy` mints ids, `clock` supplies
 * the live/draft version. Shared by all operations so the operation surface is
 * uniform for SVER-T-0009/0010.
 */
export interface OperationDeps {
  /** Injected id source; the only place record ids originate (§6.2). */
  readonly idStrategy: IdStrategy;
  /** Injected version clock; edits write at `nextVersion(clock.live())` (§6.1). */
  readonly clock: VersionClock;
}

/**
 * Arguments to {@link createContent}, distributed over the caller's content-type
 * map so `type` and `payload` stay correlated (narrowing on `type` narrows
 * `payload`). The caller supplies the destination `target`, the provisional
 * `index`, and the `type`/`payload` pair; ids and the version are injected.
 */
export type CreateContentArgs<TMap extends ContentTypeMap = AnyContentTypeMap> = {
  readonly [K in keyof TMap & string]: {
    /** The target/slot the new content is created in. */
    readonly target: TargetId;
    /** Provisional ordering position; reindex recomputes dense positions on read (§4). */
    readonly index: number;
    /** The content-type discriminant; a key of the caller's content-type map. */
    readonly type: K;
    /** Payload for this `type`, sourced from the caller's content-type map. */
    readonly payload: TMap[K];
  };
}[keyof TMap & string];

/**
 * Append a brand-new content collection at the draft version and return a new
 * {@link ContentState} (`docs/corrected-semantics.md` §5 `create`, REQ-002).
 *
 * Mints a fresh `collectionId` + `id` from `deps.idStrategy`, stamps the record
 * with the draft version `nextVersion(deps.clock.live())`, and appends it to
 * `args.target` via {@link appendRecord}. Pure: `state` untouched; only the
 * touched target array is rebuilt; the rest is shared by reference.
 *
 * @returns a new frozen `ContentState` with the created record appended.
 */
export function createContent<
  TMap extends ContentTypeMap = AnyContentTypeMap,
>(
  state: ContentState<TMap>,
  args: CreateContentArgs<TMap>,
  deps: OperationDeps,
): ContentState<TMap> {
  const version = draftVersionFor(deps.clock);
  const collectionId: ContentCollectionId = deps.idStrategy.newCollectionId();
  const id: Id = deps.idStrategy.newId();

  const record = Object.freeze({
    collectionId,
    id,
    version,
    index: args.index,
    target: args.target,
    deleted: false,
    type: args.type,
    payload: args.payload,
  }) as ContentRecord<TMap>;

  return appendRecord(state, args.target, record);
}
