import { useEffect, useState } from "react";
import { PROVIDER_APPS, isProviderAppId } from "@every-app/sdk/internal";
import { ConnectAgentDialog } from "@/client/components/ConnectAgent";
import { Button } from "@/client/components/ui/button";
import { MCP_APP_COPY } from "@/client/lib/mcpAppCopy";
import { getMcpAppConnection } from "@/serverFunctions/mcpApps";
import type { McpAppConnectionStatus } from "@/types/mcpApp";

const COPY = MCP_APP_COPY.useDialog;

interface McpAppDialogProps {
  name: string;
  /** The app's id, which finds a built-in's own example. */
  appId: string;
  role: string | undefined;
  onClose: () => void;
}

/**
 * How to use an MCP app, from Admin → Apps: the Connect your agent steps,
 * since it has no page and is reached through that one connection, then a
 * sentence to ask. A server members sign in to says first whether this person
 * is connected. Render it only while it is open.
 */
export function McpAppDialog({
  name,
  appId,
  role,
  onClose,
}: McpAppDialogProps) {
  const connection = useMcpAppConnection(appId);
  // A built-in's own example; any other MCP app is a remote server the
  // Gateway knows nothing about beyond its tools, so the sentence is generic.
  const example = isProviderAppId(appId)
    ? `Use ${name} to ${PROVIDER_APPS[appId].example}.`
    : COPY.genericExample(name);
  return (
    <ConnectAgentDialog
      title={COPY.title(name)}
      intro={connection ? <ConnectionLine status={connection} /> : null}
      lastStep={{ text: COPY.ask, code: () => example }}
      role={role}
      onClose={onClose}
    />
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
  const copy = COPY;
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
