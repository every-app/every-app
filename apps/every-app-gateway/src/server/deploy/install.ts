/**
 * Browser installation (Admin → Apps → Install app): an owner or admin
 * supplies a public GitHub repository or immutable oss.new release URL,
 * and the Gateway deploys the validated release
 * (./release.ts) through the deploy API's pipeline (./run.ts), registered
 * as a third-party app of that organization.
 *
 *   GET  /api/admin/apps/install        whether this gateway installs apps
 *   GET  /api/admin/apps/install/context eligible workspaces for approval
 *   POST /api/admin/apps/install        repoUrl OR releaseUrl, organizationId
 *   GET  /api/admin/deploys/{id}        a deploy job, as the page polls it
 *
 * Hosted deploys retain their launch gate. Self-hosted browser installs are
 * on by default with configured credentials; BROWSER_APP_INSTALLS=off opts out.
 * On a self-hosted Gateway the token is the account's, so only the install
 * organization's owners and admins may spend it: any other organization is
 * refused before anything is downloaded (one warn line names who asked for
 * which organization), and the context offers it nothing. Availability and
 * the context go by the person, not the session's active workspace: an
 * admin of the install organization whose sidebar is in another one still
 * sees Install app and is offered the install organization. The install
 * and the poll check the workspace they name.
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
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import { bundleRefused, DeployError } from "./errors";
import { fetchAppRelease, fetchReleaseUrl, parseRepoUrl } from "./release";
import {
  installOrganizationId,
  selfHostedInstallEnabled,
} from "./browser-install";
import { bundleProblems } from "./metadata";
import {
  deployerSettings,
  deployLimits,
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

const ADMINS_ONLY = "Only the organization's owners and admins install apps.";
const INSTALL_ORGANIZATION_ONLY =
  "On a self-hosted Gateway only the install organization's owners and admins install apps.";

async function authenticateSession(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id || isUserBanned(session.user)) {
    throw new DeployError("UNAUTHORIZED", 401, "Sign in again.");
  }
  return session;
}

/** The approved workspace, checked live even if another tab switched sessions. */
async function authenticateAdmin(
  session: Awaited<ReturnType<typeof authenticateSession>>,
  organizationId?: unknown,
): Promise<InstallCaller> {
  if (
    organizationId !== undefined &&
    (typeof organizationId !== "string" ||
      !organizationId.trim() ||
      organizationId.length > 256)
  )
    throw new DeployError("INVALID_REQUEST", 400, "Choose a valid workspace.");
  const org = await resolveOrgContext({
    userId: session.user.id,
    activeOrganizationId:
      organizationId ?? session.session.activeOrganizationId ?? null,
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
    throw new DeployError("APP_INSTALL_FORBIDDEN", 403, ADMINS_ONLY);
  }
  if (!(await mayInstallForOrganization(org.orgId))) {
    // An admin elsewhere reaching for the account-wide token: the one
    // refusal here the operator should see. Ids only, never the token.
    logEvent(
      "app_install.refused",
      {
        org: org.orgId,
        installOrg: await installOrganizationId(),
        user: session.user.id,
        role,
      },
      "warn",
    );
    throw new DeployError(
      "APP_INSTALL_FORBIDDEN",
      403,
      INSTALL_ORGANIZATION_ONLY,
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

/**
 * Whether an organization may spend the Gateway's deploy token. Hosted:
 * every organization, into its own dispatch app. Self-hosted: the install
 * organization only (the token is account-wide), and nobody before the
 * Gateway has an owner.
 */
async function mayInstallForOrganization(
  organizationId: string,
): Promise<boolean> {
  if (platformPolicy(env).mode !== "self_hosted") return true;
  return (await installOrganizationId()) === organizationId;
}

function installAvailable(): boolean {
  return platformPolicy(env).thirdPartyDeploys || selfHostedInstallEnabled(env);
}

function assertAvailable(): void {
  if (!installAvailable()) {
    throw new DeployError(
      "APP_INSTALL_NOT_AVAILABLE",
      404,
      "Browser installation is not enabled on this Gateway. Its owner can configure the browser deployer, or deploy with the everyapp CLI.",
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

/**
 * The active organizations this person owns or administers that the
 * install would accept: on self-host the install organization alone, so
 * the page never offers a workspace the install refuses.
 */
async function installableWorkspaces(
  userId: string,
): Promise<Array<{ id: string; name: string }>> {
  const administered =
    await OrganizationRepository.findAdminSummariesForUser(userId);
  if (platformPolicy(env).mode !== "self_hosted") return administered;
  const installOrganization = await installOrganizationId();
  return administered.filter(
    (workspace) => workspace.id === installOrganization,
  );
}

/** GET /api/admin/apps/install */
export function serveInstallAvailability(request: Request): Promise<Response> {
  return serve(async () => {
    const session = await authenticateSession(request);
    // By the person, not the session's active workspace: an admin of the
    // install organization whose sidebar is in another one still sees
    // Install app. The install itself checks the workspace it names.
    if ((await installableWorkspaces(session.user.id)).length === 0) {
      throw new DeployError(
        "APP_INSTALL_FORBIDDEN",
        403,
        platformPolicy(env).mode === "self_hosted"
          ? INSTALL_ORGANIZATION_ONLY
          : ADMINS_ONLY,
      );
    }
    return json({ available: installAvailable() });
  });
}

/** GET /api/admin/apps/install/context: approval choices, without switching sessions. */
export function serveInstallContext(request: Request): Promise<Response> {
  return serve(async () => {
    const session = await authenticateSession(request);
    const workspaces = await installableWorkspaces(session.user.id);
    const active = session.session.activeOrganizationId;
    return json({
      available: installAvailable(),
      workspaces,
      defaultOrganizationId:
        workspaces.find((workspace) => workspace.id === active)?.id ??
        workspaces[0]?.id ??
        null,
    });
  });
}

/** POST /api/admin/apps/install */
export function serveInstall(request: Request): Promise<Response> {
  return serve(async () => {
    const session = await authenticateSession(request);
    let body: {
      repoUrl?: unknown;
      releaseUrl?: unknown;
      organizationId?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new DeployError(
        "INVALID_REQUEST",
        400,
        "Send JSON with one repoUrl or releaseUrl.",
      );
    }
    const caller = await authenticateAdmin(session, body?.organizationId);
    assertAvailable();
    // Nothing is downloaded for a gateway that couldn't deploy it.
    deployerSettings();
    if (body?.releaseUrl !== undefined && body.repoUrl !== undefined)
      throw new DeployError(
        "INVALID_REQUEST",
        400,
        "Send one repoUrl or releaseUrl.",
      );
    const release =
      body?.releaseUrl !== undefined
        ? await fetchReleaseUrl(body.releaseUrl)
        : await fetchAppRelease(parseRepoUrl(body?.repoUrl));
    const manifest = parseManifest(release.bundle.manifest, release.appId);
    // Refused before the app is registered: a release that can't go
    // leaves no row behind. startDeploy checks again.
    const problems = bundleProblems(
      release.bundle.worker,
      manifest,
      deployLimits(),
      release.bundle.assets.size > 0,
    );
    if (problems.length > 0) throw bundleRefused(problems);
    // Registered as the deploy API's POST /apps registers it, then deployed.
    const plan = await registerApp(caller, manifest);
    logEvent("app_install.started", {
      org: caller.organizationId,
      app: manifest.id,
      repo: release.source.repoUrl,
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
    const caller = await authenticateAdmin(
      await authenticateSession(request),
      new URL(request.url).searchParams.get("organizationId") ?? undefined,
    );
    assertAvailable();
    return jobAnswer(caller.organizationId, id);
  });
}
