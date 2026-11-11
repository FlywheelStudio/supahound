import { describe, expect, it } from "vitest";
import {
  actorAlias, alertDue, cleanText, meetsThreshold, proseHtml, renderIncidentEmail, stripLinks, truncate,
  type AlertEmailInput,
} from "../src/alerts/email.js";
import { ALICE } from "./helpers.js";

const base: AlertEmailInput = {
  projectName: "Acme production",
  incident: {
    actor: ALICE,
    severity: "critical",
    detectors: ["cross_tenant"],
    signals: ["other_owner", "manual_tool"],
    findingCount: 3,
    hits: 1234,
    openedAt: new Date("2026-11-11T10:00:00Z"),
    lastSeenAt: new Date("2026-11-11T10:07:00Z"),
  },
  previousSeverity: null,
  explanation: {
    summary: "A signed-in user requested rows owned by 4 other user(s) in `notes`.",
    likelyImpact: "Row-level security returned up to 50 rows, so other users' data may be exposed.",
    nextSteps: [
      "Check the RLS policy on `notes` compares `user_id` to `auth.uid()`.",
      "Review this user's other requests in the incident timeline.",
    ],
  },
  dashboardUrl: "https://app.supahound.test/w/t1",
  settingsUrl: "https://app.supahound.test/w/t1/projects",
};

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe("alert thresholds", () => {
  it("emails at or above the project level, never when off", () => {
    expect(meetsThreshold("low", "low")).toBe(true);
    expect(meetsThreshold("medium", "high")).toBe(false);
    expect(meetsThreshold("critical", "high")).toBe(true);
    expect(meetsThreshold("critical", "off")).toBe(false);
  });

  it("emails once per severity, again only on a rise", () => {
    expect(alertDue("high", null, "low")).toBe(true);
    expect(alertDue("high", "high", "low")).toBe(false);
    expect(alertDue("critical", "high", "low")).toBe(true);
    expect(alertDue("medium", "high", "low")).toBe(false);
    // Below the threshold: no email even if never sent.
    expect(alertDue("medium", null, "high")).toBe(false);
  });
});

describe("renderIncidentEmail", () => {
  const email = renderIncidentEmail(base);

  it("leads with the severity in the subject and body", () => {
    expect(email.subject).toBe("[Critical] Cross-tenant data access on Acme production");
    expect(email.html).toContain("Critical severity");
    expect(email.text.startsWith("CRITICAL SEVERITY: Cross-tenant data access")).toBe(true);
  });

  it("shows incident information", () => {
    for (const s of ["Acme production", "1,234", "2026-11-11 10:00 UTC", "2026-11-11 10:07 UTC", "Filtered on another user&#39;s ID"]) {
      expect(email.html).toContain(s);
    }
    expect(email.text).toContain("Requests: 1,234");
    expect(email.text).toContain("Findings: 3");
  });

  it("includes the suggested remediation as a numbered list", () => {
    expect(email.html).toContain("Suggested remediation");
    expect(email.html).toMatch(/<ol[^>]*>.*<code[^>]*>notes<\/code>.*<\/ol>/s);
    expect(email.text).toContain("SUGGESTED REMEDIATION\n1. Check the RLS policy on `notes`");
  });

  it("omits the remediation section when there is none", () => {
    const none = renderIncidentEmail({ ...base, explanation: { ...base.explanation!, nextSteps: [] } });
    expect(none.html).not.toContain("Suggested remediation");
    expect(none.text).not.toContain("SUGGESTED REMEDIATION");
    const noExplanation = renderIncidentEmail({ ...base, explanation: null });
    expect(noExplanation.html).not.toContain("Suggested remediation");
    expect(noExplanation.html).toContain("1,234 requests in 3 findings");
  });

  it("never shows the raw actor ID", () => {
    expect(email.html).not.toContain(ALICE);
    expect(email.text).not.toContain(ALICE);
    expect(email.text).toContain(`Actor: ${actorAlias(ALICE)}`);
    expect(actorAlias("service_role:abc")).toBe("The service-role key");
  });

  it("says when an incident escalated", () => {
    const up = renderIncidentEmail({ ...base, previousSeverity: "high" });
    expect(up.subject).toBe("[Critical] Cross-tenant data access escalated on Acme production");
    expect(up.text).toContain("Severity rose from High to Critical.");
  });

  it("links only to Supahound's own pages", () => {
    expect(hrefs(email.html)).toEqual([base.dashboardUrl, base.settingsUrl]);
  });

  it("is a complete, table-based HTML document with a plain-text part", () => {
    expect(email.html.startsWith("<!doctype html>")).toBe(true);
    expect(email.html).toContain('role="presentation"');
    expect(email.html).not.toMatch(/<(script|style|link|img|iframe)\b/i);
    expect(email.text).not.toMatch(/<[a-z]/i);
  });
});

describe("untrusted text", () => {
  const hostile: AlertEmailInput = {
    ...base,
    projectName: 'Evil <img src=x onerror=alert(1)>\r\nBcc: victim@example.com',
    incident: { ...base.incident, detectors: ["<b>x</b>"], signals: ["<script>"] },
    explanation: {
      summary: 'Click https://evil.test/login or www.evil.test now <a href="javascript:x">here</a>',
      likelyImpact: "See evil.io/path for details",
      nextSteps: ["x".repeat(500), "Visit http://phish.test"],
    },
  };
  const email = renderIncidentEmail(hostile);

  it("escapes HTML everywhere", () => {
    expect(email.html).not.toMatch(/<img|<script|<b>|<a href="javascript/i);
    expect(email.html).toContain("&lt;img");
  });

  it("keeps the subject on one line", () => {
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  it("strips links from model text", () => {
    const ownLinksRemoved = email.html.replaceAll(base.dashboardUrl, "").replaceAll(base.settingsUrl, "");
    for (const s of ["https://", "evil.test", "evil.io", "phish.test", "javascript:"]) {
      expect(ownLinksRemoved).not.toContain(s);
      expect(email.text.replaceAll(base.dashboardUrl, "").replaceAll(base.settingsUrl, "")).not.toContain(s);
    }
    expect(hrefs(email.html)).toEqual([base.dashboardUrl, base.settingsUrl]);
  });

  it("truncates long text", () => {
    expect(email.text).not.toContain("x".repeat(200));
    expect(email.text).toContain(`${"x".repeat(199)}…`.slice(-20));
  });

  // Each helper on its own, so a broken step fails its own test.
  it("strips, truncates, escapes and formats code in that order", () => {
    expect(stripLinks("go to https://a.test/x now")).toBe("go to now");
    expect(stripLinks("plain `notes` text")).toBe("plain `notes` text");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(cleanText("a\nb\tc", 10)).toBe("a b c");
    expect(proseHtml("use `a<b>`", 50)).toBe(
      'use <code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:#f1f5f9;padding:1px 4px;border-radius:4px">a&lt;b&gt;</code>',
    );
  });
});
