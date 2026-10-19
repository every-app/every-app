/**
 * Install an app from GitHub (Admin → Apps → Install from GitHub): an
 * owner or admin of the session's organization pastes a repository URL,
 * and the gateway deploys the repository's latest everyapp release
 * (./release.ts) through the deploy API's pipeline (./run.ts), registered
 * as a third-party app of that organization.
 *
 *   GET  /api/admin/apps/install        whether this gateway installs apps
 *   POST /api/admin/apps/install        install one (JSON: repoUrl)
 *   GET  /api/admin/deploys/{id}        a deploy job, as the page polls it
 *
 * Only behind the deploy API's launch gate (platformPolicy(env)
 * .thirdPartyDeploys, hosted only): otherwise APP_INSTALL_NOT_AVAILABLE.
 * Session-authenticated, so these are control-plane routes
 * (src/routes/api/admin/), behind its CSRF guard.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import { auth } from "@/auth";
import { resolveLiveOrgRole } from "@/perimeter/betterAuthAuthenticator";
import {
  isOrganizationActive,
  resolveOrgContext,
} from "@/server/organization/orgContext";
import { platformPolicy } from "@/server/platform-policy";
import { isUserBanned } from "@/server/user-ban";
import { bundleRefused, DeployError } from "./errors";
import { fetchAppRelease, parseRepoUrl } from "./release";
import { bundleProblems } from "./metadata";
import {
  deployerSettings,
  failure,
  jobAnswer,
  json,
  parseManifest,
  registerApp,
  startDeploy,
} from "./run";

interface InstallCaller {
  userId: string;
  email: string;
  organizationId: string;
}

/**
 * An owner or admin of the session's organization, its role read live
 * (as a deploy key's is), in an organization that isn't suspended.
 */
async function authenticateAdmin(request: Request): Promise<InstallCaller> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id || isUserBanned(session.user)) {
    throw new DeployError("UNAUTHORIZED", 401, "Sign in again.");
  }
  const org = await resolveOrgContext({
    userId: session.user.id,
    activeOrganizationId: session.session.activeOrganizationId ?? null,
  });
  const role = org
    ? await resolveLiveOrgRole(session.user.id, org.orgId)
    : null;
  if (!org || !role) {
    throw new DeployError(
      "UNAUTHORIZED",
      401,
      "Organization membership required.",
    );
  }
  if (role !== "owner" && role !== "admin") {
    throw new DeployError(
      "APP_INSTALL_FORBIDDEN",
      403,
      "Only the organization's owners and admins install apps.",
    );
  }
  if (!(await isOrganizationActive(org.orgId))) {
    throw new DeployError(
      "ORGANIZATION_SUSPENDED",
      403,
      "The organization is suspended.",
    );
  }
  return {
    userId: session.user.id,
    email: session.user.email,
    organizationId: org.orgId,
  };
}

function installAvailable(): boolean {
  return platformPolicy(env).thirdPartyDeploys;
}

function assertAvailable(): void {
  if (!installAvailable()) {
    throw new DeployError(
      "APP_INSTALL_NOT_AVAILABLE",
      404,
      "This gateway doesn't install apps from GitHub; deploy them with the everyapp CLI.",
    );
  }
}

async function serve(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DeployError) return failure(error);
    console.error("app install error:", error);
    return json(
      { error: "INTERNAL_ERROR", message: "The install failed." },
      500,
    );
  }
}

/** GET /api/admin/apps/install */
export function serveInstallAvailability(request: Request): Promise<Response> {
  return serve(async () => {
    await authenticateAdmin(request);
    return json({ available: installAvailable() });
  });
}

/** POST /api/admin/apps/install */
export function serveInstall(request: Request): Promise<Response> {
  return serve(async () => {
    const caller = await authenticateAdmin(request);
    assertAvailable();
    let body: { repoUrl?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new DeployError("INVALID_REQUEST", 400, "Send JSON: { repoUrl }.");
    }
    const repo = parseRepoUrl(body?.repoUrl);
    // Nothing is downloaded for a gateway that couldn't deploy it.
    deployerSettings();
    const release = await fetchAppRelease(repo);
    const manifest = parseManifest(release.bundle.manifest, release.appId);
    // Refused before the app is registered: a release that can't go
    // leaves no row behind. startDeploy checks again.
    const problems = bundleProblems(
      release.bundle.worker,
      manifest,
      platformPolicy(env).thirdPartyLimits,
      release.bundle.assets.size > 0,
    );
    if (problems.length > 0) throw bundleRefused(problems);
    // Registered as the deploy API's POST /apps registers it, then deployed.
    const plan = await registerApp(caller, manifest);
    logEvent("app_install.started", {
      org: caller.organizationId,
      app: manifest.id,
      repo: repo.repoUrl,
      tag: release.source.tag,
      kind: plan.kind,
    });
    const jobId = await startDeploy({
      organizationId: caller.organizationId,
      userId: caller.userId,
      appRowId: plan.app.id,
      manifest,
      bundle: release.bundle,
      actor: caller.email,
      source: release.source,
    });
    return jobAnswer(caller.organizationId, jobId, 202);
  });
}

/** GET /api/admin/deploys/{id} */
export function serveInstallJob(
  request: Request,
  id: string,
): Promise<Response> {
  return serve(async () => {
    const caller = await authenticateAdmin(request);
    assertAvailable();
    return jobAnswer(caller.organizationId, id);
  });
}
