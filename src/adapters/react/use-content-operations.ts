/**
 * `useContentOperations` — the memoized write + navigation surface for
 * {@link useVersionedContent}, split out of the hook module so the top-level
 * hook stays small. It is itself a custom hook (its name begins with `use` and
 * it only calls hooks), so React's rules-of-hooks hold: it and every nested
 * `use*` are invoked unconditionally, in a fixed order, from the hook's top level.
 *
 * Each write callback calls the PURE core op, then persists the appended delta
 * via the injected adapter and commits the new state. Navigation is delegated to
 * {@link useNavigation}. No versioning logic lives here beyond delegating to the
 * core.
 */

import { useCallback, type Dispatch, type SetStateAction } from "react";

import type { ContentState, ContentTypeMap, IdStrategy, VersionClock } from "#core";
import {
  createContent,
  updateContent,
  moveContent,
  deleteContent,
  publish as publishCore,
} from "#core";
import type {
  CreateContentArgs,
  UpdateContentArgs,
  MoveContentArgs,
  DeleteContentArgs,
  OperationDeps,
} from "#core";

import type { StorageAdapter } from "../types.js";
import { diffAppended } from "./helpers.js";
import { useNavigation } from "./use-navigation.js";
import type { UseVersionedContent, ViewSelection } from "./types.js";

/** The mutable refs + setters the operation callbacks close over. */
export interface OperationContext<TMap extends ContentTypeMap> {
  readonly adapter: StorageAdapter<TMap>;
  readonly idStrategy: IdStrategy;
  readonly stateRef: { current: ContentState<TMap> };
  readonly clockRef: { current: VersionClock };
  readonly mountedRef: { readonly current: boolean };
  readonly setState: Dispatch<SetStateAction<ContentState<TMap>>>;
  readonly setClockState: Dispatch<SetStateAction<VersionClock>>;
  readonly setView: Dispatch<SetStateAction<ViewSelection>>;
}

/** The write + navigation callbacks returned to (and spread by) the hook. */
export type ContentOperations<TMap extends ContentTypeMap> = Pick<
  UseVersionedContent<TMap>,
  | "create"
  | "update"
  | "move"
  | "delete"
  | "publish"
  | "showLive"
  | "showDraft"
  | "goBack"
  | "goForward"
>;

/** A pure core write op: `(state, args, deps) -> nextState`. */
type CoreWriteOp<TMap extends ContentTypeMap, TArgs> = (
  state: ContentState<TMap>,
  args: TArgs,
  deps: OperationDeps,
) => ContentState<TMap>;

/**
 * Wrap one pure core write op into a memoized async callback that reads the
 * latest state/clock from refs, runs the op, and persists + commits the delta.
 * Called once per op at the top level of {@link useContentOperations}, so the
 * hook order is fixed.
 */
function useWriteOp<TMap extends ContentTypeMap, TArgs>(
  ctx: OperationContext<TMap>,
  op: CoreWriteOp<TMap, TArgs>,
): (args: TArgs) => Promise<void> {
  const { adapter, idStrategy, stateRef, clockRef, mountedRef, setState } = ctx;
  return useCallback(
    async (args: TArgs): Promise<void> => {
      const prev = stateRef.current;
      const next = op(prev, args, { idStrategy, clock: clockRef.current });
      const appended = diffAppended(prev, next);
      if (appended.length > 0) {
        await Promise.resolve(adapter.append(appended));
      }
      if (mountedRef.current) {
        setState(next);
      }
    },
    [adapter, idStrategy, mountedRef, setState, stateRef, clockRef, op],
  );
}

/**
 * Build the memoized operation + navigation callbacks. Extracted from the hook
 * to keep each unit small; behavior is identical to inline callbacks.
 */
export function useContentOperations<TMap extends ContentTypeMap>(
  ctx: OperationContext<TMap>,
): ContentOperations<TMap> {
  const create = useWriteOp<TMap, CreateContentArgs<TMap>>(ctx, createContent);
  const update = useWriteOp<TMap, UpdateContentArgs<TMap>>(ctx, updateContent);
  const move = useWriteOp<TMap, MoveContentArgs>(ctx, moveContent);
  const del = useWriteOp<TMap, DeleteContentArgs>(ctx, deleteContent);

  const { adapter, stateRef, clockRef, mountedRef, setClockState } = ctx;
  const publish = useCallback(async (): Promise<void> => {
    const result = publishCore(stateRef.current, clockRef.current);
    await Promise.resolve(adapter.setClock(result.clock));
    if (mountedRef.current) {
      setClockState(result.clock);
    }
  }, [adapter, mountedRef, setClockState, stateRef, clockRef]);

  const navigation = useNavigation(ctx.setView, clockRef);

  return { create, update, move, delete: del, publish, ...navigation };
}
