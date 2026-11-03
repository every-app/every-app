-- everyapp:contract 0.3.0
-- Caps are dollars only: the call caps go. An app's row that held only a
-- call cap is left with neither a cap nor `unlimited`, so it goes too and the
-- workspace default applies to the app. While `everyapp update` swaps the
-- code, the old Gateway's cap reads fail for those seconds.
DELETE FROM `org_app_settings` WHERE `monthly_cost_cap_micros` IS NULL AND `unlimited` = 0;--> statement-breakpoint
ALTER TABLE `org_app_settings` DROP COLUMN `monthly_call_cap`;--> statement-breakpoint
ALTER TABLE `org_settings` DROP COLUMN `default_monthly_call_cap`;
