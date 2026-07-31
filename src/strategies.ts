/**
 * Injectable effect strategies: id generation and the version clock.
 *
 * Core algorithm modules reference ONLY the `IdStrategy` and `VersionClock`
 * interfaces — never the concrete defaults below — so tests can inject
 * deterministic implementations. Any nondeterminism (counters/randomness) is
 * confined to the default strategy, which tests override.
 *
 * Replaces the source's hard-coded `Math.random() + Date.now()` id generation
 * (`useContent.tsx`) and the global integer counter (`server/data/version.js`).
 */

import type { ContentCollectionId, Id, Version } from "./types.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Produces the opaque ids the engine needs. Pure with respect to the engine:
 * the engine calls these and threads the results into new records, so all
 * id-generation nondeterminism lives here rather than in the algorithm.
 */
export interface IdStrategy {
  /** Mint a new record `Id`. */
  newId(): Id;
  /** Mint a new `ContentCollectionId` for a brand-new content item. */
  newCollectionId(): ContentCollectionId;
}

/**
 * Immutable-value version clock. `live()` reads the current live version;
 * `advance()` returns a NEW clock advanced by one — it never mutates the
 * receiver (immutable-value semantics).
 */
export interface VersionClock {
  /** The current live `Version`. */
  live(): Version;
  /** Return a new clock whose live version is advanced by one. */
  advance(): VersionClock;
}

// ---------------------------------------------------------------------------
// Default IdStrategy
// ---------------------------------------------------------------------------

/**
 * A default, injectable `IdStrategy`. Uses a monotonic counter with a
 * per-instance prefix so ids are unique without reading global mutable state at
 * the module level. The counter is instance-local, so constructing a fresh
 * strategy resets the sequence — useful for deterministic tests, though tests
 * should generally inject their own fully-deterministic strategy.
 */
export class DefaultIdStrategy implements IdStrategy {
  #counter = 0;
  readonly #prefix: string;

  constructor(prefix = "vce") {
    this.#prefix = prefix;
  }

  newId(): Id {
    this.#counter += 1;
    return `${this.#prefix}-id-${String(this.#counter)}` as Id;
  }

  newCollectionId(): ContentCollectionId {
    this.#counter += 1;
    return `${this.#prefix}-col-${String(this.#counter)}` as ContentCollectionId;
  }
}

/**
 * Convenience factory for a fully deterministic `IdStrategy` seeded from
 * explicit sequences — handy for fixture-driven tests.
 */
export function createSequenceIdStrategy(
  ids: readonly string[],
  collectionIds: readonly string[],
): IdStrategy {
  let idIndex = 0;
  let colIndex = 0;
  return {
    newId(): Id {
      const value = ids[idIndex];
      if (value === undefined) {
        throw new Error("createSequenceIdStrategy: ran out of ids");
      }
      idIndex += 1;
      return value as Id;
    },
    newCollectionId(): ContentCollectionId {
      const value = collectionIds[colIndex];
      if (value === undefined) {
        throw new Error("createSequenceIdStrategy: ran out of collectionIds");
      }
      colIndex += 1;
      return value as ContentCollectionId;
    },
  };
}

// ---------------------------------------------------------------------------
// Default VersionClock
// ---------------------------------------------------------------------------

/**
 * Default integer-backed `VersionClock`. Wraps an immutable integer; `advance()`
 * returns a fresh instance and never mutates. No wall-clock time or randomness.
 */
export class IntegerVersionClock implements VersionClock {
  readonly #value: number;

  constructor(value = 0) {
    this.#value = value;
  }

  live(): Version {
    return this.#value as Version;
  }

  advance(): VersionClock {
    return new IntegerVersionClock(this.#value + 1);
  }
}

/** Construct a default `IdStrategy`. */
export function createDefaultIdStrategy(prefix?: string): IdStrategy {
  return prefix === undefined
    ? new DefaultIdStrategy()
    : new DefaultIdStrategy(prefix);
}

/** Construct a default `VersionClock` starting at `start` (default 0). */
export function createDefaultVersionClock(start = 0): VersionClock {
  return new IntegerVersionClock(start);
}
