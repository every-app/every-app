/**
 * The rule for a workspace's name: what the Gateway's setup claim gives
 * the first organization, what a personal organization is called, and
 * what a rename takes (Manage workspace → Rename, `everyapp workspace
 * rename`). The Gateway and the CLI share it so a name the CLI writes is
 * one the Gateway would have accepted. A name is user input that reaches
 * other people: the invitation emails it sends, and every member's
 * organization switcher.
 */

export const MAX_ORGANIZATION_NAME_LENGTH = 64;

/**
 * The name, trimmed and with its runs of whitespace made single spaces, or
 * null when it is empty, longer than 64 characters, or has a control or
 * invisible formatting character (line breaks, bidirectional overrides,
 * zero-width characters) anywhere in it.
 */
export function validOrganizationName(raw: string): string | null {
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(raw)) return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name || [...name].length > MAX_ORGANIZATION_NAME_LENGTH) return null;
  return name;
}
