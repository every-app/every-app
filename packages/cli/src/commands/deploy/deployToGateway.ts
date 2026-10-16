/**
 * `everyapp deploy --gateway <url>` with EVERYAPP_DEPLOY_TOKEN: a third-party app
 * deployed through the hosted gateway's deploy API, with no Cloudflare
 * login (CI sets EVERYAPP_DEPLOY_TOKEN and EVERYAPP_GATEWAY_URL):
 *
 *   1. ask the gateway who the deploy key is (its organization), then
 *      register the app id with its manifest, which the gateway checks
 *      against the hosted policy before anything is built;
 *   2. build the app as `deploy` does, but with the sentinel deploy inputs
 *      (lib/app/hostedBundle.ts): the Worker name, organization, identity
 *      key and D1 ids are placeholders the gateway's deployer rewrites, so
 *      no SDK change is needed and nothing secret is in the build; check
 *      the Build Output against the app policy and the schema against the
 *      migrations;
 *   3. upload the Build Output, manifest, migrations and stamp, and follow
 *      the deploy job until it ends.
 *
 * The gateway creates the app's D1, applies its migrations, uploads its
 * Worker into the dispatch namespace and records it; nothing here touches
 * Cloudflare.
 */
import type { EveryAppCliManifest } from "@/lib/manifest";
import { buildApp } from "@/lib/app/buildApp";
import { sentinelDeployInputs, packageHostedBundle } from "@/lib/app/hostedBundle";
import { prepareAppBuildOutput } from "@/lib/app/policy";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { installDependencies } from "@/lib/package-manager";
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
      "EVERYAPP_DEPLOY_TOKEN is set, so this deploy goes through a hosted gateway's deploy API: name it with --gateway <url> or EVERYAPP_GATEWAY_URL. To deploy to your own Gateway with your Cloudflare login, unset EVERYAPP_DEPLOY_TOKEN.",
      { rerun: `${CLI} deploy --gateway <url>` },
    );
  }
  const used = SELF_HOST_ONLY_FLAGS.filter((flag) => flags[flag] !== undefined && flags[flag] !== false);
  if (used.length > 0) {
    throw new EveryAppError(
      "FLAG_NOT_FOR_HOSTED_DEPLOY",
      `--${used.join(", --")} ${used.length === 1 ? "is" : "are"} for deploys to your own Gateway; a hosted gateway decides ${used.length === 1 ? "it" : "them"} itself. Deploy again without.`,
      { rerun: `${CLI} deploy --gateway ${flags.gateway}` },
    );
  }
  return { gatewayUrl: flags.gateway, token };
}

interface DeployToGatewayOptions {
  cwd: string;
  manifest: EveryAppCliManifest;
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
      throw new EveryAppError(
        "GATEWAY_UNREACHABLE",
        `${gatewayUrl} didn't answer (${error instanceof Error ? error.message : String(error)}).`,
        { retryable: true, rerun },
      );
    }
    const body = (await response.json().catch(() => null)) as
      | (T & { error?: string; message?: string })
      | null;
    if (response.ok && body) return body;
    // A gateway without the launch gate has no such route.
    if (response.status === 404 && pathname === "/api/v1/deploy-key") {
      throw new EveryAppError(
        "DEPLOY_API_UNAVAILABLE",
        `${gatewayUrl} has no deploy API: it takes no third-party deploys. Deploy to your own Gateway with your Cloudflare login (unset EVERYAPP_DEPLOY_TOKEN).`,
      );
    }
    const code = body?.error ?? `HTTP_${response.status}`;
    const message = body?.message ?? `${gatewayUrl} answered ${response.status}.`;
    throw new EveryAppError(code, message, {
      retryable: response.status >= 500 || response.status === 409,
      rerun,
    });
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
  out.emit({
    type: "step",
    step: "app.register",
    status: "ok",
    message: `${manifest.id} is ${app.workerName} on ${gatewayUrl}${app.hostname ? `, at https://${app.hostname}` : " (no hostname yet: the gateway has no third-party domain)"} (${app.status}).`,
    data: { appId: manifest.id, workerName: app.workerName, hostname: app.hostname, organizationId: key.organizationId },
  });

  // 2. The build, with placeholders for everything the deployer sets.
  await (options.installDeps ?? installDependencies)({
    cwd,
    description: "Installing dependencies...",
    install: manifest.install,
    verbose: options.verbose ?? false,
  });
  const inputs = sentinelDeployInputs(manifest, gatewayUrl);
  out.emit({ type: "step", step: "app.build", status: "start", message: "Building the app..." });
  await buildApp({
    cwd,
    cf: (options.createCf ?? (() => createCfRunner()))(),
    inputs,
    buildCommand: manifest.build,
    env: {},
    verbose: options.verbose ?? false,
  });
  await prepareAppBuildOutput({ cwd, inputs: { ...inputs, helperWorkers: [] } });
  out.emit({ type: "step", step: "app.build", status: "ok", message: "Built the app and checked its Worker." });
  await checkSchemaDrift({ cwd, manifest, out });

  // 3. The upload, then the job.
  const bundle = await packageHostedBundle(cwd, manifest);
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
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (job.status === "running" && (options.wait ?? true)) {
    if (Date.now() > deadline) {
      throw new EveryAppError(
        "DEPLOY_TIMEOUT",
        `The gateway is still deploying ${manifest.id} (job ${job.id}), though it gives a deploy only about 50 seconds; the gateway may have lost the job. Deploy again in a few minutes.`,
        { retryable: true, rerun },
      );
    }
    out.emit({ type: "progress", step: "app.upload", message: `The gateway is deploying ${manifest.id}...`, data: { jobId: job.id } });
    await sleep(POLL_INTERVAL_MS);
    ({ job } = await call<{ job: JobBody }>(`${orgPath}/deploys/${encodeURIComponent(job.id)}`));
  }
  if (job.status === "failed") {
    throw new EveryAppError(job.error?.code ?? "DEPLOY_FAILED", job.error?.message ?? "The deploy failed.", {
      rerun,
      data: { jobId: job.id },
    });
  }
  const url = job.app?.url ?? null;
  out.emit({
    type: "step",
    step: "app.upload",
    status: job.status === "succeeded" ? "ok" : "start",
    message:
      job.status === "succeeded"
        ? // No browser session reaches a third-party host yet: bearer only.
          `Deployed version ${job.app?.versionId}${url ? `; ${manifest.id} is at ${url}, open with a bearer token only for now (no browser sign-in on its host yet)` : ""}.`
        : `The gateway is deploying ${manifest.id} (job ${job.id}).`,
    data: { jobId: job.id, versionId: job.app?.versionId ?? null, status: job.status },
  });
  return {
    liveUrl: url,
    workerName: job.app?.workerName ?? app.workerName,
    versionId: job.app?.versionId ?? null,
    jobId: job.id,
    status: job.status,
  };
}
