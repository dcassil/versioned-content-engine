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

export {
  DefaultIdStrategy,
  IntegerVersionClock,
  createDefaultIdStrategy,
  createDefaultVersionClock,
  createSequenceIdStrategy,
} from "./strategies.js";
