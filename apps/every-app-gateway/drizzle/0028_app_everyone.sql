-- everyapp:contract 0.3.0-rc.11
-- "Available to everyone" becomes one flag on the app (`apps.everyone`)
-- instead of a `user_app_access` row written for every member on the
-- toggle and on every join (`is_default` only said to write them). Who
-- opens an app is now computed: the flag, an owner or admin role, a
-- person's grant or a group's (server/repositories/effective-access.ts).
--
-- The flag comes from today's live state, not the manifests: an app was
-- available to everyone where `is_default` is on AND every member of its
-- organization still holds a direct row. Where an admin later took someone
-- off while `is_default` stayed on, the app keeps exactly its rows (only
-- people who join later stop getting it). Then the rows the flag makes
-- redundant go: every row on an app available to everyone. Elsewhere the
-- rows stay, owners' and admins' included (still theirs if one is demoted).
--
-- `is_default` is dropped in the same release: while `everyapp update`
-- swaps the code, the old Gateway's app queries fail for those seconds.
ALTER TABLE `apps` ADD `everyone` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `apps` SET `everyone` = 1
WHERE `is_default` = 1
  AND `scope` = 'org'
  AND `status` != 'deleted'
  AND NOT EXISTS (
    SELECT 1 FROM `members` `m`
    WHERE `m`.`organization_id` = `apps`.`organization_id`
      AND NOT EXISTS (
        SELECT 1 FROM `user_app_access` `ua`
        WHERE `ua`.`app_row_id` = `apps`.`id`
          AND `ua`.`organization_id` = `apps`.`organization_id`
          AND `ua`.`user_id` = `m`.`user_id`
      )
  );--> statement-breakpoint
DELETE FROM `user_app_access`
WHERE `app_row_id` IN (SELECT `id` FROM `apps` WHERE `everyone` = 1);--> statement-breakpoint
ALTER TABLE `apps` DROP COLUMN `is_default`;
