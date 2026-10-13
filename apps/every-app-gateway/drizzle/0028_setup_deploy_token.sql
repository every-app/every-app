ALTER TABLE `owner_setup_tokens` ADD `cli_secret_hash` text;--> statement-breakpoint
ALTER TABLE `owner_setup_tokens` ADD `deploy_token_issued_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `owner_setup_tokens_cli_secret_hash_unique` ON `owner_setup_tokens` (`cli_secret_hash`);