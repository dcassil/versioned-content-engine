/**
 * dependency-cruiser configuration — the PURITY GATE.
 *
 * The core (`src/`) is a headless, zero-runtime-dependency library. This config
 * fails the build on any import of React, Socket.IO, storage, DOM, or Node
 * filesystem/path modules from within `src/`. See SVER-T-0006.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-purity-no-forbidden-runtime",
      comment:
        "Core (src/) must not import React, React-DOM, Socket.IO, fs, path, or any DOM/browser module. The engine is a pure, headless, zero-runtime-dependency library (SVER-I-0002 NFR-001).",
      severity: "error",
      from: { path: "^src" },
      to: {
        path: [
          "^react$",
          "^react-dom",
          "^react/",
          "^socket\\.io",
          "^socket\\.io-client",
          "^(node:)?fs$",
          "^(node:)?fs/",
          "^(node:)?path$",
          "^(node:)?net$",
          "^(node:)?tls$",
          "^(node:)?http$",
          "^(node:)?https$",
          "^(node:)?ws$",
          "^jsdom$",
        ],
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
