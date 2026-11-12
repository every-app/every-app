import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { AppShell } from "@/client/components/AppShell";
import { CopyButton } from "@/client/components/CopyButton";
import { PageHeader } from "@/client/components/PageHeader";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { Checkbox } from "@/client/components/ui/checkbox";
import { Input } from "@/client/components/ui/input";
import { getHome } from "@/serverFunctions/home";
import {
  createTodo,
  deleteTodo,
  getTodos,
  updateTodo,
} from "@/serverFunctions/todos";

export const Route = createFileRoute("/")({
  loader: async () => {
    const [home, todos] = await Promise.all([getHome(), getTodos()]);
    return { home, todos };
  },
  // The manifest's name, which the server read from env.EVERYAPP_MANIFEST.
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: loaderData.home.name }] : [],
  }),
  component: Home,
});

function Home() {
  const { home, todos } = Route.useLoaderData();
  const { user, name, allowed, members } = home;
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  // A change goes to a server function; the loader then reads the list again.
  async function change(work: () => Promise<unknown>) {
    setError(null);
    try {
      await work();
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That didn't work.");
    }
  }

  return (
    <AppShell>
      <PageHeader
        title={name}
        description={
          <>
            A todo list, for now.
            {typeof members === "number" && <> {whoCanOpen(members)}</>}
          </>
        }
      />

      <Section
        title="Make it something else"
        description="Open this app's folder in a coding agent (Claude Code, Codex or Cursor) and say what it should become:"
      >
        <div
          className={`${panel} flex items-start justify-between gap-3 px-5 py-4`}
        >
          <p className="min-w-0">{PROMPT}</p>
          <CopyButton value={PROMPT} successMessage="Copied the prompt." />
        </div>
        <p className={note}>
          The agent already knows EveryApp. The folder carries the{" "}
          <code>{BUILD_SKILL}</code> skill: how to build one, with patterns from
          real apps.
        </p>
      </Section>

      <Section
        title="You"
        description="You signed in at the Gateway. It tells this app who you are, signed so the app can trust it. The app has no login of its own."
      >
        <div className={`${panel} px-5 py-4`}>
          <p className="font-medium">{user.email}</p>
          <p className={note}>
            {user.orgRole} of {user.orgId}
          </p>
        </div>
      </Section>

      <Section
        title="What this app was allowed"
        description={
          <>
            Listed in <code>everyapp.config.ts</code>. The app gets only what
            that file lists; the Gateway refuses the rest.
          </>
        }
      >
        <dl className={`${panel} divide-y divide-border text-sm`}>
          <Allowed term="resources" items={allowed.resources}>
            Storage of its own; the todos live in the database.
          </Allowed>
          <Allowed term="public" items={allowed.public} link>
            Reachable without signing in, for a provider's webhook or an OAuth
            callback. Every route not listed needs a signed-in member.
          </Allowed>
          <Allowed term="providers" items={allowed.providers}>
            AI models the Gateway calls for the app, with a key you add once.
          </Allowed>
          <Allowed term="capabilities" items={allowed.capabilities}>
            What the Gateway does for the app with keys it holds;{" "}
            {typeof members === "number" ? (
              <>
                <code>members</code> is how this page knows who can open it.
              </>
            ) : (
              <>
                the Gateway refused <code>listMembers()</code>:{" "}
                <code>{members.refused}</code>.
              </>
            )}
          </Allowed>
          <Allowed term="secrets" items={allowed.secrets}>
            Keys only this app uses.
          </Allowed>
          <Allowed term="tools" items={allowed.tools}>
            What an AI assistant may do here, through your Gateway (
            <code>src/tools.ts</code>). Read-only connections get the read
            tools; the assistant asks before one that deletes.
          </Allowed>
        </dl>
      </Section>

      <Section title="Todos">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const next = title.trim();
            if (!next) return;
            setTitle("");
            void change(() => createTodo({ data: { title: next } }));
          }}
        >
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="New todo"
            aria-label="New todo"
            className="bg-card"
          />
          <Button type="submit">Add</Button>
        </form>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {todos.length === 0 ? (
          <p className={note}>
            Nothing yet. Add one above, or ask your AI client to.
          </p>
        ) : (
          <ul className={`${panel} divide-y divide-border`}>
            {todos.map((todo) => (
              <li
                key={todo.id}
                className="flex items-center gap-3 py-2 pr-2 pl-5"
              >
                <Checkbox
                  checked={todo.completed}
                  aria-label={`Done: ${todo.title}`}
                  onCheckedChange={(completed) =>
                    change(() =>
                      updateTodo({ data: { id: todo.id, completed } }),
                    )
                  }
                />
                <span
                  className={
                    todo.completed
                      ? "min-w-0 flex-1 text-muted-foreground line-through"
                      : "min-w-0 flex-1"
                  }
                >
                  {todo.title}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete: ${todo.title}`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    change(() => deleteTodo({ data: { id: todo.id } }))
                  }
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </AppShell>
  );
}

/** A titled part of the page: what it is, then its content. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description ? <p className={note}>{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** One row of the Allowed panel: a manifest field, what it lists, and what that means. */
function Allowed({
  term,
  items,
  link,
  children,
}: {
  term: string;
  items: readonly string[];
  link?: boolean;
  children: ReactNode;
}) {
  return (
    // One block on a phone; on wider screens the term sits beside the rest.
    <div className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:gap-6">
      <dt className="shrink-0 font-mono text-muted-foreground sm:w-28">
        {term}
      </dt>
      <dd className="min-w-0 space-y-0.5">
        <p>
          {items.length === 0 ? (
            <span className="text-muted-foreground">none</span>
          ) : (
            items.map((item) => (
              <Fragment key={item}>
                {link ? (
                  <a href={item} className="underline underline-offset-3">
                    {item}
                  </a>
                ) : (
                  <code>{item}</code>
                )}{" "}
              </Fragment>
            ))
          )}
        </p>
        <p className="text-muted-foreground">{children}</p>
      </dd>
    </div>
  );
}

/** The members count as a sentence; `listMembers()` counts the signed-in person. */
function whoCanOpen(members: number): string {
  return members === 1
    ? "You alone can open it."
    : `${members} people can open it.`;
}

// The build skill `everyapp create` links into a new app, where coding agents
// look for it. A convention of the CLI (packages/cli/src/lib/app/skill.ts), not
// a manifest field, so the page names it as a constant; a test in the CLI
// (packages/cli/src/lib/app/starterSkills.test.ts) holds it to the skills the
// CLI ships.
const BUILD_SKILL = "build-every-app";

// What the page suggests saying to a coding agent.
const PROMPT =
  "Turn this into a shared todo list for my household, with separate lists for groceries and chores.";

// A white panel on the page's grey, as OpenCRM's lists and settings have.
const panel =
  "overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xs";
const note = "text-sm text-muted-foreground";
