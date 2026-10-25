CREATE TABLE `usage_models` (
	`organization_id` text NOT NULL,
	`app_row_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`month` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `app_row_id`, `provider`, `model`, `month`)
);
--> statement-breakpoint
CREATE INDEX `usage_models_org_month_idx` ON `usage_models` (`organization_id`,`month`);--> statement-breakpoint
ALTER TABLE `org_settings` ADD `ai_default` text;