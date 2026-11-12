import { previewInvite } from "@supahound/core/db/people";
import Link from "next/link";
import { withPool } from "../../lib/db";
import { ACCEPT_ERRORS, invitePagePath, ROLE_HELP, ROLE_LABEL } from "../../lib/people";
import { currentUser } from "../../lib/supabase";
import { acceptInviteAction } from "./actions";

// The link in a project invite email lands here (issue #24, decision 036). Opening it changes
// nothing: the invitee signs in (magic link), checks what they join, then presses Accept.

function Frame({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6">{children}</main>;
}

export default async function Invite({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const query = await searchParams;
  const token = query.token ?? "";
  const user = await currentUser();
  const preview = await withPool((pool) => previewInvite(pool, token, new Date()));
  const error = query.error && query.error in ACCEPT_ERRORS ? ACCEPT_ERRORS[query.error as keyof typeof ACCEPT_ERRORS] : null;

  if (!preview) {
    return (
      <Frame>
        <h1 className="text-2xl font-semibold">Project invite</h1>
        <p role="alert" className="text-red-800">{ACCEPT_ERRORS.invalid}</p>
      </Frame>
    );
  }

  if (!user) {
    return (
      <Frame>
        <h1 className="text-2xl font-semibold">You are invited to a project on Supahound</h1>
        <p className="text-slate-700">Sign in with the address the invite was sent to. Then you can accept it.</p>
        <Link href={`/login?next=${encodeURIComponent(invitePagePath(token))}`}
          className="inline-block rounded-md bg-slate-950 px-4 py-2 text-center font-medium text-white hover:bg-slate-800">
          Sign in to accept
        </Link>
      </Frame>
    );
  }

  const blocked =
    preview.state === "accepted" ? ACCEPT_ERRORS.used
      : preview.state === "expired" ? ACCEPT_ERRORS.expired
        : preview.state === "canceled" ? ACCEPT_ERRORS.canceled
          : (user.email ?? "").trim().toLowerCase() !== preview.email ? ACCEPT_ERRORS.wrong_email
            : null;

  return (
    <Frame>
      <h1 className="text-2xl font-semibold">Join {preview.projectName}</h1>
      <p className="text-slate-700">
        You are invited as <strong>{ROLE_LABEL[preview.role]}</strong>. {ROLE_HELP[preview.role]}
      </p>
      {error && <p role="alert" className="text-red-800">{error}</p>}
      {blocked ? (
        <>
          {!error && <p role="alert" className="text-red-800">{blocked}</p>}
          {preview.state === "open" && (
            <form action="/auth/signout" method="post">
              <button className="rounded-md border border-slate-300 px-4 py-2 font-medium hover:bg-slate-50">Sign out</button>
            </form>
          )}
          <Link href="/app" className="text-sm text-slate-600 underline">Go to Supahound</Link>
        </>
      ) : (
        <form action={acceptInviteAction}>
          <input type="hidden" name="token" value={token} />
          <button className="rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">Accept invite</button>
        </form>
      )}
    </Frame>
  );
}
