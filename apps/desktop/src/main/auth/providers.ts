// Hands the API client a bearer token, whatever kind of sign-in made it (port of HelperCore/Auth.swift).

import { OAuthClient, OAuthError, needsRefresh, type OAuthGrant } from "./oauth";
import { AuthError } from "./errors";

/** What the secret store holds: how this Mac signs in to one Scribe app. */
export type Credentials =
  /** A personal access token made in Manage workspace → Tokens. */
  | { kind: "token"; appUrl: string; token: string }
  /** Sign in with Every App: an OAuth grant from the Gateway. */
  | { kind: "oauth"; grant: OAuthGrant };

export function credentialsAppUrl(c: Credentials): string {
  return c.kind === "token" ? c.appUrl : c.grant.appUrl;
}

export interface AuthProvider {
  readonly appUrl: string;
  /** A token good for at least the next minute. */
  accessToken(): Promise<string>;
  /** The server refused `token` with 401: renew if possible, else throw AuthError("signedOut"). */
  tokenRejected(token: string): Promise<string>;
}

/** The pasted personal access token. Nothing to renew. */
export class AccessTokenAuthProvider implements AuthProvider {
  constructor(
    readonly appUrl: string,
    private readonly token: string,
  ) {}
  async accessToken(): Promise<string> {
    return this.token;
  }
  async tokenRejected(): Promise<string> {
    throw new AuthError("signedOut");
  }
}

export interface OAuthProviderHooks {
  /** Stores a rotated grant (before its access token is used), or clears it (undefined). */
  persist(grant: OAuthGrant | undefined): void | Promise<void>;
  /** Drops the cached client id for an issuer that answered `invalid_client`. */
  forgetClient?(issuer: string): void;
  touchClient?(issuer: string): void;
}

/** OAuth: refreshes with the refresh token when the access token is near expiry or refused, and
 * writes the renewed grant back through `persist` before anyone uses it. Concurrent callers share
 * one refresh (the Gateway rotates refresh tokens, so two refreshes would end the grant). */
export class OAuthAuthProvider implements AuthProvider {
  readonly appUrl: string;
  private refreshing: Promise<OAuthGrant> | undefined;

  constructor(
    private grant: OAuthGrant,
    private readonly client: OAuthClient,
    private readonly hooks: OAuthProviderHooks,
    private readonly now: () => number = Date.now,
  ) {
    this.appUrl = grant.appUrl;
  }

  get current(): OAuthGrant {
    return this.grant;
  }

  async accessToken(): Promise<string> {
    if (needsRefresh(this.grant, this.now())) return (await this.refresh()).accessToken;
    return this.grant.accessToken;
  }

  /** Forces a refresh (the helper asked for a fresh token). */
  async freshAccessToken(): Promise<string> {
    return (await this.refresh()).accessToken;
  }

  async tokenRejected(token: string): Promise<string> {
    // Another request may have renewed it already.
    if (token !== this.grant.accessToken) return this.grant.accessToken;
    return (await this.refresh()).accessToken;
  }

  private refresh(): Promise<OAuthGrant> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<OAuthGrant> {
    const current = this.grant;
    if (!current.refreshToken) {
      await this.hooks.persist(undefined);
      throw new AuthError("signedOut");
    }
    let renewed: OAuthGrant;
    try {
      renewed = await this.client.refresh(current, this.now());
    } catch (error) {
      if (error instanceof OAuthError && error.kind === "invalidGrant") {
        await this.hooks.persist(undefined);
        throw new AuthError("signedOut");
      }
      if (error instanceof OAuthError && error.kind === "invalidClient") {
        this.hooks.forgetClient?.(current.issuer);
        await this.hooks.persist(undefined);
        throw new AuthError("signedOut");
      }
      throw error;
    }
    // Store the rotated refresh token before the new access token goes anywhere.
    await this.hooks.persist(renewed);
    this.grant = renewed;
    this.hooks.touchClient?.(renewed.issuer);
    return renewed;
  }
}
