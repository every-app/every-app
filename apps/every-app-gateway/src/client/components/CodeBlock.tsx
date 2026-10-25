import { CopyButton } from "@/client/components/CopyButton";

interface CodeBlockProps {
  code: string;
  /** The toast after a copy. */
  successMessage?: string;
}

/** A monospace block for a command, token or link, with a copy button. */
export function CodeBlock({
  code,
  successMessage = "Copied to clipboard",
}: CodeBlockProps) {
  return (
    <div className="relative min-w-0">
      {/* A command wraps at its spaces; only a lone over-long token (a link,
          a token) breaks inside, so no text runs under the copy button and a
          setting name is never split across lines. */}
      <pre className="rounded-lg border border-border bg-muted px-3 py-2.5 pr-11 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap">
        <code>{code}</code>
      </pre>
      <CopyButton
        value={code}
        successMessage={successMessage}
        label="Copy to clipboard"
        variant="ghost"
        size="icon-xs"
        className="absolute top-2 right-2"
      />
    </div>
  );
}
