CREATE TABLE `user_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`app_row_id` text,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_row_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_row_id`,`organization_id`) REFERENCES `apps`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_access_tokens_token_hash_unique` ON `user_access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `user_access_tokens_user_id_idx` ON `user_access_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_access_tokens_organization_id_idx` ON `user_access_tokens` (`organization_id`);--> statement-breakpoint
CREATE INDEX `user_access_tokens_app_row_id_idx` ON `user_access_tokens` (`app_row_id`);--> statement-breakpoint
CREATE INDEX `user_access_tokens_token_prefix_idx` ON `user_access_tokens` (`token_prefix`);--> statement-breakpoint
CREATE INDEX `user_access_tokens_revoked_at_idx` ON `user_access_tokens` (`revoked_at`);