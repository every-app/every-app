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
      {/* Long links and tokens wrap, so no text runs under the copy button. */}
      <pre className="rounded-lg border border-border bg-muted px-3 py-2.5 pr-11 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
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
