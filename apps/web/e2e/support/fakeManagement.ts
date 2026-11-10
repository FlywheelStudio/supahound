import { createServer, type IncomingMessage, type Server } from "node:http";

// A stand-in for the Supabase Management API: only GET /v1/projects, which the project picker
// (issue #9) calls from the Worker. Browser-side page.route cannot see server-side calls, so the
// Worker reaches this through SUPABASE_API_URL. Each bearer token gets its own answer, set by a
// test through /__test/projects; an unknown token gets 401, like a revoked grant.

export interface FakeProject {
  ref: string;
  id?: string;
  name: string;
  status?: string;
  organization_id?: string;
  region?: string;
}

export interface FakeManagement {
  url: string;
  stop: () => Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

export async function startFakeManagement(port: number): Promise<FakeManagement> {
  const answers = new Map<string, { status: number; projects: FakeProject[] }>();
  const calls: { token: string; path: string }[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.method === "POST" && path === "/__test/projects") {
        const b = await readJson(req);
        answers.set(String(b.token), { status: Number(b.status ?? 200), projects: (b.projects as FakeProject[]) ?? [] });
        return send(200, {});
      }
      if (req.method === "GET" && path === "/__test/calls") return send(200, calls);
      if (req.method === "GET" && path === "/v1/projects") {
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        calls.push({ token, path });
        const a = answers.get(token);
        if (!a) return send(401, { message: "Unauthorized" });
        if (a.status !== 200) return send(a.status, { message: "error" });
        return send(200, a.projects.map((p) => ({
          id: p.id ?? p.ref, ref: p.ref, name: p.name, organization_id: p.organization_id ?? "e2e-org",
          organization_slug: "e2e-org", region: p.region ?? "us-east-1", status: p.status ?? "ACTIVE_HEALTHY",
          created_at: "2026-11-01T00:00:00Z",
        })));
      }
      send(404, { message: `fake management: no route for ${req.method} ${path}` });
    })().catch((err: unknown) => {
      res.writeHead(500).end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
