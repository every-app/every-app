import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface GatewayCredential {
  gatewayUrl: string;
  token: string;
  organizationId: string;
}

interface GatewayCredentialsFile {
  gateways: Record<string, GatewayCredential>;
}

class GatewayCredentialMissingError extends Error {
  gatewayUrl: string;

  constructor(gatewayUrl: string) {
    super(formatGatewayCredentialHelp(gatewayUrl));
    this.name = "GatewayCredentialMissingError";
    this.gatewayUrl = gatewayUrl;
  }
}

export function normalizeGatewayUrl(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function gatewayCredentialKey(gatewayUrl: string): string {
  return new URL(normalizeGatewayUrl(gatewayUrl)).host.toLowerCase();
}

export function getGatewayCredentialsPath(): string {
  return path.join(os.homedir(), ".everyapp", "credentials.json");
}

export function formatGatewayCredentialHelp(gatewayUrl: string): string {
  const normalizedGatewayUrl = normalizeGatewayUrl(gatewayUrl);
  return [
    `No deploy token is configured for ${normalizedGatewayUrl}.`,
    `Open ${normalizedGatewayUrl}/admin/tokens, create a Deploy Token, then run:`,
    "  everyapp login",
  ].join("\n");
}

async function readCredentialsFile(): Promise<GatewayCredentialsFile> {
  const credentialsPath = getGatewayCredentialsPath();
  try {
    const raw = await fs.readFile(credentialsPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<GatewayCredentialsFile>;
    return {
      gateways:
        parsed.gateways && typeof parsed.gateways === "object"
          ? parsed.gateways
          : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { gateways: {} };
    }

    throw error;
  }
}

async function writeCredentialsFile(
  credentials: GatewayCredentialsFile,
): Promise<void> {
  const credentialsPath = getGatewayCredentialsPath();
  await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
  await fs.writeFile(
    credentialsPath,
    `${JSON.stringify(credentials, null, 2)}\n`,
    { encoding: "utf-8", mode: 0o600 },
  );
  await fs.chmod(credentialsPath, 0o600);
}

export async function readGatewayCredential(
  gatewayUrl: string,
): Promise<GatewayCredential | null> {
  const credentials = await readCredentialsFile();
  return credentials.gateways[gatewayCredentialKey(gatewayUrl)] ?? null;
}

export async function requireGatewayCredentialToken(
  gatewayUrl: string,
): Promise<string> {
  const credential = await readGatewayCredential(gatewayUrl);
  if (!credential?.token) {
    throw new GatewayCredentialMissingError(gatewayUrl);
  }

  return credential.token;
}

export async function writeGatewayCredential(
  credential: GatewayCredential,
): Promise<void> {
  const normalizedGatewayUrl = normalizeGatewayUrl(credential.gatewayUrl);
  const credentials = await readCredentialsFile();
  credentials.gateways[gatewayCredentialKey(normalizedGatewayUrl)] = {
    ...credential,
    gatewayUrl: normalizedGatewayUrl,
  };
  await writeCredentialsFile(credentials);
}

export async function deleteGatewayCredential(
  gatewayUrl: string,
): Promise<boolean> {
  const credentials = await readCredentialsFile();
  const key = gatewayCredentialKey(gatewayUrl);
  if (!credentials.gateways[key]) {
    return false;
  }

  delete credentials.gateways[key];
  await writeCredentialsFile(credentials);
  return true;
}
