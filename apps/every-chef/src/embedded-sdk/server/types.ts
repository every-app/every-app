export interface AuthConfig {
  jwksUrl: string;
  issuer: string;
  audience: string;
  autoDiscoverJwks?: boolean;
  debug?: boolean;
  onError?: (error: Error, req: unknown) => void;
}
