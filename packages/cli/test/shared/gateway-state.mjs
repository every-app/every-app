/**
 * What the fake everyapp (test/setup-skills/fake-everyapp.mjs) knows
 * before a scenario adds to it: one installed, claimed Gateway on
 * apps.example.com with no apps and nothing set. A scenario's `state`
 * is spread over it.
 */
export const DEFAULT_STATE = {
  installed: true,
  claimed: true,
  accountId: "0123456789abcdef0123456789abcdef",
  accountName: "Example Co",
  cloudflareEmail: "pat@example.com",
  gatewayDomain: "apps.example.com",
  gatewayUrl: "https://apps.example.com",
  appBaseDomain: "apps.example.com",
  /** The one domain on Cloudflare in this account (what `cf zones list` shows, where setup may put the Gateway). */
  zone: "example.com",
  owner: { email: "pat@example.com", organizationName: "Example Co", slug: "example" },
  versionId: "00000000-0000-4000-8000-000000000001",
  gatewayNames: [],
  apps: [],
  members: [],
  accessCommand: false,
  access: { on: false, team: null },
};

/** Commands no scenario may run unasked (a setup never deletes; a build never deploys). */
export const DESTRUCTIVE = [/^secret unset\b/, /^access off\b/, /^delete\b/, /^db restore\b/, /^email unset\b/];
