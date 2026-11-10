import { redirect } from "next/navigation";

// The app has no home page; the marketing site is separate (decision 025). /app sends a
// signed-out visitor to /login.
export default function Root() {
  redirect("/app");
}
