import { describe, expect, it } from "vitest";
import { FIRST_LOOKBACK_MINUTES, LAG_SECONDS, nextWindow } from "../src/poller/pollProject.js";

const NOW = new Date("2026-10-27T12:30:37Z");
const END = new Date("2026-10-27T12:28:00Z"); // floor(NOW - 120s) to the minute

describe("nextWindow", () => {
  it("starts a first poll a fixed lookback before a minute-aligned end", () => {
    expect(LAG_SECONDS).toBe(120);
    expect(nextWindow(null, NOW)).toEqual({
      start: new Date(END.getTime() - FIRST_LOOKBACK_MINUTES * 60_000), end: END, truncated: false,
    });
  });

  it("continues exactly where the last assessed window ended", () => {
    const last = new Date("2026-10-27T12:25:00Z");
    expect(nextWindow(last, NOW)).toEqual({ start: last, end: END, truncated: false });
  });

  it("returns nothing when no new minute has closed", () => {
    expect(nextWindow(END, NOW)).toBeNull();
  });

  it("cuts a gap over 24 hours to the newest 24 and flags it", () => {
    const w = nextWindow(new Date("2026-10-20T00:00:00Z"), NOW)!;
    expect(w.truncated).toBe(true);
    expect(w.end.getTime() - w.start.getTime()).toBe(24 * 3600_000);
  });
});
