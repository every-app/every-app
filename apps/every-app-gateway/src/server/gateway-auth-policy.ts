import { hasProviderScope } from "./app-token-scopes";

export const APP_TOKEN_HEADER = "x-every-app-token";

type GatewayAuthErrorCode =
  | "missing_credentials"
  | "invalid_app_token"
  | "insufficient_scope"
  | "unexpected_authorization_header";

const STATUS_BY_ERROR_CODE: Record<GatewayAuthErrorCode, number> = {
  missing_credentials: 401,
  invalid_app_token: 401,
  insufficient_scope: 403,
  unexpected_authorization_header: 400,
};

export class GatewayAuthError extends Error {
  readonly code: GatewayAuthErrorCode;
  readonly status: number;

  constructor(code: GatewayAuthErrorCode, message?: string) {
    super(message ?? code);
    this.name = "GatewayAuthError";
    this.code = code;
    this.status = STATUS_BY_ERROR_CODE[code];
  }
}

export interface AppTokenPayload {
  appId: string;
  organizationId: string;
  scopes: string[];
  tokenId?: string;
}

interface AuthenticateGatewayRequestOptions {
  request: Request;
  provider: string;
  verifyAppToken: (
    token: string,
  ) => Promise<AppTokenPayload | null> | AppTokenPayload | null;
  appTokenHeader?: string;
}

export type GatewayAuthContext = {
  authType: "app";
  appId: string;
  organizationId: string;
  appToken: string;
  appTokenPayload: AppTokenPayload;
};

export async function authenticateGatewayRequest(
  options: AuthenticateGatewayRequestOptions,
): Promise<GatewayAuthContext> {
  const {
    request,
    provider,
    verifyAppToken,
    appTokenHeader = APP_TOKEN_HEADER,
  } = options;

  // Reject requests that include an Authorization header.
  // The gateway proxy only accepts app token auth via x-every-app-token.
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    throw new GatewayAuthError(
      "unexpected_authorization_header",
      "The gateway proxy authenticates via app token only. Do not send an Authorization header.",
    );
  }

  const appToken = request.headers.get(appTokenHeader);
  if (!appToken) {
    throw new GatewayAuthError("missing_credentials");
  }

  const appTokenPayload = await verifyAppToken(appToken);
  if (
    !appTokenPayload ||
    !appTokenPayload.appId ||
    !appTokenPayload.organizationId ||
    !Array.isArray(appTokenPayload.scopes)
  ) {
    throw new GatewayAuthError("invalid_app_token");
  }

  if (!hasProviderScope(appTokenPayload.scopes, provider)) {
    throw new GatewayAuthError("insufficient_scope");
  }

  return {
    authType: "app",
    appId: appTokenPayload.appId,
    organizationId: appTokenPayload.organizationId,
    appToken,
    appTokenPayload,
  };
}
