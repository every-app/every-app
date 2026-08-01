ALTER TABLE `apps` RENAME COLUMN `app_id` TO `app_slug`;--> statement-breakpoint
ALTER TABLE `app_tokens` RENAME COLUMN `app_id` TO `app_row_id`;--> statement-breakpoint
ALTER TABLE `user_app_access` RENAME COLUMN `app_id` TO `app_row_id`;--> statement-breakpoint
DROP INDEX `apps_organization_app_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `apps_organization_app_slug_unique` ON `apps` (`organization_id`,`app_slug`);--> statement-breakpoint
DROP INDEX `app_tokens_app_id_idx`;--> statement-breakpoint
CREATE INDEX `app_tokens_app_row_id_idx` ON `app_tokens` (`app_row_id`);--> statement-breakpoint
DROP INDEX `user_app_access_app_id_idx`;--> statement-breakpoint
CREATE INDEX `user_app_access_app_row_id_idx` ON `user_app_access` (`app_row_id`);
