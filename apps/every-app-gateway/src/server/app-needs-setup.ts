/**
 * The perimeter's setup gate (`GatewayDeps.needsSetup`): an app whose
 * required settings aren't set doesn't open. The app lists already say
 * "Needs setup" and name the one command; this is what a request to the
 * app's own host gets meanwhile, so no one reaches a half-configured app
 * by its URL, and no public route of it serves either (the manifest weighs
 * `required` against its public surface).
 *
 * A person opening the app in a browser (a private HTML GET navigation) is
 * sent to the launcher's setup dialog for it (`?setup=<appId>`), which
 * says what to set and how. Everything else (a public route, an API call,
 * a fetch from a page, any other method) gets a 503 `app_needs_setup`
 * with no `retry-after`, since nothing about time fixes it, and never a
 * setting's name: the dialog and the CLI name them to people who may set
 * them. The answer is uncacheable.
 *
 * Readiness comes from app-setup.ts, cached by row, version and recorded
 * secret names; a refused app is logged once per isolate per row and
 * version, not per request. The result is recorded on the row after the
 * response (`apps.setup_state`, server/events/setup-state.ts), which
 * announces an app that came to need setup, or became ready.
 */
import { env } from "cloudflare:workers";
import {
  logEvent,
  withSecurityHeaders,
  type NeedsSetupInput,
} from "@every-app/perimeter";
import { appSettingsReport } from "./app-setup";
import { deferEventWork } from "./events/defer";
import { recordSetupState } from "./events/setup-state";

const LOGGED_MAX_ENTRIES = 500;
// Per isolate: the row+version pairs already logged as needing setup.
const logged = new Set<string>();

export function resetNeedsSetupLogForTests(): void {
  logged.clear();
}

function logOnce(input: NeedsSetupInput): void {
  const { app } = input;
  const key = `${app.rowId ?? app.appId}\0${app.versionId ?? ""}`;
  if (logged.has(key)) return;
  logged.add(key);
  if (logged.size > LOGGED_MAX_ENTRIES) {
    const oldest = logged.values().next().value;
    if (oldest !== undefined) logged.delete(oldest);
  }
  logEvent("app.needs_setup", { app: app.appId, org: app.organizationId });
}

/**
 * A browser loading a page, as opposed to a page's own fetch() (which says
 * `Sec-Fetch-Mode: cors`) or a client that asked for JSON: the one case a
 * redirect helps, since a person is there to read the dialog.
 */
function isHtmlNavigation(request: Request): boolean {
  return (
    request.method === "GET" &&
    (request.headers.get("accept") ?? "").includes("text/html") &&
    request.headers.get("sec-fetch-mode") !== "cors"
  );
}

/**
 * Null when the app opens: it is ready, declares nothing to set, or runs
 * on the dispatch tier (the platform checks those at deploy). Else the
 * response the perimeter answers with.
 */
export async function refuseUnreadyApp(
  input: NeedsSetupInput,
): Promise<Response | null> {
  const { app, request, publicRoute } = input;
  const report = await appSettingsReport({
    // A row from D1 always has its id; the app id stands in for one that
    // doesn't, so the cache still has a key.
    rowId: app.rowId ?? app.appId,
    versionId: app.versionId ?? null,
    secretNames: app.secretNames ?? null,
    appId: app.appId,
    tier: app.tier,
    manifest: app.manifest,
    canFix: false,
  });
  if (report && app.rowId) {
    const rowId = app.rowId;
    deferEventWork(() =>
      recordSetupState({
        rowId,
        organizationId: app.organizationId,
        appId: app.appId,
        name: app.manifest.name ?? app.appId,
        ready: report.ready,
        unmet: report.unmet.flatMap((setting) => setting.names),
      }),
    );
  }
  const ready = report?.ready ?? true;
  if (ready) return null;
  logOnce(input);

  if (!publicRoute && isHtmlNavigation(request)) {
    return withSecurityHeaders(
      new Response(null, {
        status: 302,
        headers: {
          location: `${env.GATEWAY_URL}/?setup=${encodeURIComponent(app.appId)}`,
          "cache-control": "no-store",
        },
      }),
    );
  }
  return withSecurityHeaders(
    new Response(JSON.stringify({ error: "app_needs_setup", app: app.appId }), {
      status: 503,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    }),
  );
}
