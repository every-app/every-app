import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
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

  let betterAuthSecret = firstNonEmpty(
    process.env.BETTER_AUTH_SECRET,
    localEnv.BETTER_AUTH_SECRET,
  );
  let jwtPrivateKey = firstNonEmpty(
    process.env.JWT_PRIVATE_KEY,
    localEnv.JWT_PRIVATE_KEY,
  );
  let jwtPublicKey = firstNonEmpty(
    process.env.JWT_PUBLIC_KEY,
    localEnv.JWT_PUBLIC_KEY,
  );

  if (jwtPrivateKey && !jwtPublicKey) {
    throw new Error("JWT_PUBLIC_KEY is required when JWT_PRIVATE_KEY is set");
  }

  if (jwtPublicKey && !jwtPrivateKey) {
    throw new Error("JWT_PRIVATE_KEY is required when JWT_PUBLIC_KEY is set");
  }

  if (!betterAuthSecret) {
    console.log("Generating BETTER_AUTH_SECRET for self-hosted gateway");
    betterAuthSecret = randomBytes(32).toString("base64");
  }

  if (!jwtPrivateKey && !jwtPublicKey) {
    console.log("Generating JWT key pair for self-hosted gateway");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    jwtPrivateKey = privateKey.replace(/\n/g, "\\n");
    jwtPublicKey = publicKey.replace(/\n/g, "\\n");
  }

  const gatewayUrl = firstNonEmpty(
    process.env.GATEWAY_URL,
    localEnv.GATEWAY_URL,
    "http://every-app-gateway.localhost:3000",
  );
  const openAiApiKey = firstNonEmpty(
    process.env.OPENAI_API_KEY,
    localEnv.OPENAI_API_KEY,
  );
  const emailRestApiToken = firstNonEmpty(
    process.env.EMAIL_REST_API_TOKEN,
    localEnv.EMAIL_REST_API_TOKEN,
  );
  const cloudflareAccountId = firstNonEmpty(
    process.env.CLOUDFLARE_ACCOUNT_ID,
    localEnv.CLOUDFLARE_ACCOUNT_ID,
  );
  const emailFrom = firstNonEmpty(process.env.EMAIL_FROM, localEnv.EMAIL_FROM);
  const emailFromName = firstNonEmpty(
    process.env.EMAIL_FROM_NAME,
    localEnv.EMAIL_FROM_NAME,
  );

  process.env.GATEWAY_URL = gatewayUrl;
  process.env.BETTER_AUTH_SECRET = betterAuthSecret;
  process.env.JWT_PRIVATE_KEY = jwtPrivateKey;
  process.env.JWT_PUBLIC_KEY = jwtPublicKey;
  process.env.OPENAI_API_KEY = openAiApiKey;
  process.env.EMAIL_REST_API_TOKEN = emailRestApiToken;
  process.env.CLOUDFLARE_ACCOUNT_ID = cloudflareAccountId;
  process.env.EMAIL_FROM = emailFrom;
  process.env.EMAIL_FROM_NAME = emailFromName;

  writeEnvFile([
    "GATEWAY_URL",
    "BETTER_AUTH_SECRET",
    "JWT_PRIVATE_KEY",
    "JWT_PUBLIC_KEY",
    "OPENAI_API_KEY",
    "EMAIL_REST_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "EMAIL_FROM",
    "EMAIL_FROM_NAME",
  ]);

  chmodSync(".env", 0o600);
  console.log("Wrote gateway runtime config to .env");

  await runCommand("npx", [
    "wrangler",
    "d1",
    "execute",
    "every-app-gateway",
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
    "3000",
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
