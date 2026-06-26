import { describe, expect, it } from "vitest";

import { scopeLabel, formatActivityTarget } from "./McpAccessSection";

describe("scopeLabel", () => {
  it("renders human labels for each scope", () => {
    expect(scopeLabel("read")).toBe("Read");
    expect(scopeLabel("read_write")).toBe("Read + Write");
  });
});

describe("formatActivityTarget", () => {
  it("returns the target unchanged when short", () => {
    expect(formatActivityTarget("notes/todo.md")).toBe("notes/todo.md");
  });

  it("middle-truncates an overlong target so both ends stay readable", () => {
    const long = "projects/" + "x".repeat(80) + "/end.md";
    const out = formatActivityTarget(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).toContain("…");
    expect(out.startsWith("projects/")).toBe(true);
    expect(out.endsWith("/end.md")).toBe(true);
  });

  it("shows a dash for an empty target", () => {
    expect(formatActivityTarget("")).toBe("—");
  });
});
