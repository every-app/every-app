import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { User } from "lucide-react";
import { authClient } from "@/client/auth-client";
import { useActiveOrganization } from "@/client/hooks/useActiveOrganization";
import {
  ACCESS_SIGN_OUT_PATH,
  useSignInMethods,
} from "@/client/sign-in-methods";

interface HeaderProps {
  email?: string | null;
}

export function Header({ email }: HeaderProps) {
  const { data: activeOrganization } = useActiveOrganization({
    enabled: Boolean(email),
  });
  const { data: activeMemberRole } = authClient.useActiveMemberRole();
  const canManageOrganizationApps =
    activeMemberRole?.role === "owner" || activeMemberRole?.role === "admin";
  const { data: methods } = useSignInMethods();
  const accessProvider = methods?.providers[0];
  // Whether this account can already sign in with Cloudflare Access.
  const { data: accessLinked } = useQuery({
    queryKey: ["auth", "access-linked"],
    enabled: Boolean(email && accessProvider),
    queryFn: async () => {
      const { data } = await authClient.listAccounts();
      return (data ?? []).some(
        (account) => account.providerId === accessProvider?.id,
      );
    },
  });

  const handleSignOut = async () => {
    await authClient.signOut();
    // Hard refresh clears all client state (query cache, session, etc.).
    // Behind the outer ring, sign out of Access too: signing out of the
    // gateway alone would be undone by the next page load.
    window.location.href = methods?.accessEmail
      ? ACCESS_SIGN_OUT_PATH
      : "/sign-in";
  };

  const connectAccess = async () => {
    if (!accessProvider) return;
    await authClient.linkSocial({
      provider: accessProvider.id,
      callbackURL: window.location.pathname,
      errorCallbackURL: "/sign-in",
    });
  };

  return (
    <div className="navbar pt-safe mt-2">
      <div className="max-w-4xl justify-between mx-auto w-full flex items-center">
        <Link to="/" className="flex items-center flex-row">
          <img src="/transparent-logo.png" alt="Logo" className="h-9 w-auto" />
        </Link>
        <div className="flex-none flex items-center gap-6">
          <a
            href="https://everyapp.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="link link-hover"
          >
            Docs
          </a>
          <Link to="/organizations" className="link link-hover">
            {activeOrganization?.name ?? "Organizations"}
          </Link>
          {canManageOrganizationApps && (
            <Link to="/admin/users" className="link link-hover">
              Admin
            </Link>
          )}
          {email && (
            <div className="dropdown dropdown-end">
              <div
                tabIndex={0}
                role="button"
                className="btn btn-ghost btn-circle"
              >
                <User className="w-5 h-5" />
              </div>
              <ul
                tabIndex={0}
                className="menu menu-sm dropdown-content z-1 mt-3 w-auto min-w-52"
              >
                <li className="menu-title">
                  <span className="text-base-content">{email}</span>
                </li>
                <li>
                  <Link to="/settings/connections">Connected AI apps</Link>
                </li>
                {accessProvider && accessLinked === false && (
                  <li>
                    <a onClick={() => void connectAccess()}>
                      Connect {accessProvider.label}
                    </a>
                  </li>
                )}
                <li>
                  <a onClick={handleSignOut} className="text-error">
                    Sign Out
                  </a>
                </li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
