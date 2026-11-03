-- everyapp:contract 0.3.0-rc.11
-- OAuth simplified (docs/design/2026-11-oauth-simplify.md): per-app
-- connections replace shared ones, scope-set overlays and background grants
-- go. Every connection is dropped on purpose (people reconnect in each app),
-- so while `everyapp update` swaps the code, the old Gateway's OAuth paths
-- fail for those seconds; nothing else reads these tables.
DROP TABLE `provider_scope_sets`;--> statement-breakpoint
DROP TABLE `oauth_states`;--> statement-breakpoint
DROP TABLE `provider_background_grants`;--> statement-breakpoint
DROP TABLE `provider_connections`;--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`app_row_id` text NOT NULL,
	`code_verifier` text NOT NULL,
	`scopes` text NOT NULL,
	`return_to` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`app_row_id` text NOT NULL,
	`label` text,
	`external_id` text,
	`scopes` text NOT NULL,
	`access_token_enc` text NOT NULL,
	`refresh_token_enc` text,
	`expires_at` integer,
	`status` text NOT NULL,
	`refreshing_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_connections_owner_idx` ON `provider_connections` (`organization_id`,`provider_id`,`user_id`,`app_row_id`);--> statement-breakpoint
CREATE INDEX `provider_connections_user_idx` ON `provider_connections` (`user_id`);--> statement-breakpoint
CREATE INDEX `provider_connections_app_idx` ON `provider_connections` (`app_row_id`);
