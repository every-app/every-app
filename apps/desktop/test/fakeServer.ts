// A fake Scribe app + Every App Gateway on 127.0.0.1, for the sign-in and API tests. One origin
// plays both: the app (`/.well-known/oauth-protected-resource`, `/api/v1/*`) and the Gateway
// (`/gw` issuer: metadata, register, authorize, token, revoke).

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export class FakeServer {
  origin = "";
  issuer = "";
  server!: Server;
  requests: Recorded[] = [];

  // Knobs
  resourceOverride?: string;
  issuerOverride?: string;
  challengeMethods: string[] | undefined = ["S256"];
  issSupported = true;
  accessTtl = 3600;
  /** What the token endpoint answers next, before normal behavior. */
  tokenErrors: { status: number; error: string }[] = [];
  echoResource?: string;
  /** Answer /api/v1 like Cloudflare Access would. */
  accessMode: "off" | "redirect" | "page401" = "off";
  upcomingStatus = 200;

  // State
  clients = new Set<string>();
  codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; resource: string }>();
  refreshTokens = new Map<string, string>(); // token → clientId
  accessTokens = new Set<string>();
  revoked: string[] = [];
  meetings: { id: string; title: string; status: string; visibility: string; startsAt: string; calendarEventId?: string }[] = [];
  segments = new Map<string, unknown[]>();
  finished: string[] = [];
  deleted: string[] = [];
  events: unknown[] = [];
  private n = 0;

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", this.origin);
        this.requests.push({ method: req.method ?? "", path: url.pathname + url.search, headers: req.headers, body });
        this.route(req, res, url, body);
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.issuer = `${this.origin}/gw`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  issueAccess(): string {
    const t = `at_${++this.n}`;
    this.accessTokens.add(t);
    return t;
  }

  /** The authorize endpoint, as a browser would follow it: returns the redirect target. */
  authorize(authorizationUrl: string): string {
    const u = new URL(authorizationUrl);
    const q = u.searchParams;
    const clientId = q.get("client_id")!;
    const redirect = new URL(q.get("redirect_uri")!);
    const back = new URLSearchParams();
    if (!this.clients.has(clientId)) {
      back.set("error", "invalid_client");
    } else {
      const code = `code_${++this.n}`;
      this.codes.set(code, {
        clientId,
        challenge: q.get("code_challenge")!,
        redirectUri: q.get("redirect_uri")!,
        resource: q.get("resource")!,
      });
      back.set("code", code);
    }
    back.set("state", q.get("state")!);
    if (this.issSupported) back.set("iss", this.issuer);
    return `${redirect.toString()}?${back.toString()}`;
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  private route(req: IncomingMessage, res: ServerResponse, url: URL, body: string) {
    const p = url.pathname;
    const form = new URLSearchParams(body);
    if (p === "/.well-known/oauth-protected-resource") {
      return this.json(res, 200, { resource: this.resourceOverride ?? this.origin, authorization_servers: [this.issuer] });
    }
    if (p === "/.well-known/oauth-authorization-server/gw") {
      return this.json(res, 200, {
        issuer: this.issuerOverride ?? this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        registration_endpoint: `${this.issuer}/register`,
        revocation_endpoint: `${this.issuer}/revoke`,
        code_challenge_methods_supported: this.challengeMethods,
        authorization_response_iss_parameter_supported: this.issSupported,
      });
    }
    if (p === "/gw/register") {
      const id = `client_${++this.n}`;
      this.clients.add(id);
      return this.json(res, 201, { client_id: id });
    }
    if (p === "/gw/token") {
      const err = this.tokenErrors.shift();
      if (err) return this.json(res, err.status, { error: err.error });
      const clientId = form.get("client_id") ?? "";
      if (!this.clients.has(clientId)) return this.json(res, 401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        const code = this.codes.get(form.get("code") ?? "");
        this.codes.delete(form.get("code") ?? "");
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (!code || code.challenge !== challenge || code.clientId !== clientId || code.redirectUri !== form.get("redirect_uri") || code.resource !== form.get("resource")) {
          return this.json(res, 400, { error: "invalid_grant" });
        }
      } else if (form.get("grant_type") === "refresh_token") {
        const rt = form.get("refresh_token") ?? "";
        if (this.refreshTokens.get(rt) !== clientId) return this.json(res, 400, { error: "invalid_grant" });
        this.refreshTokens.delete(rt); // rotated: one use only
      } else {
        return this.json(res, 400, { error: "unsupported_grant_type" });
      }
      const refresh = `rt_${++this.n}`;
      this.refreshTokens.set(refresh, clientId);
      return this.json(res, 200, {
        access_token: this.issueAccess(),
        token_type: "Bearer",
        expires_in: this.accessTtl,
        refresh_token: refresh,
        resource: this.echoResource ?? form.get("resource"),
      });
    }
    if (p === "/gw/revoke") {
      const t = form.get("token") ?? "";
      this.revoked.push(t);
      this.refreshTokens.delete(t);
      res.writeHead(200);
      return res.end();
    }
    if (p.startsWith("/api/v1/")) return this.api(req, res, url, body);
    this.json(res, 404, { error: "not_found" });
  }

  private api(req: IncomingMessage, res: ServerResponse, url: URL, body: string) {
    if (this.accessMode === "redirect") {
      res.writeHead(302, { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/talk.example" });
      return res.end();
    }
    if (this.accessMode === "page401") {
      res.writeHead(401, { "content-type": "text/html" });
      return res.end('<html><script src="https://team.cloudflareaccess.com/cdn-cgi/access/x.js"></script></html>');
    }
    const auth = req.headers.authorization ?? "";
    const token = auth.replace(/^Bearer /, "");
    if (!this.accessTokens.has(token) && token !== "epat_good") return this.json(res, 401, { error: "unauthorized" });
    const p = url.pathname.slice("/api/v1".length);
    const m = p.match(/^\/meetings\/([^/]+)(\/.*)?$/);
    if (p === "/me") {
      return this.json(res, 200, { user: { id: 7, email: "ben@example.com", orgName: "Every" }, google: { connected: true } });
    }
    if (p === "/calendar/upcoming") {
      if (this.upcomingStatus !== 200) return this.json(res, this.upcomingStatus, { error: "google_not_connected" });
      return this.json(res, 200, { events: this.events, connected: true });
    }
    if (p === "/meetings" && req.method === "POST") {
      const b = JSON.parse(body) as { title: string; startsAt?: string; calendarEventId?: string };
      const meeting = { id: `m${++this.n}`, title: b.title, status: "recording", visibility: "private", startsAt: b.startsAt ?? new Date().toISOString(), calendarEventId: b.calendarEventId };
      this.meetings.push(meeting);
      return this.json(res, 201, { meeting });
    }
    if (p === "/meetings" && req.method === "GET") return this.json(res, 200, { meetings: this.meetings });
    if (m) {
      const meeting = this.meetings.find((x) => x.id === decodeURIComponent(m[1]!));
      if (!meeting) return this.json(res, 404, { error: "not_found" });
      const rest = m[2] ?? "";
      if (rest === "" && req.method === "GET") {
        return this.json(res, 200, { meeting: { ...meeting, segments: this.segments.get(meeting.id) ?? [], notes: null, shareLinks: [] } });
      }
      if (rest === "" && req.method === "DELETE") {
        this.meetings = this.meetings.filter((x) => x !== meeting);
        this.deleted.push(meeting.id);
        return this.json(res, 200, { ok: true });
      }
      if (rest === "" && req.method === "PATCH") {
        Object.assign(meeting, JSON.parse(body));
        return this.json(res, 200, { meeting });
      }
      if (rest === "/segments" && req.method === "POST") {
        const b = JSON.parse(body) as { segments: unknown[] } | unknown[];
        const list = Array.isArray(b) ? b : b.segments;
        this.segments.set(meeting.id, [...(this.segments.get(meeting.id) ?? []), ...list]);
        return this.json(res, 200, { ok: true });
      }
      if (rest === "/finish" && req.method === "POST") {
        if (meeting.status === "done") return this.json(res, 404, { error: "not_found" });
        meeting.status = "done";
        this.finished.push(meeting.id);
        return this.json(res, 200, { ok: true });
      }
    }
    this.json(res, 404, { error: "not_found" });
  }
}
