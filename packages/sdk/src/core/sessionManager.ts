import {
  BYPASS_GATEWAY_LOCAL_ONLY_EMAIL,
  BYPASS_GATEWAY_LOCAL_ONLY_TOKEN,
  BYPASS_GATEWAY_LOCAL_ONLY_USER_ID,
  isBypassGatewayLocalOnlyClient,
} from "../shared/bypassGatewayLocalOnly.js";

interface SessionToken {
  token: string;
  expiresAt: number;
}

interface TokenResponse {
  token: string;
  expiresAt?: string;
  error?: string;
}

export interface SessionManagerConfig {
  appId: string;
}

const MESSAGE_TIMEOUT_MS = 5000;
const TOKEN_EXPIRY_BUFFER_MS = 10000;
const DEFAULT_TOKEN_LIFETIME_MS = 60000;

/**
 * Detects whether the current window is running inside an iframe.
 * Returns true if in an iframe, false if running as top-level window.
 */
export function isRunningInIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // If we can't access window.top due to cross-origin restrictions,
    // we're definitely in an iframe
    return true;
  }
}

export class SessionManager {
  readonly parentOrigin: string;
  readonly appId: string;
  readonly isInIframe: boolean;
  readonly isBypassGatewayLocalOnly: boolean;
  /** @deprecated Use isBypassGatewayLocalOnly instead. */
  readonly isDemoModeLocalOnly: boolean;

  private token: SessionToken | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(config: SessionManagerConfig) {
    if (!config.appId) {
      throw new Error("[SessionManager] appId is required.");
    }

    this.isBypassGatewayLocalOnly = isBypassGatewayLocalOnlyClient();
    this.isDemoModeLocalOnly = this.isBypassGatewayLocalOnly;

    const gatewayUrl = import.meta.env.VITE_GATEWAY_URL;
    if (!this.isBypassGatewayLocalOnly) {
      if (!gatewayUrl) {
        throw new Error(
          "[SessionManager] VITE_GATEWAY_URL env var is required.",
        );
      }

      try {
        new URL(gatewayUrl);
      } catch {
        throw new Error(`[SessionManager] Invalid gateway URL: ${gatewayUrl}`);
      }
    }

    this.appId = config.appId;
    this.parentOrigin = this.isBypassGatewayLocalOnly
      ? window.location.origin
      : gatewayUrl;
    this.isInIframe = isRunningInIframe();

    if (this.isBypassGatewayLocalOnly) {
      this.token = {
        token: BYPASS_GATEWAY_LOCAL_ONLY_TOKEN,
        expiresAt: Date.now() + DEFAULT_TOKEN_LIFETIME_MS,
      };
    }
  }

  private isTokenExpiringSoon(
    bufferMs: number = TOKEN_EXPIRY_BUFFER_MS,
  ): boolean {
    if (!this.token) return true;
    return Date.now() >= this.token.expiresAt - bufferMs;
  }

  private postMessageWithResponse<T>(
    request: object,
    responseType: string,
    requestId: string,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener("message", handler);
      };

      const handler = (event: MessageEvent) => {
        // Security: reject messages from wrong origin (including null from sandboxed iframes)
        if (event.origin !== this.parentOrigin) return;
        // Safety: ignore malformed messages that could crash the handler
        if (!event.data || typeof event.data !== "object") return;
        if (
          event.data.type === responseType &&
          event.data.requestId === requestId
        ) {
          cleanup();
          if (event.data.error) {
            reject(new Error(event.data.error));
          } else {
            resolve(event.data as T);
          }
        }
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Token request timeout - parent did not respond"));
      }, MESSAGE_TIMEOUT_MS);

      window.addEventListener("message", handler);
      window.parent.postMessage(request, this.parentOrigin);
    });
  }

  async requestNewToken(): Promise<string> {
    if (this.isBypassGatewayLocalOnly) {
      this.token = {
        token: BYPASS_GATEWAY_LOCAL_ONLY_TOKEN,
        expiresAt: Date.now() + DEFAULT_TOKEN_LIFETIME_MS,
      };
      return this.token.token;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      const requestId = crypto.randomUUID();

      const response = await this.postMessageWithResponse<TokenResponse>(
        {
          type: "SESSION_TOKEN_REQUEST",
          requestId,
          appId: this.appId,
        },
        "SESSION_TOKEN_RESPONSE",
        requestId,
      );

      if (!response.token) {
        throw new Error("No token in response");
      }

      // Parse expiresAt, falling back to default lifetime if invalid
      let expiresAt = Date.now() + DEFAULT_TOKEN_LIFETIME_MS;
      if (response.expiresAt) {
        const parsed = new Date(response.expiresAt).getTime();
        if (!Number.isNaN(parsed)) {
          expiresAt = parsed;
        }
      }

      this.token = {
        token: response.token,
        expiresAt,
      };

      return this.token.token;
    })();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async getToken(): Promise<string> {
    if (this.isBypassGatewayLocalOnly) {
      if (!this.token || this.isTokenExpiringSoon()) {
        return this.requestNewToken();
      }
      return this.token.token;
    }

    if (this.isTokenExpiringSoon()) {
      return this.requestNewToken();
    }
    return this.token!.token;
  }

  getTokenState(): {
    status: "NO_TOKEN" | "VALID" | "EXPIRED" | "REFRESHING";
    token: string | null;
  } {
    if (this.refreshPromise) {
      return { status: "REFRESHING", token: null };
    }

    if (!this.token) {
      return { status: "NO_TOKEN", token: null };
    }

    if (this.isTokenExpiringSoon(0)) {
      return { status: "EXPIRED", token: this.token.token };
    }

    return { status: "VALID", token: this.token.token };
  }

  /**
   * Extracts user information from the current JWT token.
   * Returns null if no valid token is available.
   */
  getUser(): { userId: string; email: string } | null {
    if (this.isBypassGatewayLocalOnly) {
      return {
        userId: BYPASS_GATEWAY_LOCAL_ONLY_USER_ID,
        email: BYPASS_GATEWAY_LOCAL_ONLY_EMAIL,
      };
    }

    if (!this.token) {
      return null;
    }

    try {
      const parts = this.token.token.split(".");
      if (parts.length !== 3) {
        return null;
      }

      const payload = JSON.parse(atob(parts[1]));
      if (!payload.sub) {
        return null;
      }

      return {
        userId: payload.sub,
        email: payload.email ?? "",
      };
    } catch {
      return null;
    }
  }
}
