import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";

function parseEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }
  return dotenv.parse(readFileSync(path, "utf8"));
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function normalize(value) {
  return String(value ?? "").replace(/\r?\n/g, "\\n");
}

function serializeEnv(obj) {
  return (
    Object.entries(obj)
      .map(([key, val]) => {
        const needsQuotes = /[\s#"'\\]/.test(val) || val.includes("\\n");
        return needsQuotes ? `${key}="${val}"` : `${key}=${val}`;
      })
      .join("\n") + "\n"
  );
}

function writeEnvFile(keys) {
  const values = Object.fromEntries(
    keys.map((key) => [key, normalize(process.env[key])]),
  );
  writeFileSync(".env", serializeEnv(values), "utf8");
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${String(code)}`,
        ),
      );
    });
  });
}

async function main() {
  const localEnv = parseEnvFile(".env");

  const gatewayUrl = firstNonEmpty(
    process.env.GATEWAY_URL,
    localEnv.GATEWAY_URL,
    "http://every-app-gateway.localhost:3000",
  );
  const viteGatewayUrl = firstNonEmpty(
    process.env.VITE_GATEWAY_URL,
    localEnv.VITE_GATEWAY_URL,
    "http://every-app-gateway.localhost:3000",
  );
  const viteAppId = firstNonEmpty(
    process.env.VITE_APP_ID,
    localEnv.VITE_APP_ID,
    "chef",
  );
  const gatewayAppApiToken = firstNonEmpty(
    process.env.GATEWAY_APP_API_TOKEN,
    localEnv.GATEWAY_APP_API_TOKEN,
  );

  process.env.GATEWAY_URL = gatewayUrl;
  process.env.VITE_GATEWAY_URL = viteGatewayUrl;
  process.env.VITE_APP_ID = viteAppId;
  process.env.GATEWAY_APP_API_TOKEN = gatewayAppApiToken;

  writeEnvFile([
    "GATEWAY_URL",
    "VITE_GATEWAY_URL",
    "VITE_APP_ID",
    "GATEWAY_APP_API_TOKEN",
  ]);

  chmodSync(".env", 0o600);
  console.log("Wrote app runtime config to .env");

  await runCommand("npx", [
    "wrangler",
    "d1",
    "execute",
    "every-chef",
    "--local",
    "--command",
    "SELECT 1;",
  ]);
  await runCommand("pnpm", ["run", "db:migrate:local"]);
  await runCommand("pnpm", [
    "exec",
    "vite",
    "dev",
    "--host",
    "0.0.0.0",
    "--port",
    "3001",
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
