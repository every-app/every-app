CREATE TABLE `oauth_clients` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_enc` text,
	`bound_to` text,
	`added_by` text,
	`added_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`account_kind` text NOT NULL,
	`code_verifier` text NOT NULL,
	`scope_sets` text NOT NULL,
	`return_to` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`account_kind` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` text,
	`label` text,
	`external_id` text,
	`scope_sets` text NOT NULL,
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
CREATE UNIQUE INDEX `provider_connections_subject_idx` ON `provider_connections` (`organization_id`,`provider_id`,`subject`);--> statement-breakpoint
CREATE INDEX `provider_connections_user_idx` ON `provider_connections` (`user_id`);