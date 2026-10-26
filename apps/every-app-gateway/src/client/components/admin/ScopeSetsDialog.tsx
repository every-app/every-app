import { useState } from "react";
import { revalidateLogic } from "@tanstack/react-form";
import { CircleAlert, Trash2 } from "lucide-react";
import { z } from "zod";
import { SCOPE_SET_NAME } from "@every-app/sdk/internal";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import { getRuleErrorMessage } from "@/client/errors";
import { splitList } from "@/client/lib/oauthProviders";
import type { AddScopeSetInput } from "@/schemas/oauth-provider";

/** A scope set as the Providers listing carries it. */
interface ScopeSetView {
  name: string;
  label: string;
  access: "read" | "write";
  scopes: string[];
  hosts: string[];
  source: "catalog" | "row";
  addedBy?: string | null;
}

const formSchema = z.object({
  name: z
    .string()
    .trim()
    .regex(
      SCOPE_SET_NAME,
      "A set is named identity, or <area>.<access> in lowercase (gmail.send).",
    ),
  label: z.string().trim().min(1, "Label the set.").max(80, "Too long."),
  access: z.enum(["read", "write"]),
  scopes: z.string().trim().min(1, "Name at least one scope."),
  host: z.string().trim().min(1, "Pick a host."),
  paths: z.string().trim().min(1, "Name at least one path."),
  posts: z.string().trim(),
});
type FormValues = z.infer<typeof formSchema>;

interface ScopeSetsDialogProps {
  provider: {
    id: string;
    name: string;
    console: string;
    /** The client's API hosts: the only ones a set's routes may name. */
    hosts: string[];
    scopeSets: ScopeSetView[];
  };
  /** Rejects with the server's error, which the dialog shows. */
  onAdd: (input: AddScopeSetInput) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
  onClose: () => void;
}

/**
 * Manage workspace → Providers → Scope sets, for a built-in OAuth client
 * with scope sets (Google, Microsoft, Slack): the client's own sets and
 * the ones added here, a Remove on the latter, and a form that adds one
 * (its name, label, access, scopes and one route on the client's hosts).
 * An added set is one apps list under `scopes` like a built-in set; the
 * OAuth client at the provider's console must be allowed its scopes.
 * Render it only while it is open.
 */
export function ScopeSetsDialog({
  provider,
  onAdd,
  onRemove,
  onClose,
}: ScopeSetsDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: {
      name: "",
      label: "",
      access: "read",
      scopes: "",
      host: provider.hosts[0] ?? "",
      paths: "",
      posts: "",
    } as FormValues,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: formSchema },
    onSubmit: async ({ value, formApi }) => {
      setError(null);
      const posts = splitList(value.posts);
      try {
        await onAdd({
          providerId: provider.id,
          name: value.name.trim(),
          label: value.label.trim(),
          access: value.access,
          scopes: splitList(value.scopes),
          routes: [
            {
              host: value.host.trim(),
              paths: splitList(value.paths),
              ...(posts.length > 0 ? { posts } : {}),
            },
          ],
        });
        formApi.reset();
      } catch (err) {
        setError(getRuleErrorMessage(err, "Failed to add the scope set"));
      }
    },
  });

  const remove = async (name: string) => {
    setError(null);
    setRemoving(name);
    try {
      await onRemove(name);
    } catch (err) {
      setError(getRuleErrorMessage(err, "Failed to remove the scope set"));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <form.AppForm>
          <form.Form className="flex min-w-0 flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{provider.name}: scope sets</DialogTitle>
              <DialogDescription>
                What apps may list under scopes. A set added here unlocks its
                routes on the client&apos;s own hosts; allow its scopes on the
                OAuth client at the provider&apos;s console, and people connect
                again to grant them.
              </DialogDescription>
            </DialogHeader>

            <div className="flex max-h-[55vh] min-w-0 flex-col gap-4 overflow-y-auto px-0.5">
              <ul className="flex flex-col gap-1.5" aria-label="Scope sets">
                {provider.scopeSets.map((set) => (
                  <li
                    key={set.name}
                    className="flex items-start justify-between gap-2 rounded-lg border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className="font-mono">{set.name}</span>
                        <Badge variant="outline" size="sm">
                          {set.access}
                        </Badge>
                        <Badge
                          variant={
                            set.source === "row" ? "secondary" : "outline"
                          }
                          size="sm"
                        >
                          {set.source === "row" ? "Added here" : "Built in"}
                        </Badge>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {set.label}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {set.scopes.join(" ")}
                      </p>
                    </div>
                    {set.source === "row" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${set.name}`}
                        disabled={removing === set.name}
                        onClick={() => void remove(set.name)}
                      >
                        <Trash2 />
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>

              <section className="flex flex-col gap-3">
                <p className="text-sm font-medium">Add a scope set</p>
                <form.AppField name="name">
                  {(field) => (
                    <field.TextField
                      label="Name"
                      description="identity, or <area>.<access>; not one of the client's own."
                      placeholder="gmail.send"
                      spellCheck={false}
                    />
                  )}
                </form.AppField>
                <form.AppField name="label">
                  {(field) => (
                    <field.TextField label="Label" placeholder="Gmail (send)" />
                  )}
                </form.AppField>
                <form.AppField name="access">
                  {(field) => (
                    <field.SelectField
                      label="Access"
                      description="Said outright: a write set is never implied by its scopes."
                      items={[
                        {
                          value: "read",
                          label: "Read (GET, HEAD and the posts below)",
                        },
                        {
                          value: "write",
                          label: "Write (the write methods too)",
                        },
                      ]}
                    />
                  )}
                </form.AppField>
                <form.AppField name="scopes">
                  {(field) => (
                    <field.TextareaField
                      label="Scopes"
                      description="The provider's scope strings, space or comma separated."
                      placeholder="https://www.googleapis.com/auth/gmail.send"
                      spellCheck={false}
                      rows={2}
                    />
                  )}
                </form.AppField>
                <form.AppField name="host">
                  {(field) => (
                    <field.SelectField
                      label="Host"
                      description="One of the client's API hosts; the set unlocks nothing elsewhere."
                      items={provider.hosts.map((host) => ({
                        value: host,
                        label: host,
                      }))}
                    />
                  )}
                </form.AppField>
                <form.AppField name="paths">
                  {(field) => (
                    <field.TextareaField
                      label="Paths"
                      description="Path prefixes (ending in /) or exact paths, space or comma separated."
                      placeholder="/gmail/v1/users/"
                      spellCheck={false}
                      rows={2}
                    />
                  )}
                </form.AppField>
                <form.AppField name="posts">
                  {(field) => (
                    <field.TextareaField
                      label="POST patterns (optional)"
                      description="Anchored patterns (^…$) of POST paths a read set admits."
                      placeholder="^/gmail/v1/users/[^/]+/messages/send$"
                      spellCheck={false}
                      rows={2}
                    />
                  )}
                </form.AppField>
              </section>

              {error ? (
                <Alert variant="destructive">
                  <CircleAlert />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Close
              </Button>
              <form.SubmitButton>Add scope set</form.SubmitButton>
            </DialogFooter>
          </form.Form>
        </form.AppForm>
      </DialogContent>
    </Dialog>
  );
}
