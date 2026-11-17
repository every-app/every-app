-- Usage reports (server/telemetry/): the one row that holds this Gateway's
-- choice and the reporter's own state. The row is written here, once:
-- `existing` records whether the Gateway already had an owner when it got
-- this table (an update), or not yet (a new setup, where migrations run
-- before the owner is made). What that means for when reports start is the
-- policy in the SDK (packages/sdk/src/internal/telemetry.ts). Only adds.

CREATE TABLE `telemetry_state` (
	`id` text PRIMARY KEY NOT NULL,
	`existing` integer NOT NULL,
	`created_at` integer NOT NULL,
	`enabled` integer,
	`changed_at` integer,
	`changed_by` text,
	`install_id` text,
	`reported_day` text,
	`attempt_day` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_payload` text,
	`last_reported_at` integer,
	CONSTRAINT "telemetry_state_singleton_check" CHECK("telemetry_state"."id" = 'telemetry')
);
--> statement-breakpoint
INSERT INTO `telemetry_state` (`id`, `existing`, `created_at`, `install_id`)
VALUES (
	'telemetry',
	EXISTS (SELECT 1 FROM `members` WHERE `role` = 'owner'),
	cast(unixepoch('subsecond') * 1000 as integer),
	-- Random, derived from nothing: the id this Gateway's reports carry.
	lower(hex(randomblob(16)))
);
