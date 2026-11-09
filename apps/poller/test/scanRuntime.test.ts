import { describe, expect, it } from "vitest";
import { assertScannableApex, hostInScope } from "@supahound/core/scan/scope";
import { newChallenge, verifyChallenge } from "@supahound/core/scan/verify";

// Proves the scan funnel's core modules load and run inside workerd (the Workers runtime), not only
// on Node. The risk is node:crypto timingSafeEqual (first use in the repo) and the tldts public
// suffix list bundling for Workers. No network is touched; the DoH fetch is mocked.
describe("scan modules under workerd", () => {
  it("issues a challenge token with node:crypto randomBytes", () => {
    expect(newChallenge("example.com").token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("matches a TXT value with node:crypto timingSafeEqual", async () => {
    const challenge = newChallenge("example.com");
    const res = await verifyChallenge(challenge, "example.com", {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ Answer: [{ type: 16, data: `"${challenge.value}"` }] }),
      }),
    });
    expect(res.verified).toBe(true);
  });

  it("parses the public suffix list with tldts", () => {
    expect(assertScannableApex("https://app.example.co.uk/login")).toBe("example.co.uk");
    expect(hostInScope("api.example.com", "example.com")).toBe(true);
  });
});
