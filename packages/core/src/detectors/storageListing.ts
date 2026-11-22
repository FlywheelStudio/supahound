import { effectiveRole, type EdgeEvent } from "../logs/event.js";
import { STORAGE_LIST_PREFIX } from "../logs/sql.js";
import { classifyCaller, classifyNetwork, type CallerClass, type NetworkType } from "../network/classify.js";
import { LISTABLE_BUCKET_CHECK } from "../posture/findings.js";
import { fingerprint, type Finding, type Severity } from "./finding.js";

// Detector 13 (issue #157): anon calls to Storage's list endpoint, POST
// /storage/v1/object/list/<bucket>. Listing returns the bucket's file names; in a public bucket
// every one of them is then downloadable by URL. The rollup fetches every anon list call (one
// fixed prefix, logs/sql.ts).
//
// Severity: the logs cannot say whether a listing returned anything (Storage answers 200 with an
// empty list when RLS filters every file, and sends no Content-Range), so posture decides. A bucket
// the Advisor flags `public_bucket_allows_listing` lists for anyone: medium, and high at 100 list
// calls or more in one poll (someone paging through the whole bucket). Any other bucket: low, a
// probe at most, whatever the count; it never pages.
//
// The bucket comes from the request path, which the caller controls. Evidence names it only when
// posture already named it (a flagged bucket); otherwise only its fingerprint is kept.

export const LIST_BURST_HITS = 100;

// The signals this detector emits; each has a rule in rules.ts.
export const STORAGE_LISTING_SIGNALS = ["anon_bucket_list", "listable_bucket", "list_burst"] as const;
export type StorageListingSignal = (typeof STORAGE_LISTING_SIGNALS)[number];

// The bucket segment of a list path, or null for any other path. A trailing slash is ignored.
export function bucketFromListPath(path: string): string | null {
  if (!path.startsWith(STORAGE_LIST_PREFIX)) return null;
  const bucket = path.slice(STORAGE_LIST_PREFIX.length).split("/")[0] ?? "";
  return bucket === "" ? null : bucket;
}

interface Group {
  bucket: string | null;
  bucketFingerprint: string;
  asn: number | null;
  callerClass: CallerClass;
  networkType: NetworkType;
  hits: number;
  firstSeen: string;
  lastSeen: string;
}

// One finding per bucket, network (ASN) and caller class in this poll. Rejected calls (4xx/5xx)
// listed nothing and raise nothing.
export function detectStorageListing(events: EdgeEvent[], listable: ReadonlySet<string>): Finding[] {
  const groups = new Map<string, Group>();
  for (const event of events) {
    if (effectiveRole(event) !== "anon") continue;
    if (event.status !== null && event.status >= 400) continue;
    const raw = bucketFromListPath(event.path);
    if (raw === null) continue;
    const bucket = listable.has(raw) ? raw : null;
    const bucketFingerprint = fingerprint(raw);
    const { callerClass } = classifyCaller(event.userAgent, event.clientInfo);
    const key = `${bucketFingerprint}|${event.asn ?? "unknown"}|${callerClass}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        bucket, bucketFingerprint, asn: event.asn, callerClass, networkType: classifyNetwork(event.asn, event.asOrganization),
        hits: event.hits, firstSeen: event.firstSeen, lastSeen: event.lastSeen,
      });
      continue;
    }
    g.hits += event.hits;
    if (event.firstSeen < g.firstSeen) g.firstSeen = event.firstSeen;
    if (event.lastSeen > g.lastSeen) g.lastSeen = event.lastSeen;
  }

  return [...groups.values()].map((g) => {
    const flagged = g.bucket !== null;
    const signals: StorageListingSignal[] = ["anon_bucket_list"];
    if (flagged) signals.push("listable_bucket");
    if (g.hits >= LIST_BURST_HITS) signals.push("list_burst");
    const severity: Severity = !flagged ? "low" : g.hits >= LIST_BURST_HITS ? "high" : "medium";
    return {
      detector: "storage_listing",
      severity,
      actor: `anon:asn:${g.asn ?? "unknown"}`,
      signals,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      hits: g.hits,
      evidence: {
        bucket: g.bucket,
        bucketFingerprint: g.bucketFingerprint,
        postureCheck: flagged ? LISTABLE_BUCKET_CHECK : null,
        asn: g.asn,
        callerClass: g.callerClass,
        networkType: g.networkType,
      },
    } satisfies Finding;
  });
}
