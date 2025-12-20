import { useState, useEffect, useCallback, useMemo } from "react";
import {
  detectPlatform,
  isPWAStandalone,
  type Platform,
} from "@/utils/platform";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface PWAInstallState {
  platform: Platform;
  isStandalone: boolean;
  canPromptNatively: boolean;
  promptInstall: () => Promise<void>;
}

export function usePWAInstall(): PWAInstallState {
  // Platform and standalone status don't change during a session,
  // so we compute them once with useMemo
  const platform = useMemo(() => detectPlatform(), []);
  const isStandalone = useMemo(() => isPWAStandalone(), []);

  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      // Prevent the mini-infobar from appearing on mobile
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt,
      );
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return;

    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === "accepted") {
      setDeferredPrompt(null);
    }
  }, [deferredPrompt]);

  return {
    platform,
    isStandalone,
    canPromptNatively: deferredPrompt !== null,
    promptInstall,
  };
}
