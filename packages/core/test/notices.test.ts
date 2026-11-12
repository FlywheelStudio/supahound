import { describe, expect, it } from "vitest";
import { runSubprocessorNotice, type NoticeCliDeps } from "../src/cli.js";
import {
  cloudflareSender, EmailApiError, journalLine, noticeKey, noticeProblems, renderSubprocessorNotice, sendNotice,
  type NoticeEmail, type SubprocessorNotice,
} from "../src/notices/subprocessor.js";
import { revokeGrant } from "../src/supabase/oauth.js";

// The subprocessor notice (decision 037). Every network call here is a mocked fetch.

const TODAY = new Date("2026-11-12T15:00:00Z");
const NOTICE: SubprocessorNotice = {
  name: "Twilio", purpose: "SMS alerts", location: "United States", effective: "2026-12-12",
  policyUrl: "https://supahound.example/privacy", contact: "hello@supahound.example",
};

describe("noticeProblems", () => {
  it("accepts a notice exactly 30 days ahead and refuses one day less", () => {
    expect(noticeProblems(NOTICE, TODAY)).toEqual([]);
    expect(noticeProblems({ ...NOTICE, effective: "2026-12-11" }, TODAY)).toEqual([expect.stringContaining("at least 30 days")]);
  });

  it("refuses empty fields, a bad date, an http URL and a bad contact", () => {
    const p = noticeProblems({ name: " ", purpose: "", location: "x", effective: "12/12/2026", policyUrl: "http://x", contact: "nope" }, TODAY);
    expect(p).toHaveLength(5);
  });
});

describe("renderSubprocessorNotice", () => {
  it("states the subprocessor, purpose, location, date and how to object, and escapes HTML", () => {
    const r = renderSubprocessorNotice({ ...NOTICE, name: "<b>Evil</b> & Co" });
    expect(r.subject).toBe("Supahound adds a subprocessor: <b>Evil</b> & Co");
    for (const s of ["Purpose: SMS alerts", "Location: United States", "On 2026-12-12", "reply to hello@supahound.example", "https://supahound.example/privacy"]) {
      expect(r.text).toContain(s);
    }
    expect(r.html).toContain("&lt;b&gt;Evil&lt;/b&gt; &amp; Co");
    expect(r.html).not.toContain("<b>Evil</b>");
  });
});

function recordingFetch(status = 200, body: unknown = { success: true, errors: [], result: { delivered: ["x"] } }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

const EMAIL: NoticeEmail = {
  to: "owner@example.com", from: { address: "notices@supahound.example", name: "Supahound" }, replyTo: "hello@supahound.example",
  ...renderSubprocessorNotice(NOTICE),
};

describe("cloudflareSender", () => {
  it("posts one email to the Email Sending REST API with a bearer token", async () => {
    const { f, calls } = recordingFetch();
    await cloudflareSender({ accountId: "acc123", apiToken: "tok", fetch: f })(EMAIL);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({
      from: { address: "notices@supahound.example", name: "Supahound" }, to: "owner@example.com", reply_to: "hello@supahound.example",
      subject: EMAIL.subject, text: EMAIL.text, html: EMAIL.html,
    });
  });

  it("throws on an HTTP error or success: false, with error codes and never the response text", async () => {
    const bad = recordingFetch(429, { success: false, errors: [{ code: 10004, message: "email.sending.error.throttled" }] });
    await expect(cloudflareSender({ accountId: "a", apiToken: "t", fetch: bad.f })(EMAIL)).rejects.toThrow(/HTTP 429 \(email.sending.error.throttled\)/);
    const soft = recordingFetch(200, { success: false, errors: [] });
    await expect(cloudflareSender({ accountId: "a", apiToken: "t", fetch: soft.f })(EMAIL)).rejects.toBeInstanceOf(EmailApiError);
  });
});

describe("sendNotice", () => {
  it("sends once per address, skips addresses in the journal, records each success, and counts failures", async () => {
    const sent: string[] = [];
    const recorded: string[] = [];
    const already = journalLine(noticeKey(NOTICE), "a@example.com");
    const result = await sendNotice({
      notice: NOTICE, addresses: ["a@example.com", "b@example.com", "c@example.com"],
      from: EMAIL.from, sent: new Set([already]), record: (l) => recorded.push(l),
      send: async (m) => { if (m.to === "c@example.com") throw new Error("down"); sent.push(m.to); },
    });
    expect(result).toEqual({ sent: 1, skipped: 1, failed: 1 });
    expect(sent).toEqual(["b@example.com"]);
    expect(recorded).toEqual([journalLine(noticeKey(NOTICE), "b@example.com")]);
    // The journal holds hashes, never addresses.
    expect(recorded[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("supahound subprocessor-notice", () => {
  const ARGS = ["--name", "Twilio", "--purpose", "SMS alerts", "--location", "United States", "--effective", "2026-12-12", "--contact", "hello@supahound.example"];
  const SEND_ENV = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_EMAIL_API_TOKEN: "tok", NOTICE_FROM_ADDRESS: "notices@supahound.example" };

  function deps(over: Partial<NoticeCliDeps> = {}, owners = ["a@example.com", "b@example.com"]) {
    const lines: string[] = [];
    const journal: string[] = [];
    const { f, calls } = recordingFetch();
    let ended = 0;
    const d: NoticeCliDeps = {
      env: { SUPAHOUND_NOTIFIER_DATABASE_URL: "postgres://notifier", ...SEND_ENV },
      today: TODAY,
      notifier: () => ({
        query: async () => ({ rows: owners.map((email) => ({ email })) }),
        end: async () => { ended++; },
      }) as never,
      fetch: f,
      readJournal: () => [...journal],
      appendJournal: (_p, l) => journal.push(l),
      out: (l) => lines.push(l),
      ...over,
    };
    return { d, lines, journal, calls, ended: () => ended };
  }

  it("counts only, by default: no email, no address on screen", async () => {
    const t = deps();
    expect(await runSubprocessorNotice(ARGS, t.d)).toBe(0);
    expect(t.calls).toHaveLength(0);
    expect(t.lines[0]).toBe("2 recipients (distinct owner addresses across all workspaces)");
    expect(t.lines.join("\n")).not.toContain("@example.com");
    expect(t.ended()).toBe(1);
  });

  it("refuses --send without a journal, and a notice less than 30 days ahead", async () => {
    const t = deps();
    expect(await runSubprocessorNotice([...ARGS, "--send"], t.d)).toBe(2);
    expect(await runSubprocessorNotice([...ARGS.slice(0, 7), "2026-12-01", ...ARGS.slice(8)], t.d)).toBe(2);
    expect(t.calls).toHaveLength(0);
  });

  it("--test-to sends exactly one copy to that address and reads no owners", async () => {
    let read = 0;
    const t = deps({ notifier: () => { read++; throw new Error("no database expected"); } });
    expect(await runSubprocessorNotice([...ARGS, "--test-to", "me@example.com"], t.d)).toBe(0);
    expect(read).toBe(0);
    expect(t.calls.map((c) => JSON.parse(String(c.init.body)).to)).toEqual(["me@example.com"]);
  });

  it("--send emails each owner once, and a second run sends nothing more", async () => {
    const t = deps();
    expect(await runSubprocessorNotice([...ARGS, "--send", "--journal", "j"], t.d)).toBe(0);
    expect(t.calls.map((c) => JSON.parse(String(c.init.body)).to)).toEqual(["a@example.com", "b@example.com"]);
    expect(await runSubprocessorNotice([...ARGS, "--send", "--journal", "j"], t.d)).toBe(0);
    expect(t.calls).toHaveLength(2);
    expect(t.lines.at(-1)).toBe("Sent 0, already sent 2, failed 0.");
  });

  it("will not send without the Cloudflare settings", async () => {
    const t = deps({ env: { SUPAHOUND_NOTIFIER_DATABASE_URL: "postgres://notifier" } });
    expect(await runSubprocessorNotice([...ARGS, "--send", "--journal", "j"], t.d)).toBe(2);
    expect(t.calls).toHaveLength(0);
  });
});

describe("revokeGrant (disconnect)", () => {
  const client = { clientId: "66666666-6666-4666-8666-666666666666", clientSecret: "secret", redirectUri: "https://app.test/cb" };

  it("posts the app credentials and refresh token to /v1/oauth/revoke", async () => {
    const { f, calls } = recordingFetch(204, null);
    expect(await revokeGrant({ ...client, fetch: f }, "refresh-1", "https://api.supabase.test")).toBe(true);
    expect(calls[0]!.url).toBe("https://api.supabase.test/v1/oauth/revoke");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ client_id: client.clientId, client_secret: "secret", refresh_token: "refresh-1" });
  });

  it("returns false, never throws, when Supabase refuses or the network fails", async () => {
    expect(await revokeGrant({ ...client, fetch: recordingFetch(403, {}).f }, "r")).toBe(false);
    expect(await revokeGrant({ ...client, fetch: (async () => { throw new Error("offline"); }) as typeof fetch }, "r")).toBe(false);
  });
});
