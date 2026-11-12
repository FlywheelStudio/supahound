import { describe, expect, it } from "vitest";
import { deletedOn, keepNote, removalPreviewSentence, removalSentence } from "../lib/removal";

// The removal text (decision 042): Erik's rule, in the exact words every page shows.

const NOW = new Date("2026-11-12T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

describe("removal text", () => {
  const paid = { activeUntil: at(19), deleteAfter: at(26) };
  const ended = { activeUntil: at(-2), deleteAfter: at(5) };

  it("says the project stays active until the period end and is deleted 7 days later unless you keep it", () => {
    expect(removalSentence(paid, NOW)).toBe("The project stays active until 2026-12-01 and is deleted on 2026-12-08 unless you keep it.");
    expect(removalPreviewSentence(paid, NOW)).toBe("The project stays active until 2026-12-01 and is deleted on 2026-12-08 unless you keep it.");
  });

  it("says polling stopped once the period has ended", () => {
    expect(removalSentence(ended, NOW)).toBe("Supahound stopped watching this project on 2026-11-10. It is deleted on 2026-11-17 unless you keep it.");
    expect(deletedOn(ended)).toBe("Deleted on 2026-11-17");
  });

  it("says a removal with nothing paid stops now", () => {
    expect(removalPreviewSentence({ activeUntil: NOW, deleteAfter: at(7) }, NOW)).toBe("Supahound stops watching the project now. It is deleted on 2026-11-19 unless you keep it.");
  });

  it("says what keeping costs: nothing within the period, a new charge after it, nothing without per-project billing", () => {
    expect(keepNote(paid, NOW, true)).toMatch(/nothing extra is charged/);
    expect(keepNote(ended, NOW, true)).toMatch(/new subscription, charged today/);
    expect(keepNote(paid, NOW, false)).toBeNull();
  });
});
