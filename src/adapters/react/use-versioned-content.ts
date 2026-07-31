/**
 * `useVersionedContent` — the optional React binding for the versioned content
 * engine (SVER-I-0003 REQ-005). SVER-T-0016.
 *
 * The clean re-do of Stardust's `client/builder/src/hooks/useContent.tsx`, whose
 * `useState`/`useEffect`/`socket.emit`/`socket.on` tangle coupled content state
 * to a socket transport. Here the socket transport is replaced by a pluggable
 * {@link StorageAdapter}; the pure core (`operations/*`, `materialize`,
 * `publish`) remains the SINGLE source of truth — the hook is a THIN binding, not
 * a re-implementation; and effects are minimal and cleanup-safe (the only effect
 * is a mounted-ref-guarded initial async `load()`).
 *
 * React is an OPTIONAL `peerDependency` declared for THIS subpath ONLY (NFR-003);
 * no other subpath and NOT the core may import React (enforced by
 * dependency-cruiser `react-confined-to-react-adapter` and the eslint boundaries
 * `element-types` rule).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AnyContentTypeMap,
  ContentSnapshot,
  ContentState,
  ContentTypeMap,
  IdStrategy,
  VersionClock,
} from "#core";
import {
  createDefaultIdStrategy,
  createDefaultVersionClock,
  materialize,
} from "#core";

import type { StorageAdapter } from "../types.js";
import { createDefaultAdapter } from "./default-adapter.js";
import { versionFor } from "./helpers.js";
import { useContentOperations } from "./use-content-operations.js";
import type {
  UseVersionedContent,
  UseVersionedContentArgs,
  ViewSelection,
} from "./types.js";

/**
 * Holds the append-only {@link ContentState} and the {@link VersionClock} in
 * `useState`, initialized (async) from the injected {@link StorageAdapter}. The
 * memoized write/navigation callbacks live in {@link useContentOperations}; the
 * `snapshot` is derived (`useMemo`) from `materialize` at the selected version.
 * The hook contains NO versioning/materialization logic of its own.
 *
 * @typeParam TMap - the caller's content-type map (strict, no `any`).
 */
export function useVersionedContent<
  TMap extends ContentTypeMap = AnyContentTypeMap,
>(args: UseVersionedContentArgs<TMap> = {}): UseVersionedContent<TMap> {
  // Freeze injected dependencies for the hook instance's lifetime so inline
  // literals passed each render don't churn the memoized callbacks. The adapter
  // defaults to a fresh, isolated in-memory store.
  const adapterRef = useRef<StorageAdapter<TMap> | null>(null);
  adapterRef.current ??= args.adapter ?? createDefaultAdapter<TMap>();
  const adapter = adapterRef.current;

  const idStrategyRef = useRef<IdStrategy | null>(null);
  idStrategyRef.current ??= args.idStrategy ?? createDefaultIdStrategy();
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
  // `state`/`clock` in their dependency arrays. They read `.current` at call time.
  const stateRef = useRef<ContentState<TMap>>(state);
  const clockRef = useRef<VersionClock>(clock);
  stateRef.current = state;
  clockRef.current = clock;

  // Mounted-ref guard: the ONLY effect is the initial async load; the ref keeps
  // us from calling setState after unmount (the source hook's cleanup bug).
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    void (async (): Promise<void> => {
      const [loadedState, loadedClock] = await Promise.all([
        Promise.resolve(adapter.load()),
        Promise.resolve(adapter.getClock()),
      ]);
      // The mounted ref is the single post-unmount guard: cleanup flips it to
      // `false`, so no setState fires after unmount (the source hook's bug).
      if (!mountedRef.current) {
        return;
      }
      setState(loadedState);
      setClockState(loadedClock);
      setLoading(false);
    })();
    return (): void => {
      mountedRef.current = false;
    };
  }, [adapter]);

  const operations = useContentOperations<TMap>({
    adapter,
    idStrategy,
    stateRef,
    clockRef,
    mountedRef,
    setState,
    setClockState,
    setView,
  });

  const snapshot = useMemo<ContentSnapshot<TMap>>(
    () => materialize(state, versionFor(view, clock)),
    [state, clock, view],
  );

  return { snapshot, view, loading, ...operations };
}
