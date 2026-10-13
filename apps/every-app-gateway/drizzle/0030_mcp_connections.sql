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
CREATE INDEX `mcp_tool_calls_created_idx` ON `mcp_tool_calls` (`created_at`);