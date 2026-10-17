/**
 * `everyapp dev` — run the app behind a local gateway-lite that exercises the
 * real perimeter: real public-route policy, real header strip/inject, a
 * real RS256 identity JWT (the SDK's well-known dev keypair), CSRF rules, and
 * a session. The app runs under `cf dev` (or the manifest's `dev` command;
 * hot reload intact); the gateway proxies in front of it, exactly like
 * production. Nothing is written into the app: `everyAppWorker()` hands the
 * dev Worker the dev public key and issuer itself.
 *
 * Two session sources (--mode, or EVERYAPP_DEV_MODE; flag wins):
 *  - stub   (default): a seeded dev user. Zero setup; works on bare localhost.
 *  - mirror: a REAL Better Auth session resolved from a SEPARATELY-running
 *            local gateway (run `pnpm dev` in apps/every-app-gateway first).
 *            The real launcher/login is forwarded to it. Requires a two-label
 *            base host so the session cookie crosses the subdomain boundary.
 *
 * The gateway-lite listens on 127.0.0.1 unless --host says otherwise: the dev
 * keypair is public, so anything that reaches the port gets a dev identity.
 *
 * Honors $PORT (portless assigns one) and parses Host dynamically (first label
 * = app, remainder = base host), so per-worktree portless hosts route freely.
 *
 * `<app>.localhost/mcp` is served by a local ToolBus from the app's live
 * `defineTools()` catalog, with the gateway's policy and identity contract,
 * so MCP Inspector, Claude Code or curl can call the app's tools locally.
 */
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { LocalContext } from "@/context";
import { ManifestError } from "@every-app/perimeter/manifest";
import {
  mintDevIdentityJwt,
  mintDevPublicMarkerJwt,
  parseHost,
  DEV_USER,
  type SessionAuthenticator,
} from "@every-app/perimeter/dev";
import {
  getFreePort,
  handleUpgrade,
  pipeUpgrade,
  toWebRequest,
  viteFetcher,
  waitForHttp,
  waitForUrl,
  writeWebResponse,
} from "./proxy";
import {
  resolveDevMode,
  checkMirrorBaseHost,
  classifyHost,
  DEV_MODE_ENV,
  type DevMode,
} from "./mode";
import { createRemoteAuthenticator } from "./remoteAuth";
import { loadEveryAppManifest, type EveryAppCliManifest } from "@/lib/manifest";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { PINNED_CF_VERSION, resolveCfBinary } from "@/lib/cf/bin";
import { devLauncherHtml } from "./launcherPage";
import { registerDevApp } from "./registerDevApp";
import { createDevAppGateway } from "./devAppGateway";
import { applyDevMigrations } from "./migrations";
import { startAppDevServer, type AppDevServer } from "./appServer";
import { MISSING_CLOUDFLARE_CONFIG } from "@/lib/app/cloudflareConfig";
import { ensureWorkerTypes } from "@/lib/app/workerTypes";
import { EveryAppError } from "@/lib/errors";
import type { EventSink } from "@/lib/output/events";
import { eventSink, runReported } from "@/lib/output/run";

interface DevCommandFlags {
  port?: number;
  host?: string;
  mode?: string;
  gateway?: string;
  baseHost?: string;
  "skip-migrations"?: boolean;
}

const DEFAULT_GATEWAY_URL = "http://localhost:3000";
const DEFAULT_MIRROR_BASE_HOST = "everyapp.localhost";
/** Loopback only, unless --host: the dev keypair is public. */
const DEFAULT_HOST = "127.0.0.1";

export default async function dev(
  this: LocalContext,
  flags: DevCommandFlags,
): Promise<void> {
  const out = eventSink(false);
  await runReported(out, () => runDev(flags, out));
}

/** The whole run; returns once the app's dev server exits. */
export async function runDev(
  flags: DevCommandFlags,
  out: EventSink,
  {
    cwd = process.cwd(),
    cf = createCfRunner(),
  }: { cwd?: string; cf?: CfRunner } = {},
): Promise<void> {
  const mode = resolveDevMode(flags.mode, process.env[DEV_MODE_ENV]);
  const gatewayUrl = flags.gateway ?? DEFAULT_GATEWAY_URL;
  const mirrorBaseHost = flags.baseHost ?? DEFAULT_MIRROR_BASE_HOST;
  if (mode === "mirror") {
    const problem = checkMirrorBaseHost(mirrorBaseHost);
    if (problem) throw new EveryAppError("MIRROR_BASE_HOST", problem);
  }

  const manifest = await loadManifest(cwd);
  const hasCloudflareConfig = await fileExists(
    path.join(cwd, "cloudflare.config.ts"),
  );
  if (!manifest.dev && !hasCloudflareConfig) {
    throw new EveryAppError(
      "MISSING_CLOUDFLARE_CONFIG",
      MISSING_CLOUDFLARE_CONFIG,
    );
  }

  const cfBinary = await resolveCfBinary(cwd);
  if (cfBinary.source === "project" && cfBinary.version !== PINNED_CF_VERSION) {
    out.emit({
      type: "progress",
      step: "dev.cf",
      message: `Using the app's cf ${cfBinary.version} (this everyapp is tested with ${PINNED_CF_VERSION}).`,
      data: { version: cfBinary.version, tested: PINNED_CF_VERSION },
    });
  }

  // The app's typed Env, on a fresh clone. Later config changes regenerate
  // it through the app's own `types:check` script.
  if (hasCloudflareConfig && (await ensureWorkerTypes(cf, cwd))) {
    out.emit({
      type: "step",
      step: "dev.types",
      status: "ok",
      message: "Generated the Worker's types (.cloudflare/types).",
    });
  }

  // Pending local migrations go in before the app starts, so a fresh clone's
  // first page load doesn't hit an empty database.
  if (!flags["skip-migrations"]) {
    await applyDevMigrations({ cwd, manifest, cf, out });
  }

  // mirror mode: the gateway must be running separately. Fail fast with
  // guidance rather than producing silent 401s later.
  let authenticator: SessionAuthenticator | undefined;
  if (mode === "mirror") {
    try {
      // Probe the gateway URL as given so its own hostname resolution applies
      // (a gateway on localhost:3000 is reached whether it bound IPv4 or IPv6).
      await waitForUrl(gatewayUrl, 5000);
    } catch {
      throw new EveryAppError(
        "MIRROR_GATEWAY_UNREACHABLE",
        [
          `mirror mode: no gateway reachable at ${gatewayUrl}.`,
          "Start it first:  cd apps/every-app-gateway && pnpm dev",
          '(or pass --gateway <url>). See docs/TESTING.md "mirror mode".',
        ].join("\n"),
      );
    }
    authenticator = createRemoteAuthenticator({
      gatewayUrl,
      onHint: (message) =>
        out.emit({ type: "warning", code: "MIRROR_SESSION", message }),
    });
  }

  // The app's dev server on an internal port (hot reload intact); the
  // gateway-lite is the only thing you talk to directly.
  const appPort = await getFreePort();
  out.emit({
    type: "step",
    step: "dev.app",
    status: "start",
    message: manifest.dev
      ? `Starting the app's dev server (internal port ${appPort})...`
      : `Starting cf dev (internal port ${appPort})...`,
    data: { appPort },
  });
  const appServer = await startAppDevServer({
    cwd,
    manifest,
    cf,
    port: appPort,
  });
  const stop = () => appServer.stop();
  const signals = ["SIGINT", "SIGTERM", "exit"] as const;
  for (const signal of signals) process.on(signal, stop);
  try {
    await waitForAppServer(appServer, appPort);

    const gatewayPort =
      flags.port ?? (process.env["PORT"] ? Number(process.env["PORT"]) : 8787);
    // Mirror mode routes by <app>.<baseHost>; stub mode by <app>.localhost.
    const appUrl =
      mode === "mirror"
        ? `http://${manifest.id}.${mirrorBaseHost}:${gatewayPort}`
        : `http://${manifest.id}.localhost:${gatewayPort}`;
    const server = createGatewayServer({
      manifest,
      mode,
      mirrorBaseHost,
      gatewayUrl: mode === "mirror" ? new URL(gatewayUrl) : null,
      authenticator,
      appPort,
      appUrl,
      out,
    });
    const address = await listen(
      server,
      gatewayPort,
      flags.host ?? DEFAULT_HOST,
    );

    out.emit({
      type: "step",
      step: "dev.ready",
      status: "ok",
      message: readyMessage({
        manifest,
        mode,
        appUrl,
        appPort,
        gatewayUrl,
        host: address.address,
      }),
      data: {
        mode,
        appUrl,
        mcpUrl: `${appUrl}/mcp`,
        host: address.address,
        port: address.port,
        appPort,
      },
    });

    await appServer.exited;
    server.close();
  } catch (error) {
    stop();
    throw error;
  } finally {
    for (const signal of signals) process.off(signal, stop);
  }
}

async function loadManifest(cwd: string): Promise<EveryAppCliManifest> {
  try {
    return await loadEveryAppManifest(cwd);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new EveryAppError("INVALID_MANIFEST", error.message);
    }
    throw error;
  }
}

async function waitForAppServer(
  appServer: AppDevServer,
  appPort: number,
): Promise<void> {
  const startup = await Promise.race([
    waitForHttp(appPort).then(
      () => "up" as const,
      (error: unknown) => error,
    ),
    appServer.exited.then(() => "exited" as const),
  ]);
  if (startup === "up") return;
  throw new EveryAppError(
    "DEV_SERVER_FAILED",
    startup === "exited"
      ? "The app's dev server exited before it started listening."
      : `${String(startup)}\nIs the app's vite.config.ts taking its port from PORT (server.port: Number(process.env.PORT))?`,
  );
}

interface GatewayServerOptions {
  manifest: EveryAppCliManifest;
  mode: DevMode;
  mirrorBaseHost: string;
  /** Mirror mode's separately-run gateway. */
  gatewayUrl: URL | null;
  authenticator?: SessionAuthenticator;
  appPort: number;
  appUrl: string;
  out: EventSink;
}

/**
 * The gateway-lite: the real perimeter with this app registered. In mirror
 * mode the seeded authenticator is replaced by the RemoteAuthenticator, and
 * bare-base-host traffic (launcher, login, /api/auth, admin, HMR) goes to
 * the separately-run gateway so login and UI are the real thing. /mcp goes
 * to a local ToolBus serving the app's live tool catalog.
 */
function createGatewayServer({
  manifest,
  mode,
  mirrorBaseHost,
  gatewayUrl,
  authenticator,
  appPort,
  appUrl,
  out,
}: GatewayServerOptions): http.Server {
  const app = registerDevApp(manifest);
  const handleRequest = createDevAppGateway({
    app,
    appName: manifest.name,
    appUrl,
    appFetcher: viteFetcher(appPort),
    authenticator,
    out,
  });
  const gatewayPort = Number(gatewayUrl?.port || 80);
  const gatewayFetcher = gatewayUrl
    ? viteFetcher(gatewayPort, gatewayUrl.hostname)
    : null;

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const hostHeader = req.headers.host ?? "";

        if (gatewayFetcher) {
          // Resolve against the explicit base host: parseHost alone can't tell
          // the two-label base host from an app on a one-label base.
          const cls = classifyHost(hostHeader, mirrorBaseHost);
          if (cls.kind === "launcher") {
            // Real launcher / login / /api/auth — forward to the gateway.
            const response = await gatewayFetcher.fetch(toWebRequest(req));
            await writeWebResponse(res, response);
            return;
          }
          if (cls.kind === "invalid") {
            res.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
            res.end(
              checkMirrorBaseHost(
                parseHost(hostHeader)?.baseHost ?? hostHeader,
              ) ??
                `Unknown host "${hostHeader}" — expected <app>.${mirrorBaseHost}.`,
            );
            return;
          }
          // cls.kind === "app": fall through to the perimeter below.
        }

        const parsed = parseHost(hostHeader || null);
        // Stub: bare base host (no app label) = the minimal dev launcher.
        if (mode === "stub" && parsed && parsed.appLabel === "") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(devLauncherHtml(manifest.id, manifest.name, parsed.host));
          return;
        }

        const response = await handleRequest(toWebRequest(req));
        await writeWebResponse(res, response);
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
        }
        res.end(
          JSON.stringify({
            error: "dev_gateway_error",
            message: String(error),
          }),
        );
      }
    })();
  });

  // WebSocket upgrades. App-subdomain upgrades get the perimeter contract
  // (strip trust headers, inject identity). In mirror mode, bare-base-host
  // upgrades are the gateway's own HMR — forwarded untouched to the gateway.
  server.on("upgrade", (req, socket, head) => {
    if (
      gatewayUrl &&
      classifyHost(req.headers.host ?? "", mirrorBaseHost).kind === "launcher"
    ) {
      pipeUpgrade(req, socket, head, gatewayPort, {
        targetHost: gatewayUrl.hostname,
      });
      return;
    }
    void handleUpgrade(req, socket, head, {
      appId: manifest.id,
      appPort,
      publicRoutes: app.manifest.public,
      parseAppLabel: (host) => parseHost(host)?.appLabel ?? "",
      mintIdentity: async (request) => {
        if (authenticator) {
          // Resolve the real session from the upgrade cookie, then mint for it.
          const session = await authenticator.authenticate(request);
          if (!session) return null;
          return mintDevIdentityJwt(manifest.id, session);
        }
        return mintDevIdentityJwt(manifest.id);
      },
      mintPublicMarker: () => mintDevPublicMarkerJwt(manifest.id),
    });
  });

  return server;
}

async function listen(
  server: http.Server,
  port: number,
  host: string,
): Promise<AddressInfo> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    throw new EveryAppError(
      "DEV_PORT_UNAVAILABLE",
      `Could not listen on ${host}:${port}: ${error instanceof Error ? error.message : String(error)}. Pass --port <n> for another port.`,
    );
  }
  return server.address() as AddressInfo;
}

/** What's running and how to reach it, as one block. */
function readyMessage({
  manifest,
  mode,
  appUrl,
  appPort,
  gatewayUrl,
  host,
}: {
  manifest: EveryAppCliManifest;
  mode: DevMode;
  appUrl: string;
  appPort: number;
  gatewayUrl: string;
  host: string;
}): string {
  const explorer = `http://127.0.0.1:${appPort}/cdn-cgi/local/explorer`;
  const workerName = registerDevApp(manifest).workerName;
  return [
    "",
    `everyapp dev: the local gateway is running (${mode} mode)`,
    "",
    `  App:       ${appUrl}`,
    `  MCP:       ${appUrl}/mcp`,
    mode === "mirror"
      ? "             Send Authorization: Bearer <a personal access token from the local gateway>."
      : "             Send Authorization: Bearer <anything>; MCP clients act as the dev user.",
    // Crons (everyAppWorker's `crons`) run on demand through the Vite
    // plugin's local explorer, on the app's own dev server.
    `  Cron:      curl -X POST "${explorer}/api/local/scheduled?worker=${workerName}" -H 'content-type: application/json' -d '{"cron":"<schedule>"}'`,
    // Mail for email.inbound reaches the app's email() handler through
    // miniflare's local delivery endpoint on the app's own dev server (the
    // Vite plugin's; wrangler 4 had /cdn-cgi/handler/email instead).
    ...emailHint(manifest, appPort),
    // Workflows run under cf dev too; the explorer starts, inspects, pauses
    // and restarts their instances.
    ...(manifest.resources?.workflows?.length
      ? [`  Workflows: ${explorer}`]
      : []),
    ...(mode === "mirror"
      ? [
          `  Gateway:   ${gatewayUrl} (real login/launcher)`,
          "  Log in at the base host; the session cookie rides to the app subdomain.",
        ]
      : [
          `  Dev user:  ${DEV_USER.email} (seeded; org ${DEV_USER.orgId}, ${DEV_USER.orgRole})`,
        ]),
    ...(host === DEFAULT_HOST
      ? []
      : [
          `  Listening on ${host}: anyone who can reach this port gets a dev identity.`,
        ]),
    "  Real perimeter on every request (identity header, public-route policy, CSRF).",
    "  Public routes are auth-optional; to exercise them anonymously send the header",
    "  x-everyapp-dev-anon: 1 (curl) or set cookie everyapp_dev_anon=1 (browser).",
    "  Direct hits to the app's internal port get 401, by design.",
    "",
  ].join("\n");
}

/**
 * How to deliver a message to the app's email() handler locally, when the
 * manifest routes mail to it: the raw RFC 5322 message (with a Message-ID)
 * as the body, the envelope in the query. A catch-all's domain takes any
 * address.
 */
export function emailHint(
  manifest: Pick<EveryAppCliManifest, "email">,
  appPort: number,
): string[] {
  const first = manifest.email?.inbound?.[0];
  if (!first) return [];
  const to = first.replace(/^\*@/, "hello@");
  return [
    `  Email:     curl -X POST "http://127.0.0.1:${appPort}/cdn-cgi/local/email?from=someone@example.net&to=${to}" --data-binary @message.eml`,
    "             (message.eml: a raw message with From, To, Subject and Message-ID headers; email() gets no identity)",
  ];
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
