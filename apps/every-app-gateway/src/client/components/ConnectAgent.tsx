import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { CodeBlock } from "@/client/components/CodeBlock";
import { CONNECT_AI_DOCS_URL } from "@/client/components/McpAppDialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/client/components/ui/tabs";
import { CONNECT_AGENT_COPY } from "@/client/lib/connectAgentCopy";

const COPY = CONNECT_AGENT_COPY;

/**
 * The Gateway's MCP address: its own origin plus `/mcp`, one address across
 * organizations. The page is server-rendered without a window, so it is read
 * on the client only.
 */
function useMcpAddress(): string {
  const [address, setAddress] = useState("");
  useEffect(() => {
    setAddress(`${window.location.origin}/mcp`);
  }, []);
  return address;
}

/**
 * How to connect an AI client to this Gateway: the address to copy, a tab
 * per client with its exact step, what the sign-in page asks, and where a
 * token comes from for the reader's role (members cannot open /admin, so
 * they are told to ask; while the role is unknown the line stays out).
 */
export function ConnectAgentSteps({
  role,
  onNavigate,
}: {
  role: string | undefined;
  /** Called when a link inside leaves for another page, to close a dialog. */
  onNavigate?: () => void;
}) {
  const address = useMcpAddress();
  const canManageTokens = role === "owner" || role === "admin";
  return (
    <div className="flex min-w-0 flex-col gap-4 text-sm">
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground">{COPY.intro}</p>
        {address ? (
          <CodeBlock code={address} successMessage={COPY.addressCopied} />
        ) : null}
      </div>
      <Tabs defaultValue={COPY.clients[0].id} className="min-w-0">
        {/* The tabs scroll sideways on a phone instead of being cut off. */}
        <div className="scrollbar-hidden overflow-x-auto border-b border-border">
          <TabsList variant="line" className="h-9 gap-4" aria-label="AI app">
            {COPY.clients.map((client) => (
              <TabsTrigger
                key={client.id}
                value={client.id}
                className="flex-none px-0.5 pb-2"
              >
                {client.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {COPY.clients.map((client) => (
          <TabsContent
            key={client.id}
            value={client.id}
            className="flex flex-col gap-2 pt-1"
          >
            <p>{client.before}</p>
            {client.code && address ? (
              <CodeBlock code={client.code(address)} />
            ) : null}
            {client.after ? (
              <p className="text-muted-foreground">{client.after}</p>
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
      <p className="text-muted-foreground">{COPY.next}</p>
      {role ? (
        <p className="text-xs text-muted-foreground">
          {canManageTokens ? (
            <>
              {COPY.token.manager}{" "}
              <Link
                to="/admin/tokens"
                onClick={onNavigate}
                className="underline underline-offset-4 hover:text-foreground"
              >
                {COPY.token.managerLink}
              </Link>
            </>
          ) : (
            COPY.token.member
          )}
        </p>
      ) : null}
    </div>
  );
}

/** The docs page on connecting, in a new tab. */
export function ConnectAgentDocsLink() {
  return (
    <a
      href={CONNECT_AI_DOCS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-foreground"
    >
      {COPY.docsLink}
      <span className="sr-only"> (opens in a new tab)</span>
      <ArrowUpRight className="size-3.5" aria-hidden />
    </a>
  );
}

/**
 * The sidebar's "Connect your agent" dialog: the steps, then where to see or
 * revoke connections and the docs. Render it only while it is open.
 */
export function ConnectAgentDialog({
  role,
  onClose,
}: {
  role: string | undefined;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{COPY.title}</DialogTitle>
        </DialogHeader>
        <ConnectAgentSteps role={role} onNavigate={onClose} />
        <DialogFooter showCloseButton>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground sm:mr-auto sm:self-center">
            <Link
              to="/settings/connections"
              onClick={onClose}
              className="underline underline-offset-4 hover:text-foreground"
            >
              {COPY.connectionsLink}
            </Link>
            <ConnectAgentDocsLink />
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
