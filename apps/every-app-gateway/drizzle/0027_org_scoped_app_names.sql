CREATE TABLE `organization_keys` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`org_key` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_keys_org_key_unique` ON `organization_keys` (`org_key`);--> statement-breakpoint
-- Apps registered before org-scoped names keep their every-<appId> Worker
-- and resource names. The default marks every row that exists now, and any
-- row the gateway code from before this migration writes while an upgrade
-- runs (migrations go first), as legacy; new registrations write 0.
ALTER TABLE `apps` ADD `legacy_names` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `version_id` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `deployed_at` integer;
