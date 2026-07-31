// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * `useVersionedContent` React hook tests (SVER-T-0016, REQ-005).
 *
 * Drives the OPTIONAL React binding through `@testing-library/react`'s
 * `renderHook` in a jsdom environment (opted in per-file via the
 * `// @vitest-environment jsdom` pragma above so the rest of the suite stays in
 * the fast `node` environment). Everything is deterministic: an injected
 * sequence {@link createSequenceIdStrategy} and an integer {@link VersionClock}
 * remove all id/version nondeterminism, so `materialize` outputs are exact.
 *
 * Coverage of the acceptance criteria:
 *   - operation callbacks (`create`/`update`/`move`/`delete`) drive `snapshot`;
 *   - the draft/live toggle hides draft edits from `live` until `publish`, then
 *     `publish` advances live and the edit becomes visible;
 *   - version navigation shows a previous version READ-ONLY, including a version
 *     PRIOR to a delete (the tombstoned collection reappears when navigating back);
 *   - effect cleanup on unmount: no `setState`-after-unmount React warning fires
 *     when the component unmounts mid/after an async `load`.
 *
 * The hook is a THIN binding: these tests assert its wiring to the pure core, not
 * re-derived versioning logic (which the core's own suites own).
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useVersionedContent,
  type UseVersionedContent,
} from "../../src/adapters/react";
import { createMemoryAdapter } from "../../src/adapters/memory";
import {
  createSequenceIdStrategy,
  createDefaultVersionClock,
} from "../../src";
import type {
  ContentSnapshot,
  IdStrategy,
  TargetId,
  Version,
  VersionClock,
} from "../../src";
import type { StorageAdapter } from "../../src/adapters/types.js";

// ---------------------------------------------------------------------------
// Fixtures: a concrete content-type map + deterministic strategies.
// ---------------------------------------------------------------------------

interface DemoMap {
  readonly heading: { readonly text: string };
}

const TARGET = "hero" as TargetId;

/** A plentiful deterministic id sequence so no test runs out of ids. */
function seqIdStrategy(): IdStrategy {
  const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
  const cols = Array.from({ length: 50 }, (_, i) => `col-${i}`);
  return createSequenceIdStrategy(ids, cols);
}

/** Read the `text` payloads for {@link TARGET} out of a materialized snapshot. */
function headings(snapshot: ContentSnapshot<DemoMap>): readonly string[] {
  const records = snapshot.get(TARGET) ?? [];
  return records.map((r) => (r.type === "heading" ? r.payload.text : ""));
}

/**
 * Render the hook with deterministic strategies and a shared in-memory adapter,
 * waiting for the initial async `load()` to settle before returning.
 */
async function renderReady(
  overrides: {
    readonly adapter?: StorageAdapter<DemoMap>;
    readonly clock?: VersionClock;
  } = {},
): Promise<ReturnType<typeof renderHook<UseVersionedContent<DemoMap>, unknown>>> {
  const adapter = overrides.adapter ?? createMemoryAdapter<DemoMap>();
  const clock = overrides.clock ?? createDefaultVersionClock();
  const idStrategy = seqIdStrategy();
  const rendered = renderHook(() =>
    useVersionedContent<DemoMap>({ adapter, clock, idStrategy }),
  );
  await waitFor(() => { expect(rendered.result.current.loading).toBe(false); });
  return rendered;
}

// ---------------------------------------------------------------------------

describe("useVersionedContent", () => {
  it("initializes from the adapter and starts on the draft view", async () => {
    const { result } = await renderReady();
    expect(result.current.view).toBe("draft");
    expect(result.current.loading).toBe(false);
    expect(headings(result.current.snapshot)).toEqual([]);
  });

  it("drives snapshot through create then update", async () => {
    const { result } = await renderReady();

    await act(async () => {
      await result.current.create({
        target: TARGET,
        index: 0,
        type: "heading",
        payload: { text: "hello" },
      });
    });
    expect(headings(result.current.snapshot)).toEqual(["hello"]);

    // Capture the collection so we can update it.
    const colId = (result.current.snapshot.get(TARGET) ?? [])[0]?.collectionId;
    expect(colId).toBeDefined();

    await act(async () => {
      await result.current.update({
        collectionId: colId!,
        type: "heading",
        payload: { text: "world" },
      });
    });
    expect(headings(result.current.snapshot)).toEqual(["world"]);
  });

  it("hides draft edits from live until publish, then reveals them", async () => {
    const { result } = await renderReady();

    // Create at draft (v1) and publish so v1 becomes live.
    await act(async () => {
      await result.current.create({
        target: TARGET,
        index: 0,
        type: "heading",
        payload: { text: "published" },
      });
    });
    await act(async () => {
      await result.current.publish();
    });

    // A second draft edit lives at v2; live still shows the published v1.
    await act(async () => {
      await result.current.update({
        collectionId: (result.current.snapshot.get(TARGET) ?? [])[0]!
          .collectionId,
        type: "heading",
        payload: { text: "draft-only" },
      });
    });

    // Draft view sees the new edit.
    expect(headings(result.current.snapshot)).toEqual(["draft-only"]);

    // Live view does NOT see the unpublished draft edit.
    act(() => { result.current.showLive(); });
    expect(headings(result.current.snapshot)).toEqual(["published"]);

    // Publishing advances live to the draft; the edit becomes visible in live.
    await act(async () => {
      await result.current.publish();
    });
    expect(result.current.view).toBe("live");
    expect(headings(result.current.snapshot)).toEqual(["draft-only"]);
  });

  it("navigates to a previous version read-only, including a pre-delete version", async () => {
    const { result } = await renderReady();

    // v1: create "v1-text", publish so it is live at v1.
    await act(async () => {
      await result.current.create({
        target: TARGET,
        index: 0,
        type: "heading",
        payload: { text: "v1-text" },
      });
    });
    const colId = (result.current.snapshot.get(TARGET) ?? [])[0]!.collectionId;
    await act(async () => {
      await result.current.publish();
    });

    // v2: delete the collection at the new draft, then publish so the delete is live.
    await act(async () => {
      await result.current.delete({ target: TARGET, collectionId: colId });
    });
    await act(async () => {
      await result.current.publish();
    });

    // Live (v2) now shows the collection tombstoned → empty.
    act(() => { result.current.showLive(); });
    expect(headings(result.current.snapshot)).toEqual([]);

    // Navigate BACK one version (to the pre-delete v1); the collection reappears
    // read-only — no state was mutated to produce it.
    act(() => { result.current.goBack(); });
    expect(headings(result.current.snapshot)).toEqual(["v1-text"]);
    expect(result.current.view).toBe(1 as Version);

    // Navigate FORWARD again returns to the deleted (empty) v2.
    act(() => { result.current.goForward(); });
    expect(headings(result.current.snapshot)).toEqual([]);
    expect(result.current.view).toBe(2 as Version);
  });

  it("persists appended records through the injected adapter", async () => {
    const adapter = createMemoryAdapter<DemoMap>();
    const appendSpy = vi.spyOn(adapter, "append");
    const setClockSpy = vi.spyOn(adapter, "setClock");
    const { result } = await renderReady({ adapter });

    await act(async () => {
      await result.current.create({
        target: TARGET,
        index: 0,
        type: "heading",
        payload: { text: "persisted" },
      });
    });
    expect(appendSpy).toHaveBeenCalledTimes(1);
    // Exactly the single created record was persisted (the append-only delta).
    expect(appendSpy.mock.calls[0]?.[0]).toHaveLength(1);

    await act(async () => {
      await result.current.publish();
    });
    expect(setClockSpy).toHaveBeenCalledTimes(1);

    // The adapter now holds the created record: a fresh load materializes it.
    const reloaded = await adapter.load();
    expect(reloaded.get(TARGET) ?? []).toHaveLength(1);
  });

  describe("effect cleanup", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      errorSpy.mockRestore();
    });

    it("does not setState after unmount when unmounted mid-load", async () => {
      // An async adapter whose load() we resolve AFTER unmount, so any
      // unguarded setState would fire post-unmount and React would warn.
      let releaseLoad: (() => void) | undefined;
      const base = createMemoryAdapter<DemoMap>();
      const slowAdapter: StorageAdapter<DemoMap> = {
        load: () =>
          new Promise((resolve) => {
            releaseLoad = () => { resolve(base.load()); };
          }),
        append: (records) => base.append(records),
        getClock: () => base.getClock(),
        setClock: (clock) => base.setClock(clock),
      };

      const { unmount } = renderHook(() =>
        useVersionedContent<DemoMap>({
          adapter: slowAdapter,
          idStrategy: seqIdStrategy(),
        }),
      );

      // Unmount while load() is still pending, then let load() resolve.
      unmount();
      await act(async () => {
        releaseLoad?.();
        await Promise.resolve();
      });

      // No "state update on an unmounted component" warning was emitted.
      const warned = errorSpy.mock.calls.some((call) =>
        String(call[0]).includes("unmounted"),
      );
      expect(warned).toBe(false);
    });
  });
});
