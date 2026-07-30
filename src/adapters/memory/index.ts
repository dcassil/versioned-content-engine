/**
 * In-memory StorageAdapter subpath entry (`versioned-content-engine/memory`).
 *
 * Boundary + re-export barrel established by SVER-T-0012. The concrete
 * in-memory adapter is implemented in SVER-T-0013; until then this subpath
 * re-exports the {@link StorageAdapter} contract and a typed stub factory that
 * throws, so the export map + build resolve.
 *
 * Convention for T-0013: place the implementation in this folder
 * (`src/adapters/memory/`), import core types via `../../types.js` /
 * `../../strategies.js` (or the shared `../types.js` for the interface), and
 * export a `createMemoryAdapter<TMap>()` factory replacing the stub below.
 */

import type { ContentTypeMap } from "../../types.js";
import type { StorageAdapter } from "../types.js";

export type { StorageAdapter } from "../types.js";

/**
 * Stub factory for the in-memory adapter. Replaced by the real implementation
 * in SVER-T-0013. Throws so accidental use before implementation is loud.
 */
export function createMemoryAdapter<
  TMap extends ContentTypeMap = ContentTypeMap,
>(): StorageAdapter<TMap> {
  throw new Error(
    "createMemoryAdapter is not yet implemented (SVER-T-0013).",
  );
}
