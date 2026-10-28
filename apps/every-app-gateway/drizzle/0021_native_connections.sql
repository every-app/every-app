ALTER TABLE `mcp_connections` ADD `kind` text DEFAULT 'mcp' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_connections` ADD `resource` text;