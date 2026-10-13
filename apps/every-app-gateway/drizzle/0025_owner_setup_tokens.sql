CREATE TABLE `owner_setup_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`consumed_by` text,
	CONSTRAINT "owner_setup_tokens_kind_check" CHECK("owner_setup_tokens"."kind" IN ('claim', 'recovery'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `owner_setup_tokens_token_hash_unique` ON `owner_setup_tokens` (`token_hash`);