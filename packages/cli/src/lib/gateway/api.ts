import { EveryAppError } from "@/lib/errors";
import {
  formatGatewayCredentialHelp,
  requireGatewayCredentialToken,
} from "@/lib/gateway/credentials";

const GATEWAY_API_TIMEOUT_MS = 15_000;
const INTERNAL_APIS_DISABLED_ERROR_CODE = "INTERNAL_APIS_DISABLED";

interface GatewayClientOptions {
  gatewayUrl: string;
  getAuthToken?: () => Promise<string>;
}

interface GatewayErrorPayload {
  error?: string;
  code?: string;
}

/** Something in front of the gateway answered with a redirect. */
function redirectedAway(path: string, response: Response): GatewayApiError {
  const location = response.headers.get("location") ?? "";
  if (/cloudflareaccess\.com|\/cdn-cgi\/access\//.test(location)) {
    return new GatewayApiError({
      message: `Cloudflare Access answered ${path} with its login page. Let the CLI's paths through Access: /api/deploy/*, /api/setup/deploy-token and /api/admin/has-owner (the "Outer ring" section of the Cloudflare Access guide).`,
      status: response.status,
      code: "ACCESS_IN_FRONT",
    });
  }
  return new GatewayApiError({
    message: `${path} was redirected to ${location || "another address"}; the gateway's API never redirects. Check the gateway URL (--gateway or EVERYAPP_GATEWAY_URL).`,
    status: response.status,
    code: "GATEWAY_REDIRECTED",
  });
}

export class GatewayApiError extends Error {
  status: number;
  code?: string;

  constructor({
    message,
    status,
    code,
  }: {
    message: string;
    status: number;
    code?: string;
  }) {
    super(message);
    this.name = "GatewayApiError";
    this.status = status;
    this.code = code;
  }
}

export class OutdatedGatewayError extends GatewayApiError {
  constructor(message = "OUTDATED_GATEWAY") {
    super({ message, status: 404 });
    this.name = "OutdatedGatewayError";
  }
}

class GatewayInternalApisDisabledError extends GatewayApiError {
  constructor(message = "GATEWAY_INTERNAL_APIS_DISABLED") {
    super({
      message,
      status: 404,
      code: INTERNAL_APIS_DISABLED_ERROR_CODE,
    });
    this.name = "GatewayInternalApisDisabledError";
  }
}

class GatewayAuthError extends GatewayApiError {
  constructor(status: number, message = "GATEWAY_INTERNAL_AUTH") {
    super({ message, status });
    this.name = "GatewayAuthError";
  }
}

export function isOutdatedGatewayError(
  error: unknown,
): error is OutdatedGatewayError {
  return error instanceof OutdatedGatewayError;
}

function isGatewayInternalApisDisabledError(
  error: unknown,
): error is GatewayInternalApisDisabledError {
  return error instanceof GatewayInternalApisDisabledError;
}

function isGatewayAuthError(error: unknown): error is GatewayAuthError {
  return error instanceof GatewayAuthError;
}

interface GatewayIdentityKeysResponse {
  issuer?: string | null;
  keys: string[];
}

interface RegisterAppPayload {
  appId: string;
  name: string;
  description: string;
  manifest: unknown;
  cliVersion: string;
  sdkVersion?: string;
}

/** The D1 databases and KV namespaces for an app's bindings, by binding. */
export interface AppResources {
  d1: Record<string, string>;
  kv: Record<string, string>;
}

export interface RegisterAppResponse {
  appRowId: string;
  appSlug: string;
  /** pending | binding | active | disabled */
  status: string;
  workerName: string;
  hostname: string;
  resources: AppResources;
  previousManifest: unknown;
  /** The Worker version the last deploy uploaded (absent from older gateways). */
  versionId?: string | null;
  existingApp: boolean;
  defaultAccess: boolean;
  grantedUserCount: number;
}

interface AppDeployState {
  status: string;
  workerName: string;
  hostname: string;
}

/** An app's deploy state with the names of its resources. */
export interface DeletedApp extends AppDeployState {
  resources: AppResources;
}

export interface SyncAppToolsResponse {
  appId: string;
  status: "ok" | "empty" | "unsupported" | "error";
  toolCount: number;
  catalogHash: string | null;
  sdkVersion: string | null;
  warnings: string[];
  error?: string;
}

export interface GatewayWhoamiResponse {
  organizationId: string;
  organizationName: string;
  scopes: string[];
  accountId?: string | null;
  gateway?: {
    release?: { version: string; sha256: string } | null;
    gatewayHost?: string | null;
    /** Apps live one label below it, each its own Custom Domain. */
    appBaseDomain?: string;
  };
  minCli?: string;
  minSdk?: string;
  capabilities?: {
    appGateway?: boolean;
    deployProtocol?: number;
  };
}

/** What `POST /api/setup/deploy-token` answers the CLI that minted the link. */
type SetupDeployTokenResponse =
  | { status: "pending" }
  | {
      token: string;
      organizationId: string;
      organizationName: string;
      /** Who claimed the link (gateways from before it don't say). */
      ownerEmail?: string | null;
    };

export interface GatewayStatusResponse {
  release: { version: string; sha256: string } | null;
  versionId: string | null;
  appBindingsDigest: string;
  /** With a deploy token only. */
  gatewayHost?: string | null;
  appBaseDomain?: string | null;
  appBindings?: string[];
}

export class GatewayClient {
  private gatewayUrl: string;
  private getAuthToken: () => Promise<string>;

  constructor({ gatewayUrl, getAuthToken }: GatewayClientOptions) {
    this.gatewayUrl = gatewayUrl.replace(/\/+$/, "");
    this.getAuthToken =
      getAuthToken ?? (() => requireGatewayCredentialToken(this.gatewayUrl));
  }

  getIdentityKeys(): Promise<GatewayIdentityKeysResponse> {
    return this.request<GatewayIdentityKeysResponse>(
      "/api/deploy/identity-keys",
      { method: "GET" },
    );
  }

  registerApp(payload: RegisterAppPayload): Promise<RegisterAppResponse> {
    return this.request<RegisterAppResponse>("/api/deploy/register", {
      method: "POST",
      body: payload,
    });
  }

  markDeployed(
    appId: string,
    payload: { versionId: string; manifest: unknown },
  ): Promise<AppDeployState> {
    return this.request<AppDeployState>(
      `/api/deploy/apps/${encodeURIComponent(appId)}/deployed`,
      { method: "POST", body: payload },
    );
  }

  activateApp(appId: string): Promise<AppDeployState> {
    return this.request<AppDeployState>(
      `/api/deploy/apps/${encodeURIComponent(appId)}/activate`,
      { method: "POST" },
    );
  }

  /** Ask the gateway to snapshot an app's agent tools (defineTools). */
  syncAppTools(appId: string): Promise<SyncAppToolsResponse> {
    return this.request<SyncAppToolsResponse>(
      `/api/deploy/apps/${encodeURIComponent(appId)}/tools/sync`,
      { method: "POST" },
    );
  }

  appInfo(appId: string): Promise<DeletedApp> {
    return this.request<DeletedApp>(
      `/api/deploy/apps/${encodeURIComponent(appId)}/info`,
      { method: "GET" },
    );
  }

  deleteApp(appId: string): Promise<DeletedApp> {
    return this.request<DeletedApp>(
      `/api/deploy/apps/${encodeURIComponent(appId)}/delete`,
      { method: "POST" },
    );
  }

  /** What the live gateway runs; with `auth`, also the apps it binds. */
  status(options: { auth?: boolean } = {}): Promise<GatewayStatusResponse> {
    return this.request<GatewayStatusResponse>("/api/deploy/status", {
      method: "GET",
      auth: options.auth ?? false,
    });
  }

  /**
   * The owner's first deploy token, with the secret this CLI kept when it
   * minted the setup link: `pending` until the link is claimed. A spent,
   * expired or unknown secret is a 404 (`INVALID_OR_EXPIRED_SETUP_LINK`).
   */
  setupDeployToken(cliSecret: string): Promise<SetupDeployTokenResponse> {
    return this.request<SetupDeployTokenResponse>("/api/setup/deploy-token", {
      method: "POST",
      body: { cliSecret },
      auth: false,
    });
  }

  async hasOwner(): Promise<boolean> {
    const response = await this.request<{ hasOwner: boolean }>(
      "/api/admin/has-owner",
      { method: "GET", auth: false },
    );
    if (typeof response.hasOwner !== "boolean") {
      throw new GatewayApiError({
        message: "Gateway returned an invalid owner response",
        status: 200,
      });
    }
    return response.hasOwner;
  }

  whoami(): Promise<GatewayWhoamiResponse> {
    return this.request<GatewayWhoamiResponse>("/api/deploy/whoami", {
      method: "GET",
    });
  }

  private async request<T>(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: unknown;
      auth?: boolean;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (options.auth !== false) {
      const token = await this.getAuthToken();
      headers["authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(`${this.gatewayUrl}${path}`, {
      method: options.method,
      signal: AbortSignal.timeout(GATEWAY_API_TIMEOUT_MS),
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      // The gateway's API never redirects: a redirect comes from something
      // in front of it, usually Cloudflare Access sending to its login page.
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      throw redirectedAway(path, response);
    }

    const responseText = await response.text();
    let payload: (GatewayErrorPayload & T) | null = null;
    if (responseText.trim()) {
      try {
        payload = JSON.parse(responseText) as GatewayErrorPayload & T;
      } catch {
        if (!response.ok) {
          throw new GatewayApiError({
            message: `Gateway request failed (${response.status})`,
            status: response.status,
          });
        }

        throw new GatewayApiError({
          message: "Gateway returned an invalid JSON response",
          status: response.status,
        });
      }
    }

    if (response.status === 404) {
      if (payload?.code === INTERNAL_APIS_DISABLED_ERROR_CODE) {
        throw new GatewayInternalApisDisabledError();
      }
      // A route this gateway has answers with a code; a gateway without the
      // route doesn't.
      if (payload?.code) {
        throw new GatewayApiError({
          message: payload.error || "Not found",
          status: 404,
          code: payload.code,
        });
      }
      throw new OutdatedGatewayError();
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new GatewayAuthError(
          response.status,
          [
            payload?.error || "Gateway deploy-token authorization failed.",
            formatGatewayCredentialHelp(this.gatewayUrl),
          ].join("\n"),
        );
      }

      throw new GatewayApiError({
        message:
          payload?.error || `Gateway request failed (${response.status})`,
        status: response.status,
        code: payload?.code,
      });
    }

    return (payload ?? {}) as T;
  }
}

/** A gateway API failure as the error a command reports. */
export function explainGatewayError(error: unknown): unknown {
  if (isOutdatedGatewayError(error)) {
    return new EveryAppError(
      "GATEWAY_OUTDATED",
      "The gateway is too old for this everyapp. Upgrade it: everyapp gateway upgrade",
    );
  }
  if (isGatewayAuthError(error)) {
    return new EveryAppError("GATEWAY_AUTH", error.message);
  }
  if (isGatewayInternalApisDisabledError(error)) {
    return new EveryAppError(
      "GATEWAY_APIS_DISABLED",
      "This gateway runs in hosted mode (or its deployment mode is misconfigured), so its deploy API is off.",
    );
  }
  if (error instanceof GatewayApiError && error.code) {
    return new EveryAppError(error.code, error.message, {
      retryable: error.status >= 500,
    });
  }
  return error;
}

