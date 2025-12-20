CREATE TABLE `user_onboarding` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`pwa_install_completed` integer DEFAULT false NOT NULL,
	`pwa_install_skip_count` integer DEFAULT 0 NOT NULL,
	`pwa_install_skipped_at` integer,
	`pwa_install_skipped_permanently` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_onboarding_user_id_unique` ON `user_onboarding` (`user_id`);