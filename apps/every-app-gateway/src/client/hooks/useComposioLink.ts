import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getRuleErrorMessage } from "@/client/errors";
import { ComposioLinkState } from "@/schemas/composio";
import {
  finishComposioLink,
  startComposioLink,
} from "@/serverFunctions/composio";

/** How often a sign-in that waits is asked about. */
export const COMPOSIO_CHECK_MS = 2_000;

export enum ComposioLinkStep {
  /** The sign-in is open at Composio, and the page keeps asking. */
  Waiting = "waiting",
  Expired = "expired",
}

/** Where the sign-in the person started stands. */
type LinkProgress =
  | { step: ComposioLinkStep.Waiting; url: string }
  | { step: ComposioLinkStep.Expired };

/**
 * A tab for the sign-in, opened at the click: one opened later, once the
 * sign-in's page is known, is a popup that browsers block. The page it
 * shows can't reach this one. Null when the browser opened none.
 */
function openTab(): Window | null {
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  return tab;
}

/**
 * Linking the person's Composio (docs/design/2026-11-composio.md), from
 * Your connections → Accounts and from the Composio page. `start` asks
 * for a sign-in and opens its page at Composio in a new tab; `before`
 * runs first, for an owner or admin whose first step turns Composio on.
 * While the sign-in waits, the Gateway is asked every
 * {@link COMPOSIO_CHECK_MS} whether the person approved it. Once they
 * have, `onLinked` runs, and the wait ends when what it returns settles,
 * so the page shows the link and never the button to start one again. A
 * failure is a toast, and nothing waits after it.
 */
export function useComposioLink({ onLinked }: { onLinked: () => unknown }) {
  // Null while no sign-in is shown.
  const [progress, setProgress] = useState<LinkProgress | null>(null);
  const [starting, setStarting] = useState(false);
  // The caller's latest, so a new function each render doesn't restart the wait.
  const linked = useRef(onLinked);
  linked.current = onLinked;

  const start = async (before?: () => Promise<unknown>) => {
    const tab = openTab();
    setStarting(true);
    try {
      await before?.();
      const { url } = await startComposioLink();
      tab?.location.replace(url);
      setProgress({ step: ComposioLinkStep.Waiting, url });
    } catch (error) {
      tab?.close();
      setProgress(null);
      toast.error(getRuleErrorMessage(error, "Failed to link Composio"));
    } finally {
      setStarting(false);
    }
  };

  const url = progress?.step === ComposioLinkStep.Waiting ? progress.url : null;
  useEffect(() => {
    if (url === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      let result: Awaited<ReturnType<typeof finishComposioLink>>;
      try {
        result = await finishComposioLink();
      } catch (error) {
        if (!live) return;
        setProgress(null);
        toast.error(getRuleErrorMessage(error, "Failed to link Composio"));
        return;
      }
      if (!live) return;
      switch (result.state) {
        case ComposioLinkState.Waiting:
          timer = setTimeout(() => void check(), COMPOSIO_CHECK_MS);
          return;
        case ComposioLinkState.Linked:
          await linked.current();
          if (live) setProgress(null);
          return;
        case ComposioLinkState.Expired:
          setProgress({ step: ComposioLinkStep.Expired });
          return;
      }
    };
    timer = setTimeout(() => void check(), COMPOSIO_CHECK_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [url]);

  return {
    progress,
    starting,
    start: (before?: () => Promise<unknown>) => void start(before),
  };
}
