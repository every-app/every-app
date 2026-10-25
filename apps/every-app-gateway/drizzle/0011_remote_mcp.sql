CREATE TABLE `remote_mcp_credentials` (
	`name` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`bound_by` text,
	`bound_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `remote_mcp_tools` (
	`app_row_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`upstream_name` text NOT NULL,
	`local_name` text,
	`title` text,
	`risk_hint` text NOT NULL,
	`listed` integer NOT NULL,
	`problem` text,
	`listed_at` integer NOT NULL,
	PRIMARY KEY(`app_row_id`, `upstream_name`),
	FOREIGN KEY (`app_row_id`,`organization_id`) REFERENCES `apps`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `remote_mcp_tools_organization_id_idx` ON `remote_mcp_tools` (`organization_id`);
