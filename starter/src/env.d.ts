/// <reference types="vite/client" />

// everyapp.config.ts, inlined at build time (the `define` in vite.config.ts).
declare const __EVERYAPP_MANIFEST__: typeof import("../everyapp.config").default;

// The bindings come from `cf workers types` (.cloudflare/types). An app secret
// listed under `secrets` in everyapp.config.ts is typed here, optional until set:
//   declare namespace Cloudflare { interface Env { GITHUB_TOKEN?: string } }
