export interface WebViewNavigationRequest {
  url: string;
  isTopFrame?: boolean;
  mainDocumentURL?: string;
}

export function isTopFrameNavigationRequest(
  request: WebViewNavigationRequest,
): boolean {
  if (typeof request.isTopFrame === "boolean") {
    return request.isTopFrame;
  }

  if (
    typeof request.mainDocumentURL === "string" &&
    request.mainDocumentURL.length > 0
  ) {
    return request.url === request.mainDocumentURL;
  }

  return true;
}

export function isAllowedWebViewUrl(
  url: string,
  allowedOrigin: string,
): boolean {
  if (url === "about:blank") {
    return true;
  }

  try {
    return new URL(url).origin === allowedOrigin;
  } catch {
    return false;
  }
}

export function shouldAllowWebViewNavigation(
  request: WebViewNavigationRequest,
  allowedOrigin: string,
): boolean {
  return (
    !isTopFrameNavigationRequest(request) ||
    isAllowedWebViewUrl(request.url, allowedOrigin)
  );
}

export function isExternalHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
