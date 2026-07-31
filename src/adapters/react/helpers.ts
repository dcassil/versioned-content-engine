/**
 * Pure helpers for the React binding, split out of the hook module so the hook
 * file stays focused on React wiring. These functions contain NO React and NO
 * versioning logic beyond the single permitted `live +/- 1` mirror of the core's
 * draft arithmetic; the append diff is an exact tail-diff of the append-only log.
 */

import type {
  ContentRecord,
  ContentState,
  ContentTypeMap,
  Version,
  VersionClock,
} from "#core";

import type { ViewSelection } from "./types.js";

/** Resolve a {@link ViewSelection} to the concrete {@link Version} to materialize at. */
export function versionFor(
  selection: ViewSelection,
  clock: VersionClock,
): Version {
  if (selection === "live") {
    return clock.live();
  }
  if (selection === "draft") {
    // draft = live + 1 (the single permitted arithmetic mirrored from the core).
    return ((clock.live() as unknown as number) + 1) as Version;
  }
  return selection;
}

/**
 * Compute the records present in `next` but not in `prev` — the delta a single
 * pure core operation appended — so only new records are persisted via
 * `adapter.append` (the append-only write path). Because every core op only
 * APPENDS (never mutates or removes existing records), a per-target tail diff is
 * exact and cheap.
 */
export function diffAppended<TMap extends ContentTypeMap>(
  prev: ContentState<TMap>,
  next: ContentState<TMap>,
): readonly ContentRecord<TMap>[] {
  const appended: ContentRecord<TMap>[] = [];
  for (const [target, records] of next) {
    const before = prev.get(target)?.length ?? 0;
    for (let i = before; i < records.length; i += 1) {
      const record = records[i];
      if (record !== undefined) {
        appended.push(record);
      }
    }
  }
  return appended;
}
