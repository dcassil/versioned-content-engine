/**
 * React hook subpath entry (`versioned-content-engine/react`).
 *
 * Public barrel for the optional React binding (SVER-T-0012, SVER-T-0016). The
 * implementation is split across sibling modules for cohesion and to satisfy the
 * guard-rails size limits; this file only re-exports the public surface, so the
 * subpath's API is unchanged:
 *   - {@link useVersionedContent} — the hook (see `./use-versioned-content.ts`);
 *   - its argument/return contracts and {@link ViewSelection} (see `./types.ts`);
 *   - the {@link StorageAdapter} contract, re-exported for convenience.
 *
 * React is an OPTIONAL `peerDependency` declared for this subpath ONLY (NFR-003):
 * no other subpath and NOT the core may import React (enforced by the
 * dependency-cruiser `react-confined-to-react-adapter` rule and the eslint
 * boundaries `element-types` rule).
 */

export { useVersionedContent } from "./use-versioned-content.js";
export type {
  ViewSelection,
  UseVersionedContentArgs,
  UseVersionedContent,
} from "./types.js";
export type { StorageAdapter } from "../types.js";
