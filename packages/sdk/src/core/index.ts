export {
  SessionManager,
  isRunningInIframe,
  isRunningInReactNativeWebView,
  detectEnvironment,
} from "./sessionManager.js";
export type {
  SessionManagerConfig,
  EmbeddedEnvironment,
} from "./sessionManager.js";

export { authenticatedFetch, getSessionToken } from "./authenticatedFetch.js";
