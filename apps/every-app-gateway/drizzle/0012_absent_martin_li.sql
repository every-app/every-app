PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`created_at` integer NOT NULL,
	`metadata` text
);--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_uidx` ON `organizations` (`slug`);--> statement-breakpoint

CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `members_org_user_unique` ON `members` (`organization_id`, `user_id`);--> statement-breakpoint
CREATE INDEX `members_organizationId_idx` ON `members` (`organization_id`);--> statement-breakpoint
CREATE INDEX `members_userId_idx` ON `members` (`user_id`);--> statement-breakpoint

CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`inviter_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `invitations_organizationId_idx` ON `invitations` (`organization_id`);--> statement-breakpoint
CREATE INDEX `invitations_email_idx` ON `invitations` (`email`);--> statement-breakpoint

ALTER TABLE `sessions` ADD `active_organization_id` text;--> statement-breakpoint

INSERT INTO `organizations` (`id`, `name`, `slug`, `logo`, `created_at`, `metadata`)
SELECT
	'00000000-0000-4000-8000-000000000001',
	'Default Organization',
	'default',
	NULL,
	cast(unixepoch('subsecond') * 1000 as integer),
	NULL
WHERE NOT EXISTS (SELECT 1 FROM `organizations`);--> statement-breakpoint

DROP TABLE IF EXISTS `__new_apps`;--> statement-breakpoint
CREATE TABLE `__new_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`app_url` text NOT NULL,
	`dev_url` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_apps` (
	`id`,
	`organization_id`,
	`app_id`,
	`name`,
	`description`,
	`app_url`,
	`dev_url`,
	`is_default`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	coalesce(
		(SELECT id FROM `organizations` WHERE `slug` = 'default' LIMIT 1),
		(SELECT id FROM `organizations` ORDER BY `created_at` ASC LIMIT 1)
	),
	`app_id`,
	`name`,
	`description`,
	`app_url`,
	`dev_url`,
	`is_default`,
	`created_at`,
	`updated_at`
FROM `apps`;--> statement-breakpoint
DROP TABLE `apps`;--> statement-breakpoint
ALTER TABLE `__new_apps` RENAME TO `apps`;--> statement-breakpoint
CREATE UNIQUE INDEX `apps_organization_app_id_unique` ON `apps` (`organization_id`,`app_id`);--> statement-breakpoint
CREATE INDEX `apps_organization_id_idx` ON `apps` (`organization_id`);--> statement-breakpoint

DROP TABLE IF EXISTS `__new_user_app_access`;--> statement-breakpoint
CREATE TABLE `__new_user_app_access` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`app_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`granted_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`granted_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_user_app_access` (
	`id`,
	`user_id`,
	`app_id`,
	`organization_id`,
	`granted_at`,
	`granted_by`
)
SELECT
	ua.`id`,
	ua.`user_id`,
	ua.`app_id`,
	a.`organization_id`,
	ua.`granted_at`,
	ua.`granted_by`
FROM `user_app_access` ua
INNER JOIN `apps` a ON a.`id` = ua.`app_id`;--> statement-breakpoint
DROP TABLE `user_app_access`;--> statement-breakpoint
ALTER TABLE `__new_user_app_access` RENAME TO `user_app_access`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_app_access_user_app_unique` ON `user_app_access` (`organization_id`,`user_id`,`app_id`);--> statement-breakpoint
CREATE INDEX `user_app_access_organization_id_idx` ON `user_app_access` (`organization_id`);--> statement-breakpoint
CREATE INDEX `user_app_access_user_id_idx` ON `user_app_access` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_app_access_app_id_idx` ON `user_app_access` (`app_id`);--> statement-breakpoint

DROP TABLE IF EXISTS `__new_app_tokens`;--> statement-breakpoint
CREATE TABLE `__new_app_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_app_tokens` (
	`id`,
	`app_id`,
	`organization_id`,
	`token_hash`,
	`token_prefix`,
	`scopes`,
	`created_by`,
	`created_at`,
	`updated_at`,
	`expires_at`,
	`revoked_at`,
	`last_used_at`
)
SELECT
	t.`id`,
	t.`app_id`,
	a.`organization_id`,
	t.`token_hash`,
	t.`token_prefix`,
	t.`scopes`,
	t.`created_by`,
	t.`created_at`,
	t.`updated_at`,
	t.`expires_at`,
	t.`revoked_at`,
	t.`last_used_at`
FROM `app_tokens` t
INNER JOIN `apps` a ON a.`id` = t.`app_id`;--> statement-breakpoint
DROP TABLE `app_tokens`;--> statement-breakpoint
ALTER TABLE `__new_app_tokens` RENAME TO `app_tokens`;--> statement-breakpoint
CREATE UNIQUE INDEX `app_tokens_token_hash_unique` ON `app_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `app_tokens_organization_id_idx` ON `app_tokens` (`organization_id`);--> statement-breakpoint
CREATE INDEX `app_tokens_app_id_idx` ON `app_tokens` (`app_id`);--> statement-breakpoint
CREATE INDEX `app_tokens_token_prefix_idx` ON `app_tokens` (`token_prefix`);--> statement-breakpoint
CREATE INDEX `app_tokens_revoked_at_idx` ON `app_tokens` (`revoked_at`);--> statement-breakpoint

INSERT INTO `members` (`id`, `organization_id`, `user_id`, `role`, `created_at`)
SELECT
	lower(hex(randomblob(16))),
	coalesce(
		(SELECT id FROM `organizations` WHERE `slug` = 'default' LIMIT 1),
		(SELECT id FROM `organizations` ORDER BY `created_at` ASC LIMIT 1)
	),
	u.`id`,
	CASE
		WHEN u.`role` = 'owner' THEN 'owner'
		WHEN u.`role` = 'admin' THEN 'admin'
		ELSE 'member'
	END,
	cast(unixepoch('subsecond') * 1000 as integer)
FROM `users` u
WHERE NOT EXISTS (
	SELECT 1
	FROM `members` m
	WHERE m.`organization_id` = coalesce(
		(SELECT id FROM `organizations` WHERE `slug` = 'default' LIMIT 1),
		(SELECT id FROM `organizations` ORDER BY `created_at` ASC LIMIT 1)
	)
		AND m.`user_id` = u.`id`
);--> statement-breakpoint

DELETE FROM `members`
WHERE `id` NOT IN (
	SELECT MIN(`id`)
	FROM `members`
	GROUP BY `organization_id`, `user_id`
);--> statement-breakpoint

UPDATE `members`
SET `role` = 'owner'
WHERE `role` != 'owner'
	AND `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'owner');--> statement-breakpoint

UPDATE `members`
SET `role` = 'admin'
WHERE `role` = 'member'
	AND `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'admin');--> statement-breakpoint

DELETE FROM `user_app_access`
WHERE NOT EXISTS (
	SELECT 1
	FROM `members`
	WHERE `members`.`organization_id` = `user_app_access`.`organization_id`
		AND `members`.`user_id` = `user_app_access`.`user_id`
);--> statement-breakpoint

UPDATE `sessions`
SET `active_organization_id` = coalesce(
	(SELECT id FROM `organizations` WHERE `slug` = 'default' LIMIT 1),
	(SELECT id FROM `organizations` ORDER BY `created_at` ASC LIMIT 1)
)
WHERE `active_organization_id` IS NULL;--> statement-breakpoint

PRAGMA foreign_keys=ON;
