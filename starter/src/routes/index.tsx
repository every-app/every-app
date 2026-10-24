import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Fragment, useState } from "react";
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
        <h2 className={heading}>You</h2>
        <p className="font-medium">
          {user.email}
          <span className="text-neutral-500">
            {" "}
            · {user.orgRole} of {user.orgId}
          </span>
        </p>
        <p className={note}>
          Signed in by the Gateway. The app reads who you are from a header the
          Gateway signs; it has no login of its own.
        </p>
      </section>

      <section className={card}>
        <h2 className={heading}>What this app was allowed</h2>
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <Allowed term="resources" items={allowed.resources} none="none" />
          <Allowed
            term="public"
            items={allowed.public}
            none="none: every route needs a signed-in member"
            hint="opens without signing in; every other route needs a member"
            link
          />
          <Allowed
            term="providers"
            items={allowed.providers}
            none="none: AI models the Gateway calls for the app"
          />
          <Allowed
            term="capabilities"
            items={allowed.capabilities}
            none="none: what the Gateway does for the app with keys it holds"
            hint={
              typeof members === "number"
                ? `so listMembers() answers: ${members === 1 ? "you alone can" : `${members} people can`} open this app`
                : `but the Gateway refused listMembers(): ${members.refused}`
            }
          />
          <Allowed
            term="secrets"
            items={allowed.secrets}
            none="none: keys only this app uses"
          />
          <Allowed
            term="tools"
            items={allowed.tools}
            none="none"
            hint="for AI clients at /mcp; a destructive one stays hidden until the Gateway has approvals"
          />
        </dl>
        <p className={note}>
          From <code>everyapp.config.ts</code> (tools from{" "}
          <code>src/tools.ts</code>). The Gateway gives the app nothing it
          doesn't declare there.
        </p>
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

/** One line of the Allowed card: a manifest field and what it lists. */
function Allowed({
  term,
  items,
  none,
  hint,
  link,
}: {
  term: string;
  items: readonly string[];
  none: string;
  hint?: string;
  link?: boolean;
}) {
  return (
    <>
      <dt className="font-mono text-neutral-500">{term}</dt>
      <dd className="min-w-0">
        {items.length === 0 ? (
          <span className="text-neutral-500">{none}</span>
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
        {items.length > 0 && hint && (
          <span className="text-neutral-500">{hint}</span>
        )}
      </dd>
    </>
  );
}

const card =
  "flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800";
const heading =
  "text-xs font-semibold uppercase tracking-wide text-neutral-500";
const note = "text-sm text-neutral-500";
