// Open or resolved, for an incident (issue #44).
export function StatusBadge({ status }: { status: "open" | "resolved" }) {
  return status === "open" ? (
    <span className="rounded border border-red-300 px-2 py-0.5 text-xs font-semibold text-red-800">Open</span>
  ) : (
    <span className="rounded border border-slate-300 px-2 py-0.5 text-xs font-semibold text-slate-600">Resolved</span>
  );
}
