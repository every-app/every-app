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
CREATE INDEX `app_tools_organization_id_idx` ON `app_tools` (`organization_id`);