import Link from "next/link";
import { anySoon, FEATURES, type FeatureId } from "../../content/features";

// A "Coming soon" pill for a feature that is not live yet (content/features.ts). Renders nothing
// once the feature ships.
export function Soon({ id, className = "" }: { id?: FeatureId; className?: string }) {
  if (!id || FEATURES[id].status === "live") return null;
  return (
    <span className={`ml-2 inline-block whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 align-middle text-[11px] font-semibold uppercase tracking-wide text-amber-800 ${className}`}>
      Coming soon
    </span>
  );
}

// Site-wide notice while any feature is still coming soon.
export function EarlyAccessBanner() {
  if (!anySoon()) return null;
  return (
    <div className="bg-amber-50 text-amber-900">
      <p className="mx-auto max-w-6xl px-4 py-2 text-center text-sm sm:px-6">
        Supahound is in early access. Sign up now; features marked <strong>Coming soon</strong> switch on as they ship.{" "}
        <Link href="/pricing" className="font-medium underline underline-offset-2">See what&apos;s included</Link>
      </p>
    </div>
  );
}
