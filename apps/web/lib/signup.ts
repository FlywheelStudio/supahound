import { PLANS } from "../content/site";

// The magic-link page doubles as sign-up: the same link creates the account. Marketing CTAs
// send `?signup=1` (and `plan=<id>`) so the page reads as sign-up, not sign-in.
export function authCopy(params: Record<string, string | undefined>) {
  const plan = PLANS.find((p) => p.id === params.plan);
  const signup = params.signup === "1" || plan !== undefined;
  if (!signup) {
    return { heading: "Sign in to Supahound", button: "Email me a sign-in link", note: "No password. New here? The same link creates your account.", plan: undefined };
  }
  return {
    heading: "Create your free Supahound account",
    button: "Email me a sign-up link",
    note: "No password and no credit card. Already have an account? The same link signs you in.",
    plan: plan && plan.id !== "free"
      ? `You picked ${plan.name} (${plan.priceLabel} ${plan.unit}). Start free, connect a project, then upgrade it from your workspace.`
      : undefined,
  };
}
