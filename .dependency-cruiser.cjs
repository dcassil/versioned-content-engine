/**
 * dependency-cruiser configuration — the PURITY GATE.
 *
 * The core (`src/`) is a headless, zero-runtime-dependency library. This config
 * fails the build on any import of React, Socket.IO, storage, DOM, or Node
 * filesystem/path modules from within `src/`. See SVER-T-0006.
 */
/**
 * Build a regex fragment matching an installed npm package by its RESOLVED
 * path. dependency-cruiser matches `to.path` against the resolved module path,
 * which for an installed package is under `node_modules` (and, under pnpm, a
 * nested `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/...`). A bare
 * `^react$` never matches that resolved path, so the guard would silently pass.
 * The resolved path's FINAL segment is always `node_modules/<pkg>/...` even under
 * pnpm's nested `.pnpm/<pkg>@<ver>/node_modules/<pkg>/...` layout, so anchoring on
 * `/node_modules/<pkg>/` matches both without a ReDoS-prone nested quantifier.
 *
 * @param {string} pkg - the escaped package name (e.g. "react", "react-dom").
 */
const installedPkg = (pkg) => `/node_modules/${pkg}/`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-purity-no-forbidden-runtime",
      comment:
        "Core (src/, excluding src/adapters/) must not import React, React-DOM, Socket.IO, fs, path, or any DOM/browser module. The engine is a pure, headless, zero-runtime-dependency library (SVER-I-0002 NFR-001).",
      severity: "error",
      from: { path: "^src", pathNot: "^src/adapters/" },
      to: {
        path: [
          installedPkg("react"),
          installedPkg("react-dom"),
          installedPkg("socket\\.io"),
          installedPkg("socket\\.io-client"),
          installedPkg("ws"),
          installedPkg("jsdom"),
          "^(node:)?fs$",
          "^(node:)?fs/",
          "^(node:)?path$",
          "^(node:)?net$",
          "^(node:)?tls$",
          "^(node:)?http$",
          "^(node:)?https$",
        ],
      },
    },
    {
      name: "core-independence-no-adapter-imports",
      comment:
        "The pure core (src/, excluding src/adapters/) must NOT import any adapter module. Dependencies flow adapter -> core, never the reverse. This is what keeps a core-only consumer from transitively resolving React or fs (SVER-I-0003 REQ-006 / NFR-001).",
      severity: "error",
      from: { path: "^src", pathNot: "^src/adapters/" },
      to: { path: "^src/adapters/" },
    },
    {
      name: "react-confined-to-react-adapter",
      comment:
        "React may only be imported from src/adapters/react/. It is an optional peerDependency of the ./react subpath only (SVER-I-0003 NFR-003).",
      severity: "error",
      from: { path: "^src", pathNot: "^src/adapters/react/" },
      to: { path: [installedPkg("react"), installedPkg("react-dom")] },
    },
    {
      name: "fs-confined-to-json-adapter",
      comment:
        "Node fs/path may only be imported from src/adapters/json/. File I/O is confined to the JSON/file adapter (SVER-I-0003 REQ-003).",
      severity: "error",
      from: { path: "^src", pathNot: "^src/adapters/json/" },
      to: {
        path: ["^(node:)?fs$", "^(node:)?fs/", "^(node:)?path$"],
      },
    },
    {
      name: "no-orphans",
      comment: "Modules without any incoming or outgoing dependencies are suspicious.",
      severity: "warn",
      from: { orphan: true, pathNot: ["\\.d\\.ts$", "(^|/)index\\.ts$"] },
      to: {},
    },
    {
      name: "no-circular",
      comment: "Circular dependencies make the core hard to reason about.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "types"],
    },
  },
};
