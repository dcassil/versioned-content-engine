/**
 * Compile-time assertions for the core type layer (SVER-T-0002).
 *
 * This file contains NO runtime tests — it is a type-only fixture validated by
 * `tsc --noEmit` (the `typecheck` script), which includes `test/`. Each
 * `@ts-expect-error` marker FAILS the typecheck if its line ever becomes valid,
 * locking in the opacity / discrimination / immutability guarantees. It is not
 * matched by vitest's `*.test.ts` glob, so it never executes at runtime.
 *
 * Everything lives inside `assertTypeLayer`, which is exported but never called;
 * the wrapping function keeps `noUnusedLocals` satisfied without emitting
 * runtime references to `declare`d values.
 */
import type {
  ContentCollectionId,
  ContentRecord,
  ContentSnapshot,
  ContentState,
  Id,
  TargetId,
  Version,
} from "../src";

interface DemoContent {
  heading: { readonly text: string };
  image: { readonly src: string; readonly alt: string };
}

export function assertTypeLayer(
  targetId: TargetId,
  record: ContentRecord<DemoContent>,
  anyRecord: ContentRecord,
  state: ContentState<DemoContent>,
  snapshot: ContentSnapshot<DemoContent>,
): void {
  // --- Opaque id types are mutually assignment-incompatible ----------------

  // A TargetId may not stand in for a ContentCollectionId...
  // @ts-expect-error opacity: TargetId is not assignable to ContentCollectionId
  const _c: ContentCollectionId = targetId;
  // ...nor for a record Id...
  // @ts-expect-error opacity: TargetId is not assignable to Id
  const _i: Id = targetId;
  // ...and a bare string may not stand in for a branded id.
  // @ts-expect-error opacity: string is not assignable to TargetId
  const _t: TargetId = "raw-string";
  // A Version (branded number) is not a bare number sink either.
  // @ts-expect-error opacity: number is not assignable to Version
  const _v: Version = 3;
  void _c;
  void _i;
  void _t;
  void _v;

  // --- ContentRecord discriminates payload over the content-type map -------

  if (record.type === "heading") {
    const text: string = record.payload.text; // narrowed to heading payload
    void text;
    // @ts-expect-error heading payload has no `src`
    void record.payload.src;
  }

  // --- ContentRecord fields are readonly (immutability) --------------------

  // @ts-expect-error records are readonly: cannot reassign `deleted`
  anyRecord.deleted = true;
  // @ts-expect-error records are readonly: cannot reassign `index`
  anyRecord.index = 0;

  // --- ContentState / ContentSnapshot are readonly maps --------------------

  // @ts-expect-error ContentState is a ReadonlyMap: no `set`
  state.set(targetId, []);
  // @ts-expect-error ContentSnapshot is a ReadonlyMap: no `clear`
  snapshot.clear();

  const bucket = state.get(targetId);
  if (bucket !== undefined) {
    // @ts-expect-error readonly array: no `push`
    bucket.push(anyRecord);
  }
}
