/**
 * `everyapp deploy --gateway <url>` with EVERYAPP_DEPLOY_TOKEN: a third-party app
 * deployed through the hosted gateway's deploy API, with no Cloudflare
 * login (CI sets EVERYAPP_DEPLOY_TOKEN and EVERYAPP_GATEWAY_URL):
 *
 *   1. ask the gateway who the deploy key is (its organization), then
 *      register the app id with its manifest, which the gateway checks
 *      against the hosted policy before anything is built;
 *   2. build the app as `deploy` does: the tenant-neutral build, whose
 *      Worker name, organization, gateway, identity key and resource ids
 *      are placeholders (`sentinelDeployTarget()`, @every-app/sdk/cloudflare)
 *      the gateway's deployer installs, so nothing secret is in the build;
 *      check the Build Output, uninstalled, against the app policy and the
 *      schema against the migrations;
 *   3. upload the Build Output, manifest, migrations and stamp, and follow
 *      the deploy job until it ends.
 *
 * From an app release (`everyapp deploy <github url | tarball>`, ./
 * index.ts) there is nothing to build: its Build Output is checked against
 * the policy the same way, its manifest registers the app, and it uploads
 * the same way; the schema check ran where the release was packed.
 *
 * The gateway creates the app's D1, applies its migrations, uploads its
 * Worker into the dispatch namespace and records it; nothing here touches
 * Cloudflare.
 */
import { sentinelDeployTarget } from "@every-app/sdk/cloudflare";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { buildApp } from "@/lib/app/buildApp";
import { appSdkVersion, packageHostedBundle } from "@/lib/app/hostedBundle";
import { describeAppOrigin, type AppRelease } from "@/lib/app/release";
import { prepareAppBuildOutput } from "@/lib/app/policy";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { errorMessage, EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { roughly } from "@/lib/output/time";
import type { EventSink } from "@/lib/output/events";
import { installDependencies } from "@/lib/package-manager";
import { NEVER_LIVE } from "./deployApp";
import { checkSchemaDrift } from "./steps/checkSchemaDrift";

const POLL_INTERVAL_MS = 2_000;
// A little past the gateway's job deadline (5 minutes), after which it
// reports the job abandoned.
const POLL_TIMEOUT_MS = 6 * 60 * 1000;

/** The flags a hosted deploy has no use for: the gateway decides these. */
const SELF_HOST_ONLY_FLAGS = [
  "account-id",
  "allow-delete-durable-object-data",
  "allow-delete-workflows",
  "enable-email-routing",
  "force-dns",
  "shared",
  "yes",
] as const;

/**
 * Where a deploy goes when EVERYAPP_DEPLOY_TOKEN is set: the gateway `--gateway`
 * or EVERYAPP_GATEWAY_URL names, through its deploy API. Null without the
 * token (the self-host deploy, unchanged). With the token but no gateway
 * URL, or with a flag only the self-host deploy takes, it refuses rather
 * than guess which deploy was meant. A variable of its own, not
 * EVERYAPP_TOKEN: self-hosters export that as their MCP bearer
 * (docs/todo-mcp-example.md), and their deploys must not change with it.
 */
export function hostedDeployTarget(
  flags: { gateway?: string } & Partial<Record<(typeof SELF_HOST_ONLY_FLAGS)[number], unknown>>,
  env: NodeJS.ProcessEnv = process.env,
): { gatewayUrl: string; token: string } | null {
  const token = env["EVERYAPP_DEPLOY_TOKEN"]?.trim();
  if (!token) return null;
  if (!flags.gateway) {
    throw new EveryAppError(
      "GATEWAY_URL_REQUIRED",
      "EVERYAPP_DEPLOY_TOKEN is set, but no hosted Gateway is named",
      {
        fix: "add --gateway <url> (or set EVERYAPP_GATEWAY_URL); to use your own Gateway, unset the token",
      },
    );
  }
  const used = SELF_HOST_ONLY_FLAGS.filter((flag) => flags[flag] !== undefined && flags[flag] !== false);
  if (used.length > 0) {
    const one = used.length === 1;
    throw new EveryAppError(
      "FLAG_NOT_FOR_HOSTED_DEPLOY",
      `--${used.join(", --")} only work${one ? "s" : ""} with your own Gateway\nA hosted Gateway decides ${one ? "that" : "those"} itself.`,
      { rerun: `${CLI} deploy --gateway ${flags.gateway}` },
    );
  }
  return { gatewayUrl: flags.gateway, token };
}

interface DeployToGatewayOptions {
  cwd: string;
  manifest: EveryAppCliManifest;
  /** Deploy this app release instead of building the app in `cwd`. */
  release?: AppRelease;
  gatewayUrl: string;
  /** EVERYAPP_DEPLOY_TOKEN: a deploy key. */
  token: string;
  out: EventSink;
  verbose?: boolean;
  /** Follow the job until it ends (default); `--no-wait` returns once it started. */
  wait?: boolean;
  /** Seams for tests. */
  fetch?: typeof fetch;
  createCf?: () => CfRunner;
  installDeps?: typeof installDependencies;
  sleep?: (ms: number) => Promise<void>;
}

interface DeployToGatewayResult {
  liveUrl: string | null;
  workerName: string;
  versionId: string | null;
  jobId: string;
  status: string;
  /** The Gateway says the app is active. */
  live: boolean;
}

interface JobBody {
  id: string;
  status: "running" | "succeeded" | "failed";
  error: { code: string; message: string } | null;
  app: {
    workerName: string;
    hostname: string | null;
    url: string | null;
    status: string;
    versionId: string | null;
  } | null;
}

export async function deployToGateway(
  options: DeployToGatewayOptions,
): Promise<DeployToGatewayResult> {
  const { cwd, manifest, gatewayUrl, out } = options;
  const host = new URL(gatewayUrl).host;
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const rerun = `${CLI} deploy --gateway ${gatewayUrl}`;

  const call = async <T>(pathname: string, init: RequestInit = {}): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${gatewayUrl}${pathname}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${options.token}` },
      });
    } catch (error) {
      throw new EveryAppError("GATEWAY_UNREACHABLE", `${host} didn't answer\n${errorMessage(error)}`, {
        retryable: true,
        rerun,
      });
    }
    const body = (await response.json().catch(() => null)) as
      | (T & { error?: string; message?: string })
      | null;
    if (response.ok && body) return body;
    // A gateway without the launch gate has no such route.
    if (response.status === 404 && pathname === "/api/v1/deploy-key") {
      throw new EveryAppError(
        "DEPLOY_API_UNAVAILABLE",
        `${host} doesn't take deploys from other accounts\nIt has no deploy API.`,
        { fix: `to deploy to your own Gateway, unset EVERYAPP_DEPLOY_TOKEN and run ${CLI} deploy` },
      );
    }
    const code = body?.error ?? `HTTP_${response.status}`;
    if (response.status === 401 || response.status === 403) {
      throw new EveryAppError(
        code,
        `${host} refused the deploy (HTTP ${response.status})${body?.message ? `\n${body.message}` : ""}`,
        { fix: "check EVERYAPP_DEPLOY_TOKEN" },
      );
    }
    const retryable = response.status >= 500 || response.status === 409;
    throw new EveryAppError(
      code,
      `${host} couldn't deploy ${manifest.id} (HTTP ${response.status})${body?.message ? `\nIt said: ${body.message}` : ""}`,
      retryable ? { retryable, rerun, rerunNote: "to try again" } : {},
    );
  };

  // 1. Who the key is, then the app's registration (checked against the
  // hosted policy before the build).
  const key = await call<{ organizationId: string; userEmail: string }>("/api/v1/deploy-key");
  const orgPath = `/api/v1/orgs/${encodeURIComponent(key.organizationId)}`;
  const { app } = await call<{ app: { workerName: string; hostname: string | null; status: string } }>(
    `${orgPath}/apps`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: manifest.id, manifest }),
    },
  );
  const release = options.release;
  out.emit({
    type: "step",
    step: "app.deploy",
    status: "ok",
    message: `Deploying ${manifest.id}${release ? ` ${release.release.version} from ${describeAppOrigin(release.origin)}` : ""} to ${gatewayUrl}.`,
    data: {
      appId: manifest.id,
      gatewayHost: host,
      organizationId: key.organizationId,
      firstDeploy: NEVER_LIVE.has(app.status),
      ...(release
        ? { version: release.release.version, origin: describeAppOrigin(release.origin) }
        : {}),
    },
  });
  out.emit({
    type: "step",
    step: "app.register",
    status: "ok",
    message: `${manifest.id} is ${app.workerName} on ${gatewayUrl}${app.hostname ? `, at https://${app.hostname}` : " (no hostname yet: the gateway has no third-party domain)"} (${app.status}).`,
    data: { appId: manifest.id, workerName: app.workerName, hostname: app.hostname, organizationId: key.organizationId },
  });

  // 2. The build, with placeholders for everything the deployer installs;
  // a release's was built where it was packed.
  if (release) {
    await prepareAppBuildOutput({ cwd: release.dir, inputs: sentinelDeployTarget(manifest) });
    out.emit({
      type: "step",
      step: "app.build",
      status: "ok",
      message: `Checked the Worker of ${manifest.id} ${release.release.version} from ${describeAppOrigin(release.origin)}; its publisher's build checked its migrations against its schema.`,
      data: { release: true },
    });
  } else {
    if (manifest.install !== false) {
      out.emit({ type: "step", step: "app.install", status: "start", message: "Installing dependencies..." });
      await (options.installDeps ?? installDependencies)({
        cwd,
        description: "Installing dependencies...",
        install: manifest.install,
        verbose: options.verbose ?? false,
      });
      out.emit({ type: "step", step: "app.install", status: "ok" });
    }
    out.emit({ type: "step", step: "app.build", status: "start", message: "Building..." });
    await buildApp({
      cwd,
      cf: (options.createCf ?? (() => createCfRunner()))(),
      buildCommand: manifest.build,
      verbose: options.verbose ?? false,
    });
    await prepareAppBuildOutput({ cwd, inputs: sentinelDeployTarget(manifest) });
    out.emit({ type: "step", step: "app.build", status: "ok", message: "Built the app and checked its Worker." });
    await checkSchemaDrift({ cwd, manifest, out });
  }

  // 3. The upload, then the job.
  const bundle = await packageHostedBundle({
    root: release?.dir ?? cwd,
    manifest,
    sdkVersion: release ? release.release.sdkVersion : appSdkVersion(cwd),
  });
  out.emit({
    type: "step",
    step: "app.upload",
    status: "start",
    message: `Uploading ${manifest.id} (${bundle.modules} modules, ${bundle.assets} assets, ${bundle.migrations} migrations)...`,
  });
  let { job } = await call<{ job: JobBody }>(`${orgPath}/apps/${encodeURIComponent(manifest.id)}/deploys`, {
    method: "POST",
    body: bundle.form,
  });
  out.emit({
    type: "step",
    step: "app.upload",
    status: "ok",
    message: `Uploaded ${manifest.id}; ${host} deploys it as job ${job.id}.`,
    data: {
      jobId: job.id,
      modules: bundle.modules,
      assets: bundle.assets,
      migrations: bundle.migrations,
    },
  });
  const deployed = { appId: manifest.id, gatewayHost: host, jobId: job.id };
  const wait = options.wait ?? true;
  if (job.status === "running" && wait) {
    out.emit({
      type: "step",
      step: "app.hosted",
      status: "start",
      message: `${host} is deploying ${manifest.id}...`,
      data: deployed,
    });
  }
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (job.status === "running" && wait) {
    if (Date.now() > deadline) {
      throw new EveryAppError(
        "DEPLOY_TIMEOUT",
        `${host} hasn't finished deploying ${manifest.id} after ${roughly(POLL_TIMEOUT_MS)}\nIt may have lost the job (${job.id}).`,
        { retryable: true, rerun, rerunNote: "in a few minutes", data: { jobId: job.id } },
      );
    }
    await sleep(POLL_INTERVAL_MS);
    ({ job } = await call<{ job: JobBody }>(`${orgPath}/deploys/${encodeURIComponent(job.id)}`));
  }
  if (job.status === "failed") {
    throw new EveryAppError(
      job.error?.code ?? "DEPLOY_FAILED",
      `${host} couldn't deploy ${manifest.id}${job.error?.message ? `\nIt said: ${job.error.message}` : ""}`,
      { rerun, rerunNote: "to try again", data: { jobId: job.id } },
    );
  }
  const url = job.app?.url ?? (app.hostname ? `https://${app.hostname}` : null);
  const live = job.app?.status === "active";
  out.emit({
    type: "step",
    step: "app.hosted",
    status: job.status === "succeeded" ? "ok" : "skip",
    message:
      job.status === "succeeded"
        ? `Deployed version ${job.app?.versionId}${url ? `; ${manifest.id} is at ${url}` : ""}.`
        : `${host} is deploying ${manifest.id} (job ${job.id}); this run didn't wait for it.`,
    data: { ...deployed, versionId: job.app?.versionId ?? null, status: job.status },
  });
  if (url) {
    out.emit({
      type: "step",
      step: "app.live",
      status: live ? "ok" : "skip",
      message: `${manifest.id} is at ${url}.`,
      data: { url },
    });
  }
  return {
    liveUrl: url,
    workerName: job.app?.workerName ?? app.workerName,
    versionId: job.app?.versionId ?? null,
    jobId: job.id,
    status: job.status,
    live,
  };
}
