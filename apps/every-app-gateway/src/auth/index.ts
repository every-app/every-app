import { createAuth } from "./config";
import { lazyInitForWorkers } from "@/utils/lazyInitForWorkers";

/**
 * Lazy-initialized auth instance.
 * Defers initialization until first access to ensure cloudflare:workers env is available.
 */
export const auth = lazyInitForWorkers(() => createAuth());

export { createAuth };
export type { Auth } from "./config";
