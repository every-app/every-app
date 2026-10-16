/**
 * Who calls the deploy API: a deploy key (a personal access token with the
 * `deploy` scope and nothing else; `*` doesn't count) of a live owner or
 * admin of the organization the key is bound to, in an organization that
 * isn't suspended, checked on every request. No cookie is ever read: the
 * API is for CI and the CLI, never a browser.
 */
import { extractEveryAppBearer } from "@every-app/perimeter";
import { resolveLiveOrgRole } from "@/perimeter/betterAuthAuthenticator";
import { isOrganizationActive } from "@/server/organization/orgContext";
import { UserPatRepository } from "@/server/repositories/UserPatRepository";
import { UserPatService } from "@/server/services/UserPatService";
import { DEPLOY_SCOPE } from "@/server/user-pat-scopes";
import { DeployError } from "./errors";

export interface DeployCaller {
  tokenId: string;
  userId: string;
  email: string;
  organizationId: string;
  /** The app the key is bound to, when it is. */
  appRowId: string | null;
  role: string;
}

const unauthorized = (code: string, message: string) =>
  new DeployError(code, 401, message);

export async function authenticateDeployKey(
  request: Request,
): Promise<DeployCaller> {
  const token = extractEveryAppBearer(request.headers);
  if (!token) {
    throw unauthorized(
      "DEPLOY_KEY_REQUIRED",
      "Send a deploy key as the bearer token (EVERYAPP_DEPLOY_TOKEN).",
    );
  }
  const pat = await UserPatService.verify(token);
  if (!pat) {
    throw unauthorized(
      "DEPLOY_KEY_INVALID",
      "The deploy key is unknown, revoked or expired. Create one in Admin → Tokens (Deploy key).",
    );
  }
  // Deploy-only, checked where the key is used and not only where it is
  // made: a row with any other scope beside `deploy` isn't a deploy key.
  if (pat.scopes.length !== 1 || pat.scopes[0] !== DEPLOY_SCOPE) {
    throw new DeployError(
      "DEPLOY_SCOPE_REQUIRED",
      403,
      "This token isn't a deploy key. Create one in Admin → Tokens (Deploy key).",
    );
  }
  const role = await resolveLiveOrgRole(pat.userId, pat.organizationId);
  if (!role) {
    throw unauthorized(
      "NOT_A_MEMBER",
      "The deploy key's owner is no longer a member of its organization, or is deactivated.",
    );
  }
  if (role !== "owner" && role !== "admin") {
    throw new DeployError(
      "DEPLOY_FORBIDDEN",
      403,
      "Only the organization's owners and admins deploy apps.",
    );
  }
  if (!(await isOrganizationActive(pat.organizationId))) {
    throw new DeployError(
      "ORGANIZATION_SUSPENDED",
      403,
      "The organization is suspended.",
    );
  }
  void UserPatRepository.touchLastUsed(pat.id, pat.userId).catch(
    () => undefined,
  );
  return {
    tokenId: pat.id,
    userId: pat.userId,
    email: pat.userEmail,
    organizationId: pat.organizationId,
    appRowId: pat.appRowId,
    role,
  };
}
