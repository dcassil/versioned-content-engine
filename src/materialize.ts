/**
 * `materialize(state, version)` — the load-bearing read path (SVER-T-0007,
 * implements `docs/corrected-semantics.md` §1, with the corrected Defect-1 fix).
 *
 * Given an append-only {@link ContentState} and a requested {@link Version}, it
 * returns the {@link ContentSnapshot} visible at that version. For each target
 * independently (§1.1):
 *
 *   1. Group that target's records by `collectionId`.
 *   2. Select the winner per group: the record with the greatest `version` among
 *      those with `version <= requested` (argmax over the version-eligible subset).
 *   3. No version-eligible record  => the collection is absent (created later).
 *   4. Winner is a tombstone (`deleted === true`) => absent at THIS version only.
 *   5. Otherwise the live winner survives.
 *   6. Order + immutable-reindex the survivors (§4); targets with no survivors
 *      are omitted from the snapshot.
 *
 * CRITICAL (Defect 1): the baseline's global `if (c.deleted) return false`
 * short-circuit is deliberately NOT ported. A tombstone is an ordinary versioned
 * record that participates only as a possible *winner*; it is never filtered out
 * before winner selection. Hence a version strictly before a delete still
 * materializes the then-live content (NFR-004 historical fidelity).
 *
 * PURITY (NFR-001/NFR-004): does not read ambient state, time, or randomness, and
 * never mutates `state` or any record it contains; returns a NEW frozen
 * `ReadonlyMap` of NEW frozen arrays of NEW records. Safe on deeply-frozen inputs.
 */

import { reindex } from "./reindex.js";
import type {
  AnyContentTypeMap,
  ContentCollectionId,
  ContentRecord,
  ContentSnapshot,
  ContentState,
  ContentTypeMap,
  TargetId,
  Version,
} from "./types.js";

/** Total order on the opaque `Version` (underlying number). `a <= b`. */
function versionLte(a: Version, b: Version): boolean {
  return (a as unknown as number) <= (b as unknown as number);
}

/** Strict-less-than on the opaque `Version` (underlying number). `a < b`. */
function versionLt(a: Version, b: Version): boolean {
  return (a as unknown as number) < (b as unknown as number);
}

/**
 * Compute the {@link ContentSnapshot} visible at `requested`
 * (`docs/corrected-semantics.md` §1.2). Pure: input untouched; output is a fresh
 * frozen map of fresh frozen arrays of fresh records.
 */
export function materialize<TMap extends ContentTypeMap = AnyContentTypeMap>(
  state: ContentState<TMap>,
  requested: Version,
): ContentSnapshot<TMap> {
  const result = new Map<TargetId, readonly ContentRecord<TMap>[]>();

  for (const [targetId, records] of state) {
    // ---- group by collectionId ----
    const groups = new Map<ContentCollectionId, ContentRecord<TMap>[]>();
    for (const c of records) {
      const bucket = groups.get(c.collectionId);
      if (bucket === undefined) {
        groups.set(c.collectionId, [c]);
      } else {
        bucket.push(c);
      }
    }

    // ---- select winner per collection; apply version-scoped tombstone ----
    const survivors: ContentRecord<TMap>[] = [];
    for (const group of groups.values()) {
      let winner: ContentRecord<TMap> | null = null;
      for (const c of group) {
        if (versionLte(c.version, requested)) {
          // argmax(version <= requested)
          if (winner === null || versionLt(winner.version, c.version)) {
            winner = c;
          }
        }
      }
      if (winner === null) {
        continue; // (3) never existed at `requested` -> absent
      }
      if (winner.deleted) {
        continue; // (4) winner is a tombstone -> absent at THIS version only
      }
      survivors.push(winner); // (5) live winner survives
    }

    // ---- deterministic order + immutable reindex (§4) ----
    if (survivors.length > 0) {
      result.set(targetId, reindex(survivors)); // (6) fresh, reordered, reindexed
    }
  }

  return Object.freeze(result) as ContentSnapshot<TMap>;
}
