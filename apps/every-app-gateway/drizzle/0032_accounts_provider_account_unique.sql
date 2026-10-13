-- One account row per provider identity. Better Auth looks accounts up by
-- (provider_id, account_id) and refuses a sign-in when two rows match, which
-- two first-time sign-ins racing (say, Cloudflare Access's outer ring in
-- several restored tabs) could otherwise create; with this the second insert
-- fails and that request simply isn't signed in. Existing rows are password
-- (credential) accounts keyed by user id, so none collide. Not in the
-- generated Drizzle schema (src/db/auth.schema.ts comes from Better Auth's
-- generator): Better Auth validates its columns, not this index.
CREATE UNIQUE INDEX `accounts_provider_account_unique` ON `accounts` (`provider_id`,`account_id`);
