const GATEWAY_ERROR_CODES = [
  "UNAUTHORIZED",
  "ORIGIN_NOT_ALLOWED",
  "REQUEST_EXPIRED",
  "ACCESS_DENIED",
] as const;

type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

const GATEWAY_ERROR_CODE_SET = new Set<string>(GATEWAY_ERROR_CODES);

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;

  constructor(code: GatewayErrorCode, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}

export function getGatewayErrorCode(error: unknown): GatewayErrorCode | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") {
    return null;
  }

  if (!GATEWAY_ERROR_CODE_SET.has(code)) {
    return null;
  }

  return code as GatewayErrorCode;
}
