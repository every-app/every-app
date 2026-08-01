import type { UserAccessApp } from "@/types/app";

interface AppListItemProps {
  app: UserAccessApp;
}

/**
 * One launcher entry. Apps live on their own subdomains behind the gateway
 * perimeter, so an entry is a plain link to `https://<hostname>` — no iframe,
 * no token handshake. The scheme is inherited from the launcher's own origin
 * so local dev gateways (http) keep working.
 */
export function AppListItem({ app }: AppListItemProps) {
  const routable = Boolean(app.hostname) && app.status === "active";

  if (!routable) {
    const label = !app.hostname ? "needs deploy" : app.status;
    return (
      <li
        className="border border-base-content/10 rounded-lg bg-base-100 opacity-60"
        title="Deploy this app with `everyapp deploy` to make it reachable."
      >
        <div className="flex items-center justify-between p-4">
          <div className="flex-1">
            <div className="font-medium">{app.name}</div>
            <div className="text-sm text-base-content/70">
              {app.description}
            </div>
          </div>
          <span className="badge badge-ghost badge-sm rounded-full whitespace-nowrap">
            {label}
          </span>
        </div>
      </li>
    );
  }

  return (
    <li className="border border-base-content/20 rounded-lg bg-base-100 transition-all cursor-pointer hover:bg-base-200 hover:border-base-400 hover:shadow-md">
      <a
        href={`//${app.hostname}`}
        className="flex items-center justify-between p-4"
      >
        <div className="flex-1">
          <div className="font-medium">{app.name}</div>
          <div className="text-sm text-base-content/70">{app.description}</div>
        </div>
        <div className="text-xs text-base-content/40 whitespace-nowrap hidden sm:block">
          {app.hostname}
        </div>
      </a>
    </li>
  );
}
