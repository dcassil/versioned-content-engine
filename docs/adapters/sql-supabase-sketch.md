# SQL / Supabase `StorageAdapter` — Design Sketch (NOT IMPLEMENTED)

> **Status: sketch only.** This document and the typed stub at
> `src/adapters/sql/index.ts` are a DESIGN artifact for SVER-T-0015
> (SVER-I-0003 REQ-004). No SQL client, driver, migration, or runtime code path
> is built or added. The core stays a zero-runtime-dependency library; no
> `pg`/`@supabase/supabase-js` dependency exists. The purpose is to prove the
> `StorageAdapter` boundary generalizes to a relational/Supabase backend and to
> de-risk a future backend initiative — *without* building it.

## 1. Why this is a sketch and what it proves

The initiative (SVER-I-0003) ships an in-memory adapter (SVER-T-0013) and a
JSON/file adapter (SVER-T-0014) against a single interface,
[`StorageAdapter<TMap>`](../../src/adapters/types.ts):

```ts
interface StorageAdapter<TMap extends ContentTypeMap = ContentTypeMap> {
  load(): ContentState<TMap> | Promise<ContentState<TMap>>;
  append(records: readonly ContentRecord<TMap>[]): void | Promise<void>;
  getClock(): VersionClock | Promise<VersionClock>;
  setClock(clock: VersionClock): void | Promise<void>;
}
```

A relational backend is the "hardest" target for this interface: it has schema,
indexes, transactions, and (in Supabase) row-level security. If all four methods
map cleanly onto append-only SQL — and the async return types the interface
already allows absorb the I/O — then the boundary is genuinely backend-agnostic
and the future initiative is de-risked: it becomes "write the four bodies and a
migration", not "rediscover the contract". This sketch pins down exactly that
mapping so the later work is mechanical.

The typed stub (`createSqlAdapter(config): StorageAdapter<TMap>`) demonstrates
conformance **at the type level**: it type-checks against the interface today,
with a throwing body (matching the `createMemoryAdapter` / `createJsonAdapter` /
`useVersionedContent` stub convention from SVER-T-0012), so nothing suggests it
is usable.

## 2. The append-only schema

Two objects: an append-only **record log** and a single **version clock** row.
Everything the core needs to reconstruct `ContentState` and materialize is
derivable from these, in keeping with ADR SVER-A-0001 (append-only vs snapshot).

### 2.1 `content_records` — the append-only log

Columns map 1:1 onto `ContentRecordBase` + the discriminated
`{ type, payload }` from
[`ContentRecord<TMap>`](../../src/types.ts):

```sql
create table content_records (
  -- Surface identity of the row itself (DB-generated, ordering + PK).
  seq            bigint generated always as identity primary key,

  -- The StorageAdapter tenant/collection scope (RLS ownership key).
  collection_id  text        not null,   -- ContentCollectionId

  -- The engine record fields (ContentRecordBase).
  id             text        not null,   -- Id (this record instance)
  version        integer     not null,   -- Version the record was appended at
  index          integer     not null,   -- ordering within target
  target         text        not null,   -- TargetId / slot
  type           text        not null,   -- ContentTypeMap discriminant key
  deleted        boolean     not null default false, -- tombstone flag
  payload        jsonb       not null,   -- TMap[type] payload, opaque to SQL

  inserted_at    timestamptz not null default now()  -- audit only, not semantic
);
```

Notes:

- **`seq` (identity PK)** is the physical append order. It is *not* the engine
  `version` — many records can share a `version` (a single edit appends several
  reindexed records). `seq` gives a total, monotonic, insert-only order that is
  the canonical tie-break for reconstructing per-target history deterministically
  (mirrors array push order in the in-memory/JSON adapters).
- **`payload jsonb`** stores the caller's `TMap[type]` payload verbatim. It is
  opaque to SQL — the engine, not the database, owns payload typing (NFR-004).
  `jsonb` (not `json`) so Supabase/Postgres can index/query it later if needed
  and normalizes representation.
- **Append-only integrity.** There is deliberately no `updated_at` and the table
  is written by INSERT only. A future migration SHOULD additionally enforce this
  with a `REVOKE UPDATE, DELETE` on the table role and/or a rule/trigger, and an
  RLS policy that grants `insert` + `select` but not `update`/`delete`
  (see §4). A logical delete is an appended row with `deleted = true`.

### 2.2 `content_version` — the clock row

The [`VersionClock`](../../src/strategies.ts) is a single scalar (the live
version) per collection. Generalizes the global counter in the source's
`server/data/version.js`.

```sql
create table content_version (
  collection_id  text        primary key,  -- one clock per collection scope
  live_version   integer     not null default 0,
  updated_at     timestamptz not null default now()
);
```

The clock is the one place an UPDATE is legitimate (advancing the live pointer on
`publish`). It is a pointer into the append-only log, not part of it, so mutating
it in place does not violate append-only integrity of the record history. The
default `IntegerVersionClock` serializes to/from `live_version` directly.

### 2.3 Indexes for materialize-on-read

`materialize(state, version)` reads the log filtered by target and version. Two
indexes cover the read paths:

```sql
-- Load the whole collection's log, ordered for reconstruction.
create index content_records_collection_seq_idx
  on content_records (collection_id, seq);

-- Materialize a single target up to a version (target-scoped reads).
create index content_records_target_version_idx
  on content_records (collection_id, target, version, seq);
```

`(collection_id, seq)` supports `load()`'s full ordered scan;
`(collection_id, target, version, seq)` (the `(target, version)` composite the
task calls out, scoped by tenant and tie-broken by `seq`) supports
materialize-on-read for a single target at a version without scanning the whole
log — the index that makes a large log viable where the JSON adapter's
full-rewrite would not (the initiative flags exactly this).

## 3. Method-by-method mapping

| Interface method | SQL behavior |
|---|---|
| `load()` | `SELECT * FROM content_records WHERE collection_id = $1 ORDER BY seq` → group rows by `target` into `ReadonlyMap<TargetId, readonly ContentRecord[]>`, deserializing `payload` and reassembling the discriminated `{ type, payload }`. Returns an immutable `ContentState<TMap>` (NFR-002). Async — absorbed by the interface's `Promise` return. |
| `append(records)` | `INSERT INTO content_records (collection_id, id, version, index, target, type, deleted, payload) VALUES ...` — **one multi-row INSERT, never UPDATE/DELETE**. This is the ONLY write path (ADR SVER-A-0001). Records are inserted in argument order; `seq` records physical order. The argument is not mutated. |
| `getClock()` | `SELECT live_version FROM content_version WHERE collection_id = $1` (default `0` if absent) → `createDefaultVersionClock(live_version)` / `IntegerVersionClock`. |
| `setClock(clock)` | `INSERT INTO content_version (collection_id, live_version) VALUES ($1, $2) ON CONFLICT (collection_id) DO UPDATE SET live_version = excluded.live_version, updated_at = now()` — upsert the single clock pointer with `clock.live()`. |

**Immutability (NFR-002)** is preserved structurally: record history is
insert-only, so a loaded `ContentState` can never be invalidated by an in-place
mutation of the log; the only mutable cell is the clock pointer, which is a value
overwrite, not a history edit. `load` returns freshly-constructed immutable maps,
never aliases of any driver-internal buffer.

**Batching / transactions (deferred).** A single core operation produces several
records plus possibly a clock advance; a real implementation would wrap the
`append` INSERT and any `setClock` in one transaction so a `publish` is atomic.
That is an implementation concern, not a contract concern, and is deferred.

## 4. Supabase-specific considerations (high level, not prescribed)

- **RLS / ownership on `collection_id`.** Enable
  `alter table content_records enable row level security;` (and likewise
  `content_version`) and add policies keyed on `collection_id` so a caller can
  only read/append within collections they own (e.g. mapping `collection_id` to
  `auth.uid()` or a membership table). Grant `select` + `insert` on
  `content_records` but **not** `update`/`delete`, which is what enforces
  append-only at the security layer, not just by convention. `content_version`
  additionally allows the clock upsert.
- **`payload` as `jsonb`.** Chosen over `json` for canonical storage and optional
  future indexing (`jsonb_path_ops` GIN) if payload-level queries are ever
  needed; the engine still owns payload typing.
- **Driver confinement.** The future driver (`@supabase/supabase-js` or `pg`)
  MUST be a dependency of ONLY the `./sql` subpath (`src/adapters/sql/`), never
  the core — mirroring how `react` and `fs` are confined by the
  dependency-cruiser purity gate. A future task extends
  `.dependency-cruiser.cjs` with a `sql-confined-to-sql-adapter` rule so the
  driver cannot leak into `src/` at large. Until then, the sketch imports **no**
  runtime package and the `client` is typed `unknown`.
- **Migrations.** The two `create table` + index statements above become a
  Supabase migration in the future initiative; none is executed here.

## 5. Explicitly deferred to a future implementation initiative

1. Add a real driver dependency, confined to `src/adapters/sql/` + a matching
   dependency-cruiser confinement rule.
2. Author + run the migration for `content_records`, `content_version`, indexes,
   RLS policies, and the append-only grants/trigger.
3. Implement the four method bodies per §3, with connection/config handling
   (URL, key, table/schema names, RLS auth context) driven by
   [`SqlAdapterConfig`](../../src/adapters/sql/index.ts).
4. Wrap multi-record `append` + `setClock` in a transaction; add `append`
   batching for large operations.
5. Run the shared cross-adapter parity suite (SVER-T-0013) against a Supabase
   test project / local Postgres to prove parity with the in-memory and JSON
   adapters.
