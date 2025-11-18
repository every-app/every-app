// Custom environment variable type definitions
// These extend the auto-generated Env interface from worker-configuration.d.ts

declare namespace Cloudflare {
  interface Env {
    // Better Auth configuration
    BETTER_AUTH_SECRET: string;

    // JWT keys for embedded app tokens
    JWT_PRIVATE_KEY: string;
    JWT_PUBLIC_KEY: string;
  }
}
