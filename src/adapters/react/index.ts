/**
 * React hook subpath entry (`versioned-content-engine/react`).
 *
 * Boundary + re-export barrel established by SVER-T-0012. The `useVersionedContent`
 * hook is implemented in SVER-T-0016. React is an OPTIONAL `peerDependency`
 * declared for this subpath only (NFR-003) — no other subpath and NOT the core
 * may import React. Until implemented, this re-exports the {@link StorageAdapter}
 * contract and a throwing stub so the export map + build resolve.
 *
 * Convention for T-0016: implement in this folder, import `react` here only
 * (peer), and export `useVersionedContent(...)` replacing the stub below.
 */

import type { ContentTypeMap } from "../../types.js";
import type { StorageAdapter } from "../types.js";

export type { StorageAdapter } from "../types.js";

/**
 * Stub for the React hook. Replaced by the real implementation in SVER-T-0016.
 * Throws so accidental use before implementation is loud.
 */
export function useVersionedContent<
  TMap extends ContentTypeMap = ContentTypeMap,
>(_args: { readonly adapter: StorageAdapter<TMap> }): never {
  throw new Error(
    "useVersionedContent is not yet implemented (SVER-T-0016).",
  );
}
