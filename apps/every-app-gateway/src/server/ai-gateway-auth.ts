import {
  authenticateGatewayRequest,
  type AppTokenPayload,
  type GatewayAuthContext,
} from "./gateway-auth-policy";
import { AppTokenRepository } from "./repositories/AppTokenRepository";
import { hashAppToken } from "./app-token-hash";

type GatewayProxyEnv = {
  BETTER_AUTH_SECRET: string;
};

async function verifyAppToken(
  token: string,
  env: GatewayProxyEnv,
): Promise<AppTokenPayload | null> {
  const tokenHash = await hashAppToken(token, env.BETTER_AUTH_SECRET);
  const appToken = await AppTokenRepository.findActiveByTokenHash(tokenHash);

  if (!appToken) {
    return null;
  }

  void AppTokenRepository.touchLastUsed(appToken.id).catch((error) => {
    console.error("Failed to update app token last-used timestamp:", error);
  });

  return {
    appId: appToken.appId,
    scopes: appToken.scopes,
    tokenId: appToken.id,
  };
}

export function createAiGatewayAuthenticator(env: GatewayProxyEnv) {
  return async ({
    request,
    provider,
  }: {
    request: Request;
    provider: string;
  }): Promise<GatewayAuthContext> => {
    return authenticateGatewayRequest({
      request,
      provider,
      verifyAppToken: (token) => verifyAppToken(token, env),
    });
  };
}
