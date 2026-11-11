import { PRODUCT_NAME } from "./brand";

// The magic-link page doubles as sign-up: the same link creates the account. A marketing site
// sends `?signup=1` (and `plan=<id>`) so the page reads as sign-up, not sign-in. The app never
// echoes the plan id. With billing on, the page says a card comes next (decision 028).
export function authCopy(params: Record<string, string | undefined>, cardRequired: boolean) {
  const paidPlan = params.plan !== undefined && params.plan !== "" && params.plan !== "free";
  const signup = params.signup === "1" || paidPlan;
  if (!signup) {
    return { heading: `Sign in to ${PRODUCT_NAME}`, button: "Email me a sign-in link", note: "No password. New here? The same link creates your account.", plan: undefined };
  }
  if (cardRequired) {
    // Decision 028: every workspace needs a validated card. Say so before the email, not after.
    return {
      heading: `Create your ${PRODUCT_NAME} account`,
      button: "Email me a sign-up link",
      note: "No password. Already have an account? The same link signs you in.",
      plan: "After you sign in, you add a card to start a 7-day free trial. Your bank confirms the card with a $1 hold, released at once.",
    };
  }
  return {
    heading: `Create your ${PRODUCT_NAME} account`,
    button: "Email me a sign-up link",
    note: "No password. Already have an account? The same link signs you in.",
    plan: undefined,
  };
}
