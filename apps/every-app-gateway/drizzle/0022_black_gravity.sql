CREATE TABLE `owner_bootstrap` (
	`id` text PRIMARY KEY NOT NULL,
	`claimed_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT "owner_bootstrap_singleton_check" CHECK("owner_bootstrap"."id" = 'owner')
);
--> statement-breakpoint
INSERT INTO `owner_bootstrap` (`id`)
SELECT 'owner'
WHERE EXISTS (
	SELECT 1 FROM `members` WHERE `role` = 'owner'
);
