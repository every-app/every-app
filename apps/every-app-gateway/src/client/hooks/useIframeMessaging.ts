import { useCallback, RefObject } from "react";
import type { IframeMessage } from "../utils/embedded-app-types";

/**
 * Hook to safely post messages to an iframe
 * @param iframeRef - Reference to the iframe element
 * @param appUrl - The app's configured URL (used to determine target origin)
 * @param isReady - Whether the iframe has loaded and is ready to receive messages
 * @returns Object with postMessage function
 */
export function useIframeMessaging(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  appUrl: string | undefined,
  isReady: boolean,
) {
  const postMessage = useCallback(
    (message: IframeMessage) => {
      if (!isReady || !iframeRef.current?.contentWindow || !appUrl) {
        return;
      }

      const targetOrigin = new URL(appUrl).origin;
      iframeRef.current.contentWindow.postMessage(message, targetOrigin);
    },
    [isReady, appUrl],
  );

  return { postMessage };
}
