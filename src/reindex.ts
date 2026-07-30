/**
 * Pure immutable reindex (SVER-T-0007, implements `docs/corrected-semantics.md` §4).
 *
 * Survivors within a target are ordered by the single canonical total order
 * (§4.1): ascending `index`, tie-break ascending `collectionId` (lexicographic
 * on the underlying string). `reindex` copies its input, sorts the copy by that
 * order, and returns a NEW array of NEW record objects whose `index` is their
 * dense 0-based position — never mutating the caller's array or records
 * (§4.2/§4.3, NFR-004).
 *
 * This helper is exported for reuse by the operation tasks (SVER-T-0008..0010),
 * which reindex affected targets after appending records.
 *
 * PURITY (NFR-001): imports only the type surface. No React, fs/path, or runtime
 * deps; no `Math.random`/`Date.now`/global state.
 */

import type {
  AnyContentTypeMap,
  ContentRecord,
  ContentTypeMap,
} from "./types.js";

/**
 * The single canonical total order over survivors within one target
 * (`docs/corrected-semantics.md` §4.1). Primary key: ascending `index`.
 * Tie-break: ascending `collectionId` (lexicographic on the underlying string).
 *
 * Returns `0` only for identical `collectionId`, which cannot occur among the
 * distinct survivors of one target (one winner per collection), so this is a
 * genuine strict total order — independent of the engine's sort stability, which
 * is what eliminates the client/server divergence of Defect 2.
 */
export function canonicalCompare<TMap extends ContentTypeMap = AnyContentTypeMap>(
  a: ContentRecord<TMap>,
  b: ContentRecord<TMap>,
): number {
  if (a.index !== b.index) {
    return a.index - b.index; // primary: ascending index
  }
  // tie-break: ascending collectionId (lexicographic on underlying string)
  const ca = a.collectionId as unknown as string;
  const cb = b.collectionId as unknown as string;
  if (ca < cb) {
    return -1;
  }
  if (ca > cb) {
    return 1;
  }
  return 0; // unreachable among distinct survivors in one target
}

/**
 * Immutably reindex a target's survivors (`docs/corrected-semantics.md` §4.2/§4.3).
 *
 * 1. Copies the input (never sorts in place).
 * 2. Sorts the copy by {@link canonicalCompare}.
 * 3. Constructs a NEW record for each survivor with `index` rewritten to its
 *    dense 0-based position.
 *
 * The input array and every record it references are left untouched, so it is
 * safe to pass deeply-frozen inputs (NFR-004).
 *
 * @returns a new frozen array of new records with dense canonical `index`.
 */
export function reindex<TMap extends ContentTypeMap = AnyContentTypeMap>(
  survivors: readonly ContentRecord<TMap>[],
): readonly ContentRecord<TMap>[] {
  const sorted = [...survivors]; // COPY — never sort the caller's array in place
  sorted.sort(canonicalCompare);
  const out: ContentRecord<TMap>[] = sorted.map(
    (record, position) =>
      ({ ...record, index: position }) as ContentRecord<TMap>, // NEW record, dense index
  );
  return Object.freeze(out);
}
