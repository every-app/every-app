import { useEffect, useState } from "react";
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
import { Button } from "@/client/components/ui/button";
import { CONNECT_AI_DOCS_URL } from "@/client/lib/connectAgentCopy";
import { MCP_APP_COPY } from "@/client/lib/mcpAppCopy";
import { getMcpAppConnection } from "@/serverFunctions/mcpApps";
import type { McpAppConnectionStatus } from "@/types/mcpApp";

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
  const connection = useMcpAppConnection(appId);
  // A built-in's own example; any other MCP app is a remote server the
  // Gateway knows nothing about beyond its tools, so the sentence is generic.
  const example = isProviderAppId(appId)
    ? `Use ${name} to ${PROVIDER_APPS[appId].example}.`
    : MCP_APP_COPY.useDialog.genericExample(name);
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
        {connection ? <ConnectionLine status={connection} /> : null}
        {address ? (
          <CodeBlock code={address} successMessage="Address copied" />
        ) : null}
        <div className="flex flex-col gap-2 text-sm">
          <p>
            Its tools start with{" "}
            <span className="font-mono text-xs">{appId}_</span>. Try saying:
          </p>
          <p className="rounded-lg border border-border bg-muted px-3 py-2.5">
            “{example}”
          </p>
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

/**
 * A remote MCP app's OAuth connection for this member, read once on
 * mount: null for a built-in, an app with no OAuth connection, or while
 * (or if) the read fails, which leaves the dialog as it was.
 */
function useMcpAppConnection(appId: string): McpAppConnectionStatus | null {
  const [status, setStatus] = useState<McpAppConnectionStatus | null>(null);
  useEffect(() => {
    if (isProviderAppId(appId)) return;
    let live = true;
    getMcpAppConnection({ data: { appId } })
      .then((answer) => {
        if (live) setStatus(answer);
      })
      .catch(() => {
        if (live) setStatus(null);
      });
    return () => {
      live = false;
    };
  }, [appId]);
  return status;
}

/** Connected as whom, or the link to connect. */
function ConnectionLine({ status }: { status: McpAppConnectionStatus }) {
  const copy = MCP_APP_COPY.useDialog;
  if (status.connection?.status === "active") {
    return (
      <p className="text-sm" data-testid="mcp-connection">
        {copy.connectedAs(status.connection.label)}
      </p>
    );
  }
  const expired = status.connection?.status === "expired";
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="mcp-connection">
      <p>{expired ? copy.expired : copy.connectIntro}</p>
      <Button
        className="self-start"
        nativeButton={false}
        render={<a href={status.connectPath} />}
      >
        {expired ? copy.reconnect : copy.connect(status.providerName)}
      </Button>
    </div>
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
