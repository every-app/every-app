PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`app_url` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_user_apps`("id", "user_id", "app_id", "name", "description", "app_url", "created_at", "updated_at") SELECT "id", "user_id", "app_id", "name", "description", "app_url", "created_at", "updated_at" FROM `user_apps`;--> statement-breakpoint
DROP TABLE `user_apps`;--> statement-breakpoint
ALTER TABLE `__new_user_apps` RENAME TO `user_apps`;--> statement-breakpoint
PRAGMA foreign_keys=ON;