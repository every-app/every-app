/**
 * `everyapp dev` — run the app behind a local gateway-lite that exercises the
 * real perimeter: real public-route policy, real header strip/inject, a
 * real RS256 identity JWT (the SDK's well-known dev keypair), CSRF rules, and
 * a session. The app runs under `cf dev` (or the manifest's `dev` command;
 * hot reload intact); the gateway proxies in front of it, exactly like
 * production. Nothing is written into the app: `everyAppWorker()` hands the
 * dev Worker the dev public key and issuer itself.
 *
 * Three session sources (--mode, or EVERYAPP_DEV_MODE; flag wins):
 *  - stub   (default): a seeded dev user. Zero setup; works on bare localhost.
 *  - mirror: a REAL Better Auth session resolved from a SEPARATELY-running
 *            local gateway (run `pnpm dev` in apps/every-app-gateway first).
 *            The real launcher/login is forwarded to it. Requires a two-label
 *            base host so the session cookie crosses the subdomain boundary.
 *  - linked: a real Gateway (`--gateway https://…`, docs/design/linked-dev.md):
 *            the CLI signs in there once (the native sign-in flow, bound to this
 *            app), you are that owner or admin, and the app's AI, capability,
 *            email, members and event calls go through that Gateway through a
 *            loopback forwarder here (./linked.ts). Data stays local.
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
 *
 * Ctrl+C stops the app's dev server and says so (exit 130), through the
 * interrupt handler (lib/interrupt.ts) that also stops a migration's cf.
 */
import http from "node:http";
import { ManifestError } from "@every-app/perimeter/manifest";
import { devProviderFile, isCapabilityId } from "@every-app/sdk/internal";
import type { SessionAuthenticator } from "@every-app/perimeter/dev";
import { getFreePort, waitForHttp, waitForUrl } from "./proxy";
import {
  checkMirrorBaseHost,
  DEFAULT_MIRROR_BASE_HOST,
  DEV_MODE_ENV,
  DevMode,
  resolveDevMode,
} from "./mode";
import { createRemoteAuthenticator } from "./remoteAuth";
import {
  createLinkedForwarder,
  createLinkedIdentity,
  newLinkedDevNonce,
  type LinkedForwarder,
} from "./linked";
import { gatewayOrigin, linkGateway, type LinkedSession, type LinkedWhoami } from "@/lib/linkedDev";
import { LINKED_DEV_FORWARD_PATH, LINKED_DEV_NONCE_ENV, LINKED_DEV_URL_ENV } from "@every-app/sdk/internal";
import { loadEveryAppManifest, type EveryAppCliManifest } from "@/lib/manifest";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { PINNED_CF_VERSION, resolveCfBinary } from "@/lib/cf/bin";
import { applyDevMigrations } from "./migrations";
import { startAppDevServer, type AppDevServer } from "./appServer";
import { assertPortFree, listen, serveGateway } from "./gatewayServer";
import { devProviderLookup, readyBlock } from "./ready";
import { readCloudflareConfig } from "@/lib/app/cloudflareConfig";
import { generateWorkerTypes, hasWorkerTypes } from "@/lib/app/workerTypes";
import { EveryAppError } from "@/lib/errors";
import { isInterrupted, onInterrupt, sayOnInterrupt } from "@/lib/interrupt";
import type { EventSink } from "@/lib/output/events";
import { CLI } from "@/lib/output/command";
import { eventSink, runReported } from "@/lib/output/run";

interface DevCommandFlags {
  port?: number;
  host?: string;
  mode?: string;
  gateway?: string;
  baseHost?: string;
  "skip-migrations"?: boolean;
  /** The run has no --json of its own; `dev link --json` hands the sign-in URL to an agent. */
  json?: boolean;
}

/** Seams the tests use for linked mode. */
export interface LinkedDevSeams {
  /** Signs in (or reads the stored token) and answers the session; `linkGateway` by default. */
  link?: (options: { gateway: string; appId: string; out: EventSink; json?: boolean }) => Promise<LinkedSession>;
  fetchImpl?: typeof fetch;
}

const DEFAULT_GATEWAY_URL = "http://localhost:3000";
/** Loopback only, unless --host: the dev keypair is public. */
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MIRROR_PROBE_MS = 5000;

export default async function dev(flags: DevCommandFlags,
): Promise<void> {
  const out = eventSink(flags.json ?? false);
  await runReported(out, () => runDev(flags, out));
}

/**
 * The whole run; returns once the app's dev server exits, or quietly when
 * Ctrl+C stopped it (the interrupt handler then exits).
 */
export async function runDev(
  flags: DevCommandFlags,
  out: EventSink,
  {
    cwd = process.cwd(),
    cf = createCfRunner(),
    env = process.env,
    linked: linkedSeams = {},
  }: { cwd?: string; cf?: CfRunner; env?: NodeJS.ProcessEnv; linked?: LinkedDevSeams } = {},
): Promise<void> {
  const mode = resolveDevMode(flags.mode, env[DEV_MODE_ENV], flags.gateway);
  const linkedGateway =
    mode === DevMode.Linked ? gatewayOrigin(requireLinkedGateway(flags.gateway, env)) : null;
  const gatewayUrl = linkedGateway ?? flags.gateway ?? DEFAULT_GATEWAY_URL;
  const mirrorBaseHost = flags.baseHost ?? DEFAULT_MIRROR_BASE_HOST;
  if (mode === DevMode.Mirror) checkMirrorBaseHost(mirrorBaseHost);

  const manifest = await loadManifest(cwd);
  warnOutsideCatalog(manifest, cwd, out);
  const cloudflareConfig = await readCloudflareConfig(cwd);
  if (!manifest.dev && !cloudflareConfig) {
    throw new EveryAppError(
      "MISSING_CLOUDFLARE_CONFIG",
      [
        "No cloudflare.config.ts in this directory",
        "EveryApp apps build their Worker in cloudflare.config.ts with everyAppWorker() from @every-app/sdk/cloudflare.",
      ].join("\n"),
      { data: { fix: "copy cloudflare.config.ts from starter/" } },
    );
  }

  const host = flags.host ?? DEFAULT_HOST;
  const port = flags.port ?? (env["PORT"] ? Number(env["PORT"]) : DEFAULT_PORT);
  await assertPortFree(port, host);

  const cfBinary = await resolveCfBinary(cwd);
  if (cfBinary.source === "project" && cfBinary.version !== PINNED_CF_VERSION) {
    out.emit({
      type: "warning",
      code: "CF_VERSION_DIFFERS",
      message: `Using the app's cf ${cfBinary.version}; everyapp is tested with ${PINNED_CF_VERSION}`,
      data: { version: cfBinary.version, tested: PINNED_CF_VERSION },
    });
  }

  // Ctrl+C: stop what runs, then say so.
  let appServer: AppDevServer | undefined;
  let started = false;
  const forgetInterrupt = onInterrupt({
    sync: () => appServer?.stop(),
    async: async () => {
      await appServer?.exited;
      out.emit({
        type: "step",
        step: "dev.stop",
        status: "ok",
        data: { appId: manifest.id, started },
      });
    },
  });
  let unsay = sayOnInterrupt(manifest.id);
  const stopping = (what: string) => {
    unsay();
    unsay = sayOnInterrupt(what);
  };
  const stopOnExit = () => appServer?.stop();
  process.on("exit", stopOnExit);

  try {
    // Mirror mode: the gateway must be running separately. Fail fast with
    // guidance rather than producing 401s later.
    if (mode === DevMode.Mirror) await probeGateway(gatewayUrl, out);

    // Linked mode: sign in (or read the stored token) and ask the Gateway
    // who this is, before anything starts: a refused token stops here.
    let linked: { session: LinkedSession; who: LinkedWhoami; forwarder: LinkedForwarder; nonce: string } | null =
      null;
    if (linkedGateway) {
      const session = await (linkedSeams.link ?? linkGateway)({
        gateway: linkedGateway,
        appId: manifest.id,
        out,
        json: flags.json,
      });
      const who = await session.whoami();
      const nonce = newLinkedDevNonce();
      linked = {
        session,
        who,
        nonce,
        forwarder: createLinkedForwarder(session, nonce, { fetchImpl: linkedSeams.fetchImpl }),
      };
      out.emit({
        type: "step",
        step: "dev.link",
        status: "ok",
        message: `Linked to ${linkedGateway} as ${who.user.email} (${who.role} of ${who.organization.name}) for ${who.app.name}.`,
        data: {
          gateway: linkedGateway,
          appId: manifest.id,
          email: who.user.email,
          role: who.role,
          organization: who.organization.name,
          connectionId: who.connection.id,
        },
      });
    }

    // The app's typed Env, on a fresh clone. Later config changes regenerate
    // it through the app's own `types:check` script.
    if (cloudflareConfig && !(await hasWorkerTypes(cwd))) {
      out.emit({ type: "step", step: "dev.types", status: "start", message: "Generating Worker types..." });
      await generateWorkerTypes(cf, cwd);
      out.emit({ type: "step", step: "dev.types", status: "ok", message: "Generated the Worker's types (.cloudflare/types)." });
    }

    // Pending local migrations go in before the app starts, so a fresh
    // clone's first page load doesn't hit an empty database.
    stopping("the local migrations");
    await applyDevMigrations({
      cwd,
      manifest,
      cf,
      out,
      skip: flags["skip-migrations"] ?? false,
    });
    stopping(manifest.id);

    // The app's dev server on an internal port (hot reload intact); the
    // gateway-lite is the only thing you talk to directly.
    const appPort = await getFreePort();
    out.emit({
      type: "step",
      step: "dev.app",
      status: "start",
      message: manifest.dev
        ? `Starting ${manifest.id} with its dev command...`
        : `Starting ${manifest.id}...`,
      data: { appPort },
    });
    // The launcher (stub mode) or the forwarded Gateway (mirror mode): what
    // the app's "back to Every App" links reach, through gatewayUrl(env).
    const launcherUrl = `http://${mode === DevMode.Mirror ? mirrorBaseHost : "localhost"}:${port}`;
    appServer = await startAppDevServer({
      cwd,
      manifest,
      cf,
      port: appPort,
      gatewayUrl: launcherUrl,
      ...(linked
        ? {
            // The forwarder under the app's own host on the gateway-lite,
            // and this run's nonce; `everyAppWorker()` hands both to the
            // dev Worker, and the SDK's gatewayBinding() builds the shim.
            env: {
              [LINKED_DEV_URL_ENV]: `http://${manifest.id}.localhost:${port}${LINKED_DEV_FORWARD_PATH}`,
              [LINKED_DEV_NONCE_ENV]: linked.nonce,
            },
          }
        : {}),
    });
    const server = http.createServer();
    try {
      await waitForAppServer(appServer, appPort, manifest).catch(
        async (error: unknown) => {
          if (!isInterrupted()) {
            // Why it didn't start is in what it printed.
            out.emit({ type: "step", step: "dev.app", status: "fail" });
            appServer!.stop();
            await appServer!.exited;
            appServer!.releaseOutput(true);
          }
          throw error;
        },
      );
      const address = await listen(server, port, host);
      // Mirror mode routes by <app>.<baseHost>; stub mode by <app>.localhost.
      const appUrl =
        mode === DevMode.Mirror
          ? `http://${manifest.id}.${mirrorBaseHost}:${address.port}`
          : `http://${manifest.id}.localhost:${address.port}`;
      const loginUrl = `http://${mirrorBaseHost}:${address.port}`;
      const linkedIdentity = linked ? createLinkedIdentity(linked.session, { out }) : null;
      serveGateway(server, {
        manifest,
        mode,
        mirrorBaseHost,
        gatewayUrl: mode === DevMode.Mirror ? new URL(gatewayUrl) : null,
        authenticator: linkedIdentity?.authenticator ?? mirrorAuthenticator(mode, gatewayUrl, loginUrl, out),
        ...(linked ? { linked: linked.forwarder } : {}),
        appPort,
        appUrl,
        out,
      });

      started = true;
      stopping("");
      out.emit({
        type: "step",
        step: "dev.app",
        status: "ok",
        message: readyBlock({
          manifest,
          mode,
          appUrl,
          appPort,
          gatewayUrl,
          loginUrl,
          crons: cloudflareConfig?.hasCrons ?? false,
          cwd,
          ...(linked
            ? {
                linked: {
                  email: linked.who.user.email,
                  role: linked.who.role,
                  organization: linked.who.organization.name,
                  appName: linked.who.app.name,
                },
              }
            : {}),
        }),
        data: { appId: manifest.id },
      });
      appServer.releaseOutput(false);
      out.emit({
        type: "step",
        step: "dev.ready",
        status: "ok",
        data: {
          mode,
          appUrl,
          mcpUrl: `${appUrl}/mcp`,
          host: address.address,
          port: address.port,
          appPort,
          ...(linkedGateway ? { gateway: linkedGateway } : {}),
        },
      });
      if (mode !== DevMode.Mirror && !isLoopback(address.address)) {
        out.emit({
          type: "warning",
          code: "DEV_EXPOSED",
          message: linked
            ? `Listening on ${address.address}: anyone who can reach port ${address.port} acts as ${linked.who.user.email} and spends on ${linked.who.organization.name}'s providers`
            : `Listening on ${address.address}: anyone who can reach port ${address.port} gets in as the dev user`,
        });
      }
      out.emit({
        type: "progress",
        step: "dev.session",
        message: "Every request goes through the real perimeter. Ctrl+C to stop.",
      });

      await appServer.exited;
    } finally {
      server.close();
    }
  } catch (error) {
    // Ctrl+C ended the run: the interrupt handler says so.
    if (isInterrupted()) return;
    appServer?.stop();
    throw error;
  } finally {
    process.off("exit", stopOnExit);
    unsay();
    forgetInterrupt();
  }
}

/** Linked mode's Gateway: `--gateway`, else EVERYAPP_GATEWAY_URL; nothing else will do. */
function requireLinkedGateway(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const gateway = flag ?? env["EVERYAPP_GATEWAY_URL"];
  if (gateway) return gateway;
  throw new EveryAppError(
    "LINKED_DEV_GATEWAY_REQUIRED",
    "--mode linked needs the Gateway's URL\nPass --gateway https://<your gateway>, or set EVERYAPP_GATEWAY_URL.",
    { data: { fix: "pass --gateway <url>" } },
  );
}

/** The app's manifest: MANIFEST_NOT_FOUND without one, as every command says it. */
async function loadManifest(cwd: string): Promise<EveryAppCliManifest> {
  try {
    return await loadEveryAppManifest(cwd);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new EveryAppError(
        "INVALID_MANIFEST",
        `everyapp.config.ts isn't valid\n${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * dev can't ask a Gateway which providers it registered, so it validates
 * with any well-formed capability id and says so for each id outside the
 * built-in catalog: reached locally from `.everyapp/providers/<id>.json`
 * (with the key in .dev.vars) when that file has its spec, and checked
 * against the Gateway's registry by the deploy.
 */
function warnOutsideCatalog(manifest: EveryAppCliManifest, cwd: string, out: EventSink): void {
  const lookup = devProviderLookup(cwd);
  for (const id of Object.keys(manifest.capabilities ?? {})) {
    if (isCapabilityId(id)) continue;
    const file = devProviderFile(id);
    const found = lookup.get(id) !== undefined;
    out.emit({
      type: "warning",
      code: "CAPABILITY_NOT_IN_CATALOG",
      message: found
        ? `${id} isn't in the built-in provider catalog\nThis run reaches it from ${file} with your key from .dev.vars; the deploy checks it against the Gateway's registered providers.`
        : `${id} isn't in the built-in provider catalog\nIf it's registered on your Gateway, ${CLI} provider show ${id} --save writes ${file}, which this run reaches it from (start dev again after). The deploy checks it against the Gateway's registered providers.`,
      data: {
        id,
        file,
        found,
        ...(found ? {} : { fix: `${CLI} provider show ${id} --save` }),
      },
    });
  }
}

async function probeGateway(gatewayUrl: string, out: EventSink): Promise<void> {
  out.emit({
    type: "step",
    step: "dev.gateway",
    status: "start",
    message: `Looking for the local Gateway at ${gatewayUrl}...`,
  });
  try {
    // Probe the gateway URL as given so its own hostname resolution applies
    // (a gateway on localhost:3000 is reached whether it bound IPv4 or IPv6).
    await waitForUrl(gatewayUrl, MIRROR_PROBE_MS);
  } catch {
    out.emit({ type: "step", step: "dev.gateway", status: "fail" });
    throw new EveryAppError(
      "MIRROR_GATEWAY_UNREACHABLE",
      `No local Gateway at ${gatewayUrl}\nSee "mirror mode" in docs/TESTING.md.`,
      {
        data: {
          gatewayUrl,
          fix: "run pnpm dev in apps/every-app-gateway, or pass --gateway <url>",
        },
      },
    );
  }
  out.emit({ type: "step", step: "dev.gateway", status: "ok", data: { gatewayUrl } });
}

/** Mirror mode's session source: the separately-run Gateway. */
function mirrorAuthenticator(
  mode: DevMode,
  gatewayUrl: string,
  loginUrl: string,
  out: EventSink,
): SessionAuthenticator | undefined {
  if (mode !== DevMode.Mirror) return undefined;
  return createRemoteAuthenticator({
    gatewayUrl,
    loginUrl,
    onHint: (message) =>
      out.emit({ type: "warning", code: "MIRROR_SESSION", message }),
  });
}

async function waitForAppServer(
  appServer: AppDevServer,
  appPort: number,
  manifest: EveryAppCliManifest,
): Promise<void> {
  const startup = await Promise.race([
    waitForHttp(appPort).then(
      () => "up" as const,
      () => "timeout" as const,
    ),
    appServer.exited.then(() => "exited" as const),
  ]);
  if (startup === "up") return;
  if (startup === "exited") {
    throw new EveryAppError(
      "DEV_SERVER_FAILED",
      `${manifest.id}'s dev server exited before it was ready\nIts output is above.`,
    );
  }
  throw new EveryAppError(
    "DEV_SERVER_TIMEOUT",
    `${manifest.id}'s dev server didn't start listening in time\nIt must listen on the port everyapp passes in PORT.`,
    {
      data: {
        appPort,
        fix: manifest.dev
          ? `make its dev command (${manifest.dev}) listen on the port in PORT`
          : "in vite.config.ts, set server.port: Number(process.env.PORT)",
      },
    },
  );
}

function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.");
}
