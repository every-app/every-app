CREATE TABLE `usage_daily` (
	`organization_id` text NOT NULL,
	`app_row_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`day` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `app_row_id`, `user_id`, `kind`, `target`, `day`)
);
--> statement-breakpoint
CREATE INDEX `usage_daily_org_day_idx` ON `usage_daily` (`organization_id`,`day`);--> statement-breakpoint
CREATE INDEX `usage_daily_app_day_idx` ON `usage_daily` (`app_row_id`,`day`);--> statement-breakpoint
CREATE TABLE `usage_monthly` (
	`organization_id` text NOT NULL,
	`app_row_id` text NOT NULL,
	`month` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `app_row_id`, `month`)
);
