/**
 * The Gateway's page where a member lets one app use their own connection
 * with nobody present (docs/design/2026-11-birds-decisions/888-background-oauth.md):
 *
 *   GET  /connect/<id>/background?app=<app id>&return=…
 *     → the page (the app, the account, the background sets and the app's
 *       `why`; Allow and Cancel), or first the normal connect when the
 *       member has no usable connection with those sets
 *   POST /connect/<id>/background      ← the page's own form
 *     → the grant recorded, 302 to `return`
 *
 * The app links here (`connectUrl({ background: true })`) and never draws
 * this consent itself. The form must come from this page (Sec-Fetch-Site
 * same-origin, else the gateway's Origin; the control-plane CSRF guard
 * checks the same) and the sets it names must still be the ones the app's
 * deployed manifest marks, so what was shown is what is granted.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  declaredScopeSets,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import type { CapabilityRequest } from "@every-app/perimeter/manifest";
import { backgroundSetsOf } from "@/server/capabilities/heldToken";
import { readBodyWithLimit } from "@/server/mcp-auth/body";
import { gatewayProviders } from "@/server/providers";
import { AppAccessRepository } from "@/server/repositories/AppAccessRepository";
import { AppRepository } from "@/server/repositories/AppRepository";
import { BackgroundGrantRepository } from "@/server/repositories/BackgroundGrantRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { announceGranted } from "./background";
import { escapeHtml, errorPage } from "./page";
import { flowOf } from "./tokens";

const TITLE = "Can't allow background use";
const MAX_FORM_BYTES = 4096;
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

type SignedIn = { id: string; email: string; org: { orgId: string } };

interface Deps {
  signedIn: (request: Request) => Promise<SignedIn | null>;
  safeReturnTo: (raw: string | null) => string;
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });
}

function gatewayOrigin(): string | null {
  try {
    const raw = (env as { GATEWAY_URL?: string }).GATEWAY_URL;
    return raw ? new URL(raw).origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** A native form POST from this page (the MCP consent page's rule). */
function fromThisPage(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = gatewayOrigin();
  return (
    origin !== null && request.headers.get("origin")?.toLowerCase() === origin
  );
}

/** What the page offers, or the page to show instead. */
type Prepared =
  | {
      ok: true;
      capability: OAuthClientCapability;
      app: { rowId: string; slug: string; name: string };
      why: string;
      sets: string[];
      connection: { id: string; label: string | null } | null;
      /** The connection lacks a background set, is expired, or is missing. */
      needsConnect: boolean;
    }
  | { ok: false; response: Response };

async function prepare(
  id: string,
  appSlug: string | null,
  person: SignedIn,
): Promise<Prepared> {
  const fail = (status: number, message: string): Prepared => ({
    ok: false,
    response: errorPage(status, TITLE, message),
  });
  const registry = await gatewayProviders();
  const capability = registry.get(id);
  if (
    !capability ||
    capability.mode !== "oauth_client" ||
    !flowOf(capability)
  ) {
    return fail(404, `No OAuth provider ${id} is on this Gateway.`);
  }
  if (!appSlug || !APP_SLUG.test(appSlug)) {
    return fail(400, "app must name one of this workspace's apps.");
  }
  const org = person.org.orgId;
  const row = await AppRepository.findByAppSlug(appSlug, org);
  if (
    !row ||
    row.status === "deleted" ||
    row.status === "disabled" ||
    row.scope !== "org" ||
    row.tier !== "service_binding"
  ) {
    return fail(404, `No app ${appSlug} is in this workspace.`);
  }
  if (
    !(await AppAccessRepository.hasAccessByUserAndAppSlug(
      person.id,
      appSlug,
      org,
    ))
  ) {
    return fail(403, `You don't have access to ${row.name}.`);
  }
  const entry = manifestEntry(row.manifest, id);
  const policy = capability.scopePolicy;
  const declared =
    entry && policy
      ? declaredScopeSets(policy, { scopes: entry["scopes"] })
      : null;
  const sets = entry && declared ? backgroundSetsOf(entry, declared) : null;
  if (!entry || !sets) {
    return fail(
      409,
      `${row.name} doesn't ask to use ${capability.label} in the background.`,
    );
  }
  const why = (entry as { background?: { why?: unknown } }).background?.why;
  const connection = await ProviderConnectionRepository.find(
    org,
    id,
    person.id,
  );
  const needsConnect =
    !connection ||
    connection.status === "expired" ||
    sets.some((set) => !connection.scopeSets.includes(set));
  return {
    ok: true,
    capability,
    app: { rowId: row.id, slug: row.appSlug, name: row.name },
    why: typeof why === "string" ? why.slice(0, 200) : "",
    sets,
    connection: connection
      ? { id: connection.id, label: connection.label }
      : null,
    needsConnect,
  };
}

function manifestEntry(
  manifest: string | null,
  id: string,
): CapabilityRequest | null {
  if (!manifest) return null;
  try {
    const parsed = JSON.parse(manifest) as {
      capabilities?: Record<string, unknown>;
    };
    const entry = parsed?.capabilities?.[id];
    return entry && typeof entry === "object"
      ? (entry as CapabilityRequest)
      : null;
  } catch {
    return null;
  }
}

function consentPage(input: {
  id: string;
  prepared: Extract<Prepared, { ok: true }>;
  returnTo: string;
  allowedAlready: boolean;
}): Response {
  const { capability, app, why, sets, connection } = input.prepared;
  const policy = capability.scopePolicy;
  const rows = sets
    .map((name) => {
      const set = policy?.sets[name];
      const label = set?.label ?? name;
      const writes = set?.access === "write";
      return `<li><strong>${escapeHtml(label)}</strong>: ${writes ? "can read, create and change" : "can read"}</li>`;
    })
    .join("");
  const account = connection?.label
    ? `${escapeHtml(capability.label)} account <strong>${escapeHtml(connection.label)}</strong>`
    : `${escapeHtml(capability.label)} account`;
  const body = `<h1>Let ${escapeHtml(app.name)} use your ${escapeHtml(capability.label)} account while you're away?</h1>
<p>${escapeHtml(app.name)} would use your ${account} when you don't have it open (scheduled and background work), for:</p>
<ul>${rows}</ul>
${why ? `<p>${escapeHtml(app.name)} says: “${escapeHtml(why)}”</p>` : ""}
<p class="small">It acts in your name only within these. It stops if you revoke it (Settings → Connected accounts), an owner or admin revokes it, you disconnect ${escapeHtml(capability.label)}, you lose access to ${escapeHtml(app.name)}, or you don't open ${escapeHtml(app.name)} for 90 days.${input.allowedAlready ? " You allowed this already; allowing again keeps it as shown." : ""}</p>
<form method="post" action="/connect/${encodeURIComponent(input.id)}/background">
<input type="hidden" name="app" value="${escapeHtml(app.slug)}">
<input type="hidden" name="sets" value="${escapeHtml(sets.join(","))}">
<input type="hidden" name="return" value="${escapeHtml(input.returnTo)}">
<button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="cancel" class="secondary">Cancel</button>
</form>`;
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Allow background use</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#1f2937}h1{font-size:1.25rem}p,li{color:#374151;line-height:1.5}.small{font-size:.875rem;color:#6b7280}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem;border-radius:.375rem;border:1px solid #1f2937;background:#1f2937;color:#fff;cursor:pointer}button.secondary{background:#fff;color:#1f2937}</style></head>
<body>${body}</body></html>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

/** GET: the page, or the connect first. */
export async function serveBackgroundStart(
  request: Request,
  id: string,
  deps: Deps,
): Promise<Response> {
  const url = new URL(request.url);
  const person = await deps.signedIn(request);
  if (!person) {
    const back = `${url.pathname}${url.search}`;
    return redirect(`/sign-in?redirect=${encodeURIComponent(back)}`);
  }
  const appSlug = url.searchParams.get("app");
  const prepared = await prepare(id, appSlug, person);
  if (!prepared.ok) return prepared.response;
  const returnTo = deps.safeReturnTo(url.searchParams.get("return"));
  if (prepared.needsConnect) {
    // Connected first (the union of the sets active apps declare), then
    // back here once; a provider that granted less ends on a page.
    if (url.searchParams.get("connected") === "1") {
      return errorPage(
        409,
        TITLE,
        `Your ${prepared.capability.label} connection doesn't include what ${prepared.app.name} asks for in the background (${prepared.sets.join(", ")}). Connect again and grant every permission it asks for.`,
      );
    }
    const back = new URL(`/connect/${encodeURIComponent(id)}/background`, url);
    back.searchParams.set("app", prepared.app.slug);
    back.searchParams.set("return", returnTo);
    back.searchParams.set("connected", "1");
    const connect = new URLSearchParams({
      return: `${back.pathname}${back.search}`,
    });
    return redirect(`/connect/${encodeURIComponent(id)}?${connect.toString()}`);
  }
  const existing = prepared.connection
    ? await BackgroundGrantRepository.findLive(
        prepared.connection.id,
        prepared.app.rowId,
      )
    : null;
  return consentPage({
    id,
    prepared,
    returnTo,
    allowedAlready:
      existing !== null &&
      prepared.sets.every((set) => existing.scopeSets.includes(set)),
  });
}

/** POST: the decision. */
export async function serveBackgroundDecision(
  request: Request,
  id: string,
  deps: Deps,
): Promise<Response> {
  if (!fromThisPage(request)) {
    return errorPage(
      403,
      TITLE,
      "This request didn't come from the Gateway's page.",
    );
  }
  const person = await deps.signedIn(request);
  if (!person) {
    return errorPage(
      401,
      TITLE,
      "Sign in to the Gateway, then start again from the app.",
    );
  }
  const raw = await readBodyWithLimit(request, MAX_FORM_BYTES);
  if (!raw) return errorPage(413, TITLE, "The form is too large.");
  const form = new URLSearchParams(new TextDecoder().decode(raw));
  const returnTo = deps.safeReturnTo(form.get("return"));
  const decision = form.get("decision");
  if (decision === "cancel") return redirect(returnTo);
  if (decision !== "allow") {
    return errorPage(400, TITLE, "The form didn't say Allow or Cancel.");
  }
  const prepared = await prepare(id, form.get("app"), person);
  if (!prepared.ok) return prepared.response;
  if (prepared.needsConnect || !prepared.connection) {
    return errorPage(
      409,
      TITLE,
      `Connect ${prepared.capability.label} first, then allow background use from the app again.`,
    );
  }
  // What was shown is what is granted: a manifest deployed in between
  // shows the page again.
  const shown = (form.get("sets") ?? "").split(",").filter(Boolean);
  if (
    shown.length !== prepared.sets.length ||
    prepared.sets.some((set) => !shown.includes(set))
  ) {
    const again = new URLSearchParams({
      app: prepared.app.slug,
      return: returnTo,
    });
    return redirect(`/connect/${encodeURIComponent(id)}/background?${again}`);
  }
  const grant = await BackgroundGrantRepository.grant({
    organizationId: person.org.orgId,
    providerId: id,
    connectionId: prepared.connection.id,
    appRowId: prepared.app.rowId,
    userId: person.id,
    scopeSets: prepared.sets,
  });
  await announceGranted(grant).catch((error: unknown) => {
    logEvent(
      "oauth.background_announce_failed",
      { error: error instanceof Error ? error.name : "unknown" },
      "warn",
    );
  });
  return redirect(returnTo);
}
