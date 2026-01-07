#!/bin/bash
# Build a release tarball for the gateway with drizzle-kit bundled
# Usage: ./scripts/build-release.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_DIR="$(dirname "$SCRIPT_DIR")"
RELEASE_DIR="$GATEWAY_DIR/release-package"
TARBALL_PATH="$GATEWAY_DIR/every-app-gateway-build.tar.gz"

echo "Building gateway release..."
echo "Gateway directory: $GATEWAY_DIR"

# Build the gateway
echo "Running pnpm build..."
cd "$GATEWAY_DIR"
pnpm run build

# Clean up any existing release package
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

# Verify build output exists
if [ ! -d "dist" ]; then
  echo "ERROR: dist directory not found after build"
  exit 1
fi

# Copy build artifacts
echo "Copying build artifacts..."
cp -r dist/. "$RELEASE_DIR/dist/"
cp wrangler.jsonc "$RELEASE_DIR/"
cp package.json "$RELEASE_DIR/"
cp pnpm-lock.yaml "$RELEASE_DIR/"
cp -r drizzle "$RELEASE_DIR/"
cp drizzle-prod.config.ts "$RELEASE_DIR/"

# Copy .wrangler/deploy/config.json
mkdir -p "$RELEASE_DIR/.wrangler/deploy"
cp .wrangler/deploy/config.json "$RELEASE_DIR/.wrangler/deploy/"

# Clean up absolute paths from built wrangler.json
node -e "
  const fs = require('fs');
  const configPath = '$RELEASE_DIR/dist/server/wrangler.json';
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  delete config.configPath;
  delete config.userConfigPath;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
"

# Bundle drizzle-kit and drizzle-orm for migrations
echo "Bundling drizzle-kit and drizzle-orm..."
cd "$RELEASE_DIR"
mv package.json package-original.json
echo '{"name": "gateway-migrations", "private": true, "dependencies": {"drizzle-kit": "^0.31.4", "drizzle-orm": "^0.44.2"}}' > package.json
npm install --silent
mv package-original.json package.json
rm -f package-lock.json

# Create tarball
echo "Creating tarball..."
cd "$GATEWAY_DIR"
tar -czf "$TARBALL_PATH" -C "$RELEASE_DIR" .

# Show results
echo ""
echo "Release package created:"
echo "  Tarball: $TARBALL_PATH"
echo "  Size: $(du -sh "$TARBALL_PATH" | cut -f1)"
echo ""
echo "To test locally with the CLI, run:"
echo "  every gateway deploy --local-gateway \"$TARBALL_PATH\""
