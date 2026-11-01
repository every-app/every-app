CREATE TABLE `event_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`claimed_until` integer,
	`last_attempt_at` integer,
	`last_status_code` integer,
	`last_error` text,
	`delivered_at` integer,
	`redelivered_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_deliveries_status_next_idx` ON `event_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `event_deliveries_subscription_created_idx` ON `event_deliveries` (`subscription_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `event_deliveries_org_created_idx` ON `event_deliveries` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `event_deliveries_event_id_idx` ON `event_deliveries` (`event_id`);--> statement-breakpoint
CREATE TABLE `event_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`sink` text NOT NULL,
	`url` text,
	`secret` text,
	`recipients` text,
	`events` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`builtin` text,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`last_delivery_at` integer,
	`last_delivery_status` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_subscriptions_organization_id_idx` ON `event_subscriptions` (`organization_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`version` integer NOT NULL,
	`time` integer NOT NULL,
	`actor` text NOT NULL,
	`data` text NOT NULL,
	`app_row_id` text,
	`dedupe_key` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_dedupe_key_unique` ON `events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `events_org_time_idx` ON `events` (`organization_id`,`time`);--> statement-breakpoint
CREATE INDEX `events_time_idx` ON `events` (`time`);--> statement-breakpoint
ALTER TABLE `apps` ADD `setup_state` text;