// Caller and network classification for detector 4. Both lists are approximate and bundled
// for the prototype; the PRD rules out reputation feeds, so these only sort traffic into
// "looks like a server" vs "looks like a person".

export type NetworkType = "hosting" | "other" | "unknown";

// Large cloud and hosting ASNs. Approximate: not every range of these providers, and some
// (Cloudflare WARP) also carry consumer traffic.
export const HOSTING_ASNS: ReadonlyMap<number, string> = new Map([
  [16509, "Amazon"], [14618, "Amazon"], [8987, "Amazon"],
  [15169, "Google"], [396982, "Google Cloud"], [19527, "Google"],
  [8075, "Microsoft"],
  [13335, "Cloudflare"],
  [14061, "DigitalOcean"],
  [24940, "Hetzner"], [213230, "Hetzner Cloud"],
  [16276, "OVH"],
  [63949, "Akamai Linode"], [20940, "Akamai"],
  [20473, "Vultr"],
  [31898, "Oracle Cloud"],
  [54113, "Fastly"],
  [12876, "Scaleway"],
  [51167, "Contabo"],
  [45102, "Alibaba Cloud"],
  [132203, "Tencent Cloud"],
]);

// Edge logs carry the network's org name but, in practice, no ASN (#184), so the name decides.
// Each provider is one memory key: one provider registers its ranges under many names (Amazon:
// "Amazon.com, Inc.", "Amazon Data Services UK", "A100 ROW GmbH", ...), and each region shows up
// hours apart. "A100 ROW" is the registrant of Amazon's EU address ranges; its name names no
// provider. The application platforms run customers' servers and edge functions.
const PROVIDERS: readonly (readonly [key: string, pattern: RegExp])[] = [
  ["amazon", /\b(amazon|aws|a100 row)/i],
  ["google", /\bgoogle/i],
  ["microsoft", /\b(microsoft|azure)/i],
  ["digitalocean", /\bdigitalocean/i],
  ["hetzner", /\bhetzner/i],
  ["ovh", /\bovh/i],
  ["akamai", /\b(linode|akamai)/i],
  ["vultr", /\bvultr/i],
  ["oracle", /\boracle/i],
  ["cloudflare", /\bcloudflare/i],
  ["fastly", /\bfastly/i],
  ["scaleway", /\bscaleway/i],
  ["contabo", /\bcontabo/i],
  ["alibaba", /\balibaba/i],
  ["tencent", /\btencent/i],
  ["railway", /\brailway/i],
  ["render", /\brender/i],
  ["fly", /\bfly\W?io\b/i],
  ["vercel", /\bvercel/i],
  ["heroku", /\bheroku/i],
  ["netlify", /\bnetlify/i],
  ["supabase", /\bsupabase/i],
];
// Generic words: hosting, but no provider to key on.
const HOSTING_WORDS = /\b(hosting|datacenter|data center|colocation|server)/i;

function providerOf(asOrganization: string): string | null {
  for (const [key, pattern] of PROVIDERS) if (pattern.test(asOrganization)) return key;
  return null;
}

// A network's org name, reduced to lowercase letters, digits and single spaces, at most 80
// characters. Cloudflare sets it from the caller's IP; the caller does not choose it. Null when
// nothing is left.
export function networkName(asOrganization: string | null): string | null {
  if (asOrganization === null) return null;
  const name = asOrganization.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80).trim();
  return name === "" ? null : name;
}

export function classifyNetwork(asn: number | null, asOrganization: string | null): NetworkType {
  if (asn === null && asOrganization === null) return "unknown";
  if (asn !== null && HOSTING_ASNS.has(asn)) return "hosting";
  if (asOrganization !== null && (providerOf(asOrganization) !== null || HOSTING_WORDS.test(asOrganization))) return "hosting";
  return "other";
}

// The key decision 003's memory uses when the log has no ASN (decision 050): the provider for a
// known one, else the normalized name. Two Amazon regions are one network to the memory.
export function networkMemoryKey(asOrganization: string | null): string | null {
  if (asOrganization === null) return null;
  return providerOf(asOrganization) ?? networkName(asOrganization);
}

export type CallerClass = "browser" | "mobile_app" | "manual_tool" | "server" | "unknown";

export interface Caller {
  callerClass: CallerClass;
  // SDK name from X-Client-Info (e.g. "supabase-js-web"), reduced to [a-z0-9-] so it is safe to echo.
  sdk: string | null;
}

const SDK_CLASS: Record<string, CallerClass> = {
  "supabase-js-web": "browser",
  "supabase-js-react-native": "mobile_app",
  "supabase-flutter": "mobile_app",
  "supabase-swift": "mobile_app",
  "supabase-js-node": "server",
  "supabase-js-deno": "server",
  "supabase-js-bun": "server",
  "supabase-py": "server",
  "supabase-go": "server",
  "supabase-csharp": "server",
};

const BROWSER_UA = /^Mozilla\/5\.0 .*\b(Chrome|Safari|Firefox|Edg|OPR)\//;
const MOBILE_UA = /^(Dart\/|okhttp\/|Dalvik\/|CFNetwork\/|Expo\/)/i;
const MANUAL_UA = /^(curl|Wget|PostmanRuntime|insomnia|HTTPie|Bruno)\//i;
const SERVER_UA =
  /^(node|undici|node-fetch|axios|Deno|Bun|python-requests|python-httpx|aiohttp|Go-http-client|Java|Ruby|Faraday|GuzzleHttp|reqwest|supabase)/i;

export function classifyCaller(userAgent: string | null, clientInfo: string | null): Caller {
  const sdkMatch = clientInfo ? /^([a-z][a-z0-9-]*)\//i.exec(clientInfo) : null;
  const sdk = sdkMatch ? sdkMatch[1]!.toLowerCase() : null;
  const fromSdk = sdk ? SDK_CLASS[sdk] : undefined;
  if (fromSdk) return { callerClass: fromSdk, sdk };

  if (userAgent === null) return { callerClass: "unknown", sdk };
  if (BROWSER_UA.test(userAgent)) return { callerClass: "browser", sdk };
  if (MOBILE_UA.test(userAgent)) return { callerClass: "mobile_app", sdk };
  if (MANUAL_UA.test(userAgent)) return { callerClass: "manual_tool", sdk };
  if (SERVER_UA.test(userAgent)) return { callerClass: "server", sdk };
  return { callerClass: "unknown", sdk };
}
