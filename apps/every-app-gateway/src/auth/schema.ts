import type { BetterAuthPlugin } from "better-auth";

/**
 * The gateway's own additions to Better Auth's tables, in every mode and in
 * both configs (runtime and CLI), so whichever plugins a mode registers the
 * schema stays the one src/db/auth.schema.ts and the migrations describe.
 */
export function gatewaySchema() {
  return {
    id: "every-app-schema",
    schema: {
      // One account row per provider identity. Better Auth looks accounts up
      // by (provider_id, account_id) and refuses a sign-in when two rows
      // match, which two first-time sign-ins racing (say, Cloudflare
      // Access's outer ring in several restored tabs) could otherwise
      // create; with this index the second insert fails and that request
      // simply isn't signed in.
      account: {
        fields: {},
        indexes: [
          {
            name: "accounts_provider_account_unique",
            fields: ["providerId", "accountId"],
            unique: true,
          },
        ],
      },
      // One membership per person and organization: a second row would
      // give them two roles there, and every lookup by (organization, user)
      // picks one of them.
      member: {
        fields: {},
        indexes: [
          {
            name: "members_organization_user_unique",
            fields: ["organizationId", "userId"],
            unique: true,
          },
        ],
      },
    },
  } satisfies BetterAuthPlugin;
}

/**
 * The organization plugin's extra columns. `status`: `active`, or
 * `suspended` (an organization the platform switched off). Set by the
 * gateway only, never through Better Auth's endpoints.
 */
export const organizationSchema = {
  organization: {
    additionalFields: {
      status: {
        type: "string" as const,
        required: true,
        defaultValue: "active",
        input: false,
      },
    },
  },
};
