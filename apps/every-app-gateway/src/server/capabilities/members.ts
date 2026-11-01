/**
 * The `members` capability (docs/capabilities.md "Gateway services"): an
 * app reads its organization's members who can open it now, so mail and
 * notifications stop reaching people who left, were deactivated or lost
 * the app. Logged by count only, never an address.
 *
 *   GET /api/integrations/members/list   -> ListMembersResult
 *   GET /api/integrations/members        MembersCapabilityStatus
 */
import {
  CAPABILITIES,
  type MembersCapabilityStatus,
  type OrganizationMember,
} from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import type { CapabilityRequest } from "@every-app/perimeter/manifest";
import type { IntegrationCallAdmission } from "@/server/integration-proxy";
import { capabilityRefusal } from "./refusal";

const MEMBERS = CAPABILITIES.members;

/** The members of `organizationId` who can open the calling app. */
export type ListAppMembers = (
  organizationId: string,
) => Promise<OrganizationMember[]>;

/** Whether the app may list members: its manifest lists them for reading. */
function requested(entry: CapabilityRequest | undefined): boolean {
  return entry?.access === "read";
}

/** `GET /api/integrations/members`: whether a list would go through. */
export function membersCapabilityStatus(
  entry: CapabilityRequest | undefined,
): Response {
  const status: MembersCapabilityStatus = {
    capability: "members",
    requested: requested(entry),
    configured: true,
    ready: requested(entry),
  };
  return Response.json(status);
}

/** `GET /api/integrations/members/list`, checked in the order below. */
export async function handleMembersList({
  request,
  entry,
  admit,
  listMembers,
}: {
  request: Request;
  entry: CapabilityRequest | undefined;
  admit: () => Promise<IntegrationCallAdmission>;
  listMembers: ListAppMembers;
}): Promise<Response> {
  const method = request.method.toUpperCase();
  if (!(MEMBERS.routes.list as readonly string[]).includes(method)) {
    return capabilityRefusal(
      405,
      "integration_method_not_allowed",
      "Members are listed with GET /api/integrations/members/list (listMembers() in @every-app/sdk/server).",
    );
  }
  // 1. The deployed manifest listing members for reading is the grant.
  if (!requested(entry)) {
    return capabilityRefusal(
      403,
      "capability_not_requested",
      'This app doesn\'t list members in its capabilities. Add capabilities: { members: { access: "read" } } to everyapp.config.ts and deploy again.',
    );
  }
  // 2. Whose organization (throws the entrypoint's caller_* refusals).
  const { caller, user } = await admit();
  // 3. The directory is the app's to read, not an agent's to page through.
  if (user?.channel === "mcp") {
    return capabilityRefusal(
      403,
      "integration_agent_not_allowed",
      "An agent's tool call can't list the organization's members.",
    );
  }

  const members = await listMembers(caller.organizationId);
  logEvent("members.app.list", {
    ...caller,
    members: members.length,
    attribution: user ? "user" : "app",
    ...(user ? { userId: user.id } : {}),
  });
  return Response.json({ members });
}
