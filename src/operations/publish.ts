/**
 * Draft/live workflow on the injected `VersionClock` (SVER-T-0010, implements
 * `docs/corrected-semantics.md` §6).
 *
 * This module completes the headless engine's read/publish surface on top of
 * `materialize` (SVER-T-0007) and the injected {@link VersionClock}
 * (`src/strategies.ts`):
 *
 *   - {@link publish} — advance the live pointer. Per §6.3, publish performs NO
 *     content append: draft edits already live in the append-only log at
 *     `nextVersion(clock.live())`, so publishing is purely advancing the
 *     immutable-value clock (`clock.advance()`), after which `clock.live()`
 *     returns the previously-draft version. There is NO global integer counter
 *     (the source's `server/data/version.js` coupling is removed).
 *   - {@link getLive} — `materialize(state, clock.live())`: what published
 *     viewers see (§6.1).
 *   - {@link getDraft} — `materialize(state, nextVersion(clock.live()))`: what
 *     the editor sees; edits accrue here and are invisible to live until
 *     published (§6.1, draft = live + 1).
 *   - {@link goBack} / {@link goForward} — thin version-SELECTING navigation
 *     wrappers over `materialize` for SVER-I-0004; they choose a version to read
 *     at and never mutate state or the clock.
 *
 * RETURN SHAPE (the immutable-clock model): the engine `state` is an append-only
 * log that does NOT carry its clock, and `VersionClock` is an immutable value
 * whose `advance()` returns a NEW clock. `publish` therefore returns
 * `{ state, clock }`: the SAME `state` (no append — structurally identical,
 * returned by reference) paired with the ADVANCED clock the caller threads
 * forward. The `state` is included so `publish` composes uniformly with the
 * `(state, ...) => ...` operation surface and callers can destructure a single
 * result.
 *
 * PURITY (NFR-001/NFR-002/NFR-004): imports only the type/strategy/materialize
 * surface. No React, fs/path, DOM, or runtime deps; no `Math.random`/`Date.now`/
 * global state. Nothing here mutates `state` or the input clock — `advance()`
 * yields a fresh clock — so all of it is safe on deeply-frozen inputs.
 */

import { materialize } from "../materialize.js";
import { nextVersion } from "./internal.js";
import type {
  AnyContentTypeMap,
  ContentSnapshot,
  ContentState,
  ContentTypeMap,
  Version,
} from "../types.js";
import type { VersionClock } from "../strategies.js";

/**
 * Result of {@link publish}: the (unchanged) append-only `state` paired with the
 * ADVANCED, immutable {@link VersionClock}. The clock is a NEW value — the input
 * clock is untouched — and the caller threads it forward as the live pointer.
 */
export interface PublishResult<TMap extends ContentTypeMap = AnyContentTypeMap> {
  /** The append-only log, unchanged by publish (no content append; §6.3). */
  readonly state: ContentState<TMap>;
  /** A NEW clock advanced by one: `live()` now returns the previously-draft version. */
  readonly clock: VersionClock;
}

/**
 * Advance the live pointer (`docs/corrected-semantics.md` §6.3, REQ-006).
 *
 * Publish performs no content append — draft edits already sit in the log at the
 * draft version — so it simply advances the injected clock via its immutable
 * `advance()` and returns `{ state, clock }`. The input `state` and input `clock`
 * are never mutated; the returned `clock` is a fresh advanced value and the
 * returned `state` is the same log by reference.
 *
 * After publish, `getLive(state, result.clock)` materializes what had been the
 * draft, and `getDraft(state, result.clock)` opens a fresh draft one above it.
 *
 * @returns `{ state, clock }` — unchanged state + advanced clock to thread forward.
 */
export function publish<TMap extends ContentTypeMap = AnyContentTypeMap>(
  state: ContentState<TMap>,
  clock: VersionClock,
): PublishResult<TMap> {
  return Object.freeze({ state, clock: clock.advance() });
}

/**
 * The LIVE snapshot: `materialize(state, clock.live())`
 * (`docs/corrected-semantics.md` §6.1, REQ-006). What published viewers see.
 * Pure read; state and clock untouched.
 */
export function getLive<TMap extends ContentTypeMap = AnyContentTypeMap>(
  state: ContentState<TMap>,
  clock: VersionClock,
): ContentSnapshot<TMap> {
  return materialize(state, clock.live());
}

/**
 * The DRAFT snapshot: `materialize(state, nextVersion(clock.live()))`
 * (`docs/corrected-semantics.md` §6.1, REQ-006). What the editor sees; draft =
 * live + 1, using the single permitted `Version` arithmetic ({@link nextVersion}).
 * Edits accrue here and are invisible to {@link getLive} until {@link publish}.
 * Pure read; state and clock untouched.
 */
export function getDraft<TMap extends ContentTypeMap = AnyContentTypeMap>(
  state: ContentState<TMap>,
  clock: VersionClock,
): ContentSnapshot<TMap> {
  return materialize(state, nextVersion(clock.live()));
}

/**
 * Navigation helper: materialize one version BEFORE `version` (§6, SVER-I-0004
 * navigation). A thin version-SELECTING wrapper over `materialize` — it chooses a
 * version to read at and never mutates state or any clock. Selecting a version
 * `< 0` simply yields an empty snapshot (nothing has been appended yet).
 */
export function goBack<TMap extends ContentTypeMap = AnyContentTypeMap>(
  state: ContentState<TMap>,
  version: Version,
): ContentSnapshot<TMap> {
  return materialize(state, ((version as unknown as number) - 1) as Version);
}

/**
 * Navigation helper: materialize one version AFTER `version` (§6, SVER-I-0004
 * navigation). A thin version-SELECTING wrapper over `materialize` using the
 * single permitted `Version` arithmetic ({@link nextVersion}); it selects a
 * version to read at and never mutates state or any clock.
 */
export function goForward<TMap extends ContentTypeMap = AnyContentTypeMap>(
  state: ContentState<TMap>,
  version: Version,
): ContentSnapshot<TMap> {
  return materialize(state, nextVersion(version));
}
