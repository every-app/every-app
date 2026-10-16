/**
 * The deployed gateway Worker, as far as the CLI meets it in tests: the
 * hostnames FakeCloudflare publishes for it answer HTTPS (a request to one
 * that has no certificate yet, or no Custom Domain, fails as fetch does),
 * an app hostname whose app is `binding` goes `active` on the first request
 * once the deployed gateway binds its Worker (as `handleGatewayRequest`
 * activates it), and a person can claim the owner setup link (as
 * SetupService.claimOwner does). It writes the same D1 the CLI reads.
 */
import { createHash, randomUUID } from "node:crypto";
import type { FakeCloudflare } from "./fakeCloudflare";

const GATEWAY_WORKER = "every-app-gateway";

/** A request fetch couldn't make: no TLS, no DNS. */
function failed(reason: string): TypeError {
  return new TypeError("fetch failed", { cause: new Error(reason) });
}

export class GatewayWorker {
  /** Hostnames Cloudflare Access sits in front of. */
  readonly accessInFront = new Set<string>();
  /** Hostnames whose certificate hasn't come yet. */
  readonly certificatePending = new Set<string>();
  /** The URLs requested, in order. */
  readonly requests: string[] = [];
  /** The gateway's clock, for setup links' expiry. */
  now: () => number = () => Date.now();

  constructor(private readonly account: FakeCloudflare) {}

  private get db() {
    return this.account.database(GATEWAY_WORKER);
  }

  /** `fetch`, for the hosts the gateway serves. */
  readonly fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    this.requests.push(url.toString());
    const host = url.hostname.toLowerCase();
    if (this.account.customDomains.get(host) !== GATEWAY_WORKER) {
      throw failed(`getaddrinfo ENOTFOUND ${host}`);
    }
    if (this.certificatePending.has(host)) {
      throw failed("SSL alert number 40: handshake failure");
    }
    if (this.accessInFront.has(host)) {
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://acme.cloudflareaccess.com/cdn-cgi/access/login/${host}`,
        },
      });
    }
    const app = this.db.all(
      "SELECT id, status, worker_name FROM apps WHERE hostname = ? AND status != 'deleted'",
      host,
    )[0];
    if (!app) return new Response("ok", { status: 200 });
    if (
      app["status"] === "binding" &&
      this.account.gatewayBindings().includes(String(app["worker_name"]))
    ) {
      this.db.sqlite
        .prepare("UPDATE apps SET status = 'active' WHERE id = ? AND status = 'binding'")
        .run(String(app["id"]));
      return new Response("app", { status: 200 });
    }
    if (app["status"] === "active") return new Response("app", { status: 200 });
    return Response.json({ code: "app_deploying" }, { status: 503 });
  }) as typeof fetch;

  /**
   * What a person does on the gateway's /setup page with a setup link, as
   * SetupService.claimOwner does: a link that is unspent and unexpired,
   * while the gateway has no owner, makes its owner. The organization apps
   * were deployed to before (the oldest with live apps and no members) is
   * adopted and renamed, or a new one is made; the owner gets every app
   * nobody has access to; the link is spent last. Anything else is refused.
   */
  claim(
    setupUrl: string,
    { email = "owner@example.com", name = "Owner" }: { email?: string; name?: string } = {},
  ): { userId: string; organizationId: string } {
    const token = new URL(setupUrl).hash.replace(/^#token=/, "");
    const hash = createHash("sha256").update(token).digest("hex");
    const link = this.db.all(
      "SELECT id FROM owner_setup_tokens WHERE kind = 'claim' AND token_hash = ? AND consumed_at IS NULL AND expires_at > ?",
      hash,
      this.now(),
    )[0];
    if (!link) {
      throw new Error(
        "INVALID_OR_EXPIRED_SETUP_LINK: that setup link is spent, expired or unknown",
      );
    }
    if (this.db.all("SELECT 1 FROM members WHERE role = 'owner'").length > 0) {
      throw new Error("ALREADY_CLAIMED: the gateway has an owner");
    }
    const now = this.now();
    const userId = `user-${randomUUID()}`;
    this.db.sqlite
      .prepare(
        "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
      )
      .run(userId, name, email, now, now);
    const awaiting = this.db.all(
      `SELECT id FROM organizations o
       WHERE NOT EXISTS (SELECT 1 FROM members m WHERE m.organization_id = o.id)
         AND EXISTS (SELECT 1 FROM apps a WHERE a.organization_id = o.id AND a.status != 'deleted')
       ORDER BY created_at, id LIMIT 1`,
    )[0];
    let organizationId: string;
    if (awaiting) {
      organizationId = String(awaiting["id"]);
      this.db.sqlite
        .prepare("UPDATE organizations SET name = ? WHERE id = ?")
        .run(name, organizationId);
    } else {
      organizationId = `org-${randomUUID()}`;
      this.db.sqlite
        .prepare("INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
        .run(organizationId, name, name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), now);
    }
    this.db.sqlite
      .prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
      )
      .run(`member-${randomUUID()}`, organizationId, userId, now);
    // The apps nobody has access to: their initial access found no one.
    for (const app of this.db.all(
      `SELECT id FROM apps a WHERE a.organization_id = ? AND a.status != 'deleted'
         AND NOT EXISTS (SELECT 1 FROM user_app_access u WHERE u.app_row_id = a.id)`,
      organizationId,
    )) {
      this.db.sqlite
        .prepare(
          "INSERT INTO user_app_access (id, user_id, app_row_id, organization_id) VALUES (?, ?, ?, ?)",
        )
        .run(randomUUID(), userId, String(app["id"]), organizationId);
    }
    this.db.sqlite
      .prepare("UPDATE owner_setup_tokens SET consumed_at = ?, consumed_by = ? WHERE id = ?")
      .run(now, userId, String(link["id"]));
    return { userId, organizationId };
  }
}
