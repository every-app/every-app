ALTER TABLE `apps` ADD `hostname` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `worker_name` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `tier` text DEFAULT 'service_binding' NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `manifest` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `apps_hostname_unique` ON `apps` (`hostname`);