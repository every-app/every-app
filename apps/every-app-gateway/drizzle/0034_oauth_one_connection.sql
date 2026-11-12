-- One connection per person per provider
-- (docs/design/2026-11-oauth-one-connection.md): a connection stops
-- belonging to an app, and `provider_app_access` says which apps a person
-- allowed to use it. Each person keeps one connection per provider: an
-- active one before an expired one, then the one holding the most scopes,
-- then the newest. The other apps' tokens are dropped. Every app whose
-- connection was to that same account stays allowed; an app connected to
-- another account asks the person again. A connect state says whether the
-- provider's callback spends it or the Gateway's own Allow page.
-- `provider_connections.app_row_id` stays, as the app the connection was
-- last made from: the CLI before this release reads it, so a later
-- release drops it. While `everyapp update` swaps the code, the old
-- Gateway's OAuth paths fail for those seconds.
CREATE TABLE `provider_app_access` (
	`organization_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`app_row_id` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_app_access_owner_idx` ON `provider_app_access` (`organization_id`,`provider_id`,`user_id`,`app_row_id`);--> statement-breakpoint
CREATE INDEX `provider_app_access_user_idx` ON `provider_app_access` (`user_id`);--> statement-breakpoint
CREATE INDEX `provider_app_access_app_idx` ON `provider_app_access` (`app_row_id`);--> statement-breakpoint
ALTER TABLE `oauth_states` ADD `purpose` text DEFAULT 'authorize' NOT NULL;--> statement-breakpoint
INSERT INTO `provider_app_access` (`organization_id`, `provider_id`, `user_id`, `app_row_id`, `scopes`, `created_at`, `updated_at`)
SELECT c.`organization_id`, c.`provider_id`, c.`user_id`, c.`app_row_id`, c.`scopes`, c.`created_at`, c.`updated_at`
FROM `provider_connections` c
JOIN (
	SELECT `organization_id`, `provider_id`, `user_id`, `external_id`, `label`,
		ROW_NUMBER() OVER (
			PARTITION BY `organization_id`, `provider_id`, `user_id`
			ORDER BY (`status` = 'active') DESC, json_array_length(`scopes`) DESC, `updated_at` DESC, `id`
		) AS `position`
	FROM `provider_connections`
) kept ON kept.`position` = 1
	AND kept.`organization_id` = c.`organization_id`
	AND kept.`provider_id` = c.`provider_id`
	AND kept.`user_id` = c.`user_id`
WHERE COALESCE(c.`external_id`, c.`label`, '') = COALESCE(kept.`external_id`, kept.`label`, '');--> statement-breakpoint
DELETE FROM `provider_connections` WHERE `id` IN (
	SELECT `id` FROM (
		SELECT `id`,
			ROW_NUMBER() OVER (
				PARTITION BY `organization_id`, `provider_id`, `user_id`
				ORDER BY (`status` = 'active') DESC, json_array_length(`scopes`) DESC, `updated_at` DESC, `id`
			) AS `position`
		FROM `provider_connections`
	) WHERE `position` > 1
);--> statement-breakpoint
DROP INDEX `provider_connections_owner_idx`;--> statement-breakpoint
DROP INDEX `provider_connections_app_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `provider_connections_person_idx` ON `provider_connections` (`organization_id`,`provider_id`,`user_id`);
