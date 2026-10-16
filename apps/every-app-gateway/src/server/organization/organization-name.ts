/**
 * Organization names and slugs. A personal organization is named after
 * whoever signed up, so its name is user input that reaches other people:
 * the invitation emails it sends, and every member's organization switcher.
 */

const MAX_ORGANIZATION_NAME_LENGTH = 64;

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

/**
 * What a personal organization is called: the person's name, else their
 * email's local part, else "Personal", whichever is first a valid
 * organization name.
 */
export function personalOrganizationName(user: {
  name?: string | null;
  email: string;
}): string {
  return (
    validOrganizationName(user.name ?? "") ??
    validOrganizationName(user.email.split("@")[0] ?? "") ??
    "Personal"
  );
}

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}
