# Release Process

## Gateway Releases

The gateway application is released as a prebuilt artifact to speed up deployments via the CLI.

### Automated Release Process

Releases are **fully automated** when you bump the version and merge to main:

1. **Make changes** to `apps/every-app-gateway`
2. **Bump version** in `apps/every-app-gateway/package.json`
   ```json
   {
     "version": "0.0.1"  // Increment this
   }
   ```
3. **Create PR** - CI verifies version was bumped
4. **Merge to main** - GitHub automatically:
   - Builds the gateway
   - Creates tag `gateway-v{version}`
   - Creates GitHub release with build artifacts
   - Updates `gateway-latest` release

**Note:** PRs that modify gateway code will fail CI if the version isn't bumped.

### Versioning

Gateway releases follow semantic versioning: `X.Y.Z`

- **Major (X)**: Breaking changes
- **Minor (Y)**: New features, backward compatible
- **Patch (Z)**: Bug fixes

### Release Contents

Each release includes:
- `.output/` - Built Cloudflare Worker and assets
- `wrangler.jsonc` - Cloudflare configuration template
- `drizzle/` - Database migrations
- `drizzle-prod.config.ts` - Production migration config
- `package.json` - Package manifest

### CLI Integration

The `every gateway deploy` command automatically:
1. Fetches the latest gateway release from GitHub
2. Downloads and extracts the prebuilt artifacts
3. Configures Cloudflare resources
4. Deploys to Cloudflare Workers

No build step is required during deployment, making the process much faster.

### Troubleshooting

**PR check fails - "version not bumped":**
- Update the `version` field in `apps/every-app-gateway/package.json`
- Ensure the version is higher than the one in main branch

**No releases found error:**
- Ensure at least one gateway release has been created
- Check that releases exist at github.com/[org]/[repo]/releases

**Build fails in CI:**
- Check the PR Checks workflow is passing
- Ensure all dependencies are properly declared
- Verify the build works locally first:
  ```bash
  cd apps/every-app-gateway
  pnpm run build
  ```
