CREATE TABLE `invitation_link_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`invitation_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`invitation_id`) REFERENCES `invitations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitation_link_tokens_token_hash_unique` ON `invitation_link_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitation_link_tokens_invitation_id_idx` ON `invitation_link_tokens` (`invitation_id`);