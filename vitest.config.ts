import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Property/example tests live in `test/`; unit `.test.ts` may also live in
    // `src/`. Benchmarks (`bench/`) are deliberately EXCLUDED so the default
    // `pnpm test`/`pnpm coverage` run stays fast — they run via `pnpm bench`.
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // Measure the pure core only; tests, fixtures, and the barrel re-export
      // are not the subject of the >=95% correctness bar (SVER-I-0002).
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/__fixtures__/**",
        "src/**/*.d.ts",
        // types.ts is a pure type-declaration module (branded aliases,
        // interfaces) with zero runtime code — nothing to execute or cover.
        "src/types.ts",
      ],
      reporter: ["text", "html", "json-summary"],
      // Initiative bar: >=95% lines overall + high branch coverage on the
      // semantic-critical paths (materialize tombstone/argmax, move
      // same/cross-target). `pnpm coverage` FAILS below these thresholds.
      thresholds: {
        lines: 95,
        statements: 95,
        functions: 95,
        branches: 95,
      },
    },
  },
});
