-- Counts every write of a connection's tokens, so a refresh stores its result
-- (and a refused one marks the row expired) only while the tokens are still
-- the ones it read. Existing rows start at 0.

ALTER TABLE `provider_connections` ADD `token_version` integer DEFAULT 0 NOT NULL;
