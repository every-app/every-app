/// <reference types="vite/client" />
interface ViteTypeOptions {
  // By adding this line, you can make the type of ImportMetaEnv strict
  // to disallow unknown keys.
  strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
  // App-specific VITE_ vars go here. (The gateway home URL is derived at
  // runtime from the current host — see client/lib/gatewayHome.ts.)
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
