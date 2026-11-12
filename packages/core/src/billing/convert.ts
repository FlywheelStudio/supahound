import type { Pool } from "pg";
import { getBilling, markConverted, saveProjectSubscription, saveSubscription, watchedProjects } from "../db/billing.js";
import { getClosure } from "../db/closure.js";
import { withTenant } from "../db/tenant.js";
import { tenantId as parseTenantId, type TenantId } from "../tenancy/scope.js";
import type { StripeGateway } from "./flow.js";
import { isExemptEmail } from "./policy.js";
import { isLive, planConversion, type ConversionPlan, type LegacySub, type ProjectSub } from "./projects.js";
import { projectSubFromStripe, type StripeSubscription } from "./stripeMap.js";

// The conversion of seat subscriptions to one subscription per project (decision 041). An operator
// runs it from the core CLI (`pnpm convert-subscriptions`). A dry run (the default) reads the
// database and Stripe and prints each workspace's plan; it sends no write to Stripe and writes
// nothing to the database. --apply carries the plans out.
//
// Per workspace, in this order, each step safe to repeat:
//   1. make the seat subscription's card the customer's default (every project subscription bills it);
//   2. create each project's subscription (idempotency key, metadata.project_id), and record it;
//   3. set the seat subscription to cancel at its period end (metadata.converted), and record it;
//   4. mark the workspace "project".
// A run that stops part-way is finished by running again: the plan is rebuilt from Stripe (project
// subscriptions found by metadata, the seat subscription's converted mark), not from keys that
// Stripe forgets after 24 hours.

export interface ConvertDeps {
  // Lists the workspaces with a billing row (supahound_scheduler reads billing_accounts.tenant_id).
  scheduler: Pool;
  // Reads and writes one workspace at a time through withTenant (supahound_app).
  app: Pool;
  stripe: StripeGateway;
  now: () => Date;
  exemptDomains: readonly string[];
  out: (line: string) => void;
}

export interface ConvertResult {
  plans: ConversionPlan[];
  converted: number;
  failed: number;
}

const day = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

function legacyFrom(s: StripeSubscription): LegacySub {
  return {
    subscriptionId: s.id, status: s.status, trialEnd: s.trialEnd, currentPeriodEnd: s.currentPeriodEnd,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd, converted: s.converted, defaultPaymentMethod: s.defaultPaymentMethod,
    hasDiscount: s.hasDiscount,
  };
}

// Builds one workspace's plan from the database and Stripe. Reads only.
export async function workspacePlan(
  deps: Pick<ConvertDeps, "app" | "stripe" | "now" | "exemptDomains">, tenant: TenantId, includeEmpty = false,
): Promise<ConversionPlan> {
  const db = await withTenant(deps.app, tenant, async (tx) => {
    const billing = await getBilling(tx);
    const owners = await tx.query<{ email: string | null }>(
      "SELECT email FROM supahound.memberships WHERE tenant_id = $1 AND role = 'owner'", [tenant],
    );
    const soleOwner = owners.length === 1 ? owners[0]!.email : null;
    return {
      billing, closed: (await getClosure(tx)) !== null, watched: await watchedProjects(tx),
      exemptEligible: !billing.exempt && isExemptEmail(soleOwner, deps.exemptDomains),
    };
  });
  const subs = db.billing.customerId ? await deps.stripe.customerSubscriptions(db.billing.customerId) : [];
  const mine = subs.filter((s) => s.tenant === tenant);
  // The seat subscription: the one the workspace row names, else any live one without a project.
  const seat = mine.find((s) => s.id === db.billing.subscriptionId && !s.projectId)
    ?? mine.find((s) => !s.projectId && isLive(s.status)) ?? null;
  const existing: ProjectSub[] = [];
  for (const s of mine) {
    const p = projectSubFromStripe(s);
    if (p) existing.push(p);
  }
  return planConversion({
    tenant, now: deps.now(), model: db.billing.model, exempt: db.billing.exempt, exemptEligible: db.exemptEligible,
    closed: db.closed, customerId: db.billing.customerId, legacy: seat ? legacyFrom(seat) : null, watched: db.watched, existing, includeEmpty,
  });
}

export function describePlan(plan: ConversionPlan, tierName: (t: "starter" | "pro") => string): string[] {
  if (plan.action === "skip") return [`workspace ${plan.tenant}: skip (${plan.reason})`];
  const l = plan.legacy;
  const lines = [`workspace ${plan.tenant}: convert seat subscription ${l.subscriptionId} (${l.status}, ${plan.mode === "trial" ? "trial ends" : "period ends"} ${day(plan.anchor)})`];
  if (plan.setPaymentMethod) lines.push(`  set the customer's default card to the seat subscription's card ${plan.setPaymentMethod}`);
  for (const c of plan.creates) {
    lines.push(`  create: project ${c.projectId} (${c.supabaseRef}) at ${tierName(c.tier)}, ` +
      (plan.mode === "trial" ? `trial until ${day(plan.anchor)}` : `billing_cycle_anchor ${day(plan.anchor)}, no proration`) +
      `; first charge ${day(plan.anchor)}`);
  }
  for (const k of plan.kept) lines.push(`  keep: project ${k.projectId} already has ${k.subscriptionId}`);
  if (plan.creates.length + plan.kept.length === 0) lines.push(`  no watched projects: nothing is charged after ${day(plan.anchor)}`);
  lines.push(plan.cancelLegacy
    ? `  cancel ${l.subscriptionId} at its period end ${day(plan.anchor)}: it charges nothing more`
    : `  ${l.subscriptionId} already cancels at its period end (an earlier run)`);
  return lines;
}

// Carries out one plan. Each step is recorded as soon as Stripe answers.
export async function applyPlan(deps: Pick<ConvertDeps, "app" | "stripe">, plan: Extract<ConversionPlan, { action: "convert" }>): Promise<void> {
  const tenant = parseTenantId(plan.tenant);
  const l = plan.legacy;
  if (plan.setPaymentMethod) await deps.stripe.setInvoicePaymentMethod(plan.customerId, plan.setPaymentMethod, `convert-pm-${l.subscriptionId}`);
  for (const c of plan.creates) {
    const sub = await deps.stripe.createProjectSubscription({
      tenant, projectId: c.projectId, supabaseRef: c.supabaseRef, customerId: plan.customerId, tier: c.tier,
      trialEnd: plan.mode === "trial" ? plan.anchor : null, anchor: plan.mode === "anchor" ? plan.anchor : null,
      idempotencyKey: c.idempotencyKey,
    });
    const row = projectSubFromStripe(sub);
    if (!row) throw new Error(`Stripe returned ${sub.id} without the project metadata or a known price`);
    await withTenant(deps.app, tenant, (tx) => saveProjectSubscription(tx, row, row.projectId));
  }
  // Subscriptions an interrupted run created: make sure the database has them.
  for (const k of plan.kept) {
    const row = projectSubFromStripe(await deps.stripe.getSubscription(k.subscriptionId));
    if (row) await withTenant(deps.app, tenant, (tx) => saveProjectSubscription(tx, row, row.projectId));
  }
  if (plan.cancelLegacy) {
    const seat = await deps.stripe.setCancelAtPeriodEnd(l.subscriptionId, true, { converted: true, idempotencyKey: `convert-cancel-${l.subscriptionId}` });
    await withTenant(deps.app, tenant, (tx) => saveSubscription(tx, seat, null));
  }
  await withTenant(deps.app, tenant, (tx) => markConverted(tx));
}

// Every workspace with a billing row, or just `only`. Returns the exit code's inputs.
export async function convertSubscriptions(
  deps: ConvertDeps, opts: { apply: boolean; only?: TenantId | undefined; includeEmpty?: boolean },
): Promise<ConvertResult> {
  const tenants = opts.only
    ? [opts.only]
    : (await deps.scheduler.query<{ tenant_id: string }>("SELECT tenant_id FROM supahound.billing_accounts ORDER BY tenant_id")).rows
        .map((r) => parseTenantId(r.tenant_id));
  const result: ConvertResult = { plans: [], converted: 0, failed: 0 };
  const tierName = (t: "starter" | "pro") => (t === "pro" ? "Pro" : "Starter");
  for (const tenant of tenants) {
    try {
      const plan = await workspacePlan(deps, tenant, opts.includeEmpty === true);
      result.plans.push(plan);
      for (const line of describePlan(plan, tierName)) deps.out(line);
      if (plan.action === "convert" && opts.apply) {
        await applyPlan(deps, plan);
        result.converted++;
        deps.out("  done");
      }
    } catch (err) {
      result.failed++;
      deps.out(`workspace ${tenant}: failed (${err instanceof Error ? err.message : "unknown error"}); run again to finish it`);
    }
  }
  const toConvert = result.plans.filter((p) => p.action === "convert").length;
  deps.out(opts.apply
    ? `Converted ${result.converted} of ${toConvert} workspaces; ${result.failed} failed; ${result.plans.length - toConvert} skipped.`
    : `Dry run: ${toConvert} workspaces would convert, ${result.plans.length - toConvert} skip. Nothing was changed. Add --apply to convert.`);
  return result;
}
