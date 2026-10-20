/**
 * The gateway-lite's HTTP server: the real perimeter with this app
 * registered. In mirror mode the seeded authenticator is replaced by the
 * RemoteAuthenticator, and bare-base-host traffic (launcher, login,
 * /api/auth, admin, HMR) goes to the separately-run gateway so login and UI
 * are the real thing. /mcp goes to a local ToolBus serving the app's live
 * tool catalog, and POST /__everyapp/cron runs one of the app's crons.
 */
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import {
  mintDevIdentityJwt,
  mintDevPublicMarkerJwt,
  parseHost,
  type SessionAuthenticator,
} from "@every-app/perimeter/dev";
import { errorMessage, EveryAppError } from "@/lib/errors";
import type { EveryAppCliManifest } from "@/lib/manifest";
import type { EventSink } from "@/lib/output/events";
import { createDevAppGateway } from "./devAppGateway";
import { devLauncherHtml } from "./launcherPage";
import { classifyHost, DevMode } from "./mode";
import {
  handleUpgrade,
  pipeUpgrade,
  toWebRequest,
  viteFetcher,
  writeWebResponse,
} from "./proxy";
import { registerDevApp } from "./registerDevApp";
import { replaceFlag } from "./rerun";

/** Where `curl -X POST <app>/__everyapp/cron -d '<schedule>'` runs a cron. */
export const CRON_PATH = "/__everyapp/cron";

/**
 * Fail before anything starts when `port` is taken, suggesting the next free
 * one. (The real listen comes once the app is up, and fails the same way if
 * something took the port meanwhile.)
 */
export async function assertPortFree(port: number, host: string): Promise<void> {
  const problem = await tryListen(port, host);
  if (problem) throw await portError(problem, port, host);
}

/** Listen on `port`; the address it got. */
export async function listen(
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
    throw await portError(error as NodeJS.ErrnoException, port, host);
  }
  return server.address() as AddressInfo;
}

function tryListen(
  port: number,
  host: string,
): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", resolve);
    probe.listen(port, host, () => probe.close(() => resolve(null)));
  });
}

async function portError(
  error: NodeJS.ErrnoException,
  port: number,
  host: string,
): Promise<EveryAppError> {
  if (error.code !== "EADDRINUSE") {
    return new EveryAppError(
      "DEV_PORT_UNAVAILABLE",
      `Can't listen on ${host}:${port}\n${error.message}`,
      { data: { port, host, fix: "pass another --port or --host" } },
    );
  }
  let free = port + 1;
  while (await tryListen(free, host)) free++;
  return new EveryAppError("DEV_PORT_IN_USE", `Port ${port} is already in use`, {
    rerun: replaceFlag("--port", String(free)),
    data: { port, host, free, error: error.message },
  });
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

/** Serve the gateway-lite on `server`, which already listens. */
export function serveGateway(
  server: http.Server,
  {
    manifest,
    mode,
    mirrorBaseHost,
    gatewayUrl,
    authenticator,
    appPort,
    appUrl,
    out,
  }: GatewayServerOptions,
): void {
  const app = registerDevApp(manifest);
  const problems = requestProblems(out);
  const appFetcher = viteFetcher(appPort);
  const handleRequest = createDevAppGateway({
    app,
    appName: manifest.name,
    appUrl,
    appFetcher: {
      // Why a request failed, for the terminal: the perimeter answers 502
      // and keeps the reason to itself.
      fetch: (request) =>
        appFetcher.fetch(request).catch((error: unknown) => {
          problems.failed(request.method, new URL(request.url).pathname, error);
          throw error;
        }),
    },
    authenticator,
    out,
  });
  const gatewayPort = Number(gatewayUrl?.port || 80);
  const gatewayFetcher = gatewayUrl
    ? viteFetcher(gatewayPort, gatewayUrl.hostname)
    : null;

  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    void (async () => {
      try {
        const hostHeader = req.headers.host ?? "";

        if (req.method === "POST" && req.url === CRON_PATH) {
          await writeWebResponse(
            res,
            await runCron(await readBody(req), appPort, app.workerName),
          );
          return;
        }

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
          if (cls.kind === "invalid" || cls.appLabel !== manifest.id) {
            misdirected(res, hostHeader, `${manifest.id}.${mirrorBaseHost}`);
            return;
          }
        }

        const parsed = parseHost(hostHeader || null);
        if (mode === DevMode.Stub && parsed) {
          // The bare base host is the minimal dev launcher.
          if (parsed.appLabel === "") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(devLauncherHtml(manifest.id, manifest.name, parsed.host));
            return;
          }
          // (An IP address names no app: the perimeter answers that.)
          if (
            parsed.appLabel !== manifest.id &&
            !net.isIP(parsed.host.replace(/:\d+$/, ""))
          ) {
            misdirected(
              res,
              hostHeader,
              `${manifest.id}.${parsed.baseHost.replace(/:\d+$/, "")}`,
            );
            return;
          }
        }

        const response = await handleRequest(toWebRequest(req));
        await writeWebResponse(res, response);
      } catch (error) {
        problems.failed(req.method ?? "GET", req.url ?? "/", error);
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

  /** 421: this server serves one app, on one host. */
  function misdirected(res: http.ServerResponse, host: string, served: string) {
    problems.misdirected(host, served);
    res.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
    res.end(`This dev server serves ${served}, not ${host}.\n`);
  }

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
}

/**
 * Run the dev Worker's scheduled() handler for `schedule` through the Vite
 * plugin's local explorer, on the app's own dev server.
 */
async function runCron(
  schedule: string,
  appPort: number,
  workerName: string,
): Promise<Response> {
  const cron = schedule.trim();
  if (!cron) {
    return new Response("Send the cron schedule as the body: -d '*/5 * * * *'\n", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return fetch(
    `http://127.0.0.1:${appPort}/cdn-cgi/local/explorer/api/local/scheduled?worker=${encodeURIComponent(workerName)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cron }),
    },
  );
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The gateway-lite's answers a person should hear about in the terminal,
 * not only in the response body: each distinct problem once.
 */
function requestProblems(out: EventSink) {
  const seen = new Set<string>();
  const once = (key: string, warn: () => void) => {
    if (seen.has(key)) return;
    seen.add(key);
    warn();
  };
  return {
    failed(method: string, path: string, error: unknown) {
      const reason = errorMessage(error);
      once(`failed\n${reason}`, () =>
        out.emit({
          type: "warning",
          code: "DEV_REQUEST_FAILED",
          message: `${method} ${path} failed in the local Gateway: ${reason}`,
          data: { method, path, status: 502 },
        }),
      );
    },
    misdirected(host: string, served: string) {
      once(`misdirected\n${host}`, () =>
        out.emit({
          type: "warning",
          code: "DEV_WRONG_HOST",
          message: `Request for ${host} refused: this dev server serves ${served}`,
          data: { host, served, status: 421 },
        }),
      );
    },
  };
}
