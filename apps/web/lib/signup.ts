import { PRODUCT_NAME } from "./brand";

// The magic-link page doubles as sign-up: the same link creates the account. A marketing site
// sends `?signup=1` (and `plan=<id>`) so the page reads as sign-up, not sign-in. Plans and prices
// live on the marketing site, not here (decision 025); the app never echoes the plan id.
export function authCopy(params: Record<string, string | undefined>) {
  const paidPlan = params.plan !== undefined && params.plan !== "" && params.plan !== "free";
  const signup = params.signup === "1" || paidPlan;
  if (!signup) {
    return { heading: `Sign in to ${PRODUCT_NAME}`, button: "Email me a sign-in link", note: "No password. New here? The same link creates your account.", plan: undefined };
  }
  return {
    heading: `Create your free ${PRODUCT_NAME} account`,
    button: "Email me a sign-up link",
    note: "No password and no credit card. Already have an account? The same link signs you in.",
    plan: paidPlan ? "You picked a paid plan. Create your free account first; you choose the plan from your workspace." : undefined,
  };
}
