-- MCP servers, counted apart from apps: how many a Gateway has connected, and their use for the
-- day, all of them together. A report from before these columns (none was ever sent) reads 0.
ALTER TABLE reports ADD COLUMN mcp_servers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reports ADD COLUMN mcp_active_members_1d INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reports ADD COLUMN mcp_tool_calls_1d INTEGER NOT NULL DEFAULT 0;
