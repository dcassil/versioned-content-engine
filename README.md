# versioned-content-engine

A headless, dependency-free TypeScript library for draft/live content versioning.

Model content as an append-only log of version records and **materialize** a content
snapshot at any version. Pure, deterministic, immutable operations:
`create`, `update`, `move`, `delete`, `publish`, `materialize` — with injectable ID and
version-clock strategies so the core has no coupling to React, sockets, storage, or the DOM.

## Status

Under active development. Built as a clean extraction of a content-versioning algorithm
into a rigorously-testable standalone package.

## Design

- **Pure core** — functions over immutable data; zero runtime dependencies.
- **History preserved** — append-only records; old versions always remain materializable, including across deletes.
- **Corrected delete semantics** — a tombstone hides content at/after its version, never retroactively.
- **Injectable strategies** — ID generation and the version clock are pluggable for deterministic tests.
- **Adapters last** — optional in-memory / JSON storage and a React hook layer sit outside the core.

## License

MIT
