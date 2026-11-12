import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import setupPrompt from "../../content/docs/setup-prompt.txt?raw";

/**
 * The quick start's main action: copies the setup prompt (the one the home
 * page copies) for the reader to paste into their coding agent. The full
 * text is further down the page, for anyone who wants to read it first.
 */
export function CopySetupPrompt() {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    if (status === "idle") return;
    const timer = setTimeout(() => setStatus("idle"), 2500);
    return () => clearTimeout(timer);
  }, [status]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(setupPrompt);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="not-prose my-2 inline-flex h-12 items-center gap-3 rounded-md bg-fd-primary px-6 text-base font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
    >
      {status === "copied" ? (
        <Check className="size-5" aria-hidden="true" />
      ) : (
        <Copy className="size-5" aria-hidden="true" />
      )}
      <span aria-live="polite">
        {status === "copied"
          ? "Copied. Paste it into your agent"
          : status === "error"
            ? "Copy failed. Use the full prompt below"
            : "Copy the agent prompt"}
      </span>
    </button>
  );
}
