/**
 * `useNavigation` — the read-only view-selection callbacks for
 * {@link useVersionedContent}, split out of {@link useContentOperations} to keep
 * each hook small. It only changes the view selection; `goBack`/`goForward`
 * mirror only the core's `live +/- 1` navigation arithmetic (via `versionFor`).
 */

import { useCallback, type Dispatch, type SetStateAction } from "react";

import type { Version, VersionClock } from "#core";

import { versionFor } from "./helpers.js";
import type { UseVersionedContent, ViewSelection } from "./types.js";

/** The navigation slice of the hook's returned surface. */
export type NavigationCallbacks = Pick<
  UseVersionedContent,
  "showLive" | "showDraft" | "goBack" | "goForward"
>;

/**
 * Build the memoized navigation callbacks.
 *
 * @param setView - the view-selection state setter.
 * @param clockRef - a ref to the latest clock (read at call time only).
 */
export function useNavigation(
  setView: Dispatch<SetStateAction<ViewSelection>>,
  clockRef: { readonly current: VersionClock },
): NavigationCallbacks {
  const showLive = useCallback((): void => {
    setView("live");
  }, [setView]);
  const showDraft = useCallback((): void => {
    setView("draft");
  }, [setView]);
  const goBack = useCallback((): void => {
    setView((current) => {
      const from = versionFor(current, clockRef.current);
      return ((from as unknown as number) - 1) as Version;
    });
  }, [setView, clockRef]);
  const goForward = useCallback((): void => {
    setView((current) => {
      const from = versionFor(current, clockRef.current);
      return ((from as unknown as number) + 1) as Version;
    });
  }, [setView, clockRef]);

  return { showLive, showDraft, goBack, goForward };
}
