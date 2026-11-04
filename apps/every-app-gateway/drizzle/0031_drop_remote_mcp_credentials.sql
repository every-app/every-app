-- everyapp:contract 0.3.0-rc.11
-- Remote MCP credentials live in the provider registry now
-- (docs/design/2026-11-mcp-apps-auth.md): the pin table goes. A remote MCP
-- app added before it reads as needing setup and is added again.
DROP TABLE `remote_mcp_credentials`;