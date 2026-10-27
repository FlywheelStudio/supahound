// The onboarding checklist (PRD, Onboarding). One source of truth for the order, the copy and
// which steps are built. A step is "done" from data, never from a client flag.

export type StepId = "account" | "workspace" | "connect" | "projects" | "plan" | "alerts";

export interface StepState {
  hasWorkspace: boolean;
  connections: number;
  projects: number;
}

export interface Step {
  id: StepId;
  title: string;
  detail: string;
  done: boolean;
  // False until the step's screen ships; shown as "Coming next", never as a dead button.
  available: boolean;
}

export function onboardingSteps(s: StepState): Step[] {
  return [
    { id: "account", title: "Sign in", detail: "Your email is your account.", done: true, available: true },
    { id: "workspace", title: "Create a workspace", detail: "One per agency or company. Invite your team later.", done: s.hasWorkspace, available: true },
    { id: "connect", title: "Connect Supabase", detail: "Read-only access to logs and policies. No service-role key, ever.", done: s.connections > 0, available: false },
    { id: "projects", title: "Choose projects", detail: "Pick the Supabase projects Guardbase watches.", done: s.projects > 0, available: false },
    { id: "plan", title: "Choose a plan", detail: "Free posture scans, or detection from $19 per project.", done: false, available: false },
    { id: "alerts", title: "Set up alerts", detail: "Email first; Slack and Discord webhooks optional.", done: false, available: false },
  ];
}

export function currentStep(steps: Step[]): Step | undefined {
  return steps.find((s) => !s.done);
}
