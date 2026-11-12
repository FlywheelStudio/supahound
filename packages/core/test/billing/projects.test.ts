import { describe, expect, it } from "vitest";
import type { BillingStatus } from "../../src/billing/policy.js";
import {
  CONVERSION_MIN_LEAD_MS, createKey, currentSubFor, planConversion, planReconcile, removalActiveUntil, removalDates, REMOVAL_GRACE_DAYS, trialEndForNewProject, trialEndsAt, workspaceStanding,
  type ConversionInput, type LegacySub, type ProjectSub,
} from "../../src/billing/projects.js";

// One subscription per project (decisions 032 and 041): the pure rules.

const NOW = new Date("2026-11-12T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const REF = (c: string) => c.repeat(20);

const sub = (over: Partial<ProjectSub> & Pick<ProjectSub, "subscriptionId">): ProjectSub => ({
  projectId: null, supabaseRef: REF("a"), tier: "starter", status: "active", trialEnd: null, currentPeriodEnd: at(20), cancelAtPeriodEnd: false, ...over,
});

describe("the trial of a new project (decision 032)", () => {
  it("shares the workspace trial while it runs, and bills from the day it is added after it", () => {
    expect(trialEndForNewProject(at(3), NOW)).toEqual(at(3));
    expect(trialEndForNewProject(at(-1), NOW)).toBeNull();
    expect(trialEndForNewProject(null, NOW)).toBeNull();
    // Inside the last minute: Stripe needs a future trial end, so the project bills now.
    expect(trialEndForNewProject(new Date(NOW.getTime() + 30_000), NOW)).toBeNull();
    expect(trialEndForNewProject(new Date(NOW.getTime() + 61_000), NOW)).toEqual(new Date(NOW.getTime() + 61_000));
  });

  it("shows the trial end from the subscription (seat model) or the workspace (per-project model)", () => {
    expect(trialEndsAt({ model: "project", status: "none", trialEnd: at(2) }, NOW)).toEqual(at(2));
    expect(trialEndsAt({ model: "project", status: "active", trialEnd: at(-2) }, NOW)).toBeNull();
    expect(trialEndsAt({ model: "workspace", status: "trialing", trialEnd: at(2) }, NOW)).toEqual(at(2));
    expect(trialEndsAt({ model: "workspace", status: "active", trialEnd: at(2) }, NOW)).toBeNull();
  });
});

describe("the workspace standing (decision 041)", () => {
  const watched = [{ id: "p1" }, { id: "p2" }];

  it("is none with no billed project, and the worst status of the watched projects otherwise", () => {
    expect(workspaceStanding(watched, [])).toBe("none");
    expect(workspaceStanding(watched, [sub({ subscriptionId: "sub_1", projectId: "p1", status: "trialing" })])).toBe("trialing");
    const two = (a: BillingStatus, b: BillingStatus) => workspaceStanding(watched, [
      sub({ subscriptionId: "sub_1", projectId: "p1", status: a }), sub({ subscriptionId: "sub_2", projectId: "p2", status: b }),
    ]);
    expect(two("active", "trialing")).toBe("active");
    expect(two("active", "past_due")).toBe("past_due");
    expect(two("past_due", "incomplete")).toBe("past_due");
    expect(two("active", "unpaid")).toBe("unpaid");
    expect(two("canceled", "active")).toBe("canceled");
  });

  it("ignores removed and paused projects, and a project's ended subscription once a live one replaced it", () => {
    const subs = [
      sub({ subscriptionId: "sub_old", projectId: "p1", status: "canceled" }),
      sub({ subscriptionId: "sub_new", projectId: "p1", status: "active" }),
      sub({ subscriptionId: "sub_gone", projectId: null, status: "unpaid" }),
      sub({ subscriptionId: "sub_paused", projectId: "p3", status: "canceled" }),
    ];
    expect(workspaceStanding([{ id: "p1" }], subs)).toBe("active");
    expect(currentSubFor("p1", subs)!.subscriptionId).toBe("sub_new");
    expect(currentSubFor("p9", subs)).toBeNull();
  });
});

describe("reconcile: Stripe follows the watched projects (decision 041)", () => {
  const p = (id: string, ref: string, tier: "starter" | "pro" = "starter") => ({ id, supabaseRef: ref, tier });

  it("creates one subscription per new project, with the workspace trial, and keys each create", () => {
    const plan = planReconcile({ now: NOW, workspaceTrialEnd: at(5), watched: [p("p1", REF("a")), p("p2", REF("b"), "pro")], subs: [] });
    expect(plan).toEqual([
      { kind: "create", projectId: "p1", supabaseRef: REF("a"), tier: "starter", trialEnd: at(5), attempt: 0 },
      { kind: "create", projectId: "p2", supabaseRef: REF("b"), tier: "pro", trialEnd: at(5), attempt: 0 },
    ]);
    expect(createKey("t1", "p1", 0)).toBe("project-sub-t1-p1-0");
  });

  it("bills a project added after the trial from today, with a new key after an ended subscription", () => {
    const plan = planReconcile({
      now: NOW, workspaceTrialEnd: at(-3), watched: [p("p1", REF("a"))],
      subs: [sub({ subscriptionId: "sub_1", projectId: "p1", status: "canceled" })],
    });
    expect(plan).toEqual([{ kind: "create", projectId: "p1", supabaseRef: REF("a"), tier: "starter", trialEnd: null, attempt: 1 }]);
  });

  it("cancels a removed or paused project's subscription at the period end, once", () => {
    const subs = [sub({ subscriptionId: "sub_removed", projectId: null }), sub({ subscriptionId: "sub_paused", projectId: "p9" })];
    expect(planReconcile({ now: NOW, workspaceTrialEnd: null, watched: [], subs })).toEqual([
      { kind: "cancel", subscriptionId: "sub_removed" }, { kind: "cancel", subscriptionId: "sub_paused" },
    ]);
    const done = subs.map((s) => ({ ...s, cancelAtPeriodEnd: true }));
    expect(planReconcile({ now: NOW, workspaceTrialEnd: null, watched: [], subs: done })).toEqual([]);
  });

  it("gives a re-added project (new ID, same ref) its running subscription back instead of a second one", () => {
    const subs = [sub({ subscriptionId: "sub_1", projectId: null, supabaseRef: REF("a"), cancelAtPeriodEnd: true })];
    expect(planReconcile({ now: NOW, workspaceTrialEnd: null, watched: [p("p2", REF("a"))], subs })).toEqual([
      { kind: "relink", subscriptionId: "sub_1", projectId: "p2" }, { kind: "resume", subscriptionId: "sub_1" },
    ]);
    // An ended one is not taken back: the project gets a new subscription.
    const ended = [{ ...subs[0]!, status: "canceled" as const }];
    expect(planReconcile({ now: NOW, workspaceTrialEnd: null, watched: [p("p2", REF("a"))], subs: ended })[0]!.kind).toBe("create");
  });

  it("resumes a paused project that comes back, and changes a tier without touching anything else", () => {
    const subs = [sub({ subscriptionId: "sub_1", projectId: "p1", cancelAtPeriodEnd: true, tier: "starter" })];
    expect(planReconcile({ now: NOW, workspaceTrialEnd: null, watched: [p("p1", REF("a"), "pro")], subs })).toEqual([
      { kind: "resume", subscriptionId: "sub_1" }, { kind: "tier", subscriptionId: "sub_1", tier: "pro" },
    ]);
  });

  it("returns an empty plan once Stripe matches", () => {
    const subs = [sub({ subscriptionId: "sub_1", projectId: "p1" }), sub({ subscriptionId: "sub_x", projectId: null, cancelAtPeriodEnd: true })];
    expect(planReconcile({ now: NOW, workspaceTrialEnd: null, watched: [p("p1", REF("a"))], subs })).toEqual([]);
  });
});

describe("the conversion planner (decision 041)", () => {
  const legacy = (over: Partial<LegacySub> = {}): LegacySub => ({
    subscriptionId: "sub_seat", status: "active", trialEnd: null, currentPeriodEnd: at(10), cancelAtPeriodEnd: false,
    converted: false, defaultPaymentMethod: "pm_card", hasDiscount: false, ...over,
  });
  const input = (over: Partial<ConversionInput> = {}): ConversionInput => ({
    tenant: "t1", now: NOW, model: "workspace", exempt: false, exemptEligible: false, closed: false, customerId: "cus_1",
    legacy: legacy(), watched: [{ id: "p1", supabaseRef: REF("a"), tier: "starter" }, { id: "p2", supabaseRef: REF("b"), tier: "pro" }],
    existing: [], ...over,
  });

  it("anchors a paid seat subscription's projects at its period end: nothing charged twice, no day skipped", () => {
    const plan = planConversion(input());
    expect(plan).toMatchObject({
      action: "convert", mode: "anchor", anchor: at(10), cancelLegacy: true, setPaymentMethod: "pm_card", kept: [],
      creates: [
        { projectId: "p1", tier: "starter", idempotencyKey: "convert-sub_seat-p1" },
        { projectId: "p2", tier: "pro", idempotencyKey: "convert-sub_seat-p2" },
      ],
    });
    // The seat subscription stops exactly where every new one first charges.
    if (plan.action !== "convert") throw new Error("expected a conversion");
    expect(plan.anchor).toEqual(plan.legacy.currentPeriodEnd);
  });

  it("gives a trialing seat subscription's projects the same trial end", () => {
    const plan = planConversion(input({ legacy: legacy({ status: "trialing", trialEnd: at(6), currentPeriodEnd: at(6) }) }));
    expect(plan).toMatchObject({ action: "convert", mode: "trial", anchor: at(6) });
  });

  it.each([
    ["an exempt workspace", { exempt: true }, /staff exemption/],
    ["a staff workspace whose exemption is not granted yet", { exemptEligible: true }, /exemption is not granted/],
    ["a closing workspace", { closed: true }, /closing or closed/],
    ["a workspace with no customer", { customerId: null }, /no Stripe customer/],
    ["a workspace with no seat subscription", { legacy: null }, /no live seat subscription/],
    ["an ended seat subscription", { legacy: legacy({ status: "canceled" }) }, /no live seat subscription/],
    ["a seat subscription the owner already canceled", { legacy: legacy({ cancelAtPeriodEnd: true }) }, /already cancels/],
    ["a failed payment", { legacy: legacy({ status: "past_due" }) }, /past_due: run again/],
    ["a renewal within the hour", { legacy: legacy({ currentPeriodEnd: new Date(NOW.getTime() + CONVERSION_MIN_LEAD_MS - 1) }) }, /within an hour/],
    ["a converted workspace", { model: "project" as const, legacy: legacy({ cancelAtPeriodEnd: true, converted: true }) }, /already converted/],
    ["a seat subscription with a coupon (it would not carry over)", { legacy: legacy({ hasDiscount: true }) }, /has a discount/],
    ["a seat subscription with no card", { legacy: legacy({ defaultPaymentMethod: null }) }, /no default card/],
    ["a workspace with no watched project, unless asked", { watched: [] }, /--include-empty/],
  ])("skips %s", (_name, over, reason) => {
    const plan = planConversion(input(over));
    expect(plan.action).toBe("skip");
    expect(plan.action === "skip" && plan.reason).toMatch(reason);
  });

  it("finishes an interrupted run: keeps what exists, creates the rest, and does not cancel twice", () => {
    const existing = [sub({ subscriptionId: "sub_p1", projectId: "p1" })];
    const plan = planConversion(input({ existing, legacy: legacy({ cancelAtPeriodEnd: true, converted: true }) }));
    expect(plan).toMatchObject({
      action: "convert", cancelLegacy: false, kept: [{ projectId: "p1", subscriptionId: "sub_p1" }],
      creates: [{ projectId: "p2", idempotencyKey: "convert-sub_seat-p2" }],
    });
  });

  it("plans the same keys on every run, so a repeat within Stripe's 24 hours creates nothing new", () => {
    expect(planConversion(input())).toEqual(planConversion(input()));
  });

  it("with --include-empty, cancels the seat subscription of a workspace with no watched projects: nothing is charged after it", () => {
    expect(planConversion(input({ watched: [], includeEmpty: true }))).toMatchObject({ action: "convert", creates: [], kept: [], cancelLegacy: true });
  });
});

describe("removal dates (decision 042)", () => {
  it("keeps a paid project active until its period end, and deletes it 7 days later", () => {
    expect(REMOVAL_GRACE_DAYS).toBe(7);
    expect(removalDates(sub({ subscriptionId: "sub_1", currentPeriodEnd: at(20) }), NOW)).toEqual({ activeUntil: at(20), deleteAfter: at(27) });
    expect(removalActiveUntil(sub({ subscriptionId: "sub_1", status: "past_due", currentPeriodEnd: at(3) }), NOW)).toEqual(at(3));
  });

  it("uses the trial end during the trial", () => {
    expect(removalActiveUntil(sub({ subscriptionId: "sub_1", status: "trialing", trialEnd: at(4), currentPeriodEnd: at(9) }), NOW)).toEqual(at(4));
    expect(removalActiveUntil(sub({ subscriptionId: "sub_1", status: "trialing", trialEnd: null, currentPeriodEnd: at(9) }), NOW)).toEqual(at(9));
  });

  it("stops at once with no subscription, an ended or blocked one, or a period end in the past", () => {
    expect(removalDates(null, NOW)).toEqual({ activeUntil: NOW, deleteAfter: at(7) });
    for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"] as BillingStatus[]) {
      expect(removalActiveUntil(sub({ subscriptionId: "sub_1", status, currentPeriodEnd: at(20) }), NOW), status).toEqual(NOW);
    }
    expect(removalActiveUntil(sub({ subscriptionId: "sub_1", currentPeriodEnd: at(-1) }), NOW)).toEqual(NOW);
    expect(removalActiveUntil(sub({ subscriptionId: "sub_1", currentPeriodEnd: null }), NOW)).toEqual(NOW);
  });
});
