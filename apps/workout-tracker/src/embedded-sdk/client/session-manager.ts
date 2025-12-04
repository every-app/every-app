interface SessionToken {
  token: string;
  expiresAt: number;
}

export interface SessionManagerConfig {
  appId: string;
  debug?: boolean;
}

export class SessionManager {
  private token: SessionToken | null = null;
  private refreshPromise: Promise<string> | null = null;
  private parentOrigin: string;
  private appId: string;
  private messageTimeout: number;
  private debug: boolean;
  private onError?: (error: Error) => void;
  private pendingRequests = new Map<
    string,
    {
      resolve: (token: string) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(config: SessionManagerConfig) {
    this.parentOrigin = import.meta.env.VITE_GATEWAY_URL;
    this.appId = config.appId || this.detectAppId();
    this.messageTimeout = 5000;
    this.debug = config.debug ?? false;

    if (!this.parentOrigin) {
      throw new Error(
        "[SessionManager] Set the Parent Origin by specifying the VITE_GATEWAY_URL env var.",
      );
    }

    try {
      new URL(this.parentOrigin);
    } catch {
      throw new Error(
        `[SessionManager] Invalid parent origin URL: ${this.parentOrigin}`,
      );
    }

    this.setupMessageListener();
  }

  private detectAppId(): string {
    if (typeof window === "undefined") return "";

    const url = new URL(window.location.href);
    return (
      url.searchParams.get("appId") ||
      url.hostname.split(".")[0] ||
      "embedded-app"
    );
  }

  private log(message: string, data?: unknown) {
    if (this.debug) {
      console.log(`[SessionManager - Logger] ${message}`, data);
    }
  }

  private setupMessageListener() {
    if (typeof window === "undefined") return;

    window.addEventListener("message", (event) => {
      if (event.origin !== this.parentOrigin) {
        this.log("Message rejected due to origin mismatch", {
          expected: this.parentOrigin,
          received: event.origin,
        });
        return;
      }

      this.log("Accepted message from parent", event.data);
    });
  }

  private isTokenExpired(): boolean {
    if (!this.token) return true;
    return Date.now() >= this.token.expiresAt;
  }

  private isTokenExpiringSoon(bufferMs: number = 10000): boolean {
    if (!this.token) return true;
    return Date.now() >= this.token.expiresAt - bufferMs;
  }

  async requestNewToken(): Promise<string> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = new Promise((resolve, reject) => {
      const requestId = Date.now().toString();

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.log(`Token request #${requestId} timed out`);
        const error = new Error(
          "Token refresh timeout - parent did not respond",
        );
        this.onError?.(error);
        reject(error);
      }, this.messageTimeout);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      const messageHandler = (event: MessageEvent) => {
        if (event.origin !== this.parentOrigin) {
          this.log("Ignoring message from unexpected origin", {
            expected: this.parentOrigin,
            received: event.origin,
          });
          return;
        }

        this.log(`Received message for request #${requestId}`, event.data);

        if (
          event.data.type === "SESSION_TOKEN_RESPONSE" &&
          event.data.requestId === requestId
        ) {
          clearTimeout(timeout);
          window.removeEventListener("message", messageHandler);

          if (event.data.error) {
            this.log(`Token request #${requestId} failed`, {
              error: event.data.error,
            });
            const error = new Error(event.data.error);
            this.onError?.(error);
            reject(error);
            return;
          }

          if (!event.data.token) {
            this.log(
              `Token request #${requestId} failed - no token in response`,
            );
            const error = new Error("No token in response");
            this.onError?.(error);
            reject(error);
            return;
          }

          this.token = {
            token: event.data.token,
            expiresAt: event.data.expiresAt
              ? new Date(event.data.expiresAt).getTime()
              : Date.now() + 60000,
          };

          this.log(`Token #${requestId} received successfully`, {
            expiresAt: new Date(this.token.expiresAt).toISOString(),
          });
          resolve(this.token.token);
        }
      };

      window.addEventListener("message", messageHandler);

      this.log(
        `Requesting new session token #${requestId} for app "${this.appId}"`,
      );

      // Fire-and-forget postMessage to the parent
      try {
        window.parent.postMessage(
          {
            type: "SESSION_TOKEN_REQUEST",
            requestId: requestId,
            appId: this.appId,
          },
          this.parentOrigin,
        );
        this.log(`Message sent for token request #${requestId}`, {
          targetOrigin: this.parentOrigin,
        });
      } catch (e) {
        this.log(`postMessage failed for token request #${requestId}`, e);
        // We don't reject the promise here because the timeout will handle it
      }
    });

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async getToken(): Promise<string> {
    // If token is expired or expiring soon (within 10 seconds), get a new one
    if (this.isTokenExpiringSoon() || !this.token) {
      this.log("Token expired or expiring soon, requesting new token", {
        hasToken: !!this.token,
        expiresAt: this.token
          ? new Date(this.token.expiresAt).toISOString()
          : "N/A",
        timeUntilExpiry: this.token ? this.token.expiresAt - Date.now() : "N/A",
      });
      return this.requestNewToken();
    }

    return this.token.token;
  }

  getParentOrigin(): string {
    return this.parentOrigin;
  }

  getAppId(): string {
    return this.appId;
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

    if (this.isTokenExpired()) {
      return { status: "EXPIRED", token: this.token.token };
    }

    return { status: "VALID", token: this.token.token };
  }

  onDebugEvent(callback: () => void): () => void {
    // For now, we'll create a simple event system
    // In a more complete implementation, you might want to emit events at various points
    const intervalId = setInterval(() => {
      // This will trigger the callback periodically to update the UI
      callback();
    }, 5000);

    // Return an unsubscribe function
    return () => clearInterval(intervalId);
  }
}
