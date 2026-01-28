-- Create new apps catalog table
CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`app_url` text NOT NULL,
	`dev_url` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apps_app_id_unique` ON `apps` (`app_id`);--> statement-breakpoint
CREATE INDEX `apps_app_id_idx` ON `apps` (`app_id`);--> statement-breakpoint

-- Create user app access junction table
CREATE TABLE `user_app_access` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`app_id` text NOT NULL,
	`granted_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`granted_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_app_access_user_app_unique` ON `user_app_access` (`user_id`,`app_id`);--> statement-breakpoint
CREATE INDEX `user_app_access_user_id_idx` ON `user_app_access` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_app_access_app_id_idx` ON `user_app_access` (`app_id`);--> statement-breakpoint

-- Migrate data from user_apps to new tables
-- Step 1: Insert unique apps into the apps catalog (using first occurrence for each app_id)
INSERT INTO `apps` (`id`, `app_id`, `name`, `description`, `app_url`, `dev_url`, `is_default`, `created_at`, `updated_at`)
SELECT 
    `id`,
    `app_id`,
    `name`,
    `description`,
    `app_url`,
    `dev_url`,
    1, -- Mark all migrated apps as default so existing behavior is preserved
    `created_at`,
    `updated_at`
FROM `user_apps`
WHERE `id` IN (
    SELECT MIN(`id`) FROM `user_apps` GROUP BY `app_id`
);
--> statement-breakpoint

-- Step 2: Create access records for all users who had each app
INSERT INTO `user_app_access` (`id`, `user_id`, `app_id`, `granted_at`, `granted_by`)
SELECT 
    ua.`id`,
    ua.`user_id`,
    a.`id`,
    ua.`created_at`,
    NULL
FROM `user_apps` ua
JOIN `apps` a ON ua.`app_id` = a.`app_id`;
--> statement-breakpoint

-- Step 3: Drop the old user_apps table
DROP TABLE `user_apps`;
