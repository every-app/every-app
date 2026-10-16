/**
 * `.everyapp/deploy.json` — the deploy-time inputs `everyapp deploy`
 * writes just before `cf build --mode production` and deletes right after.
 * `everyAppWorker()` reads it in production mode, so a bare `cf build` or
 * `cf deploy` (no file) fails instead of shipping a Worker with no identity
 * keys or gateway binding.
 */
import fs from "node:fs";
import path from "node:path";

/** Where the deploy inputs live, relative to the app root. */
export const DEPLOY_INPUTS_FILE = ".everyapp/deploy.json";

export interface EveryAppDeployInputs {
  schema: 1;
  /** The Worker name the gateway registry assigned to this app. */
  workerName: string;
  /** The organization that owns the app; scopes the AppGateway binding. */
  organizationId: string;
  gatewayUrl: string;
  /** Expected `iss` of identity tokens. */
  identityIssuer: string;
  /** SPKI PEM public keys (current + next) that verify identity tokens. */
  identityPublicKeys: string[];
  /** Provisioned resources keyed by manifest binding name. */
  resources: {
    d1?: Record<string, { name: string; id: string }>;
    kv?: Record<string, { id: string }>;
  };
  /** Durable Object classes removed from the app; their data is deleted. */
  deletedDurableObjects?: string[];
  createdAt?: string;
}

export class DeployInputsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployInputsError";
  }
}

/** Validate an untrusted value as deploy inputs, or throw DeployInputsError. */
export function parseDeployInputs(value: unknown): EveryAppDeployInputs {
  const input = record(value, "deploy inputs");
  if (input["schema"] !== 1) {
    throw new DeployInputsError(
      `${DEPLOY_INPUTS_FILE} has schema ${JSON.stringify(input["schema"])}; this SDK reads schema 1. Upgrade @every-app/sdk or the everyapp CLI so they match.`,
    );
  }
  const resources = record(input["resources"] ?? {}, "resources");
  const deleted = input["deletedDurableObjects"];
  if (
    deleted !== undefined &&
    (!Array.isArray(deleted) || !deleted.every(isNonEmptyString))
  ) {
    throw new DeployInputsError(
      "deletedDurableObjects must be a list of class names",
    );
  }
  const keys = input["identityPublicKeys"];
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every(isPem)) {
    throw new DeployInputsError(
      "identityPublicKeys must be a non-empty list of PEM public keys",
    );
  }
  const createdAt = input["createdAt"];

  return {
    schema: 1,
    workerName: string(input, "workerName"),
    organizationId: string(input, "organizationId"),
    gatewayUrl: url(input, "gatewayUrl"),
    identityIssuer: url(input, "identityIssuer"),
    identityPublicKeys: keys,
    resources: {
      d1: mapValues(record(resources["d1"] ?? {}, "resources.d1"), (v, k) => {
        const entry = record(v, `resources.d1.${k}`);
        return { name: string(entry, "name"), id: string(entry, "id") };
      }),
      kv: mapValues(record(resources["kv"] ?? {}, "resources.kv"), (v, k) => {
        const entry = record(v, `resources.kv.${k}`);
        return { id: string(entry, "id") };
      }),
    },
    ...(deleted ? { deletedDurableObjects: deleted } : {}),
    ...(typeof createdAt === "string" ? { createdAt } : {}),
  };
}

/** Read `<root>/.everyapp/deploy.json`, or undefined when it doesn't exist. */
export function readDeployInputs(
  root: string,
): EveryAppDeployInputs | undefined {
  const file = path.join(root, DEPLOY_INPUTS_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeployInputsError(`${file} is not valid JSON`);
  }
  return parseDeployInputs(parsed);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeployInputsError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (!isNonEmptyString(value)) {
    throw new DeployInputsError(`${key} must be a non-empty string`);
  }
  return value;
}

function url(input: Record<string, unknown>, key: string): string {
  const value = string(input, key);
  try {
    new URL(value);
  } catch {
    throw new DeployInputsError(`${key} must be an absolute URL`);
  }
  return value;
}

function mapValues<T>(
  input: Record<string, unknown>,
  fn: (value: unknown, key: string) => T,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, fn(value, key)]),
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPem(value: unknown): value is string {
  return (
    isNonEmptyString(value) && value.includes("-----BEGIN PUBLIC KEY-----")
  );
}
