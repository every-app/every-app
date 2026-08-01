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

class GatewayApiError extends Error {
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

export class GatewayInternalApisDisabledError extends GatewayApiError {
  constructor(message = "GATEWAY_INTERNAL_APIS_DISABLED") {
    super({
      message,
      status: 404,
      code: INTERNAL_APIS_DISABLED_ERROR_CODE,
    });
    this.name = "GatewayInternalApisDisabledError";
  }
}

export class GatewayAuthError extends GatewayApiError {
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

export function isGatewayInternalApisDisabledError(
  error: unknown,
): error is GatewayInternalApisDisabledError {
  return error instanceof GatewayInternalApisDisabledError;
}

export function isGatewayAuthError(error: unknown): error is GatewayAuthError {
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
  workerName: string;
  manifest: unknown;
}

interface RegisterAppResponse {
  appId: string;
  appSlug: string;
  hostname: string;
  existingApp: boolean;
  defaultAccess: boolean;
  grantedUserCount: number;
}

interface GatewayWhoamiResponse {
  organizationId: string;
  organizationName: string;
  scopes: string[];
  capabilities?: {
    appGateway?: boolean;
  };
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
    });

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
