/**
 * The hosted deploy API, for third-party apps: what `everyapp deploy
 * --gateway` (and CI with EVERYAPP_DEPLOY_TOKEN and EVERYAPP_GATEWAY_URL) calls.
 * It exists only while platformPolicy(env).thirdPartyDeploys holds (the
 * launch gate; server.ts sends nothing here otherwise, so its paths are the
 * control plane's 404s), and only for deploy keys (./auth.ts).
 *
 *   GET  /api/v1/deploy-key                          who the key is, and its organization
 *   POST /api/v1/orgs/{orgId}/apps                   register an app id (JSON: appId, manifest)
 *   POST /api/v1/orgs/{orgId}/apps/{appId}/deploys   deploy it (multipart, ./bundle.ts)
 *   GET  /api/v1/orgs/{orgId}/deploys/{id}           a deploy job
 *
 * A deploy runs in the request that starts it (and `waitUntil` after):
 * the answer is the job, finished when the deploy took under
 * {@link INLINE_WAIT_MS}, else `running`, for the CLI to poll.
 */
import { env, waitUntil } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  ManifestError,
  validateManifest,
  type Manifest,
} from "@every-app/perimeter/manifest";
import type { AppRow } from "@every-app/perimeter/registry";
import { platformPolicy } from "@/server/platform-policy";
import { AppRepository } from "@/server/repositories/AppRepository";
import {
  DeployJobRepository,
  type DeployJob,
} from "@/server/repositories/DeployJobRepository";
import { authenticateDeployKey, type DeployCaller } from "./auth";
import { parseDeployUpload } from "./bundle";
import { CfRestDeployer } from "./cfRestDeployer";
import { bundleRefused, DeployError } from "./errors";
import { bundleProblems, manifestProblems } from "./metadata";
import { runDeploy } from "./pipeline";
import { findOrgApp, registerDispatchApp, toAppRow } from "./registry";

// server.ts routes this prefix here.
const DEPLOY_API_PREFIX = "/api/v1/";

const INLINE_WAIT_MS = 20_000;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function failure(error: DeployError): Response {
  return json({ error: error.code, message: error.message }, error.status);
}

const notFound = () =>
  new DeployError("NOT_FOUND", 404, "No such deploy API route.");

function appView(app: AppRow) {
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
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    app: app ? appView(app) : null,
  };
}

function parseManifest(raw: unknown, appId: string): Manifest {
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
  const problems = manifestProblems(
    manifest,
    platformPolicy(env).thirdPartyLimits,
  );
  if (problems.length > 0) throw bundleRefused(problems);
  return manifest;
}

/** The path's organization is the key's, or the route doesn't exist for it. */
function assertOrganization(caller: DeployCaller, orgId: string): void {
  if (caller.organizationId !== orgId) throw notFound();
}

/** A key bound to one app deploys that app only. */
function assertBoundApp(
  caller: DeployCaller,
  app: { id: string } | null,
): void {
  if (caller.appRowId && caller.appRowId !== app?.id) {
    throw new DeployError(
      "DEPLOY_KEY_APP_MISMATCH",
      403,
      "This deploy key is bound to another app.",
    );
  }
}

function register(caller: DeployCaller, manifest: Manifest) {
  return registerDispatchApp({
    organizationId: caller.organizationId,
    appSlug: manifest.id,
    name: manifest.name ?? manifest.id,
    description: manifest.description ?? manifest.id,
    manifest,
    deployerUserId: caller.userId,
    thirdPartyDomain: env.THIRD_PARTY_DOMAIN ?? null,
  });
}

async function registerRoute(request: Request, caller: DeployCaller) {
  let body: { appId?: unknown; manifest?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw new DeployError(
      "INVALID_REQUEST",
      400,
      "Send JSON: { appId, manifest }.",
    );
  }
  if (typeof body.appId !== "string") {
    throw new DeployError("INVALID_REQUEST", 400, "appId is required.");
  }
  const manifest = parseManifest(
    body.manifest ?? { id: body.appId },
    body.appId,
  );
  const existing = await findOrgApp(caller.organizationId, manifest.id);
  assertBoundApp(caller, existing);
  const plan = await register(caller, manifest);
  logEvent("deploy_api.app_registered", {
    org: caller.organizationId,
    app: manifest.id,
    kind: plan.kind,
  });
  return json({ app: appView(plan.app) }, plan.kind === "existing" ? 200 : 201);
}

async function deployRoute(
  request: Request,
  caller: DeployCaller,
  appId: string,
) {
  const bundle = await parseDeployUpload(request);
  const manifest = parseManifest(bundle.manifest, appId);
  const existing = await findOrgApp(caller.organizationId, appId);
  if (!existing || existing.status === "deleted") {
    throw new DeployError(
      "APP_NOT_REGISTERED",
      404,
      `No app "${appId}" is registered for this organization; register it first (everyapp deploy --gateway does).`,
    );
  }
  assertBoundApp(caller, existing);
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
  // Refused before anything is registered, created or queued; the
  // pipeline checks again before it uploads.
  const limits = platformPolicy(env).thirdPartyLimits;
  const problems = bundleProblems(
    bundle.worker,
    manifest,
    limits,
    bundle.assets.size > 0,
  );
  if (problems.length > 0) throw bundleRefused(problems);
  const deployer = CfRestDeployer.fromEnv(env);
  const { app } = await register(caller, manifest);
  const job = await DeployJobRepository.start(caller.organizationId, app.id);
  if (!job) {
    throw new DeployError(
      "DEPLOY_IN_PROGRESS",
      409,
      `Another deploy of ${appId} is running; wait for it, then deploy again.`,
    );
  }
  logEvent("deploy_api.deploy_started", {
    org: caller.organizationId,
    app: appId,
    job: job.id,
  });

  const run = runDeploy({
    app,
    manifest,
    bundle,
    deployer,
    gatewayUrl,
    identityPublicKey,
    limits,
    actor: `deploy-key:${caller.tokenId}`,
  }).then(
    async () => {
      await DeployJobRepository.finish(job.id, { status: "succeeded" });
      logEvent("deploy_api.deploy_succeeded", {
        org: caller.organizationId,
        app: appId,
        job: job.id,
      });
    },
    async (error: unknown) => {
      const known = error instanceof DeployError;
      if (!known) console.error("deploy failed:", error);
      await DeployJobRepository.finish(job.id, {
        status: "failed",
        code: known ? error.code : "DEPLOY_FAILED",
        message: known
          ? error.message
          : "The deploy failed in the gateway. Deploy again.",
      });
      logEvent(
        "deploy_api.deploy_failed",
        {
          org: caller.organizationId,
          app: appId,
          job: job.id,
          code: known ? error.code : "DEPLOY_FAILED",
        },
        "warn",
      );
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
  return jobRoute(caller, job.id, 202);
}

async function jobRoute(caller: DeployCaller, id: string, status = 200) {
  const job = await DeployJobRepository.findForOrganization(
    id,
    caller.organizationId,
  );
  if (!job) throw new DeployError("DEPLOY_NOT_FOUND", 404, "No such deploy.");
  const row = await AppRepository.findById(job.appRowId, caller.organizationId);
  return json({ job: jobView(job, row ? toAppRow(row) : null) }, status);
}

/** Serve a deploy API request; the caller checked the launch gate. */
export async function serveDeployApi(request: Request): Promise<Response> {
  try {
    const { pathname } = new URL(request.url);
    const segments = pathname
      .slice(DEPLOY_API_PREFIX.length)
      .split("/")
      .map(decodeURIComponent);
    const method = request.method.toUpperCase();
    const caller = await authenticateDeployKey(request);

    if (
      segments.length === 1 &&
      segments[0] === "deploy-key" &&
      method === "GET"
    ) {
      return json({
        organizationId: caller.organizationId,
        userEmail: caller.email,
        role: caller.role,
        appRowId: caller.appRowId,
      });
    }
    const [orgs, orgId, collection, id, sub, ...rest] = segments;
    if (orgs !== "orgs" || !orgId || rest.length > 0) throw notFound();
    assertOrganization(caller, orgId);
    if (collection === "apps" && id === undefined && method === "POST") {
      return await registerRoute(request, caller);
    }
    if (collection === "apps" && id && sub === "deploys" && method === "POST") {
      return await deployRoute(request, caller, id);
    }
    if (
      collection === "deploys" &&
      id &&
      sub === undefined &&
      method === "GET"
    ) {
      return await jobRoute(caller, id);
    }
    throw notFound();
  } catch (error) {
    if (error instanceof DeployError) return failure(error);
    console.error("deploy API error:", error);
    return json(
      { error: "INTERNAL_ERROR", message: "The deploy API failed." },
      500,
    );
  }
}
