const ORGANIZATION_ROLES = ["owner", "admin", "member"] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

function isOrganizationRole(value: string): value is OrganizationRole {
  return (ORGANIZATION_ROLES as readonly string[]).includes(value);
}

function parseOrganizationRoles(
  value: string | readonly string[] | null | undefined,
): OrganizationRole[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.filter(isOrganizationRole);
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(isOrganizationRole);
}

export function resolvePrimaryOrganizationRole(
  value: string | readonly string[] | null | undefined,
): OrganizationRole | null {
  const roles = parseOrganizationRoles(value);
  if (roles.includes("owner")) {
    return "owner";
  }
  if (roles.includes("admin")) {
    return "admin";
  }
  if (roles.includes("member")) {
    return "member";
  }
  return null;
}
