/**
 * `everyapp dev` — run the app behind a local gateway-lite that exercises the
 * real perimeter: real public-route policy, real header strip/inject, a
 * real RS256 identity JWT (local dev keypair), CSRF rules, and a session.
 * The app runs under `cf dev` (or the manifest's `dev` command; hot reload
 * intact); the gateway proxies in front of it, exactly like production.
 *
 * Two session sources (--mode, or EVERYAPP_DEV_MODE; flag wins):
 *  - stub   (default): a seeded dev user. Zero setup; works on bare localhost.
 *  - mirror: a REAL Better Auth session resolved from a SEPARATELY-running
 *            local gateway (run `pnpm dev` in apps/every-app-gateway first).
 *            The real launcher/login is forwarded to it. Requires a two-label
 *            base host so the session cookie crosses the subdomain boundary.
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
import path from "node:path";
import chalk from "chalk";
import type { LocalContext } from "@/context";
import { ManifestError } from "@every-app/perimeter/manifest";
import {
  mintDevIdentityJwt,
  mintDevPublicMarkerJwt,
  parseHost,
  DEV_USER,
  DEV_ISSUER,
  type SessionAuthenticator,
} from "@every-app/perimeter/dev";
import { ensureDevKeys, upsertDevVars } from "./devEnv";
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
  DevModeError,
  DEV_MODE_ENV,
  type DevMode,
} from "./mode";
import { createRemoteAuthenticator } from "./remoteAuth";
import { loadEveryAppManifest } from "@/lib/manifest";
import { createCfRunner } from "@/lib/cf/runner";
import { PINNED_CF_VERSION, resolveCfBinary } from "@/lib/cf/bin";
import { devLauncherHtml } from "./launcherPage";
import { registerDevApp } from "./registerDevApp";
import { createDevAppGateway } from "./devAppGateway";
import { applyDevMigrations } from "./migrations";
import { startAppDevServer } from "./appServer";
import { MISSING_CLOUDFLARE_CONFIG } from "@/lib/app/cloudflareConfig";
import { setExitCode } from "@/lib/exit-code";

interface DevCommandFlags {
  port?: number;
  mode?: string;
  gateway?: string;
  baseHost?: string;
  "skip-migrations"?: boolean;
}

const DEFAULT_GATEWAY_URL = "http://localhost:3000";
const DEFAULT_MIRROR_BASE_HOST = "everyapp.localhost";

function startingDevServerMessage(
  devCommand: string | undefined,
  appPort: number,
): string {
  return devCommand
    ? `Starting app dev server (internal port ${appPort})...`
    : `Starting cf dev (internal port ${appPort})...`;
}

export default async function dev(
  this: LocalContext,
  flags: DevCommandFlags,
): Promise<void> {
  const cwd = process.cwd();

  let mode: DevMode;
  try {
    mode = resolveDevMode(flags.mode, process.env[DEV_MODE_ENV]);
  } catch (error) {
    if (error instanceof DevModeError) {
      console.error(chalk.red(error.message));
      setExitCode(1);
      return;
    }
    throw error;
  }
  const gatewayUrl = flags.gateway ?? DEFAULT_GATEWAY_URL;
  const mirrorBaseHost = flags.baseHost ?? DEFAULT_MIRROR_BASE_HOST;
  if (mode === "mirror") {
    const problem = checkMirrorBaseHost(mirrorBaseHost);
    if (problem) {
      console.error(chalk.red(problem));
      setExitCode(1);
      return;
    }
  }

  let manifest;
  try {
    manifest = await loadEveryAppManifest(cwd);
  } catch (error) {
    if (error instanceof ManifestError) {
      console.error(chalk.red(error.message));
      setExitCode(1);
      return;
    }
    throw error;
  }
  if (
    !manifest.dev &&
    !(await fileExists(path.join(cwd, "cloudflare.config.ts")))
  ) {
    console.error(chalk.red(MISSING_CLOUDFLARE_CONFIG));
    setExitCode(1);
    return;
  }

  const cf = createCfRunner();
  const cfBinary = await resolveCfBinary(cwd);
  if (cfBinary.source === "project" && cfBinary.version !== PINNED_CF_VERSION) {
    console.log(
      chalk.dim(
        `  Using the app's cf ${cfBinary.version} (this everyapp is tested with ${PINNED_CF_VERSION}).`,
      ),
    );
  }

  // 2. Stable local keypair + .dev.vars so the app verifies real signatures.
  const keys = ensureDevKeys(cwd);
  upsertDevVars(cwd, keys.publicKeyPem);

  // 3. Apply pending local migrations before the app starts, so a fresh
  //    clone's first page load doesn't hit an empty database.
  if (
    !(await applyDevMigrations({
      cwd,
      manifest,
      cf,
      skipMigrations: flags["skip-migrations"] ?? false,
    }))
  ) {
    return;
  }

  const gatewayPort =
    flags.port ?? (process.env["PORT"] ? Number(process.env["PORT"]) : 8787);

  // 4. mirror mode: the gateway must be running separately. Fail fast with
  //    guidance rather than producing silent 401s later.
  let gatewayOrigin: URL | null = null;
  let authenticator: SessionAuthenticator | undefined;
  if (mode === "mirror") {
    gatewayOrigin = new URL(gatewayUrl);
    try {
      // Probe the gateway URL as given so its own hostname resolution applies
      // (a gateway on localhost:3000 is reached whether it bound IPv4 or IPv6).
      await waitForUrl(gatewayUrl, 5000);
    } catch {
      console.error(
        chalk.red(
          `mirror mode: no gateway reachable at ${gatewayUrl}.\n` +
            `Start it first:  cd apps/every-app-gateway && pnpm dev\n` +
            `(or pass --gateway <url>). See docs/TESTING.md "mirror mode".`,
        ),
      );
      setExitCode(1);
      return;
    }
    authenticator = createRemoteAuthenticator({
      gatewayUrl,
      onHint: (m) => console.log(chalk.yellow(`  ${m}`)),
    });
  }

  // 5. Start the app's dev server on an internal port (hot reload intact);
  //    the gateway-lite is the only thing you talk to directly.
  const appPort = await getFreePort();
  console.log(chalk.dim(startingDevServerMessage(manifest.dev, appPort)));
  const appServer = await startAppDevServer({
    cwd,
    manifest,
    cf,
    port: appPort,
  });
  const stop = () => appServer.stop();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", stop);

  const startup = await Promise.race([
    waitForHttp(appPort).then(
      () => "up" as const,
      (error: unknown) => error,
    ),
    appServer.exited.then(() => "exited" as const),
  ]);
  if (startup !== "up") {
    console.error(
      chalk.red(
        startup === "exited"
          ? "The app's dev server exited before it started listening."
          : `${String(startup)}\nIs the app's vite.config.ts taking its port from PORT (server.port: Number(process.env.PORT))?`,
      ),
    );
    stop();
    setExitCode(1);
    return;
  }

  // Mirror mode routes by <app>.<baseHost>; stub mode by <app>.localhost.
  const appUrl =
    mode === "mirror"
      ? `http://${manifest.id}.${mirrorBaseHost}:${gatewayPort}`
      : `http://${manifest.id}.localhost:${gatewayPort}`;

  // 6. The gateway-lite: the real perimeter with this app registered. In
  //    mirror mode the seeded authenticator is replaced by the RemoteAuthenticator.
  //    /mcp goes to a local ToolBus serving the app's live tool catalog.
  const app = registerDevApp(manifest);
  const handleRequest = createDevAppGateway({
    app,
    appName: manifest.name,
    appUrl,
    appFetcher: viteFetcher(appPort),
    privateKeyPem: keys.privateKeyPem,
    authenticator,
  });

  // In mirror mode, bare-base-host traffic (launcher, login, /api/auth, admin)
  // is forwarded to the separately-run gateway so login/UI are the real thing.
  const gatewayFetcher =
    mode === "mirror" && gatewayOrigin
      ? viteFetcher(Number(gatewayOrigin.port || 80), gatewayOrigin.hostname)
      : null;

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const hostHeader = req.headers.host ?? "";

        if (mode === "mirror" && gatewayFetcher) {
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
    if (mode === "mirror" && gatewayOrigin) {
      // Base-host upgrades are the gateway's own HMR — forward untouched.
      if (
        classifyHost(req.headers.host ?? "", mirrorBaseHost).kind === "launcher"
      ) {
        pipeUpgrade(req, socket, head, Number(gatewayOrigin.port || 80), {
          targetHost: gatewayOrigin.hostname,
        });
        return;
      }
    }
    void handleUpgrade(req, socket, head, {
      appId: manifest.id,
      appPort,
      publicRoutes: app.manifest.public,
      parseAppLabel: (host) => parseHost(host)?.appLabel ?? "",
      mintIdentity: async (request) => {
        if (mode === "mirror" && authenticator) {
          // Resolve the real session from the upgrade cookie, then mint for it.
          const session = await authenticator.authenticate(request);
          if (!session) return null;
          return mintDevIdentityJwt(
            keys.privateKeyPem,
            manifest.id,
            DEV_ISSUER,
            session,
          );
        }
        return mintDevIdentityJwt(keys.privateKeyPem, manifest.id, DEV_ISSUER);
      },
      mintPublicMarker: () =>
        mintDevPublicMarkerJwt(keys.privateKeyPem, manifest.id, DEV_ISSUER),
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(gatewayPort, resolve);
  });

  console.log("");
  console.log(
    chalk.bold(`  everyapp dev — gateway-lite running (${mode} mode)`),
  );
  console.log("");
  console.log(`  App:       ${chalk.cyan(appUrl)}`);
  console.log(`  MCP:       ${chalk.cyan(`${appUrl}/mcp`)}`);
  console.log(
    chalk.dim(
      mode === "mirror"
        ? "             Send Authorization: Bearer <a personal access token from the local gateway>."
        : "             Send Authorization: Bearer <anything>; MCP clients act as the dev user.",
    ),
  );
  if (mode === "mirror") {
    console.log(`  Gateway:   ${chalk.cyan(gatewayUrl)} (real login/launcher)`);
    console.log(
      chalk.dim(
        `  Log in at the base host; the session cookie rides to the app subdomain.`,
      ),
    );
  } else {
    console.log(
      `  Dev user:  ${chalk.cyan(DEV_USER.email)} (seeded; org ${DEV_USER.orgId}, ${DEV_USER.orgRole})`,
    );
  }
  console.log(
    chalk.dim(
      `  Real perimeter on every request (identity header, public-route policy, CSRF).`,
    ),
  );
  console.log(
    chalk.dim(
      `  Public routes are auth-optional; to exercise them anonymously send the header ` +
        `x-everyapp-dev-anon: 1 (curl) or set cookie everyapp_dev_anon=1 (browser).`,
    ),
  );
  console.log(
    chalk.dim(`  Direct hits to the app's internal port get 401 — by design.`),
  );
  console.log("");

  await appServer.exited;
  server.close();
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
