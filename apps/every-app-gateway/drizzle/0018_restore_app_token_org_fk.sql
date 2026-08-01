PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_app_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text,
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
CREATE INDEX `app_tokens_revoked_at_idx` ON `app_tokens` (`revoked_at`);