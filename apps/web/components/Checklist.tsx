import { currentStep, type Step } from "../lib/onboarding";

export function Checklist({ steps }: { steps: Step[] }) {
  const current = currentStep(steps);
  return (
    <ol className="flex flex-col gap-4" aria-label="Setup steps">
      {steps.map((s, i) => {
        const isCurrent = s.id === current?.id;
        return (
          <li key={s.id} aria-current={isCurrent ? "step" : undefined} className="flex gap-3">
            <span
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                s.done ? "bg-emerald-600 text-white" : isCurrent ? "bg-slate-950 text-white" : "bg-slate-200 text-slate-600"
              }`}
            >
              {s.done ? "✓" : i + 1}
            </span>
            <div>
              <p className={`font-medium ${s.done ? "text-slate-500" : ""}`}>
                {s.title}
                {!s.available && !s.done && <span className="ml-2 text-xs font-normal text-slate-400">Coming next</span>}
              </p>
              <p className="text-sm text-slate-600">{s.detail}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
