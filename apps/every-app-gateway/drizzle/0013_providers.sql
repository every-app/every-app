CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`spec` text NOT NULL,
	`added_by` text,
	`added_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`bound_to` text,
	`bound_at` integer
);
