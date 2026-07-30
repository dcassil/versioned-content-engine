/**
 * SVER-T-0011 — materialize-on-read benchmark.
 *
 * Feeds back into ADR SVER-A-0001 ("append-only vs snapshot storage"): the one
 * real cost of the append-only source-of-truth is that every read pays a
 * materialization cost (group-by-collectionId + argmax + reindex) growing with
 * log size. This benchmark builds a realistically large append-only log and
 * times `materialize` at live, draft, and a historical version.
 *
 * It is DELIBERATELY excluded from `pnpm test`/`pnpm coverage` (not under
 * `test/`, and vitest's `include` does not match `bench/`) so CI stays fast. Run
 * it with `pnpm bench`. Results are informational only — the ADR is explicit
 * that timing must NOT be a CI gate; it is a measurement that decides whether the
 * deferred hybrid-checkpoint option is ever needed.
 *
 * A concrete wall-clock summary is printed via `console.log` (see the IIFE at
 * the bottom) so `pnpm bench` output can be pasted straight into the task's
 * status updates and the ADR follow-up.
 */

import { bench, describe } from "vitest";

// Minimal ambient typing for the two runtime globals this bench uses, so the
// core `tsconfig` need not pull in the DOM or @types/node lib just for a
// dev-only benchmark. Both are present in Node and the browser.
declare const performance: { now(): number };
declare const console: { log(...args: readonly unknown[]): void };

import { materialize } from "../src/materialize.js";
import type {
  ContentCollectionId,
  ContentRecord,
  ContentState,
  Id,
  TargetId,
  Version,
} from "../src/types.js";

interface BenchMap {
  text: { readonly value: string };
}
type BenchRecord = ContentRecord<BenchMap>;
type BenchState = ContentState<BenchMap>;

const asTarget = (s: string): TargetId => s as unknown as TargetId;
const asCol = (s: string): ContentCollectionId =>
  s as unknown as ContentCollectionId;
const asVersion = (n: number): Version => n as unknown as Version;

/**
 * Build a realistically large append-only log:
 *   - `targets` render targets,
 *   - `collectionsPerTarget` collections in each,
 *   - `editsPerCollection` appended versions per collection (edit history),
 * plus a scattering of tombstones. Records are appended in ascending version
 * order per collection, mirroring the real write path.
 */
function buildLog(opts: {
  targets: number;
  collectionsPerTarget: number;
  editsPerCollection: number;
}): { state: BenchState; totalRecords: number; maxVersion: number } {
  const { targets, collectionsPerTarget, editsPerCollection } = opts;
  const map = new Map<TargetId, BenchRecord[]>();
  let total = 0;
  let maxVersion = 0;

  for (let t = 0; t < targets; t += 1) {
    const target = asTarget(`target-${t}`);
    const records: BenchRecord[] = [];
    for (let c = 0; c < collectionsPerTarget; c += 1) {
      const collectionId = asCol(`t${t}-c${c}`);
      for (let e = 0; e < editsPerCollection; e += 1) {
        const version = e + 1; // versions 1..editsPerCollection
        maxVersion = Math.max(maxVersion, version);
        // ~5% of the final edits are tombstones (a realistic delete rate).
        const deleted = e === editsPerCollection - 1 && (c % 20 === 0);
        records.push({
          collectionId,
          id: `t${t}-c${c}-e${e}` as Id,
          version: asVersion(version),
          index: c,
          target,
          deleted,
          type: "text" as const,
          payload: { value: `v${e}` },
        } as BenchRecord);
        total += 1;
      }
    }
    map.set(target, records);
  }
  return { state: map as BenchState, totalRecords: total, maxVersion };
}

// A "realistically large" content-authoring surface, generously oversized:
// 25 targets x 40 collections x 12 edits = 12,000 records across the log.
const { state, totalRecords, maxVersion } = buildLog({
  targets: 25,
  collectionsPerTarget: 40,
  editsPerCollection: 12,
});

const liveVersion = asVersion(maxVersion);
const draftVersion = asVersion(maxVersion + 1);
const historicalVersion = asVersion(Math.max(1, Math.floor(maxVersion / 2)));

describe(`materialize over ${totalRecords} records`, () => {
  bench("materialize @ live", () => {
    materialize(state, liveVersion);
  });
  bench("materialize @ draft", () => {
    materialize(state, draftVersion);
  });
  bench("materialize @ historical (mid-log)", () => {
    materialize(state, historicalVersion);
  });
});

// ---------------------------------------------------------------------------
// Concrete wall-clock summary (printed once at load, so `pnpm bench` output
// carries pasteable numbers even without parsing vitest's tinybench table).
// ---------------------------------------------------------------------------
(() => {
  const iterations = 200;
  const timeOnce = (v: Version): number => {
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      materialize(state, v);
    }
    return (performance.now() - start) / iterations;
  };
  // warm up
  timeOnce(liveVersion);
  const live = timeOnce(liveVersion);
  const draft = timeOnce(draftVersion);
  const hist = timeOnce(historicalVersion);
  // eslint-disable-next-line no-console
  console.log(
    `\n[materialize benchmark] ${totalRecords} records, ${maxVersion} versions\n` +
      `  live       (v${maxVersion}) : ${live.toFixed(4)} ms/op\n` +
      `  draft      (v${maxVersion + 1}) : ${draft.toFixed(4)} ms/op\n` +
      `  historical (v${Math.max(1, Math.floor(maxVersion / 2))}) : ${hist.toFixed(4)} ms/op\n`,
  );
})();
