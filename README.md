# versioned-content-engine

A headless, **zero-runtime-dependency** TypeScript engine for draft/live content versioning.

Model content as an **append-only log of version records** and **materialize** a content snapshot at
any version. Every operation is a pure, immutable function — no hidden mutation, no `Date.now()`,
no `Math.random()`, no framework, storage, or DOM coupling. History is always preserved: old
versions remain materializable **even across deletes**.

```bash
npm install versioned-content-engine
# or: pnpm add versioned-content-engine
```

- **Zero dependencies.** The core is functions over immutable data.
- **Deterministic.** ID generation and the version clock are injected, so tests are reproducible.
- **Correct delete semantics.** A tombstone hides content at/after its version — never retroactively.
- **Optional adapters** (separate entry points): in-memory + JSON storage, a React hook, a SQL sketch.

---

## Quick start

```ts
import {
  createContent,
  deleteContent,
  publish,
  getLive,
  getDraft,
  materialize,
  createDefaultIdStrategy,
  createDefaultVersionClock,
  type ContentState,
  type TargetId,
} from "versioned-content-engine";

// 1. Describe your content types (the engine stays content-agnostic).
type MyContent = { text: { value: string }; image: { src: string } };

// 2. Injected strategies. Use the defaults in production…
const idStrategy = createDefaultIdStrategy();
let clock = createDefaultVersionClock(); // integer clock, live version starts at 0
// …or a deterministic sequence in tests: createSequenceIdStrategy(ids, collectionIds)

const deps = { idStrategy, clock };

// 3. Start from an empty append-only log. Branded ids are cast at the boundary.
let state: ContentState<MyContent> = new Map();
const hero = "hero" as TargetId;

// 4. Operations are pure: (state, args, deps) => newState. They never mutate the input.
state = createContent(
  state,
  { target: hero, index: 0, type: "text", payload: { value: "Hello" } },
  deps,
);

// 5. Draft vs live. Edits accrue at the draft version (live + 1); they're invisible to
//    `live` until you publish.
getLive(state, clock);   // → empty (nothing published yet)
getDraft(state, clock);  // → shows the "Hello" text block

// 6. Publish advances live. publish returns a NEW clock (immutable) — thread it forward.
({ state, clock } = publish(state, clock));
getLive(state, clock);   // → now shows "Hello"

// 7. Historical fidelity: delete + publish, then materialize an EARLIER version.
const collectionId = [...getLive(state, clock).get(hero)!][0].collectionId;
const liveBeforeDelete = clock.live();

state = deleteContent(state, { target: hero, collectionId }, deps);
({ state, clock } = publish(state, clock));

getLive(state, clock).get(hero);        // → undefined (deleted)
materialize(state, liveBeforeDelete)    // → STILL shows "Hello" at the earlier version ✅
  .get(hero);
```

The last step is the whole point: **deleting content never rewrites history.** A version from before
the delete still materializes the content exactly as it was.

---

## Core concepts

| Concept | What it means |
|---|---|
| **Append-only records** | `ContentState` is a `ReadonlyMap<TargetId, readonly ContentRecord[]>`. An edit appends a new record for the same `collectionId` at a higher version; prior records are never touched. |
| **`materialize(state, version)`** | For each `collectionId`, pick the record with the greatest `version <= requested`; drop it if that winner is a tombstone; order + reindex survivors deterministically. Returns a `ContentSnapshot`. |
| **Draft / live** | `live = clock.live()`, `draft = live + 1`. Edits write at the draft version and are invisible to `getLive` until `publish` advances the clock. |
| **Tombstones** | `deleteContent` appends a `deleted` record at the draft version. It hides content at/after that version **only** — earlier versions still materialize it. |
| **Injectable strategies** | `IdStrategy` (`newId`/`newCollectionId`) and `VersionClock` (`live`/`advance`) are passed in. The core contains no ambient time, randomness, or global counters. |
| **`collectionId` vs `id`** | `collectionId` is the stable identity of a piece of content across all its versions; each individual record has its own `id`. |

---

## API

### Operations — pure `(state, args, deps) => ContentState`
`deps` is `{ idStrategy, clock }`.

- `createContent(state, { target, index, type, payload }, deps)` — mint a new `collectionId`+`id`, append at the draft version.
- `updateContent(state, { collectionId, type, payload }, deps)` — append a new record for an existing collection.
- `moveContent(state, { collectionId, source, dest, index }, deps)` — reorder / move across targets (cross-target adds a source tombstone + destination record).
- `deleteContent(state, { target, collectionId }, deps)` — append a tombstone.

### Reads
- `materialize(state, version): ContentSnapshot` — the low-level read (takes a `Version`).
- `getLive(state, clock)` / `getDraft(state, clock)` — materialize at `live` / `live + 1`.
- `goBack(clock)` / `goForward(clock)` — version-navigation helpers for history views.
- `reindex(records)` / `canonicalCompare(a, b)` — the deterministic ordering primitives.

### Publish
- `publish(state, clock): { state, clock }` — advances the live version via `clock.advance()` (no content append). **Thread the returned clock forward.**

### Strategies
- `createDefaultIdStrategy(prefix?)`, `createDefaultVersionClock(start = 0)` — production defaults.
- `createFixedIdStrategy(collectionId)`, `createSequenceIdStrategy(ids, collectionIds)`, `IntegerVersionClock(value?)`, `DefaultIdStrategy` — deterministic building blocks for tests and seeded/imported content.

### Types
`Id`, `ContentCollectionId`, `TargetId`, `Version` (opaque branded types), `asId`, `asCollectionId`, `asTargetId`, `asVersion`, `ContentRecord`, `ContentState`, `ContentSnapshot`, `ContentTypeMap`, `IdStrategy`, `VersionClock`, plus the per-operation arg types.

---

## Adapters (optional, separate entry points)

The core has no storage or framework coupling. Adapters are opt-in subpath imports, so a core-only
consumer pulls in nothing extra:

```ts
import { createMemoryAdapter } from "versioned-content-engine/memory"; // in-memory store
import { createJsonAdapter }   from "versioned-content-engine/json";   // JSON/file persistence (Node)
import { useVersionedContent } from "versioned-content-engine/react";  // React hook (peer: react)
// versioned-content-engine/sql — a documented interface + schema sketch (no runtime driver)
```

- **`/memory`** — `createMemoryAdapter(initial?)`: holds state + clock in a closure; the default for tests/demos.
- **`/json`** — `createJsonAdapter({ filePath })`: append-only log + clock persisted to a JSON file, immutably; survives a reload.
- **`/react`** — `useVersionedContent({ adapter?, clock?, idStrategy? })`: holds state, exposes `snapshot`, `create`/`update`/`move`/`delete`, `publish`, a draft/live toggle, and read-only version navigation. Delegates all logic to the pure core.
- **`/sql`** — an interface + Postgres/Supabase schema sketch (append-only `content_records` + a version row). No driver is bundled.

All storage adapters implement the same `StorageAdapter` contract and pass a shared parity suite, so
they're interchangeable.

> Building an in-iframe visual editor? [`@stardust-cms/dashboard`](https://www.npmjs.com/package/@stardust-cms/dashboard)
> uses this engine as its reference content store, proving the full draft → publish → inspect-history flow end to end.

---

## Design & guarantees

- **Purity is enforced**, not just intended: a dependency-cruiser gate forbids React/`fs`/socket/DOM imports in the core, and `package.json` has zero runtime `dependencies`.
- **No hidden mutation**: operations pass deep-frozen-input tests; reindex returns new objects.
- **Determinism**: given the same records + version, materialization is referentially transparent (property-tested with fast-check).

Full design notes live in [`docs/`](./docs) — corrected semantics, the append-only-vs-snapshot ADR,
and the worked-example fixtures used as the test oracle.

## License

MIT © Daniel Cassil
