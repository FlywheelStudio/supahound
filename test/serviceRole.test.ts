import { describe, expect, it } from "vitest";
import { detectServiceRoleMisuse, ServiceRoleNetworks } from "../src/detectors/serviceRole.js";
import { classifyCaller, classifyNetwork } from "../src/network/classify.js";
import { CHROME_UA, event, serviceEvent } from "./helpers.js";

const ctx = (expectedAsns?: number[]) => ({
  projectRef: "abcdefghijklmnopqrst",
  networks: new ServiceRoleNetworks(),
  ...(expectedAsns ? { expectedAsns: new Set(expectedAsns) } : {}),
});

describe("classifyCaller", () => {
  it.each([
    [CHROME_UA, null, "browser"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36", null, "browser"],
    ["node", "supabase-js-web/2.80.0", "browser"],
    [null, "supabase-js-react-native/2.80.0", "mobile_app"],
    ["Dart/3.9 (dart:io)", null, "mobile_app"],
    ["okhttp/4.12.0", null, "mobile_app"],
    ["curl/8.7.1", null, "manual_tool"],
    ["PostmanRuntime/7.43.0", null, "manual_tool"],
    ["node", "supabase-js-node/2.80.0", "server"],
    [CHROME_UA, "supabase-js-deno/2.80.0", "server"],
    ["python-httpx/0.28.1", null, "server"],
    [null, null, "unknown"],
    ["SomethingElse/1.0", null, "unknown"],
  ])("classifies UA %s with client info %s as %s", (ua, info, expected) => {
    expect(classifyCaller(ua, info).callerClass).toBe(expected);
  });

  it("reduces the SDK name to a safe token", () => {
    expect(classifyCaller(null, "supabase-js-node/2.80.0 <script>").sdk).toBe("supabase-js-node");
    expect(classifyCaller(null, "<script>/1").sdk).toBeNull();
  });
});

describe("classifyNetwork", () => {
  it("knows bundled hosting ASNs and hosting org names", () => {
    expect(classifyNetwork(16509, null)).toBe("hosting");
    expect(classifyNetwork(99999, "Example Hosting GmbH")).toBe("hosting");
    expect(classifyNetwork(7922, "Comcast Cable Communications, LLC")).toBe("other");
    expect(classifyNetwork(null, null)).toBe("unknown");
  });
});

describe("detectServiceRoleMisuse", () => {
  it("passes a server SDK on a hosting network", () => {
    expect(detectServiceRoleMisuse([serviceEvent()], ctx())).toEqual([]);
  });

  it("ignores non-service-role traffic", () => {
    expect(detectServiceRoleMisuse([event()], ctx())).toEqual([]);
  });

  it("flags the PRD example: service key from a residential IP with a Chrome user agent", () => {
    const [f] = detectServiceRoleMisuse(
      [serviceEvent({ userAgent: CHROME_UA, clientInfo: null, asn: 7922, asOrganization: "Comcast Cable Communications, LLC" })],
      ctx(),
    );
    expect(f).toMatchObject({
      detector: "service_role_misuse",
      severity: "critical",
      signals: ["browser_caller", "non_hosting_network"],
      evidence: { callerClass: "browser", networkType: "other", asn: 7922 },
    });
  });

  it("never puts the raw user agent in the evidence", () => {
    const [f] = detectServiceRoleMisuse([serviceEvent({ userAgent: CHROME_UA, clientInfo: null })], ctx());
    expect(JSON.stringify(f)).not.toContain("Mozilla");
  });

  it("flags the key shipped in a mobile app", () => {
    const [f] = detectServiceRoleMisuse([serviceEvent({ clientInfo: "supabase-flutter/2.10.0", userAgent: null })], ctx());
    expect(f!.signals).toContain("mobile_app_caller");
    expect(f!.severity).toBe("critical");
  });

  it("rates a script from a home network as high", () => {
    const [f] = detectServiceRoleMisuse(
      [serviceEvent({ asn: 7922, asOrganization: "Comcast Cable Communications, LLC" })],
      ctx(),
    );
    expect(f).toMatchObject({ severity: "high", signals: ["non_hosting_network"] });
  });

  it("rates curl from a hosting network as medium", () => {
    const [f] = detectServiceRoleMisuse([serviceEvent({ userAgent: "curl/8.7.1", clientInfo: null })], ctx());
    expect(f).toMatchObject({ severity: "medium", signals: ["manual_tool"] });
  });

  it("silences network signals for declared networks but still flags a browser", () => {
    const home = { asn: 7922, asOrganization: "Comcast Cable Communications, LLC" };
    expect(detectServiceRoleMisuse([serviceEvent(home)], ctx([7922]))).toEqual([]);
    const [f] = detectServiceRoleMisuse([serviceEvent({ ...home, userAgent: CHROME_UA, clientInfo: null })], ctx([7922]));
    expect(f!.signals).toEqual(["browser_caller"]);
  });

  describe("new_network", () => {
    it("learns hosting networks silently on the first poll, then flags a new one", () => {
      const c = ctx();
      expect(detectServiceRoleMisuse([serviceEvent({ asn: 16509 })], c)).toEqual([]);
      expect(detectServiceRoleMisuse([serviceEvent({ asn: 16509 })], c)).toEqual([]);
      const [f] = detectServiceRoleMisuse([serviceEvent({ asn: 14061, asOrganization: "DigitalOcean, LLC" })], c);
      expect(f).toMatchObject({ severity: "medium", signals: ["new_network"] });
    });

    it("learns the new network after flagging it once", () => {
      const c = ctx();
      detectServiceRoleMisuse([serviceEvent({ asn: 16509 })], c);
      detectServiceRoleMisuse([serviceEvent({ asn: 14061 })], c);
      expect(detectServiceRoleMisuse([serviceEvent({ asn: 14061 })], c)).toEqual([]);
    });

    it("does not learn a network from a browser or manual caller", () => {
      const c = ctx();
      detectServiceRoleMisuse([serviceEvent({ asn: 16509 })], c);
      detectServiceRoleMisuse([serviceEvent({ asn: 14061, userAgent: "curl/8.7.1", clientInfo: null })], c);
      const [f] = detectServiceRoleMisuse([serviceEvent({ asn: 14061 })], c);
      expect(f!.signals).toEqual(["new_network"]);
    });

    it("keeps projects apart", () => {
      const networks = new ServiceRoleNetworks();
      detectServiceRoleMisuse([serviceEvent({ asn: 16509 })], { projectRef: "aaaaaaaaaaaaaaaaaaaa", networks });
      detectServiceRoleMisuse([serviceEvent({ asn: 14061 })], { projectRef: "bbbbbbbbbbbbbbbbbbbb", networks });
      const [f] = detectServiceRoleMisuse([serviceEvent({ asn: 14061 })], { projectRef: "aaaaaaaaaaaaaaaaaaaa", networks });
      expect(f!.signals).toEqual(["new_network"]);
    });
  });

  it("covers Auth admin and Storage calls, not only PostgREST", () => {
    const [f] = detectServiceRoleMisuse(
      [serviceEvent({ path: "/auth/v1/admin/users", userAgent: CHROME_UA, clientInfo: null })],
      ctx(),
    );
    expect(f!.evidence.table).toBeNull();
    expect(f!.signals).toContain("browser_caller");
  });
});
