import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { CopyButton } from "@/client/components/CopyButton";

const CONNECT_AI_DOCS_URL = "https://everyapp.com/docs/connect-ai";

/**
 * The way in, under the empty AI connections list: the gateway's own MCP
 * address with a copy button, the user docs, and where a personal access
 * token comes from for the reader's role. Members cannot open /admin, so
 * they are told to ask; while the role is unknown the line stays out.
 */
export function ConnectAiHint({ role }: { role: string | undefined }) {
  // The page is server-rendered without a window: read the address on the
  // client only.
  const [address, setAddress] = useState("");
  useEffect(() => {
    setAddress(`${window.location.origin}/mcp`);
  }, []);
  const canManageTokens = role === "owner" || role === "admin";

  return (
    <>
      {address ? (
        <div className="flex w-full min-w-0 items-center justify-center gap-2">
          <code className="min-w-0 truncate rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs">
            {address}
          </code>
          <CopyButton value={address} successMessage="Address copied" />
        </div>
      ) : null}
      <a
        href={CONNECT_AI_DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-primary"
      >
        How to connect an AI app
        <span className="sr-only"> (opens in a new tab)</span>
        <ArrowUpRight className="size-3.5" aria-hidden />
      </a>
      {role ? (
        <p className="text-xs text-muted-foreground">
          {canManageTokens ? (
            <>
              Scripts and tools that can&apos;t sign in use a personal access
              token:{" "}
              <Link
                to="/admin/tokens"
                className="underline underline-offset-4 hover:text-primary"
              >
                Manage workspace → Tokens
              </Link>
            </>
          ) : (
            "Ask an owner or admin for a personal access token if a tool can't sign in."
          )}
        </p>
      ) : null}
    </>
  );
}
