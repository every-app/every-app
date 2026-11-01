/**
 * How a personal organization is told apart (personal-organization.ts): its
 * Better Auth `metadata` is `{"personalFor": <the owner's user id>}`. The
 * gateway alone writes it; Better Auth's organization update endpoint, the
 * one way to change metadata over HTTP, is closed (auth/config.ts).
 */

export function personalOrganizationMetadata(userId: string): string {
  return JSON.stringify({ personalFor: userId });
}

export function isPersonalOrganizationOf(
  metadata: string | null | undefined,
  userId: string,
): boolean {
  if (!metadata) return false;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { personalFor?: unknown }).personalFor === userId
    );
  } catch {
    return false;
  }
}
