import {
  BYPASS_GATEWAY_LOCAL_ONLY_EMAIL,
  BYPASS_GATEWAY_LOCAL_ONLY_TOKEN,
  BYPASS_GATEWAY_LOCAL_ONLY_USER_ID,
  isBypassGatewayLocalOnlyClient,
} from "../shared/bypassGatewayLocalOnly.js";
import { parseMessagePayload } from "../shared/parseMessagePayload.js";

interface SessionToken {
  token: string;
  expiresAt: number;
}

interface TokenResponse {
  token: string;
  expiresAt?: string;
  error?: string;
}

interface TokenUpdateMessage {
  type: "SESSION_TOKEN_UPDATE";
  token?: string;
  expiresAt?: string;
  appId?: string;
}

function isTokenUpdateMessage(data: unknown): data is TokenUpdateMessage {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }

  return (data as { type?: unknown }).type === "SESSION_TOKEN_UPDATE";
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tokenAudienceMatchesApp(
  payload: Record<string, unknown>,
  appId: string,
): boolean {
  const aud = payload.aud;
  if (typeof aud === "string") {
    return aud === appId;
  }

  if (Array.isArray(aud)) {
    return aud.some((value) => value === appId);
  }

  return false;
}

export interface SessionManagerConfig {
  appId: string;
}

const MESSAGE_TIMEOUT_MS = 5000;
const TOKEN_EXPIRY_BUFFER_MS = 10000;
const DEFAULT_TOKEN_LIFETIME_MS = 60000;
const REACT_NATIVE_TOKEN_WAIT_TIMEOUT_MS = 10000;

/**
 * Environment detection types
 */
export type EmbeddedEnvironment =
  | "iframe"
  | "react-native-webview"
  | "standalone";

/**
 * Detects whether the current window is running inside an iframe.
 * Returns true if in an iframe, false if running as top-level window.
 */
export function isRunningInIframe(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.self !== window.top;
  } catch {
    // If we can't access window.top due to cross-origin restrictions,
    // we're definitely in an iframe
    return true;
  }
}

/**
 * Detects whether the current window is running inside a React Native WebView.
 * Returns true if window.ReactNativeWebView is available.
 */
export function isRunningInReactNativeWebView(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return (
    typeof (window as any).ReactNativeWebView?.postMessage === "function" ||
    (window as any).isReactNativeWebView === true
  );
}

/**
 * Detects the current embedded environment.
 * Priority: React Native WebView > iframe > standalone
 */
export function detectEnvironment(): EmbeddedEnvironment {
  const isRNWebView = isRunningInReactNativeWebView();
  const isIframe = isRunningInIframe();

  if (isRNWebView) {
    return "react-native-webview";
  }
  if (isIframe) {
    return "iframe";
  }
  return "standalone";
}

export class SessionManager {
  readonly parentOrigin: string;
  readonly appId: string;
  readonly isInIframe: boolean;
  readonly environment: EmbeddedEnvironment;
  readonly isBypassGatewayLocalOnly: boolean;

  private token: SessionToken | null = null;
  private refreshPromise: Promise<string> | null = null;
  private tokenWaiters: Array<{
    resolve: (token: string) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(config: SessionManagerConfig) {
    if (!config.appId) {
      throw new Error("[SessionManager] appId is required.");
    }

    this.isBypassGatewayLocalOnly = isBypassGatewayLocalOnlyClient();

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
    this.environment = detectEnvironment();
    this.isInIframe = isRunningInIframe();

    if (this.environment === "react-native-webview") {
      this.setupReactNativeTokenListener();
    }

    if (this.isBypassGatewayLocalOnly) {
      this.token = {
        token: BYPASS_GATEWAY_LOCAL_ONLY_TOKEN,
        expiresAt: Date.now() + DEFAULT_TOKEN_LIFETIME_MS,
      };
    }
  }

  /**
   * Check if running in an embedded environment (iframe or React Native WebView)
   */
  isEmbedded(): boolean {
    return this.environment !== "standalone";
  }

  isTrustedHostMessage(event: MessageEvent): boolean {
    if (this.environment === "react-native-webview") {
      const origin = (event as MessageEvent & { origin?: string | null })
        .origin;
      return (
        origin === "react-native" ||
        origin === "null" ||
        origin === "" ||
        origin == null
      );
    }

    return event.origin === this.parentOrigin;
  }

  postToHost(message: object): void {
    if (this.environment === "react-native-webview") {
      const postMessage = (window as any).ReactNativeWebView?.postMessage;
      if (typeof postMessage !== "function") {
        throw new Error("React Native WebView bridge is unavailable");
      }

      postMessage.call(
        (window as any).ReactNativeWebView,
        JSON.stringify(message),
      );
      return;
    }

    window.parent.postMessage(message, this.parentOrigin);
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
        // Security: validate message origin based on environment
        if (!this.isTrustedHostMessage(event)) return;
        const data = parseMessagePayload(event.data);
        if (!data) return;

        if (data.type === responseType && data.requestId === requestId) {
          cleanup();
          if (typeof data.error === "string" && data.error) {
            reject(new Error(data.error));
          } else {
            resolve(data as T);
          }
        }
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Token request timeout - parent did not respond"));
      }, MESSAGE_TIMEOUT_MS);

      window.addEventListener("message", handler);

      try {
        this.postToHost(request);
      } catch (error) {
        cleanup();
        reject(
          error instanceof Error
            ? error
            : new Error("Failed to post message to host"),
        );
      }
    });
  }

  private setupReactNativeTokenListener(): void {
    window.addEventListener("message", (event: MessageEvent) => {
      if (!this.isTrustedHostMessage(event)) {
        return;
      }

      const data = parseMessagePayload(event.data);
      if (!data) {
        return;
      }

      if (!isTokenUpdateMessage(data)) {
        return;
      }

      const message = data;

      if (!message.token || typeof message.token !== "string") {
        return;
      }

      if (typeof message.appId !== "string" || message.appId !== this.appId) {
        return;
      }

      if (
        message.expiresAt !== undefined &&
        typeof message.expiresAt !== "string"
      ) {
        return;
      }

      const payload = decodeJwtPayload(message.token);
      if (!payload || !tokenAudienceMatchesApp(payload, this.appId)) {
        return;
      }

      // Native controls token minting and pushes updates into the embedded app.
      // We only consume pushed tokens in React Native WebView mode.
      let expiresAt = Date.now() + DEFAULT_TOKEN_LIFETIME_MS;
      if (message.expiresAt) {
        const parsed = new Date(message.expiresAt).getTime();
        if (!Number.isNaN(parsed)) {
          expiresAt = parsed;
        }
      }

      this.token = {
        token: message.token,
        expiresAt,
      };

      if (this.tokenWaiters.length > 0) {
        const waiters = this.tokenWaiters;
        this.tokenWaiters = [];

        for (const waiter of waiters) {
          clearTimeout(waiter.timeout);
          waiter.resolve(message.token);
        }
      }
    });
  }

  private waitForReactNativeTokenPush(): Promise<string> {
    if (this.token && !this.isTokenExpiringSoon()) {
      return Promise.resolve(this.token.token);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.tokenWaiters = this.tokenWaiters.filter(
          (w) => w.timeout !== timeout,
        );
        reject(
          new Error("Timed out waiting for token from React Native bridge"),
        );
      }, REACT_NATIVE_TOKEN_WAIT_TIMEOUT_MS);

      this.tokenWaiters.push({ resolve, reject, timeout });
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

    if (this.environment === "react-native-webview") {
      this.refreshPromise = this.waitForReactNativeTokenPush();

      try {
        return await this.refreshPromise;
      } finally {
        this.refreshPromise = null;
      }
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

    const payload = decodeJwtPayload(this.token.token);
    if (!payload) {
      return null;
    }

    if (typeof payload.sub !== "string") {
      return null;
    }

    return {
      userId: payload.sub,
      email: typeof payload.email === "string" ? payload.email : "",
    };
  }
}
