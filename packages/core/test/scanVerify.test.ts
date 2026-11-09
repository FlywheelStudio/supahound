import { describe, expect, it } from "vitest";
import { newChallenge, verifyChallenge, type Resolver } from "../src/scan/verify.js";

const APEX = "example.com";

// A DoH mock. `answers(resolverName, dnsName)` returns the TXT strings that resolver sees for that
// name; throwing or returning null models a resolver error.
function dohMock(answers: (resolver: string, name: string) => string[] | null) {
  return async (url: string) => {
    const parsed = new URL(url);
    const name = parsed.searchParams.get("name") ?? "";
    const resolver = parsed.hostname.includes("cloudflare") ? "cloudflare" : "google";
    const values = answers(resolver, name);
    if (values === null) return { ok: false, status: 502, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ Answer: values.map((v) => ({ type: 16, data: `"${v}"` })) }),
    };
  };
}

describe("newChallenge", () => {
  it("issues a prefixed 128-bit token on two record names", () => {
    const c = newChallenge(APEX);
    expect(c.token).toMatch(/^[0-9a-f]{32}$/);
    expect(c.value).toBe(`hackme-verify=${c.token}`);
    expect(c.names).toEqual([APEX, `_hackme-verify.${APEX}`]);
  });

  it("issues a different token each time", () => {
    expect(newChallenge(APEX).token).not.toBe(newChallenge(APEX).token);
  });
});

describe("verifyChallenge", () => {
  const challenge = newChallenge(APEX);

  it("verifies when both resolvers see the value on the apex", async () => {
    const res = await verifyChallenge(challenge, APEX, {
      fetchImpl: dohMock((_r, name) => (name === APEX ? [challenge.value] : [])),
    });
    expect([res.verified, res.agreed, res.required]).toEqual([true, 2, 2]);
  });

  it("verifies when the value is on the _hackme-verify subdomain", async () => {
    const res = await verifyChallenge(challenge, APEX, {
      fetchImpl: dohMock((_r, name) => (name === `_hackme-verify.${APEX}` ? [challenge.value] : [])),
    });
    expect(res.verified).toBe(true);
  });

  it("reassembles a chunked TXT record before matching", async () => {
    const half = Math.ceil(challenge.value.length / 2);
    const chunked = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => {
        void url;
        return { Answer: [{ type: 16, data: `"${challenge.value.slice(0, half)}" "${challenge.value.slice(half)}"` }] };
      },
    });
    const res = await verifyChallenge(challenge, APEX, { fetchImpl: chunked });
    expect(res.verified).toBe(true);
  });

  it("does not verify on a split-horizon answer only one resolver sees", async () => {
    const res = await verifyChallenge(challenge, APEX, {
      fetchImpl: dohMock((r, name) => (r === "google" && name === APEX ? [challenge.value] : [])),
    });
    expect([res.verified, res.agreed]).toEqual([false, 1]);
  });

  it("counts a resolver error as disagreement, not a pass", async () => {
    const res = await verifyChallenge(challenge, APEX, {
      fetchImpl: dohMock((r, name) => {
        if (r === "cloudflare") return null; // errors
        return name === APEX ? [challenge.value] : [];
      }),
    });
    expect(res.verified).toBe(false);
    expect(res.resolvers.find((x) => x.resolver === "cloudflare")?.error).toBe("http 502");
  });

  it("ignores other TXT records and non-TXT answers", async () => {
    const noise = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        Answer: [
          { type: 1, data: "203.0.113.1" },
          { type: 16, data: `"v=spf1 include:_spf.google.com ~all"` },
        ],
      }),
    });
    const res = await verifyChallenge(challenge, APEX, { fetchImpl: noise });
    expect(res.verified).toBe(false);
  });

  it("does not verify a wrong token", async () => {
    const other = newChallenge(APEX);
    const res = await verifyChallenge(challenge, APEX, {
      fetchImpl: dohMock((_r, name) => (name === APEX ? [other.value] : [])),
    });
    expect(res.verified).toBe(false);
  });

  it("requires a strict majority with three resolvers", async () => {
    const three: Resolver[] = [
      { name: "cloudflare", url: (n) => `https://cloudflare-dns.com/x?name=${encodeURIComponent(n)}` },
      { name: "google", url: (n) => `https://dns.google/x?name=${encodeURIComponent(n)}` },
      { name: "quad9", url: (n) => `https://dns.quad9.net/x?name=${encodeURIComponent(n)}` },
    ];
    // Only two of the three see it: 2 >= ceil(3/2)=2, so verified.
    const res = await verifyChallenge(challenge, APEX, {
      resolvers: three,
      fetchImpl: async (url: string) => {
        const name = new URL(url).searchParams.get("name") ?? "";
        const seen = url.includes("quad9") ? false : name === APEX;
        return { ok: true, status: 200, json: async () => ({ Answer: seen ? [{ type: 16, data: `"${challenge.value}"` }] : [] }) };
      },
    });
    expect([res.required, res.agreed, res.verified]).toEqual([2, 2, true]);
  });
});
