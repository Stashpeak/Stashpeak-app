import { describe, expect, it } from "vitest";

import { isSerializableValue, namespaceNodeId, toViewInfo } from "./contract";
import type { ViewContribution } from "./contract";

// The two runtime guards in the otherwise type-only View contract. Both became
// the persistence-key / serialized-boundary format, so their edge cases are
// pinned here (hardened across Codex P2s on #187).

describe("isSerializableValue", () => {
  it("accepts plain JSON-shaped values", () => {
    for (const v of [
      "s",
      0,
      -1.5,
      123,
      true,
      false,
      null,
      [],
      [1, "a", true, null, [2]],
      { a: 1, b: { c: ["x"] }, d: null },
      Object.create(null) as object, // null-prototype bag
    ]) {
      expect(isSerializableValue(v)).toBe(true);
    }
  });

  it("accepts a shared but acyclic reference (JSON duplicates it)", () => {
    const shared = { k: 1 };
    expect(isSerializableValue({ a: shared, b: shared })).toBe(true);
    expect(isSerializableValue([shared, shared])).toBe(true);
  });

  it("rejects non-finite numbers (JSON coerces them to null)", () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(isSerializableValue(v)).toBe(false);
      expect(isSerializableValue({ v })).toBe(false);
      expect(isSerializableValue([v])).toBe(false);
    }
  });

  it("rejects non-serializable primitives and functions", () => {
    expect(isSerializableValue(undefined)).toBe(false);
    expect(isSerializableValue(() => {})).toBe(false);
    expect(isSerializableValue(Symbol("s"))).toBe(false);
    expect(isSerializableValue(10n)).toBe(false);
    expect(isSerializableValue({ fn: () => {} })).toBe(false);
  });

  it("rejects non-plain objects (Date / Map / Set / class instances)", () => {
    class Box {
      x = 1;
    }
    for (const v of [new Date(), new Map(), new Set(), new Box(), /re/]) {
      expect(isSerializableValue(v)).toBe(false);
      expect(isSerializableValue({ nested: v })).toBe(false);
    }
  });

  it("rejects symbol-keyed, non-enumerable, and accessor properties", () => {
    expect(isSerializableValue({ [Symbol("k")]: 1 })).toBe(false);

    const nonEnum: Record<string, unknown> = {};
    Object.defineProperty(nonEnum, "hidden", { value: 1, enumerable: false });
    expect(isSerializableValue(nonEnum)).toBe(false);

    const withGetter = {};
    Object.defineProperty(withGetter, "g", { get: () => 1, enumerable: true });
    expect(isSerializableValue(withGetter)).toBe(false);
  });

  it("rejects circular references instead of overflowing the stack", () => {
    const circObj: Record<string, unknown> = {};
    circObj.self = circObj;
    expect(isSerializableValue(circObj)).toBe(false);

    const circArr: unknown[] = [];
    circArr.push(circArr);
    expect(isSerializableValue(circArr)).toBe(false);
  });

  it("rejects sparse array holes (JSON renders them as null)", () => {
    const sparse = [1];
    sparse[2] = 3; // index 1 is a hole
    expect(isSerializableValue(sparse)).toBe(false);
  });

  it("rejects arrays carrying non-index own properties", () => {
    const withFn: number[] & { fn?: unknown } = [1, 2];
    withFn.fn = () => {}; // JSON drops it, but the closure still rides on the array
    expect(isSerializableValue(withFn)).toBe(false);

    const withSym: number[] = [1];
    (withSym as unknown as Record<symbol, unknown>)[Symbol("s")] = 2;
    expect(isSerializableValue(withSym)).toBe(false);
  });

  it("rejects array own-keys at/above the max array index (JSON drops them)", () => {
    // 2**32 - 1 (4294967295) is NOT a valid array index (max is 2**32 - 2): JS
    // stores it as an ordinary property that JSON.stringify silently drops, so
    // the guard must reject it as a non-index extra (Codex P2, #187).
    const overMax: number[] = [1];
    (overMax as unknown as Record<string, unknown>)["4294967295"] = 2;
    expect(isSerializableValue(overMax)).toBe(false);
  });

  it("rejects -0 (JSON.stringify rewrites it to 0)", () => {
    expect(isSerializableValue(-0)).toBe(false);
    expect(isSerializableValue([-0])).toBe(false);
    expect(isSerializableValue({ a: -0 })).toBe(false);
  });

  it("rejects array indices satisfied only via the prototype (not own props)", () => {
    const arr = new Array(1); // own hole at index 0
    Object.setPrototypeOf(arr, { 0: () => {} }); // index 0 lives only on the prototype
    expect(isSerializableValue(arr)).toBe(false);
  });
});

describe("toViewInfo", () => {
  it("projects dataDeps/actions to fresh { id } records, stripping extra fields", () => {
    const contribution = {
      id: "view-x",
      slot: "nav.section",
      title: "X",
      order: 0,
      abiVersion: 1,
      renderer: { mode: "react", component: () => null },
      // Extra runtime fields that structurally satisfy the { id } interfaces but
      // must NOT cross into the frozen wire projection (Codex P2, #187).
      dataDeps: [{ id: "dep-1", fetch: () => {} }],
      actions: [{ id: "act-1", handler: () => {} }],
    } as unknown as ViewContribution;

    const info = toViewInfo(contribution);

    expect(info.dataDeps).toEqual([{ id: "dep-1" }]);
    expect(info.actions).toEqual([{ id: "act-1" }]);
  });
});

describe("namespaceNodeId", () => {
  it("joins sourceId and localId with the reserved delimiter", () => {
    expect(namespaceNodeId("spend-summary", "row-1")).toBe("spend-summary:row-1");
  });

  it("allows ':' inside localId (the map's hierarchical ids) and stays injective", () => {
    // The FIRST ':' delimits sourceId, so localId may keep its own colons.
    expect(namespaceNodeId("vault", "product:anthropic:claude-ai")).toBe(
      "vault:product:anthropic:claude-ai",
    );
  });

  it("rejects a sourceId containing the reserved ':' delimiter", () => {
    // Without this guard, ("a:b","c") and ("a","b:c") would both yield "a:b:c".
    expect(() => namespaceNodeId("a:b", "c")).toThrow(/reserved/);
  });
});
