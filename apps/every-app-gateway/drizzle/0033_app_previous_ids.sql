-- The ids (and hostnames) apps had before a rename
-- (docs/design/2026-11-app-rename.md). The app's row keeps its primary key
-- and Worker; the old hostname is served until the id is retired.

CREATE TABLE `app_previous_ids` (
	`organization_id` text NOT NULL,
	`app_slug` text NOT NULL,
	`app_row_id` text NOT NULL,
	`hostname` text NOT NULL,
	`renamed_at` integer NOT NULL,
	`moved_at` integer,
	`retired_at` integer,
	PRIMARY KEY(`organization_id`, `app_slug`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_row_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_previous_ids_hostname_unique` ON `app_previous_ids` (`hostname`);--> statement-breakpoint
CREATE INDEX `app_previous_ids_app_row_id_idx` ON `app_previous_ids` (`app_row_id`);