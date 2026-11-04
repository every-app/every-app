import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { CodeBlock } from "@/client/components/CodeBlock";
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
import {
  CONNECT_AGENT_COPY,
  CONNECT_AI_DOCS_URL,
  type ConnectStep,
} from "@/client/lib/connectAgentCopy";

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
 * How to connect an AI client to this Gateway: a tab per client, then that
 * client's numbered steps, each command carrying this Gateway's address.
 */
export function ConnectAgentSteps({
  role,
  onNavigate,
  lastStep,
}: {
  role: string | undefined;
  /** Called when a link inside leaves for another page, to close a dialog. */
  onNavigate?: () => void;
  /** A step after every client's own: what to do once it is connected. */
  lastStep?: ConnectStep;
}) {
  const address = useMcpAddress();
  return (
    <Tabs defaultValue={COPY.clients[0].id} className="min-w-0 gap-4 text-sm">
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
          className="flex flex-col gap-4"
        >
          <ol className="flex flex-col gap-4">
            {[...client.steps, ...(lastStep ? [lastStep] : [])].map(
              (step: ConnectStep, index) => (
                <li
                  key={step.text}
                  className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 not-last:before:absolute not-last:before:top-6 not-last:before:-bottom-3 not-last:before:left-[9.5px] not-last:before:w-px not-last:before:bg-border"
                >
                  <span
                    aria-hidden
                    className="flex size-5 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background"
                  >
                    {index + 1}
                  </span>
                  <p className="leading-5 font-medium">{step.text}</p>
                  {step.code && address ? (
                    <div className="col-start-2">
                      <CodeBlock code={step.code(address)} />
                    </div>
                  ) : null}
                </li>
              ),
            )}
          </ol>
          {client.id === "other" && role ? (
            <TokenNote role={role} onNavigate={onNavigate} />
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}

/**
 * Where a token comes from, for tools that can't sign in: owners and admins
 * go to Tokens; members cannot open /admin, so they are told to ask.
 */
function TokenNote({
  role,
  onNavigate,
}: {
  role: string;
  onNavigate?: () => void;
}) {
  if (role !== "owner" && role !== "admin") {
    return <p className="text-xs text-muted-foreground">{COPY.token.member}</p>;
  }
  return (
    <p className="text-xs text-muted-foreground">
      {COPY.token.manager}{" "}
      <Link
        to="/admin/tokens"
        onClick={onNavigate}
        className="underline underline-offset-4 hover:text-foreground"
      >
        {COPY.token.managerLink}
      </Link>
    </p>
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
 * revoke connections and the docs. An MCP app's dialog is this one with its
 * own title and last step (McpAppDialog). Render it only while it is open.
 */
export function ConnectAgentDialog({
  title = COPY.title,
  intro,
  lastStep,
  role,
  onClose,
}: {
  title?: string;
  /** Above the steps. */
  intro?: ReactNode;
  lastStep?: ConnectStep;
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
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {intro}
        <ConnectAgentSteps
          role={role}
          onNavigate={onClose}
          lastStep={lastStep}
        />
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
