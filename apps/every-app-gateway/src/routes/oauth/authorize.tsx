import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ShieldCheck, X } from "lucide-react";
import {
  approveAuthorization,
  denyAuthorization,
  getAuthorizeContext,
} from "@/serverFunctions/oauthAuthorization";

export const Route = createFileRoute("/oauth/authorize")({
  component: OAuthAuthorizePage,
});

function currentAuthorizeQuery(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

function OAuthAuthorizePage() {
  const contextQuery = useQuery({
    queryKey: ["oauth", "authorize", currentAuthorizeQuery()],
    queryFn: () => getAuthorizeContext(),
  });

  const approveMutation = useMutation({
    mutationFn: approveAuthorization,
    onSuccess: ({ redirectTo }) => {
      window.location.assign(redirectTo);
    },
  });

  const denyMutation = useMutation({
    mutationFn: denyAuthorization,
    onSuccess: ({ redirectTo }) => {
      window.location.assign(redirectTo);
    },
  });

  if (contextQuery.isLoading) {
    return (
      <main className="min-h-screen bg-base-100 grid place-items-center p-6">
        <span className="loading loading-spinner loading-lg" />
      </main>
    );
  }

  const context = contextQuery.data;
  if (!context || contextQuery.isError) {
    return <AuthorizeError message="This authorization request is invalid" />;
  }

  if (!context.ok) {
    if ("unauthenticated" in context && context.unauthenticated) {
      if (typeof window !== "undefined") {
        const redirect = `${window.location.pathname}${window.location.search}`;
        window.location.assign(
          `/sign-in?redirect=${encodeURIComponent(redirect)}`,
        );
      }
      return null;
    }
    return <AuthorizeError message={context.message} />;
  }

  const isPending = approveMutation.isPending || denyMutation.isPending;
  const query = currentAuthorizeQuery();

  return (
    <main className="min-h-screen bg-base-100 grid place-items-center p-6">
      <section className="w-full max-w-lg rounded-lg border border-base-300 bg-base-100 p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            {context.client.logoUri ? (
              <img
                src={context.client.logoUri}
                alt=""
                className="h-8 w-8 rounded object-contain"
              />
            ) : (
              <ShieldCheck className="h-6 w-6" />
            )}
          </div>
          <div>
            <h1 className="text-xl font-bold">Connect {context.client.name}</h1>
            <p className="mt-1 text-sm text-base-content/70">
              {context.client.name} wants to access {context.app.name} as{" "}
              {context.user.email}.
            </p>
          </div>
        </div>

        <div className="mt-6 rounded-md border border-base-300 p-4">
          <h2 className="text-sm font-semibold">Access</h2>
          {context.fullAccess ? (
            <p className="mt-2 text-sm">
              Full access to {context.app.name} as your user
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {context.scopes.map((scope) => (
                <span key={scope} className="badge badge-outline">
                  {scope}
                </span>
              ))}
            </div>
          )}
        </div>

        {(approveMutation.isError || denyMutation.isError) && (
          <div className="alert alert-error mt-4">
            <span>Unable to complete authorization.</span>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={isPending}
            onClick={() => denyMutation.mutate({ data: { query } })}
          >
            <X className="h-4 w-4" />
            Deny
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={isPending}
            onClick={() => approveMutation.mutate({ data: { query } })}
          >
            <ShieldCheck className="h-4 w-4" />
            Approve
          </button>
        </div>
      </section>
    </main>
  );
}

function AuthorizeError({ message }: { message: string }) {
  return (
    <main className="min-h-screen bg-base-100 grid place-items-center p-6">
      <section className="w-full max-w-lg rounded-lg border border-error/30 bg-base-100 p-6 shadow-sm">
        <h1 className="text-xl font-bold">Authorization error</h1>
        <p className="mt-2 text-base-content/70">{message}</p>
      </section>
    </main>
  );
}
