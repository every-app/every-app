// Navigation guards for every webContents. Every App's window shows only its own page: the bundled
// renderer (file://…/renderer/index.html) or, in an unpackaged dev run, the electron-vite dev
// server. Any other navigation or redirect is refused. Links that open a window, or an https link
// the page tries to navigate to, go to the system browser; nothing else is opened.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { WebContents } from "electron";

export interface AppOrigin {
  /** Absolute path of the bundled renderer's index.html. */
  rendererFile: string;
  /** Other bundled pages beside it (the floating recorder's pill.html). */
  otherPages?: string[];
  /** The electron-vite dev server (ELECTRON_RENDERER_URL), only for an unpackaged run. */
  devUrl?: string;
}

function parse(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** True for the app's own pages: the bundled index.html (or one of `otherPages`; any hash or
 * query), or the dev server's origin when one is given. */
export function isAppUrl(raw: string, origin: AppOrigin): boolean {
  const url = parse(raw);
  if (!url) return false;
  if (url.protocol === "file:") {
    if (url.host && url.host !== "localhost") return false;
    try {
      const path = resolve(fileURLToPath(url));
      return [origin.rendererFile, ...(origin.otherPages ?? [])].some((page) => path === resolve(page));
    } catch {
      return false;
    }
  }
  if (origin.devUrl) {
    const dev = parse(origin.devUrl);
    return !!dev && (dev.protocol === "http:" || dev.protocol === "https:") && url.origin === dev.origin;
  }
  return false;
}

/** An https URL safe to hand to the system browser, else undefined. */
export function externalUrl(raw: string): string | undefined {
  const url = parse(raw);
  return url && url.protocol === "https:" && url.hostname ? url.toString() : undefined;
}

export type NavigationDecision = { allow: true } | { allow: false; openExternal?: string };

/** `will-navigate`: our own page may reload or move within itself; an https link goes to the
 * browser; anything else is dropped. */
export function navigationDecision(raw: string, origin: AppOrigin): NavigationDecision {
  if (isAppUrl(raw, origin)) return { allow: true };
  return { allow: false, openExternal: externalUrl(raw) };
}

/** `will-redirect`: only to our own page. A redirect is never opened elsewhere. */
export function redirectAllowed(raw: string, origin: AppOrigin): boolean {
  return isAppUrl(raw, origin);
}

/** `setWindowOpenHandler`: never a new Electron window; https goes to the browser. */
export function windowOpenDecision(raw: string): { openExternal?: string } {
  return { openExternal: externalUrl(raw) };
}

export function guardNavigation(contents: WebContents, origin: AppOrigin, openExternal: (url: string) => void, log?: (line: string) => void): void {
  contents.on("will-navigate", (event, url) => {
    const decision = navigationDecision(url, origin);
    if (decision.allow) return;
    event.preventDefault();
    if (decision.openExternal) openExternal(decision.openExternal);
    else log?.(`refused a navigation to ${url.split(":")[0]}:`);
  });
  contents.on("will-redirect", (event, url) => {
    if (redirectAllowed(url, origin)) return;
    event.preventDefault();
    log?.(`refused a redirect to ${url.split(":")[0]}:`);
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const { openExternal: external } = windowOpenDecision(url);
    if (external) openExternal(external);
    return { action: "deny" };
  });
}
