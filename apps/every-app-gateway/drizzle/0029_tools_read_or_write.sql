-- Tools read or write; personal tokens read-only, full or a deploy key.
-- Data only, no schema change.
--
-- A tool that said `risk: "destructive"` was hidden from every caller. Its
-- snapshot rows go: an SDK app lists it again as a write tool (with
-- `destructive: true`) once it runs the new SDK, and a remote MCP app
-- re-lists on first use because its revision is bumped below.
DELETE FROM `app_tools` WHERE `risk` = 'destructive';--> statement-breakpoint
-- The Activity log's old rows read as write calls.
UPDATE `mcp_tool_calls` SET `risk` = 'write' WHERE `risk` = 'destructive';--> statement-breakpoint
-- A remote MCP tool the operator set to destructive was hidden; it stays
-- hidden as a tool turned off. Every remote app's revision is bumped, so
-- its snapshot re-lists with the new risks.
UPDATE `apps` SET `manifest` = json_set(
	`manifest`,
	'$.remote.tools',
	json((
		SELECT coalesce(json_group_object(
			t.key,
			CASE WHEN json_extract(t.value, '$.risk') = 'destructive'
				THEN json_set(json_remove(t.value, '$.risk'), '$.enabled', json('false'))
				ELSE json(t.value)
			END
		), '{}')
		FROM json_each(`apps`.`manifest`, '$.remote.tools') AS t
	)),
	'$.remote.rev',
	coalesce(json_extract(`manifest`, '$.remote.rev'), 0) + 1
) WHERE json_valid(`manifest`) AND json_type(`manifest`, '$.remote') = 'object';--> statement-breakpoint
-- Read & write (`mcp:write`), typed scopes and empty scopes (which opened
-- nothing) are gone: those tokens are revoked, and their owners create a
-- read-only or full one.
UPDATE `user_access_tokens` SET
	`revoked_at` = (cast(unixepoch('subsecond') * 1000 as integer)),
	`updated_at` = (cast(unixepoch('subsecond') * 1000 as integer))
WHERE `revoked_at` IS NULL
	AND (NOT json_valid(`scopes`) OR json(`scopes`) NOT IN ('["*"]', '["mcp:read"]', '["deploy"]'));
