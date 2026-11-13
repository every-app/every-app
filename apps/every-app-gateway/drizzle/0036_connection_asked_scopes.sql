-- The scopes the provider was asked for at a connection's last connect, so a
-- scope the person declined (asked, not held) is told from one an app started
-- listing later (never asked). Null on existing rows: nothing is known.

ALTER TABLE `provider_connections` ADD `asked_scopes` text;
