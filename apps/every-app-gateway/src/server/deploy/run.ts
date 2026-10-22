/**
 * What every way into the deploy pipeline shares: the deploy API's routes
 * (./routes.ts, deploy keys) and browser installation (./install.ts, a
 * session, hosted or self-hosted). Each authenticates its caller
 * and gets the bundle its own way; from there a deploy shares the manifest
 * policy, registration, one job at a time per app, and the
 * pipeline (./pipeline.ts) inside the request and `waitUntil` after it.
 * A deploy that went live takes the new version's tool snapshot, since
 * only here does the gateway itself learn of a new `apps.version_id`.
 */
import { env, waitUntil } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  ManifestError,
  validateManifest,
  type Manifest,
} from "@every-app/perimeter/manifest";
import type { AppRow } from "@every-app/perimeter/registry";
import { appBaseDomain, thirdPartyDomain } from "@/server/app-hosts";
import { platformPolicy } from "@/server/platform-policy";
import { AppRepository } from "@/server/repositories/AppRepository";
import { scheduleCatalogResync } from "@/server/toolbus/catalog-sync";
import {
  DeployJobRepository,
  type DeployJob,
  type DeployJobSource,
} from "@/server/repositories/DeployJobRepository";
import type { DeployBundle } from "./bundle";
import { CfRestDeployer } from "./cfRestDeployer";
import { bundleRefused, DeployError } from "./errors";
import { bundleProblems, manifestProblems } from "./metadata";
import { runDeploy } from "./pipeline";
import { registerDispatchApp, toAppRow } from "./registry";
import { BROWSER_INSTALL_LIMITS, withInstallLease } from "./browser-install";

export function deployLimits() {
  return platformPolicy(env).mode === "self_hosted"
    ? BROWSER_INSTALL_LIMITS
    : platformPolicy(env).thirdPartyLimits;
}

const INLINE_WAIT_MS = 20_000;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function failure(error: DeployError): Response {
  return json({ error: error.code, message: error.message }, error.status);
}

export function appView(app: AppRow) {
  return {
    id: app.appSlug,
    workerName: app.workerName,
    hostname: app.hostname,
    url: app.hostname ? `https://${app.hostname}` : null,
    status: app.status,
    tier: app.tier,
    versionId: app.versionId,
  };
}

function jobView(job: DeployJob, app: AppRow | null) {
  return {
    id: job.id,
    status: job.status,
    error: job.error,
    source: job.source,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    app: app ? appView(app) : null,
  };
}

/** The organization's job, as the routes answer with it. */
export async function jobAnswer(
  organizationId: string,
  id: string,
  status = 200,
): Promise<Response> {
  const job = await DeployJobRepository.findForOrganization(id, organizationId);
  if (!job) throw new DeployError("DEPLOY_NOT_FOUND", 404, "No such deploy.");
  const row = await AppRepository.findById(job.appRowId, organizationId);
  return json({ job: jobView(job, row ? toAppRow(row) : null) }, status);
}

/** A manifest the hosted policy takes, for the app id `appId`. */
export function parseManifest(raw: unknown, appId: string): Manifest {
  let manifest: Manifest;
  try {
    manifest = validateManifest(raw);
  } catch (error) {
    throw new DeployError(
      "INVALID_MANIFEST",
      400,
      error instanceof ManifestError ? error.message : "Invalid manifest",
    );
  }
  if (manifest.id !== appId) {
    throw new DeployError(
      "INVALID_MANIFEST",
      400,
      `manifest.id "${manifest.id}" does not match the app id "${appId}".`,
    );
  }
  const problems = manifestProblems(manifest, deployLimits());
  if (problems.length > 0) throw bundleRefused(problems);
  return manifest;
}

/** Who a deploy is for: the organization, and the member who asked. */
interface Deployer {
  organizationId: string;
  userId: string;
}

export function registerApp(deployer: Deployer, manifest: Manifest) {
  return registerDispatchApp({
    serviceBinding: platformPolicy(env).mode === "self_hosted",
    organizationId: deployer.organizationId,
    appSlug: manifest.id,
    name: manifest.name ?? manifest.id,
    description: manifest.description ?? manifest.id,
    manifest,
    deployerUserId: deployer.userId,
    // As set, so one overlapping the gateway's own domain is refused
    // (registry.ts) rather than silently left unused.
    configuredThirdPartyDomain: env.THIRD_PARTY_DOMAIN ?? null,
    appBaseDomain: appBaseDomain(env),
    // Validated: never one that could share a site with the gateway.
    thirdPartyDomain: thirdPartyDomain(env),
  });
}

/** What the gateway gives every app it deploys, or DEPLOYER_NOT_CONFIGURED. */
export function deployerSettings(): {
  gatewayUrl: string;
  identityPublicKey: string;
} {
  const gatewayUrl = env.GATEWAY_URL?.trim();
  // As the gateway holds it: apps verify with exactly this PEM.
  const identityPublicKey = env.JWT_PUBLIC_KEY;
  if (!gatewayUrl || !identityPublicKey?.trim()) {
    throw new DeployError(
      "DEPLOYER_NOT_CONFIGURED",
      503,
      "This gateway has no GATEWAY_URL or JWT_PUBLIC_KEY to give apps.",
    );
  }
  return { gatewayUrl, identityPublicKey };
}

type JobOutcome = Parameters<typeof DeployJobRepository.finish>[1];

/**
 * A failed job's outcome. Logging an error the deployer didn't name is the
 * caller's: once per error, by whoever is last to see it.
 */
function failedOutcome(error: unknown): JobOutcome {
  if (error instanceof DeployError) {
    return { status: "failed", code: error.code, message: error.message };
  }
  return {
    status: "failed",
    code: "DEPLOY_FAILED",
    message: "The deploy failed in the gateway. Deploy again.",
  };
}

/**
 * Record a job's outcome. One that can't be recorded is logged: the job
 * stays `running` and reads DEPLOY_ABANDONED at its deadline, and the
 * request that started it still answers with the job.
 */
async function finishJob(
  id: string,
  outcome: JobOutcome,
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    await DeployJobRepository.finish(id, outcome);
  } catch (error) {
    console.error("deploy job outcome not recorded:", error);
    logEvent(
      "deploy_api.deploy_unrecorded",
      { ...fields, status: outcome.status },
      "error",
    );
    return;
  }
  if (outcome.status === "succeeded") {
    logEvent("deploy_api.deploy_succeeded", fields);
  } else {
    logEvent(
      "deploy_api.deploy_failed",
      { ...fields, code: outcome.code },
      "warn",
    );
  }
}

interface StartDeployInput extends Deployer {
  /** The app's registered row (not a tombstone). */
  appRowId: string;
  manifest: Manifest;
  bundle: DeployBundle;
  /** `deployed_by_actor`. */
  actor: string;
  /** Where the bundle came from, when not from an upload. */
  source?: DeployJobSource;
}

/**
 * Deploy a registered app: refuse a bundle the policy won't take before
 * anything is created, start its job (one at a time), register the
 * manifest, and run the pipeline in this request and `waitUntil` after
 * it. The job's id, once it finished or {@link INLINE_WAIT_MS} passed.
 */
export async function startDeploy(input: StartDeployInput): Promise<string> {
  const { organizationId, manifest, bundle } = input;
  const { gatewayUrl, identityPublicKey } = deployerSettings();
  // Refused before anything is registered, created or queued; the
  // pipeline checks again before it uploads.
  const limits = deployLimits();
  const problems = bundleProblems(
    bundle.worker,
    manifest,
    limits,
    bundle.assets.size > 0,
  );
  if (problems.length > 0) throw bundleRefused(problems);
  const selfHosted = platformPolicy(env).mode === "self_hosted";
  const deployer = selfHosted
    ? CfRestDeployer.fromSelfHostedEnv(env)
    : CfRestDeployer.fromEnv(env);
  // The job before the row: a deploy refused as already running leaves the
  // registry as the running one has it.
  const job = await DeployJobRepository.start(
    organizationId,
    input.appRowId,
    input.source ?? null,
  );
  if (!job) {
    throw new DeployError(
      "DEPLOY_IN_PROGRESS",
      409,
      `Another deploy of ${manifest.id} is running; wait for it, then deploy again.`,
    );
  }
  const fields = { org: organizationId, app: manifest.id, job: job.id };
  let app: AppRow;
  try {
    ({ app } = await registerApp(input, manifest));
  } catch (error) {
    // Rethrown: the route logs it as it answers.
    await finishJob(job.id, failedOutcome(error), fields);
    throw error;
  }
  logEvent("deploy_api.deploy_started", fields);

  // Never rejects: the answer is the job, however its outcome was recorded.
  const execute = (port: CfRestDeployer, current = app) =>
    runDeploy({
      app: current,
      manifest,
      bundle,
      deployer: port,
      gatewayUrl,
      identityPublicKey,
      limits,
      actor: input.actor,
    });
  const deploy = selfHosted
    ? withInstallLease(`app:${app.workerName}`, "app.deploy", async (renew) => {
        // A CLI operation may have finished after registration, before we
        // acquired its lease. Never upload against that stale snapshot.
        const row = await AppRepository.findById(app.id, organizationId);
        if (
          !row ||
          row.status === "deleted" ||
          row.tier !== "service_binding" ||
          row.workerName !== app.workerName ||
          row.hostname !== app.hostname ||
          row.versionId !== app.versionId
        )
          throw new DeployError(
            "APP_CHANGING",
            409,
            "This app changed before installation started. Try again.",
          );
        const current = toAppRow(row);
        const deployed = await execute(
          deployer.usingLease(renew, current),
          current,
        );
        await deployer.publishBoundApp(deployed, gatewayUrl, renew);
        return deployed;
      })
    : execute(deployer);
  const run = deploy.then(
    (deployed) => {
      if (deployed.hostname && deployed.workerName) {
        scheduleCatalogResync(
          {
            rowId: deployed.id,
            organizationId: deployed.organizationId,
            appSlug: deployed.appSlug,
            hostname: deployed.hostname,
            workerName: deployed.workerName,
            tier: deployed.tier,
            versionId: deployed.versionId,
          },
          "new_version",
        );
      }
      return finishJob(job.id, { status: "succeeded" }, fields);
    },
    (error: unknown) => {
      // Only the job records this error; the request answers with the job.
      if (!(error instanceof DeployError)) {
        console.error("deploy failed:", error);
      }
      return finishJob(job.id, failedOutcome(error), fields);
    },
  );
  waitUntil(run);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    run,
    new Promise((resolve) => {
      timer = setTimeout(resolve, INLINE_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  return job.id;
}
