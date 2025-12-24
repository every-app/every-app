# Every App MCP
This server gives your coding agent access to example apps and Every App documentation which can be used for reference when building out your application. 

## Quick Start

This MCP server is compatabile with any coding agent tool. Below are some example configs:

### Claude Code

Run this command:

```sh
claude mcp add every-app -- npx -y @every-app/mcp
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "every-app": {
      "command": "npx",
      "args": ["-y", "@every-app/mcp"]
    }
  }
}
```

### OpenCode

Add to `opencode.json`:

```json
{
  "mcp": {
    "every-app": {
      "type": "local",
      "command": ["npx", "-y", "@every-app/mcp"]
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `every_app_mcp_list_examples` | List all available example apps with descriptions |
| `every_app_mcp_list_directory` | Browse directory structure of example apps |
| `every_app_mcp_read_file` | Read file contents with line numbers |
| `every_app_mcp_search_code` | Search for patterns using regex |
| `every_app_mcp_find_files` | Find files matching a glob pattern |
| `every_app_mcp_fetch_docs` | Fetch Every App documentation pages |


## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Type check
pnpm run types:check

# Run locally
Swap command argument with this:
`bun run ~/your_workspace/every-app/packages/mcp/src/index.ts`
```

