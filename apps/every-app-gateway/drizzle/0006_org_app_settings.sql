CREATE TABLE `org_app_settings` (
	`organization_id` text NOT NULL,
	`app_row_id` text NOT NULL,
	`monthly_call_cap` integer,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	PRIMARY KEY(`organization_id`, `app_row_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_row_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
