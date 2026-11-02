CREATE TABLE `provider_background_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`app_row_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scope_sets` text NOT NULL,
	`granted_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`last_used_at` integer,
	`ended_at` integer,
	`ended_reason` text,
	`ended_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_background_grants_pair_idx` ON `provider_background_grants` (`connection_id`,`app_row_id`);--> statement-breakpoint
CREATE INDEX `provider_background_grants_user_idx` ON `provider_background_grants` (`user_id`,`app_row_id`);--> statement-breakpoint
CREATE INDEX `provider_background_grants_org_idx` ON `provider_background_grants` (`organization_id`);