/**
 * Organization names and slugs. The name rule itself lives in the SDK
 * (`@every-app/sdk/internal` organizationName.ts) so the CLI's `workspace
 * rename` and the gateway accept the same names; what is only the
 * gateway's stays here: what a personal organization is called, and the
 * slug a new organization gets.
 */
import { validOrganizationName } from "@every-app/sdk/internal";

export { validOrganizationName } from "@every-app/sdk/internal";

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
