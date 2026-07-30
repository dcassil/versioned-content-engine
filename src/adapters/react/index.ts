/**
 * React hook subpath entry (`versioned-content-engine/react`).
 *
 * Boundary established by SVER-T-0012; the `useVersionedContent` hook is
 * implemented here (SVER-T-0016). React is an OPTIONAL `peerDependency` declared
 * for this subpath ONLY (NFR-003) — no other subpath and NOT the core may import
 * React (enforced by dependency-cruiser `react-confined-to-react-adapter`).
 *
 * ## What this hook is
 * The clean re-do of Stardust's `client/builder/src/hooks/useContent.tsx`, whose
 * `useState`/`useEffect`/`socket.emit`/`socket.on` tangle coupled content state
 * to a socket transport. Here:
 *   - the socket transport is replaced by a pluggable {@link StorageAdapter};
 *   - the pure core (`operations/*`, `materialize`, `publish`) remains the
 *     SINGLE source of truth — the hook is a THIN binding, not a re-implementation;
 *   - effects are minimal and cleanup-safe: the only effect is an initial,
 *     mounted-ref-guarded async `load()` so no `setState` fires after unmount and
 *     nothing is left subscribed.
 *
 * All versioning/materialization logic is delegated to the core; the hook only
 * (a) holds the append-only {@link ContentState} + {@link VersionClock} in
 * React state, (b) memoizes operation callbacks that call the pure core op then
 * persist via the adapter, and (c) derives `snapshot` via `materialize` at the
 * selected version.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AnyContentTypeMap,
  ContentRecord,
  ContentSnapshot,
  ContentState,
  ContentTypeMap,
  Version,
} from "../../types.js";
import type { IdStrategy, VersionClock } from "../../strategies.js";
import {
  createDefaultIdStrategy,
  createDefaultVersionClock,
} from "../../strategies.js";
import { materialize } from "../../materialize.js";
import {
  createContent,
  type CreateContentArgs,
} from "../../operations/create.js";
import {
  updateContent,
  type UpdateContentArgs,
} from "../../operations/update.js";
import { moveContent, type MoveContentArgs } from "../../operations/move.js";
import {
  deleteContent,
  type DeleteContentArgs,
} from "../../operations/delete.js";
import { publish as publishCore } from "../../operations/publish.js";
import type { StorageAdapter } from "../types.js";
import { createMemoryAdapter } from "../memory/index.js";

export type { StorageAdapter } from "../types.js";

/**
 * Which version the hook's `snapshot` reflects.
 *
 *   - `"live"`   — the published version (`clock.live()`); draft edits are
 *     invisible until {@link UseVersionedContent.publish}.
 *   - `"draft"`  — the editor's working version (`live + 1`); where edits accrue.
 *   - a numeric {@link Version} — a pinned historical version selected via
 *     {@link UseVersionedContent.goBack}/{@link UseVersionedContent.goForward}
 *     for READ-ONLY navigation (viewing a previous, incl. pre-delete, version).
 */
export type ViewSelection = "live" | "draft" | Version;

/**
 * Arguments to {@link useVersionedContent}.
 *
 * @typeParam TMap - the caller's content-type map (NFR-004: strict, no `any`);
 *   threads payload typing through every operation callback and `snapshot`.
 */
export interface UseVersionedContentArgs<
  TMap extends ContentTypeMap = AnyContentTypeMap,
> {
  /**
   * The persistence boundary backing the hook. Defaults to a fresh
   * {@link createMemoryAdapter} when omitted, so a consumer can use the hook
   * with zero configuration. The adapter may be sync (in-memory) or async
   * (JSON/SQL); the hook `await`s uniformly.
   */
  readonly adapter?: StorageAdapter<TMap>;
  /**
   * The initial injected {@link VersionClock}. Defaults to
   * {@link createDefaultVersionClock} (v0). The adapter's persisted clock, once
   * loaded, supersedes this; it is only the pre-load seed.
   */
  readonly clock?: VersionClock;
  /**
   * The injected {@link IdStrategy} threaded into every op. Defaults to
   * {@link createDefaultIdStrategy}. Tests inject a deterministic sequence
   * strategy for reproducibility.
   */
  readonly idStrategy?: IdStrategy;
}

/**
 * The value returned by {@link useVersionedContent}: the derived read view plus
 * the memoized write/navigation surface. All logic delegates to the pure core.
 *
 * @typeParam TMap - the caller's content-type map.
 */
export interface UseVersionedContent<
  TMap extends ContentTypeMap = AnyContentTypeMap,
> {
  /**
   * The materialized read view at the currently-selected version
   * ({@link view}). `materialize(state, selectedVersion)` — recomputed
   * (memoized) whenever the state, clock, or selection changes.
   */
  readonly snapshot: ContentSnapshot<TMap>;
  /** The current view selection driving {@link snapshot}. */
  readonly view: ViewSelection;
  /** `true` until the initial adapter `load()` has resolved. */
  readonly loading: boolean;

  /** Append a brand-new collection at the draft version (delegates to `createContent`). */
  readonly create: (args: CreateContentArgs<TMap>) => Promise<void>;
  /** Append a new version of an existing collection (delegates to `updateContent`). */
  readonly update: (args: UpdateContentArgs<TMap>) => Promise<void>;
  /** Move/reorder a collection (delegates to `moveContent`). */
  readonly move: (args: MoveContentArgs) => Promise<void>;
  /** Tombstone a collection at the draft version (delegates to `deleteContent`). */
  readonly delete: (args: DeleteContentArgs) => Promise<void>;

  /**
   * Advance the live pointer to the current draft (delegates to core `publish`):
   * previously-draft edits become live and a fresh draft opens above. Persists
   * the advanced clock via `adapter.setClock`.
   */
  readonly publish: () => Promise<void>;

  /** Show the LIVE version in `snapshot` (published viewers' view). */
  readonly showLive: () => void;
  /** Show the DRAFT version in `snapshot` (editor's view; where edits accrue). */
  readonly showDraft: () => void;
  /**
   * Read-only navigation: pin `snapshot` to one version BEFORE the currently
   * shown version (echoes core `goBack` semantics). Lets a UI walk back through
   * history, including a version prior to a delete.
   */
  readonly goBack: () => void;
  /**
   * Read-only navigation: pin `snapshot` to one version AFTER the currently
   * shown version (echoes core `goForward` semantics).
   */
  readonly goForward: () => void;
}

/** Resolve a {@link ViewSelection} to the concrete {@link Version} to materialize at. */
function versionFor(selection: ViewSelection, clock: VersionClock): Version {
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
function diffAppended<TMap extends ContentTypeMap>(
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

/**
 * `useVersionedContent` — the optional React binding for the versioned content
 * engine (SVER-I-0003 REQ-005).
 *
 * Holds the append-only {@link ContentState} and the {@link VersionClock} in
 * `useState`, initialized (async) from the injected {@link StorageAdapter}. Each
 * operation callback is memoized (`useCallback`), calls the PURE core op, then
 * persists the produced records via `adapter.append` and updates state. `publish`
 * advances the clock via the core and persists it via `adapter.setClock`. The
 * `snapshot` is derived (`useMemo`) from `materialize` at the selected version.
 *
 * The hook contains NO versioning/materialization logic of its own — it is a thin
 * binding over the core. Its only effect is a mounted-ref-guarded initial `load`,
 * so no state update happens after unmount and nothing is left subscribed.
 *
 * @typeParam TMap - the caller's content-type map (strict, no `any`).
 */
export function useVersionedContent<
  TMap extends ContentTypeMap = AnyContentTypeMap,
>(args: UseVersionedContentArgs<TMap> = {}): UseVersionedContent<TMap> {
  // Freeze the injected dependencies for the lifetime of the hook instance so a
  // caller passing inline literals each render doesn't churn the memoized
  // callbacks. The adapter defaults to a fresh in-memory store.
  const adapterRef = useRef<StorageAdapter<TMap> | null>(null);
  if (adapterRef.current === null) {
    adapterRef.current = args.adapter ?? createMemoryAdapter<TMap>();
  }
  const adapter = adapterRef.current;

  const idStrategyRef = useRef<IdStrategy | null>(null);
  if (idStrategyRef.current === null) {
    idStrategyRef.current = args.idStrategy ?? createDefaultIdStrategy();
  }
  const idStrategy = idStrategyRef.current;

  const [state, setState] = useState<ContentState<TMap>>(
    () => new Map() as ContentState<TMap>,
  );
  const [clock, setClockState] = useState<VersionClock>(
    () => args.clock ?? createDefaultVersionClock(),
  );
  const [view, setView] = useState<ViewSelection>("draft");
  const [loading, setLoading] = useState<boolean>(true);

  // Keep refs of the latest state/clock so the memoized callbacks never need
  // `state`/`clock` in their dependency arrays (which would recreate them every
  // edit and defeat the memoization). They read `.current` at call time only.
  const stateRef = useRef<ContentState<TMap>>(state);
  const clockRef = useRef<VersionClock>(clock);
  stateRef.current = state;
  clockRef.current = clock;

  // Mounted-ref guard: the ONLY effect is the initial async load; the ref keeps
  // us from calling setState after unmount (the source hook's cleanup bug).
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    void (async (): Promise<void> => {
      const [loadedState, loadedClock] = await Promise.all([
        Promise.resolve(adapter.load()),
        Promise.resolve(adapter.getClock()),
      ]);
      if (cancelled || !mountedRef.current) {
        return;
      }
      setState(loadedState);
      setClockState(loadedClock);
      setLoading(false);
    })();
    return (): void => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [adapter]);

  // Shared write path: persist the appended delta then commit the new state —
  // but only if still mounted.
  const persistAndSet = useCallback(
    async (
      prev: ContentState<TMap>,
      next: ContentState<TMap>,
    ): Promise<void> => {
      const appended = diffAppended(prev, next);
      if (appended.length > 0) {
        await Promise.resolve(adapter.append(appended));
      }
      if (mountedRef.current) {
        setState(next);
      }
    },
    [adapter],
  );

  const create = useCallback(
    async (opArgs: CreateContentArgs<TMap>): Promise<void> => {
      const prev = stateRef.current;
      const next = createContent(prev, opArgs, {
        idStrategy,
        clock: clockRef.current,
      });
      await persistAndSet(prev, next);
    },
    [idStrategy, persistAndSet],
  );

  const update = useCallback(
    async (opArgs: UpdateContentArgs<TMap>): Promise<void> => {
      const prev = stateRef.current;
      const next = updateContent(prev, opArgs, {
        idStrategy,
        clock: clockRef.current,
      });
      await persistAndSet(prev, next);
    },
    [idStrategy, persistAndSet],
  );

  const move = useCallback(
    async (opArgs: MoveContentArgs): Promise<void> => {
      const prev = stateRef.current;
      const next = moveContent(prev, opArgs, {
        idStrategy,
        clock: clockRef.current,
      });
      await persistAndSet(prev, next);
    },
    [idStrategy, persistAndSet],
  );

  const del = useCallback(
    async (opArgs: DeleteContentArgs): Promise<void> => {
      const prev = stateRef.current;
      const next = deleteContent(prev, opArgs, {
        idStrategy,
        clock: clockRef.current,
      });
      await persistAndSet(prev, next);
    },
    [idStrategy, persistAndSet],
  );

  const publish = useCallback(async (): Promise<void> => {
    const result = publishCore(stateRef.current, clockRef.current);
    await Promise.resolve(adapter.setClock(result.clock));
    if (mountedRef.current) {
      setClockState(result.clock);
    }
  }, [adapter]);

  const showLive = useCallback((): void => setView("live"), []);
  const showDraft = useCallback((): void => setView("draft"), []);
  const goBack = useCallback((): void => {
    setView((current) => {
      const from = versionFor(current, clockRef.current);
      return ((from as unknown as number) - 1) as Version;
    });
  }, []);
  const goForward = useCallback((): void => {
    setView((current) => {
      const from = versionFor(current, clockRef.current);
      return ((from as unknown as number) + 1) as Version;
    });
  }, []);

  const snapshot = useMemo<ContentSnapshot<TMap>>(
    () => materialize(state, versionFor(view, clock)),
    [state, clock, view],
  );

  return {
    snapshot,
    view,
    loading,
    create,
    update,
    move,
    delete: del,
    publish,
    showLive,
    showDraft,
    goBack,
    goForward,
  };
}
