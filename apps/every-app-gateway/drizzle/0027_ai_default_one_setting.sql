-- everyapp:contract 0.3.0-rc.11
-- The default model is one setting, `ai_default` = `<provider>[/<model>]`;
-- the per-provider model memory (`ai_models`) goes. A stored provider with a
-- chat model in `ai_models` keeps that model in the one setting first. Every
-- other model setting is dropped on purpose and the catalog model serves
-- instead: embeddings models, providers that weren't the stored default, and
-- an organization with no stored default whose `everyapp ai model` choice
-- served through the shipped order (its provider still serves; the model
-- falls back to the catalog's). A row left holding nothing stays: every
-- reader treats it as no setting, and the next write of the row deletes it.
-- While `everyapp update` swaps the code, the old Gateway's default-model
-- reads fail for those seconds.
UPDATE `org_settings`
SET `ai_default` = `ai_default` || '/' || json_extract(`ai_models`, '$."' || `ai_default` || '".chat')
WHERE `ai_default` IS NOT NULL
  AND instr(`ai_default`, '/') = 0
  AND json_valid(`ai_models`)
  AND json_type(`ai_models`, '$."' || `ai_default` || '".chat') = 'text';--> statement-breakpoint
ALTER TABLE `org_settings` DROP COLUMN `ai_models`;
