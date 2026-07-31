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
 *      those with `version <= requested` (argmax over the version-eligible
 *      subset). Ties at the greatest version resolve LAST-WRITE-WINS — the
 *      last-appended record wins (SVER-T-0022, §1.1).
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

/** Group a target's records by `collectionId`, preserving append order. */
function groupByCollection<TMap extends ContentTypeMap>(
  records: readonly ContentRecord<TMap>[],
): Map<ContentCollectionId, ContentRecord<TMap>[]> {
  const groups = new Map<ContentCollectionId, ContentRecord<TMap>[]>();
  for (const c of records) {
    const bucket = groups.get(c.collectionId);
    if (bucket === undefined) {
      groups.set(c.collectionId, [c]);
    } else {
      bucket.push(c);
    }
  }
  return groups;
}

/**
 * Select the winner for one collection group: argmax(version <= requested) with
 * LAST-WRITE-WINS tie-break (SVER-T-0022, §1.1). The group preserves append
 * order, so `<=` lets a candidate tying the incumbent's version replace it — the
 * last-appended record at the winning version wins. This is the WINNER-SELECTION
 * tie-break, distinct from the display-ordering tie-break `reindex` applies (§4).
 * Returns `null` when the collection has no version-eligible record.
 */
function selectWinner<TMap extends ContentTypeMap>(
  group: readonly ContentRecord<TMap>[],
  requested: Version,
): ContentRecord<TMap> | null {
  let winner: ContentRecord<TMap> | null = null;
  for (const c of group) {
    const eligible = versionLte(c.version, requested);
    if (eligible && (winner === null || versionLte(winner.version, c.version))) {
      winner = c;
    }
  }
  return winner;
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
    const groups = groupByCollection(records);

    // ---- select winner per collection; apply version-scoped tombstone ----
    const survivors: ContentRecord<TMap>[] = [];
    for (const group of groups.values()) {
      const winner = selectWinner(group, requested);
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

  return Object.freeze(result);
}
