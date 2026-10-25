import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Fragment, useState, type ReactNode } from "react";
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
  component: Home,
});

function Home() {
  const { home, todos } = Route.useLoaderData();
  const { user, name, allowed, members, launcher } = home;
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
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">{name}</h1>
        <a
          href={launcher}
          className="text-sm text-blue-700 underline dark:text-blue-400"
        >
          All apps
        </a>
      </header>

      <section className={card}>
        <h2 className={heading}>This app</h2>
        <p>
          A todo list, for now. To make it something else, open its folder in a
          coding agent (Claude Code, Codex or Cursor) and say what it should
          become:
        </p>
        <blockquote className="border-l-2 border-neutral-300 pl-3 text-neutral-700 dark:border-neutral-700 dark:text-neutral-300">
          Turn this into a shared todo list for my household, with separate
          lists for groceries and chores.
        </blockquote>
        <p className={note}>
          The agent already knows Every App. The folder carries the{" "}
          <code>{BUILD_SKILL}</code> skill: how to build one, with patterns from
          real apps.
        </p>
        {typeof members === "number" && (
          <p className={note}>{whoCanOpen(members)}</p>
        )}
      </section>

      <section className={card}>
        <h2 className={heading}>You</h2>
        <p className="font-medium">
          {user.email}
          <span className="text-neutral-500">
            {" "}
            · {user.orgRole} of {user.orgId}
          </span>
        </p>
        <p className={note}>
          You signed in at the Gateway. It tells this app who you are, signed so
          the app can trust it. The app has no login of its own.
        </p>
      </section>

      <section className={card}>
        <h2 className={heading}>What this app was allowed</h2>
        <p className={note}>
          Listed in <code>everyapp.config.ts</code>. The app gets only what that
          file lists; the Gateway refuses the rest.
        </p>
        <dl className="flex flex-col gap-3 text-sm sm:grid sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-x-4 sm:gap-y-2">
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
            <code>src/tools.ts</code>). A destructive one stays hidden until the
            Gateway has approvals.
          </Allowed>
        </dl>
      </section>

      <section className={card}>
        <h2 className={heading}>Todos</h2>
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
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="New todo"
            aria-label="New todo"
            className="flex-1 rounded-lg border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
          />
          <button
            type="submit"
            className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white"
          >
            Add
          </button>
        </form>
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {todos.map((todo) => (
            <li key={todo.id} className="flex items-center gap-3 py-2">
              <input
                type="checkbox"
                checked={todo.completed}
                aria-label={`Done: ${todo.title}`}
                onChange={(event) =>
                  change(() =>
                    updateTodo({
                      data: { id: todo.id, completed: event.target.checked },
                    }),
                  )
                }
                className="size-4 accent-blue-600"
              />
              <span
                className={
                  todo.completed
                    ? "flex-1 text-neutral-500 line-through"
                    : "flex-1"
                }
              >
                {todo.title}
              </span>
              <button
                type="button"
                onClick={() =>
                  change(() => deleteTodo({ data: { id: todo.id } }))
                }
                className="text-sm text-neutral-500 hover:text-red-600"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
        {todos.length === 0 && (
          <p className={note}>
            Nothing yet. Add one above, or ask your AI client to.
          </p>
        )}
      </section>
    </main>
  );
}

/** One line of the Allowed card: a manifest field, what it lists, and what that means. */
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
    // One block on a phone; on wider screens the dt and dd join the grid.
    <div className="sm:contents">
      <dt className="font-mono text-neutral-500">{term}</dt>
      <dd className="min-w-0">
        <p>
          {items.length === 0 ? (
            <span className="text-neutral-500">none</span>
          ) : (
            items.map((item) => (
              <Fragment key={item}>
                {link ? (
                  <a href={item} className="underline">
                    {item}
                  </a>
                ) : (
                  <code>{item}</code>
                )}{" "}
              </Fragment>
            ))
          )}
        </p>
        <p className="text-neutral-500">{children}</p>
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

// The build skill `everyapp create` copies into a new app, where coding agents
// look for it. A convention of the CLI (packages/cli/src/lib/app/skill.ts), not
// a manifest field, so the page names it as a constant; a test in the CLI
// (packages/cli/src/lib/app/starterSkills.test.ts) holds it to the skills the
// CLI ships.
const BUILD_SKILL = "build-every-app";

const card =
  "flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800";
const heading =
  "text-xs font-semibold uppercase tracking-wide text-neutral-500";
const note = "text-sm text-neutral-500";
