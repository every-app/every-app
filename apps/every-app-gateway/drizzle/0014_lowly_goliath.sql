CREATE UNIQUE INDEX `apps_id_organization_unique` ON `apps` (`id`,`organization_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_app_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`app_id`,`organization_id`) REFERENCES `apps`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_app_tokens`("id", "app_id", "organization_id", "token_hash", "token_prefix", "scopes", "created_by", "created_at", "updated_at", "expires_at", "revoked_at", "last_used_at") SELECT "id", "app_id", "organization_id", "token_hash", "token_prefix", "scopes", "created_by", "created_at", "updated_at", "expires_at", "revoked_at", "last_used_at" FROM `app_tokens`;--> statement-breakpoint
DROP TABLE `app_tokens`;--> statement-breakpoint
ALTER TABLE `__new_app_tokens` RENAME TO `app_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `app_tokens_token_hash_unique` ON `app_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `app_tokens_organization_id_idx` ON `app_tokens` (`organization_id`);--> statement-breakpoint
CREATE INDEX `app_tokens_app_id_idx` ON `app_tokens` (`app_id`);--> statement-breakpoint
CREATE INDEX `app_tokens_token_prefix_idx` ON `app_tokens` (`token_prefix`);--> statement-breakpoint
CREATE INDEX `app_tokens_revoked_at_idx` ON `app_tokens` (`revoked_at`);--> statement-breakpoint
CREATE TABLE `__new_user_app_access` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`app_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`granted_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`granted_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`app_id`,`organization_id`) REFERENCES `apps`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_user_app_access`("id", "user_id", "app_id", "organization_id", "granted_at", "granted_by") SELECT "id", "user_id", "app_id", "organization_id", "granted_at", "granted_by" FROM `user_app_access`;--> statement-breakpoint
DROP TABLE `user_app_access`;--> statement-breakpoint
ALTER TABLE `__new_user_app_access` RENAME TO `user_app_access`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_app_access_user_app_unique` ON `user_app_access` (`organization_id`,`user_id`,`app_id`);--> statement-breakpoint
CREATE INDEX `user_app_access_organization_id_idx` ON `user_app_access` (`organization_id`);--> statement-breakpoint
CREATE INDEX `user_app_access_user_id_idx` ON `user_app_access` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_app_access_app_id_idx` ON `user_app_access` (`app_id`);