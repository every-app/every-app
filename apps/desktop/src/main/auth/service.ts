// Sign-in state for the app: which credentials are stored, the API client built on them, and the
// two ways in (Sign in with Every App, or a pasted personal access token). Electron-free, so the
// tests can drive it with a fake browser.

import { EventEmitter } from "node:events";
import type { AuthSnapshot } from "@shared/ipc";
import type { Me } from "@shared/api";
import { ApiClient, ApiError } from "../api/client";
import { AuthError } from "./errors";
import { LoopbackServer } from "./loopback";
import { OAuthClient, errorMessage, type Fetch } from "./oauth";
import { AccessTokenAuthProvider, OAuthAuthProvider, type AuthProvider, type Credentials } from "./providers";
import { CALLBACK_PATH } from "./redirect";
import { SignInFlow, touchClient } from "./signin";
import type { SecretStore } from "./store";
import { typedAppUrl } from "./url";
import { exampleBackendUrl, SCRIBE } from "@shared/features";

const TYPE_APP_URL = `Type the ${SCRIBE.label} app URL, like ${exampleBackendUrl(SCRIBE)}.`;

export interface AuthServiceOptions {
  store: SecretStore;
  /** Opens the authorization URL in the system browser. */
  openBrowser: (url: string) => Promise<void> | void;
  fetchImpl?: Fetch;
  signInTimeoutMs?: number;
  /** Every /api/v1 call's outcome (undefined on success), for reachability. */
  onApiOutcome?: (error?: unknown) => void;
  log?: (...parts: unknown[]) => void;
}

export class AuthService extends EventEmitter<{ change: [AuthSnapshot] }> {
  private provider: AuthProvider | undefined;
  private client: ApiClient | undefined;
  private me: Me | undefined;
  private snapshot: AuthSnapshot = { status: "signedOut" };
  private signInAbort: AbortController | undefined;
  private readonly oauth: OAuthClient;
  /** Credentials held only in memory (the dev sign-in), never written to the store. */
  private ephemeral = false;

  constructor(private readonly options: AuthServiceOptions) {
    super();
    this.oauth = new OAuthClient(options.fetchImpl);
  }

  get state(): AuthSnapshot {
    return this.snapshot;
  }

  get api(): ApiClient | undefined {
    return this.client;
  }

  get user(): Me | undefined {
    return this.me;
  }

  /** Loads stored credentials. A sign-in this build can't decrypt reads as signed out, with why. */
  restore(): void {
    this.options.store.load();
    const credentials = this.options.store.credentials;
    if (credentials) {
      this.use(credentials, false);
    } else if (this.options.store.loadProblem === "unreadable") {
      this.set({
        status: "signedOut",
        error: "This build can't read the saved sign-in (it was saved by a differently signed build). Sign in again.",
      });
    }
  }

  /** Uses credentials without storing them (the dev sign-in). */
  useEphemeral(credentials: Credentials): void {
    this.use(credentials, true);
  }

  /** A fresh access token, refreshed if near expiry; undefined when signed out. */
  async accessToken(): Promise<string | undefined> {
    try {
      return await this.provider?.accessToken();
    } catch (error) {
      this.handleError(error);
      return undefined;
    }
  }

  /** Forces a refresh for an OAuth sign-in (the helper's token was refused). */
  async freshAccessToken(): Promise<string | undefined> {
    try {
      const p = this.provider;
      if (p instanceof OAuthAuthProvider) return await p.freshAccessToken();
      return await p?.accessToken();
    } catch (error) {
      this.handleError(error);
      return undefined;
    }
  }

  /** Who's signed in; also proves the token works. */
  async loadMe(): Promise<Me | undefined> {
    if (!this.client) return undefined;
    try {
      this.me = await this.client.me();
      this.set({ email: this.me.email, orgName: this.me.orgName, error: undefined, needsEveryAppSignIn: undefined });
      return this.me;
    } catch (error) {
      this.handleError(error);
      return undefined;
    }
  }

  async signIn(appUrlText: string): Promise<void> {
    const appUrl = typedAppUrl(appUrlText);
    if (!appUrl) return this.set({ error: TYPE_APP_URL });
    this.cancelSignIn();
    const abort = new AbortController();
    this.signInAbort = abort;
    const previous = this.snapshot.status === "signedIn" ? this.snapshot : undefined;
    this.set({ status: "signingIn", appUrl, error: undefined, needsEveryAppSignIn: undefined });
    const server = new LoopbackServer();
    try {
      const port = await server.start();
      const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
      const flow = new SignInFlow(this.options.store, this.oauth);
      const grant = await flow.run(appUrl, redirectUri, async (url, expectation) => {
        const code = server.waitForCode(expectation, this.options.signInTimeoutMs ?? 10 * 60_000, abort.signal);
        code.catch(() => {}); // Awaited below; this only keeps an early failure from going unhandled.
        await this.options.openBrowser(url);
        return code;
      });
      if (abort.signal.aborted) return;
      await this.replaceCredentials({ kind: "oauth", grant });
      this.options.log?.(`signed in with Every App to ${new URL(appUrl).host}`);
      await this.loadMe();
    } catch (error) {
      if (abort.signal.aborted || (error instanceof AuthError && error.kind === "cancelled")) {
        this.set(previous ?? { status: "signedOut", error: undefined });
        return;
      }
      this.options.log?.(`sign-in failed: ${errorMessage(error)}`);
      this.set(previous ? { ...previous, error: errorMessage(error) } : { status: "signedOut", appUrl, error: errorMessage(error) });
    } finally {
      server.stop();
      if (this.signInAbort === abort) this.signInAbort = undefined;
    }
  }

  cancelSignIn(): void {
    this.signInAbort?.abort();
    this.signInAbort = undefined;
  }

  /** The fallback: the app URL plus a personal access token. Checked with /me before it's kept. */
  async signInWithToken(appUrlText: string, tokenText: string): Promise<void> {
    const appUrl = typedAppUrl(appUrlText);
    const token = tokenText.trim();
    if (!appUrl) return this.set({ error: TYPE_APP_URL });
    if (!token) return this.set({ error: "Paste an access token." });
    const client = new ApiClient(new AccessTokenAuthProvider(appUrl, token), this.options.fetchImpl);
    try {
      const me = await client.me();
      await this.replaceCredentials({ kind: "token", appUrl, token });
      this.me = me;
      this.set({ email: me.email, orgName: me.orgName });
      this.options.log?.(`signed in with an access token to ${new URL(appUrl).host}`);
    } catch (error) {
      const needsEveryAppSignIn = error instanceof ApiError && error.kind === "accessLogin";
      const message =
        error instanceof ApiError && error.kind === "signedOut" ? "Scribe refused that token." : errorMessage(error);
      this.set({ error: message, needsEveryAppSignIn });
    }
  }

  /** Revokes an OAuth grant (best effort) and forgets the sign-in. */
  async signOut(): Promise<void> {
    const credentials = this.ephemeral ? undefined : this.options.store.credentials;
    this.clear();
    if (credentials?.kind === "oauth") await this.oauth.revoke(credentials.grant);
  }

  /** Maps API errors onto the sign-in state; returns whether it was a sign-in problem. */
  handleError(error: unknown): boolean {
    if ((error instanceof ApiError && error.kind === "signedOut") || (error instanceof AuthError && error.kind === "signedOut")) {
      // The session ended under us (refresh refused, or a 401 after a refresh): "expired", so the
      // window keeps its page and asks to sign in again instead of starting over.
      const wasSignedIn = this.snapshot.status === "signedIn";
      this.clear("Your sign-in expired. Sign in again.", wasSignedIn);
      return true;
    }
    if (error instanceof ApiError && error.kind === "accessLogin") {
      this.set({ error: error.message, needsEveryAppSignIn: true });
      return true;
    }
    return false;
  }

  private async replaceCredentials(credentials: Credentials): Promise<void> {
    const old = this.ephemeral ? undefined : this.options.store.credentials;
    this.options.store.setCredentials(credentials);
    this.use(credentials, false);
    // A new OAuth sign-in replaces an old one: revoke the old grant.
    if (old?.kind === "oauth" && (credentials.kind !== "oauth" || old.grant.refreshToken !== credentials.grant.refreshToken)) {
      void this.oauth.revoke(old.grant);
    }
  }

  private use(credentials: Credentials, ephemeral: boolean): void {
    this.ephemeral = ephemeral;
    if (credentials.kind === "token") {
      this.provider = new AccessTokenAuthProvider(credentials.appUrl, credentials.token);
    } else {
      const store = this.options.store;
      this.provider = new OAuthAuthProvider(credentials.grant, this.oauth, {
        persist: (grant) => {
          if (ephemeral) return;
          if (grant) store.setCredentials({ kind: "oauth", grant });
          else store.setCredentials(undefined);
        },
        forgetClient: (issuer) => store.forget(issuer),
        touchClient: (issuer) => touchClient(store, issuer),
      });
    }
    this.client = new ApiClient(this.provider, this.options.fetchImpl, this.options.onApiOutcome);
    this.me = undefined;
    this.snapshot = { status: "signedIn", method: credentials.kind, appUrl: this.provider.appUrl };
    this.emit("change", this.snapshot);
  }

  /** `expired`: not the person's choice; keeps the app URL and method (for "Sign in again"). */
  private clear(error?: string, expired = false): void {
    const { appUrl, method } = this.snapshot;
    if (!this.ephemeral) {
      try {
        this.options.store.setCredentials(undefined);
      } catch (e) {
        this.options.log?.(`couldn't clear the stored sign-in: ${errorMessage(e)}`);
      }
    }
    this.ephemeral = false;
    this.provider = undefined;
    this.client = undefined;
    this.me = undefined;
    this.snapshot = expired ? { status: "signedOut", appUrl, method, error, expired: true } : { status: "signedOut", appUrl, error };
    this.emit("change", this.snapshot);
  }

  private set(patch: Partial<AuthSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit("change", this.snapshot);
  }
}
