ALTER TABLE `event_subscriptions` ADD `app_row_id` text;--> statement-breakpoint
CREATE INDEX `event_subscriptions_app_row_id_idx` ON `event_subscriptions` (`app_row_id`);