import { describe, expect, it } from "vitest";

import { isSerializableValue, namespaceNodeId } from "./contract";

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
