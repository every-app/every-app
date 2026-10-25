ALTER TABLE `events` ADD `actor_kind` text;--> statement-breakpoint
ALTER TABLE `events` ADD `actor_id` text;--> statement-breakpoint
CREATE INDEX `events_org_actor_time_idx` ON `events` (`organization_id`,`actor_id`,`time`);--> statement-breakpoint
-- Backfill: the actor JSON's kind and id as columns, for the audit log's filter.
UPDATE `events` SET `actor_kind` = json_extract(`actor`, '$.kind'), `actor_id` = json_extract(`actor`, '$.id') WHERE `actor_kind` IS NULL;