import { describe, expect, it } from "vitest";

import {
  createDefaultIdStrategy,
  createDefaultVersionClock,
  createSequenceIdStrategy,
  DefaultIdStrategy,
  IntegerVersionClock,
  type IdStrategy,
  type VersionClock,
} from "../src";

describe("scaffold smoke", () => {
  it("exports a default id strategy that mints distinct ids", () => {
    const strategy: IdStrategy = createDefaultIdStrategy();
    const a = strategy.newId();
    const b = strategy.newId();
    const col = strategy.newCollectionId();
    expect(a).not.toBe(b);
    expect(String(col)).toContain("col");
  });

  it("default id strategy is a DefaultIdStrategy instance", () => {
    expect(createDefaultIdStrategy()).toBeInstanceOf(DefaultIdStrategy);
  });

  it("integer clock advances immutably (advance returns a new clock)", () => {
    const clock: VersionClock = createDefaultVersionClock(5);
    const advanced = clock.advance();
    expect(Number(clock.live())).toBe(5); // original unchanged
    expect(Number(advanced.live())).toBe(6);
    expect(advanced).not.toBe(clock);
    expect(clock).toBeInstanceOf(IntegerVersionClock);
  });

  it("sequence id strategy yields ids deterministically and then throws", () => {
    const strategy = createSequenceIdStrategy(["x"], ["c"]);
    expect(String(strategy.newId())).toBe("x");
    expect(String(strategy.newCollectionId())).toBe("c");
    expect(() => strategy.newId()).toThrow(/ran out of ids/);
  });
});
