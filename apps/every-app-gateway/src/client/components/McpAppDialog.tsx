import { ExternalLink } from "lucide-react";
import { PROVIDER_APPS, isProviderAppId } from "@every-app/sdk/internal";
import { CodeBlock } from "@/client/components/CodeBlock";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";

/** The person's page on connecting Claude, ChatGPT and Claude Code. */
export const CONNECT_AI_DOCS_URL = "https://everyapp.com/docs/connect-ai";
/** The agent docs' section on MCP apps, for the agent that was told to use one. */
export const MCP_APPS_DOCS_URL = "https://everyapp.com/docs/agent/mcp#mcp-apps";

interface McpAppDialogProps {
  name: string;
  /** The app's id: its tool prefix (`dataforseo_<tool>`). */
  appId: string;
  onClose: () => void;
}

/**
 * The address an AI client connects to: this Gateway's own origin (the UI
 * is served from it) plus `/mcp`, one address across organizations. The
 * dialog only ever mounts from a click, so the window is there; the guard
 * keeps a server render honest.
 */
function mcpAddress(): string | null {
  return typeof window === "undefined" ? null : `${window.location.origin}/mcp`;
}

/**
 * What an MCP app is and how to use it, for whoever clicked its card: the
 * Gateway's MCP address to copy, the tools' prefix, a sentence to say to
 * an agent, and the two docs pages. Closes from the footer alone, like the
 * setup dialog. Render it only while it is open.
 */
export function McpAppDialog({ name, appId, onClose }: McpAppDialogProps) {
  const address = mcpAddress();
  const example = isProviderAppId(appId) ? PROVIDER_APPS[appId].example : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Use {name} from your agent</DialogTitle>
          <DialogDescription>
            {name} has no page. Claude, ChatGPT and Claude Code reach it through
            this Gateway's MCP address:
          </DialogDescription>
        </DialogHeader>
        {address ? (
          <CodeBlock code={address} successMessage="Address copied" />
        ) : null}
        <div className="flex flex-col gap-2 text-sm">
          <p>
            Its tools start with{" "}
            <span className="font-mono text-xs">{appId}_</span>.
            {example ? " Try saying:" : null}
          </p>
          {example ? (
            <p className="rounded-lg border border-border bg-muted px-3 py-2.5">
              “Use {name} to {example}.”
            </p>
          ) : null}
          <p className="text-muted-foreground">
            Agents can build skills on its tools, like any app's.
          </p>
        </div>
        <DialogFooter showCloseButton>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm sm:mr-auto sm:self-center">
            <DocsLink href={CONNECT_AI_DOCS_URL}>
              Connect Claude or ChatGPT, in the docs
            </DocsLink>
            <DocsLink href={MCP_APPS_DOCS_URL}>
              MCP apps, in the agent docs
            </DocsLink>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DocsLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 underline underline-offset-3 hover:text-foreground"
    >
      {children}
      <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}
