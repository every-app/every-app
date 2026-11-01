CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_account_unique` ON `accounts` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `accounts_userId_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`inviter_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invitations_organizationId_idx` ON `invitations` (`organization_id`);--> statement-breakpoint
CREATE INDEX `invitations_email_idx` ON `invitations` (`email`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_organization_user_unique` ON `members` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `members_organizationId_idx` ON `members` (`organization_id`);--> statement-breakpoint
CREATE INDEX `members_userId_idx` ON `members` (`user_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`created_at` integer NOT NULL,
	`metadata` text,
	`status` text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	`active_organization_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_userId_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`role` text,
	`banned` integer DEFAULT false,
	`ban_reason` text,
	`ban_expires` integer,
	`status` text DEFAULT 'active'
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);--> statement-breakpoint
CREATE TABLE `user_onboarding` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_onboarding_user_id_unique` ON `user_onboarding` (`user_id`);--> statement-breakpoint
CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`app_slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`hostname` text,
	`worker_name` text,
	`tier` text DEFAULT 'service_binding' NOT NULL,
	`scope` text DEFAULT 'org' NOT NULL,
	`manifest` text,
	`status` text DEFAULT 'active' NOT NULL,
	`version_id` text,
	`deployed_at` integer,
	`deployed_by_actor` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apps_hostname_unique` ON `apps` (`hostname`);--> statement-breakpoint
CREATE UNIQUE INDEX `apps_worker_name_unique` ON `apps` (`worker_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `apps_id_organization_unique` ON `apps` (`id`,`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `apps_organization_app_slug_unique` ON `apps` (`organization_id`,`app_slug`);--> statement-breakpoint
CREATE INDEX `apps_organization_id_idx` ON `apps` (`organization_id`);--> statement-breakpoint
CREATE TABLE `user_app_access` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`app_row_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`granted_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`granted_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_row_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`app_row_id`,`organization_id`) REFERENCES `apps`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_app_access_user_app_unique` ON `user_app_access` (`organization_id`,`user_id`,`app_row_id`);--> statement-breakpoint
CREATE INDEX `user_app_access_organization_id_idx` ON `user_app_access` (`organization_id`);--> statement-breakpoint
CREATE INDEX `user_app_access_user_id_idx` ON `user_app_access` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_app_access_app_row_id_idx` ON `user_app_access` (`app_row_id`);--> statement-breakpoint
CREATE TABLE `user_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`app_row_id` text,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_row_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_row_id`,`organization_id`) REFERENCES `apps`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_access_tokens_token_hash_unique` ON `user_access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `user_access_tokens_user_id_idx` ON `user_access_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_access_tokens_organization_id_idx` ON `user_access_tokens` (`organization_id`);--> statement-breakpoint
CREATE INDEX `user_access_tokens_app_row_id_idx` ON `user_access_tokens` (`app_row_id`);--> statement-breakpoint
CREATE INDEX `user_access_tokens_token_prefix_idx` ON `user_access_tokens` (`token_prefix`);--> statement-breakpoint
CREATE INDEX `user_access_tokens_revoked_at_idx` ON `user_access_tokens` (`revoked_at`);--> statement-breakpoint
CREATE TABLE `owner_bootstrap` (
	`id` text PRIMARY KEY NOT NULL,
	`claimed_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT "owner_bootstrap_singleton_check" CHECK("owner_bootstrap"."id" = 'owner')
);
--> statement-breakpoint
CREATE TABLE `owner_setup_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`consumed_by` text,
	CONSTRAINT "owner_setup_tokens_kind_check" CHECK("owner_setup_tokens"."kind" IN ('claim', 'recovery'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `owner_setup_tokens_token_hash_unique` ON `owner_setup_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `invitation_link_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`invitation_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`invitation_id`) REFERENCES `invitations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitation_link_tokens_token_hash_unique` ON `invitation_link_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitation_link_tokens_invitation_id_idx` ON `invitation_link_tokens` (`invitation_id`);--> statement-breakpoint
CREATE TABLE `organization_keys` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`org_key` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_keys_org_key_unique` ON `organization_keys` (`org_key`);--> statement-breakpoint
CREATE TABLE `app_tool_catalogs` (
	`app_row_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`status` text NOT NULL,
	`catalog_hash` text,
	`tool_count` integer DEFAULT 0 NOT NULL,
	`instructions` text,
	`sdk_version` text,
	`warnings` text,
	`last_error` text,
	`fetched_at` integer NOT NULL,
	`version_id` text,
	FOREIGN KEY (`app_row_id`,`organization_id`) REFERENCES `apps`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `app_tools` (
	`app_row_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`title` text,
	`description` text NOT NULL,
	`risk` text NOT NULL,
	`input_schema` text NOT NULL,
	`output_schema` text,
	`annotations` text,
	`catalog_hash` text NOT NULL,
	PRIMARY KEY(`app_row_id`, `name`),
	FOREIGN KEY (`app_row_id`,`organization_id`) REFERENCES `apps`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `app_tools_organization_id_idx` ON `app_tools` (`organization_id`);--> statement-breakpoint
CREATE TABLE `mcp_connection_apps` (
	`connection_id` text NOT NULL,
	`app_row_id` text NOT NULL,
	PRIMARY KEY(`connection_id`, `app_row_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `mcp_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_row_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mcp_connection_apps_app_row_id_idx` ON `mcp_connection_apps` (`app_row_id`);--> statement-breakpoint
CREATE TABLE `mcp_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text NOT NULL,
	`client_domain` text,
	`redirect_uri` text NOT NULL,
	`redirect_host` text NOT NULL,
	`app_scope` text NOT NULL,
	`access` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`revoked_by` text,
	`revoked_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mcp_connections_user_org_idx` ON `mcp_connections` (`user_id`,`organization_id`);--> statement-breakpoint
CREATE INDEX `mcp_connections_user_client_idx` ON `mcp_connections` (`user_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `mcp_connections_organization_id_idx` ON `mcp_connections` (`organization_id`);--> statement-breakpoint
CREATE TABLE `mcp_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_kind` text NOT NULL,
	`credential_id` text NOT NULL,
	`client_name` text,
	`surface` text NOT NULL,
	`app_row_id` text,
	`app_slug` text,
	`tool_name` text NOT NULL,
	`risk` text,
	`decision` text NOT NULL,
	`reason` text,
	`outcome` text NOT NULL,
	`duration_ms` integer,
	`args_digest` text,
	`result_bytes` integer,
	`protocol_version` text,
	`request_id` text
);
--> statement-breakpoint
CREATE INDEX `mcp_tool_calls_org_created_idx` ON `mcp_tool_calls` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `mcp_tool_calls_credential_created_idx` ON `mcp_tool_calls` (`credential_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `mcp_tool_calls_created_idx` ON `mcp_tool_calls` (`created_at`);--> statement-breakpoint
CREATE TABLE `rate_limit_counters` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_limit_counters_expires_at_idx` ON `rate_limit_counters` (`expires_at`);--> statement-breakpoint
CREATE TABLE `deploy_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`app_row_id` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_row_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deploy_jobs_organization_id_idx` ON `deploy_jobs` (`organization_id`);--> statement-breakpoint
CREATE INDEX `deploy_jobs_app_row_id_status_idx` ON `deploy_jobs` (`app_row_id`,`status`);