"use server";

import { createWorkspace, listWorkspaces } from "@supahound/core/db/user";
import { redirect } from "next/navigation";
import { withPool } from "../../lib/db";
import { requireUser } from "../../lib/supabase";

export async function createWorkspaceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 1 || name.length > 200) redirect("/onboarding?error=name");
  const tenant = await withPool(async (pool) => {
    // One workspace from onboarding; more can be added from settings later.
    const existing = await listWorkspaces(pool, user.id);
    return existing[0]?.tenantId ?? createWorkspace(pool, user.id, name, user.email);
  });
  redirect(`/w/${tenant}`);
}
