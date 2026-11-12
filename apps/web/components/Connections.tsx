import type { ConnectionStatus } from "@supahound/core/db/repo";
import type { TenantId } from "@supahound/core/tenancy/scope";
import Link from "next/link";
import { startConnect } from "../app/w/[tenantId]/actions";
import { disconnectAction } from "../app/w/[tenantId]/settings/actions";
import { backPath, connectionState, ymd, type Back } from "../lib/dataControls";

// The workspace's Supabase connections (decision 037): Disconnect for owners and admins, the state
// of a disconnected one, and Reconnect. Shown on the workspace settings page and on the closed
// page. The confirmation states exactly what happens and asks for the connection's name.

export function Connections({
  tenant, connections, canDisconnect, confirming, back, paying, canReconnect,
}: {
  tenant: TenantId;
  connections: ConnectionStatus[];
  canDisconnect: boolean;
  confirming: string | undefined;
  back: Back;
  paying: boolean;
  // Reconnect needs the paid gate (startConnect), so the closed page does not offer it.
  canReconnect: boolean;
}) {
  const target = canDisconnect ? connections.find((c) => c.id === confirming && !c.disconnectedAt) : undefined;
  const anyDisconnected = connections.some((c) => c.disconnectedAt);
  return (
    <section aria-labelledby="connections-heading" className="mb-10">
      <h2 id="connections-heading" className="mb-3 font-semibold">Supabase connections</h2>
      {target && (
        <div aria-labelledby="disconnect-heading" role="region" className="mb-6 rounded-md border border-red-300 bg-red-50 p-6">
          <h3 id="disconnect-heading" className="mb-2 font-semibold text-red-900">Disconnect {target.label}?</h3>
          <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-red-900">
            <li>Supahound deletes its sealed access token for this Supabase organization at once, and stops polling.</li>
            <li>Everyone on the {target.projects} project{target.projects === 1 ? "" : "s"} watched through it gets an email.</li>
            <li>
              {paying
                ? "While the workspace pays, Supahound keeps their incidents, findings and poll history."
                : "Supahound deletes their incidents, findings and poll history after 30 days, unless you reconnect the same Supabase organization before then."}
              {" "}Audit log entries stay.
            </li>
            <li>
              Supahound also asks Supabase to revoke the grant. If Supabase does not confirm it, remove the Supahound app in your
              Supabase organization&apos;s OAuth Apps settings.
            </li>
          </ul>
          <form action={disconnectAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="tenantId" value={tenant} />
            <input type="hidden" name="connectionId" value={target.id} />
            <input type="hidden" name="back" value={back} />
            <label className="flex flex-col gap-1 text-sm">
              Type <strong>{target.label}</strong> to confirm
              <input name="confirmLabel" autoComplete="off" required className="rounded-md border border-slate-300 bg-white px-3 py-2" />
            </label>
            <button className="rounded-md bg-red-700 px-4 py-2 font-medium text-white hover:bg-red-800">Disconnect Supabase</button>
            <Link href={backPath(tenant, back)} className="px-2 py-2 text-sm text-slate-700">Cancel</Link>
          </form>
        </div>
      )}
      {connections.length === 0 ? (
        <p className="text-slate-600">No Supabase organization is connected.</p>
      ) : (
        <ul aria-label="Supabase connections" className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
          {connections.map((c) => {
            const state = connectionState(c, paying);
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span>
                  <span className="font-medium">{c.label}</span>
                  <span className="ml-2 text-sm text-slate-500">
                    connected {ymd(c.createdAt)} · {c.projects} project{c.projects === 1 ? "" : "s"}
                  </span>
                  {state && <span className="block text-sm text-amber-800">{state}</span>}
                </span>
                {canDisconnect && !c.disconnectedAt && (
                  <Link
                    href={`${backPath(tenant, back)}?disconnect=${c.id}`}
                    className="text-sm text-red-700 hover:text-red-900"
                    aria-label={`Disconnect ${c.label}`}
                  >
                    Disconnect
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canDisconnect && canReconnect && anyDisconnected && (
        <form action={startConnect} className="mt-3">
          <input type="hidden" name="tenantId" value={tenant} />
          <button className="rounded-md bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">Reconnect Supabase</button>
        </form>
      )}
      {!canDisconnect && connections.length > 0 && (
        <p className="mt-2 text-sm text-slate-600">Only workspace owners and admins can disconnect Supabase.</p>
      )}
    </section>
  );
}
