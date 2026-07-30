/**
 * JSON/file StorageAdapter subpath entry (`versioned-content-engine/json`).
 *
 * Boundary + re-export barrel established by SVER-T-0012. The concrete
 * JSON/file adapter is implemented in SVER-T-0014; Node `fs` usage is confined
 * to THIS folder (`src/adapters/json/`) — no other subpath or the core may
 * import `fs`. Until implemented, this re-exports the contract and a throwing
 * stub so the export map + build resolve.
 *
 * Convention for T-0014: implement in this folder, import `node:fs`/`node:path`
 * here only, and export a `createJsonAdapter<TMap>({ path })` factory.
 */

import type { ContentTypeMap } from "../../types.js";
import type { StorageAdapter } from "../types.js";

export type { StorageAdapter } from "../types.js";

/** Options for the JSON/file adapter (shape finalized in SVER-T-0014). */
export interface JsonAdapterOptions {
  /** Absolute path to the JSON file backing the append-only log + clock. */
  readonly path: string;
}

/**
 * Stub factory for the JSON/file adapter. Replaced by the real implementation
 * in SVER-T-0014. Throws so accidental use before implementation is loud.
 */
export function createJsonAdapter<
  TMap extends ContentTypeMap = ContentTypeMap,
>(_options: JsonAdapterOptions): StorageAdapter<TMap> {
  throw new Error("createJsonAdapter is not yet implemented (SVER-T-0014).");
}
