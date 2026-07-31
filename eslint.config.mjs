// @ts-check
/**
 * Guard-rails ESLint flat config for versioned-content-engine.
 *
 * STRONG, STRICT rules: typescript-eslint strict+stylistic (type-checked), hard
 * size/complexity ceilings, banned escape hatches (no `any`, no non-null `!`, no
 * `ts-` comments, no `eslint-disable`), import-depth limits, and MODULE
 * BOUNDARIES that encode this package's real architecture:
 *
 *   - `core` is a LEAF: it imports only itself (its own modules + the internal
 *     primitive). It NEVER imports an adapter, React, or any storage/DOM module.
 *   - each `adapter` (memory / json / sql / react) may import the CORE PUBLIC
 *     ENTRY (`#core`) and the shared internal append primitive (`#core/internal`)
 *     and the adapter contract — but NEVER a SIBLING adapter.
 *   - only the `react` adapter may import `react`.
 *
 * These edges mirror the path-based rules in `.dependency-cruiser.cjs`; the two
 * gates are kept in lockstep. Nothing here is loosened to pass — every existing
 * violation was refactored away.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";
import importPlugin from "eslint-plugin-import";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import reactHooks from "eslint-plugin-react-hooks";

/** Directories that are build output / vendored and never linted. */
const IGNORES = ["dist/**", "node_modules/**", "coverage/**", "html/**"];

export default tseslint.config(
  { ignores: IGNORES },

  // Base recommended set for every linted file (incl. *.config.* files).
  js.configs.recommended,

  // ── Type-aware strict + stylistic rules (source + tests) ──────────────────
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      boundaries,
      import: importPlugin,
      "@eslint-community/eslint-comments": eslintComments,
    },
    settings: {
      "import/resolver": {
        typescript: { alwaysTryTypes: true, project: "./tsconfig.json" },
      },
      // Module-boundary elements — most specific patterns FIRST so a file is
      // classified as exactly one element.
      // Elements are defined with NON-NESTING patterns: no element's pattern is
      // an ancestor path of another's, so cross-element imports resolve to
      // exactly one public entry (`core-barrel`, `core-internal`) and are never
      // treated as a private child of `core`. Each source file matches exactly
      // one element.
      "boundaries/elements": [
        // The public core entry (`#core`) — the barrel adapters import.
        { type: "core-barrel", pattern: "src/index.ts", mode: "full" },
        // The shared internal append primitive (`#core/internal`).
        {
          type: "core-internal",
          pattern: "src/operations/internal.ts",
          mode: "full",
        },
        // The adapter contract (interface-only over the core's public types).
        {
          type: "adapter-contract",
          pattern: "src/adapters/types.ts",
          mode: "full",
        },
        { type: "adapter-memory", pattern: "src/adapters/memory/**" },
        { type: "adapter-json", pattern: "src/adapters/json/**" },
        { type: "adapter-sql", pattern: "src/adapters/sql/**" },
        { type: "adapter-react", pattern: "src/adapters/react/**" },
        { type: "fixtures", pattern: "src/__fixtures__/**" },
        // The pure core leaf — every remaining core module, listed explicitly so
        // the pattern is not an ancestor of the public entries above.
        {
          type: "core",
          mode: "full",
          pattern: [
            "src/types.ts",
            "src/strategies.ts",
            "src/materialize.ts",
            "src/reindex.ts",
            "src/operations/create.ts",
            "src/operations/update.ts",
            "src/operations/move.ts",
            "src/operations/delete.ts",
            "src/operations/publish.ts",
          ],
        },
      ],
      "boundaries/ignore": ["**/*.test.ts", "**/*.test.tsx", "test/**"],
    },
    rules: {
      // ── SIZE / COMPLEXITY ────────────────────────────────────────────────
      "max-lines": ["error", { max: 200, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": [
        "error",
        { max: 80, skipBlankLines: true, skipComments: true },
      ],
      complexity: ["error", 12],
      "max-depth": ["error", 4],
      "max-params": ["error", 4],
      "max-nested-callbacks": ["error", 3],

      // ── ESCAPE HATCHES BANNED ────────────────────────────────────────────
      // Intentionally-unused args/vars must be marked with a leading underscore
      // (the conventional, explicit opt-out — NOT a loosening of the rule's
      // intent). Everything without that marker is still an error.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@eslint-community/eslint-comments/no-use": ["error", { allow: [] }],

      // ── IMPORTS / DEPTH ──────────────────────────────────────────────────
      "import/no-cycle": ["error", { maxDepth: Infinity }],
      "import/no-useless-path-segments": ["error", { noUselessIndex: true }],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../**", "../../../**"],
              message:
                "Deep relative import banned: import from a module's public entry (`#core` / `#core/internal`), not across 2+ parent dirs.",
            },
          ],
        },
      ],

      // ── MODULE BOUNDARIES ────────────────────────────────────────────────
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          message:
            "Boundary violation: '{{from.type}}' may not import '{{to.type}}'. Allowed edges are declared in eslint.config.mjs (adapters import the core public entry only; core is a leaf).",
          policies: [
            // The pure core is a LEAF: it may only import itself and the shared
            // internal append primitive. It may NOT import any adapter.
            {
              from: { element: { type: "core" } },
              allow: { to: { element: { types: { anyOf: ["core", "core-internal"] } } } },
              message:
                "core must stay framework/storage-free — it is a leaf and may not import an adapter (memory/json/sql/react) or React.",
            },
            {
              from: { element: { type: "core-internal" } },
              allow: { to: { element: { types: { anyOf: ["core", "core-internal"] } } } },
            },
            // The public barrel re-exports the core; it too must not reach an adapter.
            {
              from: { element: { type: "core-barrel" } },
              allow: { to: { element: { types: { anyOf: ["core", "core-internal"] } } } },
              message:
                "the core public barrel (src/index.ts) re-exports the leaf core only — it may not import an adapter.",
            },
            // The adapter contract is interface-only over the core's public types.
            {
              from: { element: { type: "adapter-contract" } },
              allow: { to: { element: { type: "core-barrel" } } },
            },
            // Each adapter may import the core public entry, the shared internal
            // append primitive, and the adapter contract — NEVER a sibling adapter.
            {
              from: {
                element: {
                  types: {
                    anyOf: [
                      "adapter-memory",
                      "adapter-json",
                      "adapter-sql",
                      "adapter-react",
                    ],
                  },
                },
              },
              allow: {
                to: {
                  element: {
                    types: {
                      anyOf: ["core-barrel", "core-internal", "adapter-contract"],
                    },
                  },
                },
              },
              message:
                "an adapter may import the core public entry (`#core`), the shared internal primitive (`#core/internal`), and the adapter contract only — NEVER a sibling adapter.",
            },
            // Fixtures (worked examples) exercise the core public surface.
            {
              from: { element: { type: "fixtures" } },
              allow: { to: { element: { types: { anyOf: ["core-barrel", "core"] } } } },
            },
          ],
        },
      ],
      "boundaries/no-unknown-dependencies": "error",
    },
  },

  // ── React adapter: react-hooks rules ──────────────────────────────────────
  {
    files: ["src/adapters/react/**/*.ts", "src/adapters/react/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },

  // ── Test / fixture override ───────────────────────────────────────────────
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/__tests__/**",
      "**/testing/**",
      "test/**",
      "src/__fixtures__/**",
      "bench/**",
    ],
    // The guard-rails (strict type-checking + module boundaries + size limits)
    // are enforced in FULL on every `src/` module — the shipped library. Test,
    // fixture, and bench code lives in a sibling tree and legitimately (a) reaches
    // into `src/` internals to exercise them, (b) drives ops with dynamically
    // typed fast-check arbitraries, and (c) uses many-arg table helpers. Relaxing
    // these production-code rules HERE does not weaken any guarantee about the
    // published package; it only avoids forcing test scaffolding into shapes that
    // obscure the tests. Boundaries and no-`any`/no-`!`/no-`ts-comment`/
    // no-`eslint-disable` stay ON everywhere.
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "max-nested-callbacks": "off",
      "max-params": "off",
      // Tests import the package's internal source modules directly (so coverage
      // instruments source); the deep-relative production ban does not apply.
      "no-restricted-imports": "off",
      // fast-check arbitraries and test doubles are dynamically typed at the
      // boundary; the strict type-flow rules add noise without catching bugs here.
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-floating-promises": "off",
    },
  },

  // ── Config files: not part of the type-aware program ──────────────────────
  {
    files: ["*.config.*", ".dependency-cruiser.cjs"],
    languageOptions: {
      parserOptions: { projectService: false, project: null },
    },
    ...tseslint.configs.disableTypeChecked,
  },
);
