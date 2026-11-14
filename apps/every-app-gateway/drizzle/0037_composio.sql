-- Composio (docs/design/2026-11-composio.md): the organization's switch, a
-- person's link (their key, sealed) and the sign-in waiting to become one,
-- and how a connection was made. Every row there is today is `via` "oauth".
-- A connection through Composio holds services with their accounts
-- (`composio_accounts`), not scopes. Only adds.

CREATE TABLE `composio_link_requests` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`sign_in_enc` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `composio_link_requests_person_idx` ON `composio_link_requests` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `composio_link_requests_user_idx` ON `composio_link_requests` (`user_id`);--> statement-breakpoint
CREATE TABLE `composio_links` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`key_enc` text NOT NULL,
	`account_label` text NOT NULL,
	`composio_org_id` text NOT NULL,
	`composio_project_id` text NOT NULL,
	`composio_user_id` text NOT NULL,
	`session_id` text,
	`session_accounts` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `composio_links_person_idx` ON `composio_links` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `composio_links_user_idx` ON `composio_links` (`user_id`);--> statement-breakpoint
ALTER TABLE `org_settings` ADD `composio` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `via` text DEFAULT 'oauth' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `composio_accounts` text;
