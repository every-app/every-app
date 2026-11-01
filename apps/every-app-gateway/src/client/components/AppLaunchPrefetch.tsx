import { useEffect, useMemo } from "react";
import { useAppLibrary } from "@/client/hooks/useAppLibrary";
import { useSession } from "@/client/hooks/useSession";
import {
  openableHosts,
  speculationRulesFor,
} from "@/client/lib/appLaunchPrefetch";

/**
 * Tells Chrome which apps it may prefetch on hover: one
 * `<script type="speculationrules">` in the document head naming every app
 * that opens (see lib/appLaunchPrefetch). The script is created with the
 * DOM rather than JSX so the browser parses it as rules, and is replaced
 * whenever the list of hosts changes, and whenever the person switches
 * organization: removing the script drops what was prefetched under the
 * old one, so a page fetched as one organization is never committed as
 * another. Renders nothing; other browsers ignore the script.
 */
export function AppLaunchPrefetch({
  site = window.location.hostname,
}: {
  /** The launcher's hostname; only apps on its site are listed. */
  site?: string;
}) {
  const { apps } = useAppLibrary();
  const { data: session } = useSession();
  const organizationId = session?.session.activeOrganizationId ?? null;
  const rules = useMemo(() => {
    const hosts = openableHosts(apps, site);
    return hosts.length > 0 ? speculationRulesFor(hosts) : null;
  }, [apps, site]);
  useEffect(() => {
    if (!rules) return;
    const script = document.createElement("script");
    script.type = "speculationrules";
    script.textContent = rules;
    document.head.appendChild(script);
    return () => {
      script.remove();
    };
  }, [rules, organizationId]);
  return null;
}
