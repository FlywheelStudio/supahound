"use client";

import Link, { useLinkStatus } from "next/link";
import type { ComponentProps } from "react";

// A Link that answers a click at once. Signed-in pages render on the server and their data can
// be a long way off, so without this a click shows nothing until the next page arrives.
//
// Not loading.tsx: a loading boundary streams a 200 before the page runs its access check, so a
// non-member would get a 200 instead of a 404 and a signed-out user a 200 instead of a 307
// (UAT-W7, W21, W25, W26, W28 and the signed-out redirect test pin those codes).

function PendingBar() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span
      role="status"
      aria-label="Loading"
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 animate-pulse bg-emerald-500"
    />
  );
}

export default function NavLink({ children, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link {...props}>
      {children}
      <PendingBar />
    </Link>
  );
}
