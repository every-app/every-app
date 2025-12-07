interface SessionManager {
  getToken(): Promise<string>;
}

interface WindowWithSessionManager extends Window {
  __embeddedSessionManager?: SessionManager;
}

/**
 * Gets the current session token from the embedded session manager
 */
export async function getSessionToken(): Promise<string> {
  const windowWithSession = window as WindowWithSessionManager;
  const sessionManager = windowWithSession.__embeddedSessionManager;

  if (!sessionManager) {
    throw new Error("Session manager not available");
  }

  const token = await sessionManager.getToken();

  if (!token) {
    throw new Error("No token available");
  }

  return token;
}

/**
 * Performs a fetch request with the authorization header automatically added
 */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const token = await getSessionToken();

  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);

  return fetch(input, {
    ...init,
    headers,
  });
}
