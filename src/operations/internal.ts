/**
 * Shared pure helpers for the append-only write operations
 * (`docs/corrected-semantics.md` §0.1, §1.2, §2.3, §5).
 *
 * Every write operation (`createContent`, `updateContent`, and the later
 * SVER-T-0009 move/delete and SVER-T-0010 publish) is a pure
 * `(state, args, deps) => newState` transition. This module factors out the two
 * primitives they all share:
 *
 *   - {@link nextVersion} — the ONLY permitted `Version` arithmetic (§0.1); the
 *     draft version an edit writes at is `nextVersion(clock.live())` (§6.1), so
 *     no operation touches raw numbers or advances the write-side clock.
 *   - {@link appendRecord} — the ONLY write path (§2.3, ADR SVER-A-0001): append
 *     one immutable record into a single target's log and return a NEW
 *     structurally-shared {@link ContentState}. Only the touched target is
 *     copied; every other target array is shared by reference.
 *   - {@link winnerFor} — the §1 winner for one collection at a version, no
 *     reindex (§2.3), used by `updateContent` (and later move/delete) to read
 *     the collection's current record so the new record can be well-typed and
 *     placed.
 *
 * PURITY (NFR-001/NFR-004): imports only the type/strategy surface. No React,
 * fs/path, DOM, or runtime deps; no `Math.random`/`Date.now`/global state. Every
 * function returns new frozen values and never mutates its inputs, so it is safe
 * on deeply-frozen state.
 */

import type {
  AnyContentTypeMap,
  ContentCollectionId,
  ContentRecord,
  ContentState,
  ContentTypeMap,
  TargetId,
  Version,
} from "./../types.js";
import type { VersionClock } from "./../strategies.js";

/**
 * The next version after `v` — the draft version relative to a live `v`
 * (`docs/corrected-semantics.md` §0.1). This is the sole permitted `Version`
 * arithmetic: all edits write at `nextVersion(clock.live())`. It never advances
 * the injected clock (only `publish` does, SVER-T-0010); it is a pure read-side
 * computation of the draft stamp.
 */
export function nextVersion(v: Version): Version {
  return ((v as unknown as number) + 1) as Version;
}

/**
 * The draft version an edit writes at, given the injected {@link VersionClock}
 * (`docs/corrected-semantics.md` §6.1: `draftVersion = liveVersion + 1`). Pure:
 * reads `clock.live()` and never mutates the clock.
 */
export function draftVersionFor(clock: VersionClock): Version {
  return nextVersion(clock.live());
}

/** Strict-less-than on the opaque `Version` (underlying number). `a < b`. */
function versionLt(a: Version, b: Version): boolean {
  return (a as unknown as number) < (b as unknown as number);
}

/** Total order on the opaque `Version` (underlying number). `a <= b`. */
function versionLte(a: Version, b: Version): boolean {
  return (a as unknown as number) <= (b as unknown as number);
}

/**
 * Append one immutable `record` into `target`'s log, returning a NEW
 * structurally-shared {@link ContentState} (`docs/corrected-semantics.md` §2.3).
 *
 * The map is shallow-copied and only the touched target's array is rebuilt
 * (`[...prev, record]`, frozen); every other target array is shared by reference
 * (NFR-004 structural sharing). The input `state`, its arrays, and its records
 * are never mutated, so this is safe on deeply-frozen inputs.
 *
 * This is the single write path every operation funnels through: create/update
 * here, and move/delete/publish downstream (SVER-T-0009/0010).
 *
 * @returns a new frozen `ContentState`; input untouched.
 */
export function appendRecord<TMap extends ContentTypeMap = AnyContentTypeMap>(
  state: ContentState<TMap>,
  target: TargetId,
  record: ContentRecord<TMap>,
): ContentState<TMap> {
  const next = new Map<TargetId, readonly ContentRecord<TMap>[]>(state); // shallow map copy
  const prev = state.get(target) ?? [];
  next.set(target, Object.freeze([...prev, record])); // NEW array; old target arrays shared
  return Object.freeze(next) as ContentState<TMap>;
}

/**
 * The §1 winner for one `collectionId` within one `target` at `version`, with NO
 * reindex (`docs/corrected-semantics.md` §2.3). Returns the record with the
 * greatest `version <= requested` for that collection, or `null` if the
 * collection has no version-eligible record in the target.
 *
 * Pure: scans the target's log without mutating anything. Used by operations
 * that must read the collection's current record (e.g. `updateContent` copies
 * its `target`/`index`/`type` to keep the new record well-typed and placed).
 */
export function winnerFor<TMap extends ContentTypeMap = AnyContentTypeMap>(
  state: ContentState<TMap>,
  target: TargetId,
  collectionId: ContentCollectionId,
  version: Version,
): ContentRecord<TMap> | null {
  let winner: ContentRecord<TMap> | null = null;
  for (const c of state.get(target) ?? []) {
    if (c.collectionId === collectionId && versionLte(c.version, version)) {
      if (winner === null || versionLt(winner.version, c.version)) {
        winner = c;
      }
    }
  }
  return winner;
}

/**
 * Find the winner for `collectionId` at `version` across ALL targets (the log is
 * keyed by target, and a collection lives in exactly one target at a time, but
 * its history may span targets after a cross-target move). Returns the highest
 * version-eligible record for the collection anywhere, or `null`.
 *
 * `updateContent` uses this so a caller need only supply the `collectionId`
 * (not its current target), matching the source's `updateVersionedContent`,
 * which located the record by id/collection rather than by target.
 */
export function winnerForAcrossTargets<
  TMap extends ContentTypeMap = AnyContentTypeMap,
>(
  state: ContentState<TMap>,
  collectionId: ContentCollectionId,
  version: Version,
): ContentRecord<TMap> | null {
  let winner: ContentRecord<TMap> | null = null;
  for (const records of state.values()) {
    for (const c of records) {
      if (c.collectionId === collectionId && versionLte(c.version, version)) {
        if (winner === null || versionLt(winner.version, c.version)) {
          winner = c;
        }
      }
    }
  }
  return winner;
}
