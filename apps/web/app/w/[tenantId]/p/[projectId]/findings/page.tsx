import { MAX_FINDINGS_PER_SCAN, projectScanResults } from "@supahound/core/db/scanDomains";
import Link from "next/link";
import { SeverityBadge, Shell } from "../../../../../../components/Shell";
import { mode } from "../../../../../../lib/billing";
import { loadProjectPage } from "../../../../../../lib/projectPage";
import { canLinkDomains, domainsPath, evidenceItems, findingCountsText, findingTitle, scanStateText } from "../../../../../../lib/scanDomains";

// The project's Security scan tab (issue #100, decisions 034 and 040): the latest finished scan of
// each verified domain attached to the project, findings most severe first, each with its fix.
// Evidence shows an allowlist of structured keys only (lib/scanDomains.ts); the endpoint is text,
// never a link. Starting a scan from the app is issue #51.

export default async function ProjectFindings({ params }: { params: Promise<{ tenantId: string; projectId: string }> }) {
  const d = await loadProjectPage(params, (tx, p) => projectScanResults(tx, p.id));
  const { tenant, project: p } = d;
  const results = d.extra;
  const settings = domainsPath(tenant, p.id);

  return (
    <Shell tenant={tenant} role={d.role} projects={d.projects} tiers={d.tiers} billingOn={mode() !== "off"} active={{ kind: "project", project: p, page: "findings" }}>
      <h1 className="mb-2 text-2xl font-semibold">Security scan</h1>
      <p className="mb-6 text-sm text-slate-600">
        What the security scan found on the domains attached to {p.name}: exposed keys in client code, public source maps and
        leak paths, each with the fix.
      </p>

      {results.length === 0 ? (
        <section aria-label="No domain linked" className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-700">
          <p className="mb-2 font-semibold text-slate-900">No domain is linked to {p.name}.</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>Verify your app&apos;s domain with the security scan (a DNS TXT record proves you control it).</li>
            <li>
              Open <Link href={settings} className="underline">Settings → General</Link> and attach the domain under Security scan
              domains.
            </li>
          </ol>
          <p className="mt-2 text-slate-500">
            {canLinkDomains(d.projectRole)
              ? "Workspace owners and admins see the workspace's verified domains there."
              : "Only the project's owners and admins can attach a domain."}
          </p>
        </section>
      ) : (
        <div className="space-y-8">
          {results.map((r) => {
            const findings = r.latest?.findings ?? [];
            return (
              <section key={r.id} aria-label={`Scan of ${r.apex}`} className="rounded-md border border-slate-200 bg-white p-4">
                <h2 className="font-mono text-lg font-semibold">{r.apex}</h2>
                <p className="mt-1 text-sm text-slate-600">
                  {scanStateText(r)}
                  {r.latest && ` ${findingCountsText(findings)}.`}
                </p>
                {r.latest && findings.length === 0 && <p className="mt-3 text-sm text-slate-600">No findings in the last finished scan.</p>}
                {findings.length > 0 && (
                  <ul aria-label={`Findings for ${r.apex}`} className="mt-4 space-y-3">
                    {findings.map((f) => {
                      const items = evidenceItems(f.evidence);
                      return (
                        <li key={f.id} className="rounded-md border border-slate-200 p-3">
                          <div className="flex flex-wrap items-center gap-3">
                            <SeverityBadge severity={f.severity} />
                            <span className="font-medium">{findingTitle(f)}</span>
                            {f.endpoint && <span className="break-all font-mono text-xs text-slate-600">{f.endpoint}</span>}
                          </div>
                          {items.length > 0 && (
                            <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                              {items.map((it) => (
                                <div key={it.label} className="flex gap-1">
                                  <dt>{it.label}:</dt>
                                  <dd className="font-mono">{it.value}</dd>
                                </div>
                              ))}
                            </dl>
                          )}
                          {f.fix && (
                            <p className="mt-2 text-sm text-slate-700">
                              <span className="font-medium">Fix: </span>
                              {f.fix}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {findings.length >= MAX_FINDINGS_PER_SCAN && (
                  <p className="mt-3 text-sm text-slate-500">Showing the {MAX_FINDINGS_PER_SCAN} most severe findings.</p>
                )}
              </section>
            );
          })}
        </div>
      )}
    </Shell>
  );
}
