import { describe, expect, it } from "vitest";

import { scopeLabel, formatActivityTarget, formatTimestamp } from "./McpAccessSection";

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

describe("formatTimestamp", () => {
  it("renders a parseable ISO timestamp as a locale string (not the raw ISO)", () => {
    const out = formatTimestamp("2026-06-26T10:00:00Z");
    // Locale + timezone vary by environment, so assert on stable invariants:
    // the year is present and the raw ISO punctuation is gone.
    expect(out).toContain("2026");
    expect(out).not.toContain("T10:00");
    expect(out).not.toContain("Z");
  });

  it("falls back to the raw string for an unparseable value", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });

  it("falls back to the raw (empty) string rather than 'Invalid Date'", () => {
    expect(formatTimestamp("")).toBe("");
  });
});
