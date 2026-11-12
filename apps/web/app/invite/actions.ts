"use server";

import { acceptInvite } from "@supahound/core/db/people";
import { redirect } from "next/navigation";
import { withPool } from "../../lib/db";
import { projectPath } from "../../lib/nav";
import { invitePagePath } from "../../lib/people";
import { requireUser } from "../../lib/supabase";

// Accepts a project invite (issue #24, decision 036). A POST from the invite page, never the GET
// that opens the link, so a mail scanner that follows links cannot use up the invite. The
// signed-in user's verified email (getClaims) must match the invited address.
export async function acceptInviteAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const token = String(formData.get("token") ?? "");
  const result = await withPool((pool) => acceptInvite(pool, { token, user: user.id, email: user.email, now: new Date() }));
  if (result.status !== "accepted") redirect(invitePagePath(token, result.status));
  redirect(`${projectPath(result.tenant, result.project)}?joined=1`);
}
