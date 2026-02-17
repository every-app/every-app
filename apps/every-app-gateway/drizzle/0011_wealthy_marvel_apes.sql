CREATE TABLE `app_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
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
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_tokens_token_hash_unique` ON `app_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `app_tokens_app_id_idx` ON `app_tokens` (`app_id`);--> statement-breakpoint
CREATE INDEX `app_tokens_token_prefix_idx` ON `app_tokens` (`token_prefix`);--> statement-breakpoint
CREATE INDEX `app_tokens_revoked_at_idx` ON `app_tokens` (`revoked_at`);