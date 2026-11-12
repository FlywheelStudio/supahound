// How the pages describe a project removal with a grace period (decision 042). Pure, so every
// branch is unit-tested. Dates are UTC days, as on the other billing pages.

export interface RemovalWindow {
  activeUntil: Date;
  deleteAfter: Date;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

// The sentence every page shows for a scheduled removal (Erik, 2026-11-12): the project stays
// active through the billing period and is deleted 7 days later unless someone keeps it.
export function removalSentence(r: RemovalWindow, now: Date): string {
  if (r.activeUntil > now) {
    return `The project stays active until ${day(r.activeUntil)} and is deleted on ${day(r.deleteAfter)} unless you keep it.`;
  }
  return `Supahound stopped watching this project on ${day(r.activeUntil)}. It is deleted on ${day(r.deleteAfter)} unless you keep it.`;
}

// The same, before the user confirms: what will happen if they remove it now.
export function removalPreviewSentence(r: RemovalWindow, now: Date): string {
  if (r.activeUntil > now) {
    return `The project stays active until ${day(r.activeUntil)} and is deleted on ${day(r.deleteAfter)} unless you keep it.`;
  }
  return `Supahound stops watching the project now. It is deleted on ${day(r.deleteAfter)} unless you keep it.`;
}

// What "Keep project" costs. Within the paid period the same subscription continues. After it, a
// per-project workspace that pays (not exempt) gets a new subscription, charged at once.
export function keepNote(r: RemovalWindow, now: Date, billedPerProject: boolean): string | null {
  if (!billedPerProject) return null;
  return r.activeUntil > now
    ? "Keeping it continues its subscription: nothing extra is charged."
    : "Keeping it starts a new subscription, charged today. Watching resumes once the payment goes through.";
}

export const deletedOn = (r: RemovalWindow) => `Deleted on ${day(r.deleteAfter)}`;
