/**
 * Shared cross-adapter parity / contract test suite (SVER-T-0013).
 *
 * This is the SINGLE authoritative contract every {@link StorageAdapter} must
 * satisfy. Rather than each adapter (in-memory SVER-T-0013, JSON/file
 * SVER-T-0014, the SQL sketch, and any future backend) carrying divergent
 * ad-hoc tests, they are all plugged into {@link runStorageAdapterParitySuite},
 * which drives an IDENTICAL canonical operation sequence
 * (create -> update -> move -> delete -> publish) through the adapter and
 * asserts:
 *
 *   1. **Materialize parity** — after every step, `materialize(adapter.load(),
 *      v)` at each interesting version equals the result of the SAME core
 *      operations applied directly to an in-memory reference state. Assertions
 *      are on OBSERVABLE materialized output + clock values, never on an
 *      adapter's internal representation, so structurally-different-but-correct
 *      adapters pass (mitigates the "assert on internals" risk in the task).
 *   2. **Append-only** — `adapter.load()` after each `append` retains every
 *      previously-appended record; nothing is mutated or removed (ADR
 *      SVER-A-0001). A tombstone is itself an appended record.
 *   3. **Immutability / no aliasing** (NFR-002) — a `load()` snapshot captured
 *      BEFORE an `append` is unchanged after it (the adapter never mutates
 *      previously-returned state in place), and the adapter tolerates
 *      deeply-frozen inputs.
 *   4. **Clock round-trip** — `getClock`/`setClock` persist and read back the
 *      immutable `VersionClock` faithfully, including after `publish` advances it.
 *
 * ## How operations are driven through the adapter
 * The core write operations are pure `(state, args, deps) => newState`
 * transitions; the adapter's write path is `append(records)`. This suite bridges
 * the two with {@link diffAppendedRecords}: it runs an operation on a REFERENCE
 * state, extracts the records that were newly appended (identified by their
 * always-fresh `id`), and feeds exactly those to `adapter.append`. The adapter
 * then re-folds them into its own state. Asserting that `adapter.load()`
 * materializes identically to the reference state proves the adapter's write
 * path faithfully reconstructs what the operations produced — which is precisely
 * the contract REQ-002/NFR-002 require.
 *
 * ## Reuse (SVER-T-0014 / SVER-T-0016)
 * Import and call `runStorageAdapterParitySuite(name, makeAdapter)` from any
 * adapter's test file. `makeAdapter` is an async-tolerant factory returning a
 * FRESH, EMPTY adapter (empty state, clock at v0). The suite `await`s every
 * adapter method, so synchronous (in-memory) and asynchronous (JSON/SQL)
 * adapters are exercised identically. The suite registers its own `describe`
 * block, so a caller needs only one line.
 *
 * PURITY: this is a test helper under `test/`, outside `src/`, so it is not
 * subject to the core purity gate; it imports only the public core surface and
 * the adapter interface.
 */

import { describe, expect, it } from "vitest";

import type {
  ContentCollectionId,
  ContentRecord,
  ContentSnapshot,
  ContentState,
  Id,
  TargetId,
  Version,
} from "../../src/types.js";
import type { VersionClock } from "../../src";
import type { StorageAdapter } from "../../src/adapters/types.js";
import {
  createContent,
  updateContent,
  moveContent,
  deleteContent,
  publish,
  materialize,
  createSequenceIdStrategy,
  createDefaultVersionClock,
} from "../../src";
import type { OperationDeps } from "../../src";

// ---------------------------------------------------------------------------
// Canonical fixture content map + branded helpers (shared by every adapter)
// ---------------------------------------------------------------------------

/** The content-type map the canonical script operates over. */
export interface ParityContentMap {
  readonly text: { readonly value: string };
}

type ParityRecord = ContentRecord<ParityContentMap>;
type ParityState = ContentState<ParityContentMap>;
type ParitySnapshot = ContentSnapshot<ParityContentMap>;

const target = (s: string): TargetId => s as unknown as TargetId;

const HEADER = target("header");
const FOOTER = target("footer");

/**
 * An async-tolerant factory returning a FRESH, EMPTY adapter (empty state, a
 * fresh clock at version 0). Each adapter passes its own `createXxxAdapter`
 * wrapped to satisfy this shape.
 */
export type MakeAdapter<TMap extends ParityContentMap = ParityContentMap> = () =>
  | StorageAdapter<TMap>
  | Promise<StorageAdapter<TMap>>;

// ---------------------------------------------------------------------------
// Record diffing: extract records an operation appended
// ---------------------------------------------------------------------------

/** Flatten a state's per-target logs into a flat record list. */
function allRecords(state: ParityState): readonly ParityRecord[] {
  const out: ParityRecord[] = [];
  for (const records of state.values()) {
    for (const r of records) out.push(r);
  }
  return out;
}

/**
 * Return the records present in `next` but not in `prev`, i.e. the records a
 * single core operation appended. Record `id`s are always freshly minted and
 * unique (a create/update/move/delete never re-emits an existing `id`), so set
 * difference by `id` exactly recovers the appended records — in their append
 * order within `next` (preserving multi-record ops like a cross-target move,
 * which appends a source tombstone then a destination record).
 */
export function diffAppendedRecords(
  prev: ParityState,
  next: ParityState,
): readonly ParityRecord[] {
  const prevIds = new Set<Id>(allRecords(prev).map((r) => r.id));
  return allRecords(next).filter((r) => !prevIds.has(r.id));
}

// ---------------------------------------------------------------------------
// Deep-freeze so immutability violations throw loudly in tests
// ---------------------------------------------------------------------------

/** Recursively freeze a state, its target arrays, and its records (test-only). */
function deepFreezeState(state: ParityState): ParityState {
  for (const records of state.values()) {
    for (const r of records) Object.freeze(r);
    Object.freeze(records);
  }
  return Object.freeze(state);
}

// ---------------------------------------------------------------------------
// Snapshot equality on OBSERVABLE materialized output (never internals)
// ---------------------------------------------------------------------------

/**
 * Normalize a snapshot into a plain, order-preserving structure comparable with
 * `toEqual`. We compare the materialized VIEW (targets -> ordered records),
 * which is the only observable contract; adapters may store the log differently.
 */
function normalizeSnapshot(
  snapshot: ParitySnapshot,
): readonly (readonly [string, readonly ParityRecord[]])[] {
  return [...snapshot.entries()]
    .map(
      ([t, records]) =>
        [t as unknown as string, [...records]] as const,
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The versions the canonical script materializes at for parity checks. */
const CHECK_VERSIONS: readonly Version[] = [0, 1, 2, 3, 4, 5].map(
  (n) => n as unknown as Version,
);

/**
 * Assert the adapter's loaded state materializes IDENTICALLY to the reference
 * state at every interesting version. This is the heart of the parity contract.
 */
function expectMaterializeParity(
  adapterState: ParityState,
  referenceState: ParityState,
): void {
  for (const v of CHECK_VERSIONS) {
    expect(normalizeSnapshot(materialize(adapterState, v))).toEqual(
      normalizeSnapshot(materialize(referenceState, v)),
    );
  }
}

// ---------------------------------------------------------------------------
// The reusable contract suite
// ---------------------------------------------------------------------------

/**
 * Run the shared parity/contract suite against any {@link StorageAdapter}
 * factory. Registers a `describe(\`StorageAdapter parity: ${name}\`)` block.
 *
 * @param name - human label for the adapter under test (appears in test output).
 * @param makeAdapter - async-tolerant factory returning a FRESH, EMPTY adapter.
 */
export function runStorageAdapterParitySuite(
  name: string,
  makeAdapter: MakeAdapter,
): void {
  describe(`StorageAdapter parity: ${name}`, () => {
    // Deterministic ids so the reference state and the adapter-driven state are
    // built from identical inputs; the script mints at most a handful of ids.
    function deps(): OperationDeps {
      return {
        idStrategy: createSequenceIdStrategy(
          Array.from({ length: 20 }, (_, i) => `id-${i}`),
          Array.from({ length: 20 }, (_, i) => `col-${i}`),
        ),
        clock: createDefaultVersionClock(),
      };
    }

    /**
     * Run one operation on `reference`, push the appended records into the
     * adapter, then assert append-only + immutability + materialize parity.
     * Returns the new reference state so steps chain.
     */
    async function step(
      adapter: StorageAdapter<ParityContentMap>,
      reference: ParityState,
      op: (s: ParityState) => ParityState,
    ): Promise<ParityState> {
      // Snapshot BEFORE the write, to prove no aliasing after append (NFR-002).
      const before = await adapter.load();
      const beforeCount = allRecords(before).length;

      const next = deepFreezeState(op(reference));
      const appended = diffAppendedRecords(reference, next);

      await adapter.append(appended);

      const after = await adapter.load();

      // (1) Append-only: every record that was present remains present, plus the
      // newly appended ones — nothing removed or mutated.
      expect(allRecords(after).length).toBe(beforeCount + appended.length);
      for (const r of allRecords(before)) {
        expect(allRecords(after)).toContainEqual(r);
      }

      // (2) No aliasing: the pre-append snapshot is untouched by the append.
      expect(allRecords(before).length).toBe(beforeCount);

      // (3) Materialize parity against the reference at every version.
      expectMaterializeParity(after, next);

      return next;
    }

    it("drives create -> update -> move -> delete -> publish with full materialize parity", async () => {
      const adapter = await makeAdapter();
      const d = deps();
      let reference: ParityState = new Map() as ParityState;

      // The collection ids the sequence strategy mints, in order.
      const c0 = "col-0" as unknown as ContentCollectionId;
      const c1 = "col-1" as unknown as ContentCollectionId;

      // create two collections in HEADER
      reference = await step(adapter, reference, (s) =>
        createContent(
          s,
          { target: HEADER, index: 0, type: "text", payload: { value: "a" } },
          d,
        ),
      );
      reference = await step(adapter, reference, (s) =>
        createContent(
          s,
          { target: HEADER, index: 1, type: "text", payload: { value: "b" } },
          d,
        ),
      );

      // update the first collection
      reference = await step(adapter, reference, (s) =>
        updateContent(
          s,
          { collectionId: c0, type: "text", payload: { value: "a2" } },
          d,
        ),
      );

      // move the second collection cross-target (HEADER -> FOOTER): two records
      reference = await step(adapter, reference, (s) =>
        moveContent(
          s,
          { collectionId: c1, source: HEADER, dest: FOOTER, index: 0 },
          d,
        ),
      );

      // delete (tombstone) the first collection in HEADER
      reference = await step(adapter, reference, (s) =>
        deleteContent(s, { target: HEADER, collectionId: c0 }, d),
      );

      // publish: advances the clock (no content append) — persist via setClock
      const published = publish(reference, await adapter.getClock());
      await adapter.setClock(published.clock);

      // Final observable parity across all versions, plus clock round-trip.
      expectMaterializeParity(await adapter.load(), reference);
      const roundTripped: VersionClock = await adapter.getClock();
      expect(roundTripped.live()).toBe(published.clock.live());
    });

    it("round-trips the clock through setClock/getClock without mutation", async () => {
      const adapter = await makeAdapter();
      const initial = await adapter.getClock();
      expect(initial.live()).toBe(0 as unknown as Version);

      const advanced = initial.advance().advance();
      await adapter.setClock(advanced);

      // The stored clock reads back the advanced value; the original is untouched
      // (immutable-value semantics).
      expect((await adapter.getClock()).live()).toBe(
        2 as unknown as Version,
      );
      expect(initial.live()).toBe(0 as unknown as Version);
    });

    it("never aliases previously loaded snapshots when appending", async () => {
      const adapter = await makeAdapter();
      const d = deps();

      const snapshotBefore = await adapter.load();
      expect(allRecords(snapshotBefore).length).toBe(0);

      const next = deepFreezeState(
        createContent(
          (await adapter.load()) as ParityState,
          { target: HEADER, index: 0, type: "text", payload: { value: "x" } },
          d,
        ),
      );
      await adapter.append(diffAppendedRecords(new Map() as ParityState, next));

      // The earlier snapshot still observes an empty log — append did not mutate
      // the previously returned state in place (NFR-002).
      expect(allRecords(snapshotBefore).length).toBe(0);
      // ...while a fresh load reflects the appended record.
      expect(allRecords(await adapter.load()).length).toBe(1);
    });

    it("tolerates deeply-frozen appended records (frozen-input contract)", async () => {
      const adapter = await makeAdapter();
      const d = deps();

      const next = createContent(
        new Map() as ParityState,
        { target: HEADER, index: 0, type: "text", payload: { value: "frozen" } },
        d,
      );
      const appended = diffAppendedRecords(new Map() as ParityState, next);
      for (const r of appended) Object.freeze(r);

      // Appending frozen records must not throw (no in-place mutation of inputs).
      await expect(
        Promise.resolve(adapter.append(appended)),
      ).resolves.not.toThrow();
      expect(allRecords(await adapter.load()).length).toBe(1);
    });
  });
}
