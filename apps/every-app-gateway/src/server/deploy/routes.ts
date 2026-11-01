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
 * A deploy runs in the request that starts it (and `waitUntil` after,
 * ./run.ts): the answer is the job, finished when the deploy took under
 * 20 seconds, else `running`, for the CLI to poll. The admin's install from
 * GitHub (./install.ts) deploys through the same pipeline with a session.
 */
import { logEvent } from "@every-app/perimeter";
import { authenticateDeployKey, type DeployCaller } from "./auth";
import { parseDeployUpload } from "./bundle";
import { DeployError } from "./errors";
import { findOrgApp } from "./registry";
import {
  appView,
  failure,
  jobAnswer,
  json,
  parseManifest,
  registerApp,
  startDeploy,
} from "./run";
import { gatewayProviders } from "@/server/providers";

// server.ts routes this prefix here.
const DEPLOY_API_PREFIX = "/api/v1/";

const notFound = () =>
  new DeployError("NOT_FOUND", 404, "No such deploy API route.");

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
    await gatewayProviders(),
  );
  const existing = await findOrgApp(caller.organizationId, manifest.id);
  assertBoundApp(caller, existing);
  const plan = await registerApp(caller, manifest);
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
  const manifest = parseManifest(
    bundle.manifest,
    appId,
    await gatewayProviders(),
  );
  const existing = await findOrgApp(caller.organizationId, appId);
  if (!existing || existing.status === "deleted") {
    throw new DeployError(
      "APP_NOT_REGISTERED",
      404,
      `No app "${appId}" is registered for this organization; register it first (everyapp deploy --gateway does).`,
    );
  }
  assertBoundApp(caller, existing);
  const jobId = await startDeploy({
    organizationId: caller.organizationId,
    userId: caller.userId,
    appRowId: existing.id,
    manifest,
    bundle,
    actor: `deploy-key:${caller.tokenId}`,
    via: "cli",
  });
  return jobAnswer(caller.organizationId, jobId, 202);
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
      return await jobAnswer(caller.organizationId, id);
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
