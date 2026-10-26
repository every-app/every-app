CREATE TABLE `provider_scope_sets` (
	`provider_id` text NOT NULL,
	`name` text NOT NULL,
	`spec` text NOT NULL,
	`added_by` text,
	`added_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`provider_id`, `name`)
);
