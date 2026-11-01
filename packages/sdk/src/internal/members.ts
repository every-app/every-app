/**
 * The `members` capability's wire contract (docs/capabilities.md "Gateway
 * services"): what `GET /api/integrations/members/list` answers. The
 * gateway builds it, the SDK's `listMembers()` returns it, and its local-dev
 * fallback answers in the same shape. Types only.
 */

import type { OrgRole } from "./protocol.js";

/** A member's role in the organization: the identity token's {@link OrgRole}. */
export type OrganizationMemberRole = OrgRole;

/**
 * One member of the organization who can open the app: not deactivated,
 * and, for an organization's own app, granted it.
 */
export interface OrganizationMember {
  /** The user id, the identity's `sub` (`getEveryAppUser().id`). */
  id: string;
  email: string;
  /** The display name; empty when the person set none. */
  name: string;
  role: OrganizationMemberRole;
}

/** What a list answers. */
export interface ListMembersResult {
  members: OrganizationMember[];
}

/** `GET /api/integrations/members`: whether the app may list members. */
export interface MembersCapabilityStatus {
  capability: "members";
  /** The app's manifest lists `members`. */
  requested: boolean;
  /** Always true: the gateway needs no setting to list its own members. */
  configured: true;
  /** Lists would go through. */
  ready: boolean;
}
