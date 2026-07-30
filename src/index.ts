/**
 * versioned-content-engine — public barrel.
 *
 * A headless, zero-runtime-dependency, pure TypeScript engine for versioned
 * content. This scaffold (SVER-T-0006) exports the type surface and the
 * injectable strategy interfaces + defaults. Algorithm functions
 * (`materialize`, `createContent`, `publish`, ...) are added by later tasks
 * under SVER-I-0002.
 */

export type {
  Id,
  ContentCollectionId,
  TargetId,
  Version,
  ContentTypeMap,
  AnyContentTypeMap,
  ContentRecord,
  ContentState,
  ContentSnapshot,
} from "./types.js";

export type { IdStrategy, VersionClock } from "./strategies.js";

export { materialize } from "./materialize.js";
export { reindex, canonicalCompare } from "./reindex.js";

export { createContent } from "./operations/create.js";
export { updateContent } from "./operations/update.js";
export { moveContent } from "./operations/move.js";
export { deleteContent } from "./operations/delete.js";
export type {
  OperationDeps,
  CreateContentArgs,
} from "./operations/create.js";
export type { UpdateContentArgs } from "./operations/update.js";
export type { MoveContentArgs } from "./operations/move.js";
export type { DeleteContentArgs } from "./operations/delete.js";

export {
  DefaultIdStrategy,
  IntegerVersionClock,
  createDefaultIdStrategy,
  createDefaultVersionClock,
  createSequenceIdStrategy,
} from "./strategies.js";
