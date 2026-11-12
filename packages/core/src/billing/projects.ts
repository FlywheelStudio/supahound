// One Stripe subscription per watched project (decisions 032 and 041). Pure functions: no Stripe,
// no database. The flow (flow.ts) and the conversion CLI (convert.ts) carry out what these plan.

import type { BillingStatus, Tier } from "./policy.js";

// A project subscription as Supahound stores it (project_subscriptions) or reads it from Stripe.
export interface ProjectSub {
  subscriptionId: string;
  // Null once the project is removed: the row stays as payment history.
  projectId: string | null;
  supabaseRef: string;
  tier: Tier;
  status: BillingStatus;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

// A project that Supahound watches now (not paused), and so bills.
export interface WatchedProject {
  id: string;
  supabaseRef: string;
  tier: Tier;
}

const ENDED: readonly BillingStatus[] = ["canceled", "incomplete_expired"];

// Live: Stripe may still charge it, or it still runs to the end of a paid period.
export const isLive = (status: BillingStatus): boolean => status !== "none" && !ENDED.includes(status);

// Stripe needs a trial end in the future. A trial that ends within this margin is treated as over,
// so a project added in the last minute of the trial bills at once instead of failing.
export const TRIAL_MARGIN_MS = 60_000;

// Decision 032: one 7-day trial per workspace. A project added during it shares the workspace's
// trial end; a project added after it bills from the day it is added (no trial).
export function trialEndForNewProject(workspaceTrialEnd: Date | null, now: Date): Date | null {
  if (!workspaceTrialEnd) return null;
  return workspaceTrialEnd.getTime() - now.getTime() > TRIAL_MARGIN_MS ? workspaceTrialEnd : null;
}

// The end of the workspace's free trial while it runs, else null. Seat model: the subscription's
// trial. Per-project model: the workspace trial that the card check started (decision 032).
export function trialEndsAt(b: { model: "workspace" | "project"; status: BillingStatus; trialEnd: Date | null }, now: Date): Date | null {
  if (b.model === "project") return b.trialEnd && b.trialEnd > now ? b.trialEnd : null;
  return b.status === "trialing" ? b.trialEnd : null;
}

// The subscription that speaks for a watched project: its live one, else its most recent one.
// `subs` are in creation order.
export function currentSubFor(projectId: string, subs: readonly ProjectSub[]): ProjectSub | null {
  const mine = subs.filter((s) => s.projectId === projectId);
  return mine.find((s) => isLive(s.status)) ?? mine.at(-1) ?? null;
}

// Worst first. A blocked status of any watched project blocks the workspace: every project bills
// to the same card, so one project's failed charge means the card fails for all of them.
const RANK: Record<BillingStatus, number> = {
  unpaid: 6, canceled: 6, incomplete_expired: 6, paused: 6,
  past_due: 4, incomplete: 3, active: 2, trialing: 1, none: 0,
};

// The workspace's standing (billing_accounts.status in the per-project model): the worst status
// among the watched projects' current subscriptions; "none" when no watched project has one.
// Subscriptions of removed or paused projects do not count: they only run out their period.
export function workspaceStanding(watched: readonly Pick<WatchedProject, "id">[], subs: readonly ProjectSub[]): BillingStatus {
  let worst: BillingStatus = "none";
  for (const p of watched) {
    const s = currentSubFor(p.id, subs);
    if (s && RANK[s.status] > RANK[worst]) worst = s.status;
  }
  return worst;
}

export type ReconcileAction =
  | { kind: "create"; projectId: string; supabaseRef: string; tier: Tier; trialEnd: Date | null; attempt: number }
  // A removed project added again (new project ID, same Supabase ref) takes back its subscription,
  // which still runs to the end of its period: no second charge for the same project.
  | { kind: "relink"; subscriptionId: string; projectId: string }
  | { kind: "resume"; subscriptionId: string }
  | { kind: "cancel"; subscriptionId: string }
  | { kind: "tier"; subscriptionId: string; tier: Tier };

export interface ReconcileInput {
  now: Date;
  workspaceTrialEnd: Date | null;
  watched: readonly WatchedProject[];
  // Every project subscription of the workspace, in creation order.
  subs: readonly ProjectSub[];
}

// What makes Stripe match the watched projects. Running it again after it is carried out gives
// an empty plan. Every watched project has one live subscription at its tier that does not cancel;
// every other live subscription cancels at the end of its period (no refund, nothing more charged).
// A tier change applies at the next renewal (no proration, decision 028).
export function planReconcile(input: ReconcileInput): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  const claimed = new Set<string>();
  for (const p of input.watched) {
    let sub = input.subs.find((s) => s.projectId === p.id && isLive(s.status)) ?? null;
    if (!sub) {
      sub = [...input.subs].reverse().find((s) => s.projectId === null && s.supabaseRef === p.supabaseRef && isLive(s.status) && !claimed.has(s.subscriptionId)) ?? null;
      if (sub) actions.push({ kind: "relink", subscriptionId: sub.subscriptionId, projectId: p.id });
    }
    if (!sub) {
      const attempt = input.subs.filter((s) => s.projectId === p.id).length;
      actions.push({
        kind: "create", projectId: p.id, supabaseRef: p.supabaseRef, tier: p.tier,
        trialEnd: trialEndForNewProject(input.workspaceTrialEnd, input.now), attempt,
      });
      continue;
    }
    claimed.add(sub.subscriptionId);
    if (sub.cancelAtPeriodEnd) actions.push({ kind: "resume", subscriptionId: sub.subscriptionId });
    if (sub.tier !== p.tier) actions.push({ kind: "tier", subscriptionId: sub.subscriptionId, tier: p.tier });
  }
  for (const s of input.subs) {
    if (!claimed.has(s.subscriptionId) && isLive(s.status) && !s.cancelAtPeriodEnd) {
      actions.push({ kind: "cancel", subscriptionId: s.subscriptionId });
    }
  }
  return actions;
}

// --- Removal with a grace period (decision 042) -------------------------------------------------

// A removed project is deleted this many days after its active period ends (Erik, 2026-11-12).
// The migration's CHECK holds the same number.
export const REMOVAL_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

// When a removed project stops: the end of the period its subscription has paid (or trials) for,
// never before `now`. No subscription, an ended or blocked one, an exempt or seat workspace, or
// billing off: the removal time (the caller passes sub = null).
export function removalActiveUntil(sub: Pick<ProjectSub, "status" | "trialEnd" | "currentPeriodEnd"> | null, now: Date): Date {
  if (!sub) return now;
  let end: Date | null = null;
  if (sub.status === "trialing") end = sub.trialEnd ?? sub.currentPeriodEnd;
  else if (sub.status === "active" || sub.status === "past_due") end = sub.currentPeriodEnd;
  return end && end > now ? end : now;
}

export interface RemovalDates {
  activeUntil: Date;
  deleteAfter: Date;
}

export function removalDates(sub: Pick<ProjectSub, "status" | "trialEnd" | "currentPeriodEnd"> | null, now: Date): RemovalDates {
  const activeUntil = removalActiveUntil(sub, now);
  return { activeUntil, deleteAfter: new Date(activeUntil.getTime() + REMOVAL_GRACE_DAYS * DAY_MS) };
}

// The Stripe idempotency key for a project's subscription. `attempt` counts the project's earlier
// subscriptions, so a retry reuses the key and a new subscription after an ended one gets a new key.
export const createKey = (tenant: string, projectId: string, attempt: number) => `project-sub-${tenant}-${projectId}-${attempt}`;

// --- Conversion of seat subscriptions (decision 041) -----------------------------------------------

// The seat subscription, read live from Stripe (never from the database).
export interface LegacySub {
  subscriptionId: string;
  status: BillingStatus;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  // metadata.converted, set by the CLI when it sets the cancel. A re-run then finishes the job
  // instead of skipping a workspace whose seat subscription already cancels.
  converted: boolean;
  defaultPaymentMethod: string | null;
  // A coupon on the seat subscription. The new subscriptions would not get it.
  hasDiscount: boolean;
}

export interface ConversionInput {
  tenant: string;
  now: Date;
  model: "workspace" | "project";
  exempt: boolean;
  // The sole owner's recorded email is on the exempt list, but the exemption is not granted yet
  // (the owner has not opened Billing since). Converting would bill a staff workspace.
  exemptEligible: boolean;
  closed: boolean;
  customerId: string | null;
  legacy: LegacySub | null;
  watched: readonly WatchedProject[];
  // The customer's project subscriptions in Stripe (metadata.project_id), live or not.
  existing: readonly ProjectSub[];
  // --include-empty: also convert a workspace with no watched project. Converting it ends the
  // seat subscription's minimum charge (decision 041 point 4), so it waits for Erik's answer.
  includeEmpty?: boolean;
}

// No subscription starts within this long of the seat subscription's end: the CLI could still be
// running when the old period ends. Run it again after the renewal.
export const CONVERSION_MIN_LEAD_MS = 60 * 60_000;

export type ConversionPlan =
  | { tenant: string; action: "skip"; reason: string }
  | {
      tenant: string;
      action: "convert";
      customerId: string;
      legacy: LegacySub;
      // When every new subscription first charges: the seat subscription's trial end or period end.
      anchor: Date;
      // "trial": the seat subscription is trialing, so the new ones trial until the same moment.
      // "anchor": it is paid, so the new ones start now with billing_cycle_anchor = its period end
      // and no proration: the time already paid for costs nothing, and the first charge is at the
      // anchor. Either way nothing is charged twice and no day goes unbilled.
      mode: "trial" | "anchor";
      creates: { projectId: string; supabaseRef: string; tier: Tier; idempotencyKey: string }[];
      // Watched projects that already have a live subscription (an earlier, interrupted run).
      kept: { projectId: string; subscriptionId: string }[];
      setPaymentMethod: string | null;
      cancelLegacy: boolean;
    };

// The plan for one workspace. The CLI prints it in a dry run and carries it out with --apply.
export function planConversion(i: ConversionInput): ConversionPlan {
  const skip = (reason: string): ConversionPlan => ({ tenant: i.tenant, action: "skip", reason });
  if (i.exempt) return skip("staff exemption (decision 029): no subscriptions");
  if (i.exemptEligible) return skip("sole owner is on a staff domain but the exemption is not granted yet: have the owner open Billing, then run again");
  if (i.closed) return skip("workspace is closing or closed (decision 037)");
  if (!i.customerId) return skip("no Stripe customer");
  const legacy = i.legacy;
  if (!legacy || !isLive(legacy.status)) return skip(i.model === "project" ? "already converted" : "no live seat subscription");
  if (legacy.cancelAtPeriodEnd && !legacy.converted) return skip("the seat subscription already cancels at its period end");
  if (i.model === "project" && legacy.cancelAtPeriodEnd) return skip("already converted");
  if (legacy.status !== "trialing" && legacy.status !== "active") return skip(`seat subscription is ${legacy.status}: run again after it resolves`);
  if (legacy.hasDiscount) return skip("seat subscription has a discount the new subscriptions would not get: move it by hand");
  if (!legacy.defaultPaymentMethod) return skip("seat subscription has no default card: the new subscriptions could not charge");
  if (i.watched.length === 0 && !i.includeEmpty) return skip("no watched projects: converting ends its minimum charge; pass --include-empty to convert it");
  const mode = legacy.status === "trialing" ? "trial" : "anchor";
  const anchor = mode === "trial" ? legacy.trialEnd : legacy.currentPeriodEnd;
  if (!anchor) return skip(`seat subscription has no ${mode === "trial" ? "trial end" : "period end"}`);
  if (anchor.getTime() - i.now.getTime() < CONVERSION_MIN_LEAD_MS) return skip("seat subscription renews within an hour: run again after the renewal");

  const creates: Extract<ConversionPlan, { action: "convert" }>["creates"] = [];
  const kept: Extract<ConversionPlan, { action: "convert" }>["kept"] = [];
  for (const p of i.watched) {
    const live = i.existing.find((s) => s.projectId === p.id && isLive(s.status));
    if (live) kept.push({ projectId: p.id, subscriptionId: live.subscriptionId });
    else creates.push({ projectId: p.id, supabaseRef: p.supabaseRef, tier: p.tier, idempotencyKey: `convert-${legacy.subscriptionId}-${p.id}` });
  }
  return {
    tenant: i.tenant, action: "convert", customerId: i.customerId, legacy, anchor, mode, creates, kept,
    setPaymentMethod: legacy.defaultPaymentMethod, cancelLegacy: !legacy.cancelAtPeriodEnd,
  };
}
