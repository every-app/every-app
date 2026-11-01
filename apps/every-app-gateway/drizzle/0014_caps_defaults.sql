CREATE TABLE `org_settings` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`default_monthly_call_cap` integer,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `org_app_settings` ADD `unlimited` integer DEFAULT false NOT NULL;