import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Property/example tests live in `test/`; unit `.test.ts` may also live in
    // `src/`. Benchmarks (`bench/`) are deliberately EXCLUDED so the default
    // `pnpm test`/`pnpm coverage` run stays fast — they run via `pnpm bench`.
    // `.test.tsx` picks up the React hook suite (SVER-T-0016); it opts into the
    // jsdom environment via a per-file `// @vitest-environment jsdom` pragma so
    // the rest of the suite stays in the fast default `node` environment.
    include: ["test/**/*.test.ts", "test/**/*.test.tsx", "src/**/*.test.ts"],
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
        // The React hook (SVER-T-0016) is exercised by its own jsdom `renderHook`
        // suite (`test/adapters/react.test.tsx`), which runs in the jsdom
        // environment. The default `pnpm coverage` pass runs in `node`, so it
        // would report the hook as uncovered and skew the pure-core bar; its
        // correctness is guaranteed by the dedicated suite instead.
        "src/adapters/react/**",
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
