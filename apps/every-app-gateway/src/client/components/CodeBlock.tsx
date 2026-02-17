import { useState } from "react";
import { Check, Copy } from "lucide-react";

interface CodeBlockProps {
  code: string;
}

export function CodeBlock({ code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative">
      <pre className="bg-base-200 rounded-lg p-3 pr-14 overflow-x-auto text-sm font-mono">
        <code className="text-base-content/70">{code}</code>
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 btn btn-ghost btn-xs bg-base-100/80 border border-base-content/10 backdrop-blur-sm opacity-100"
        title="Copy to clipboard"
      >
        {copied ? (
          <Check className="w-3 h-3 text-success" />
        ) : (
          <Copy className="w-3 h-3" />
        )}
      </button>
    </div>
  );
}
