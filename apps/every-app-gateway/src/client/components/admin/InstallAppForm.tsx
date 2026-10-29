import {
  AppInstallError,
  fetchInstallJob,
  reviewAppInstall,
  startAppInstall,
  useAppInstallContext,
  type InstallJob,
} from "@/client/app-install";
import { authClient } from "@/client/auth-client";
import { CodeBlock } from "@/client/components/CodeBlock";
import {
  AuthCard,
  authInputClassName,
} from "@/client/components/auth/AuthPageShell";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { Checkbox } from "@/client/components/ui/checkbox";
import { Field, FieldLabel } from "@/client/components/ui/field";
import { Input } from "@/client/components/ui/input";
import { Spinner } from "@/client/components/ui/spinner";
import { adminAppsCollection } from "@/client/tanstack-db";
import { isAppInstallUrl, OSS_NEW_RELEASE_URL } from "@/schemas/app-install";
import { revalidateLogic } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";

const POLL_MS = 2_000;

interface InstallAppFormProps {
  onBack: () => void;
  sourceUrl?: string;
}

/**
 * Install an app from a public GitHub repository or immutable oss.new release:
 * explicit approval first, then the deploy job until it finishes.
 */
export function InstallAppForm({
  onBack,
  sourceUrl = "",
}: InstallAppFormProps) {
  const {
    data: context,
    isPending: checking,
    error: availabilityError,
  } = useAppInstallContext();
  const available = context?.available;
  const workspaces = context?.workspaces ?? [];
  const review = useMutation({ mutationFn: reviewAppInstall });
  const [values, setValues] = useState<Record<string, string>>({});
  const [authorizedChanges, setAuthorizedChanges] = useState<
    Record<string, boolean>
  >({});

  const install = useMutation({
    mutationFn: startAppInstall,
    onError: (error) => {
      if (
        error instanceof AppInstallError &&
        error.code === "RELEASE_CHANGED"
      ) {
        review.reset();
        setValues({});
        setAuthorizedChanges({});
      }
    },
    onSuccess: () => {
      void adminAppsCollection.utils.refetch();
    },
  });
  const jobId = install.data?.id ?? null;

  // Self-hosted requests stay open for the install; hosted jobs may
  // answer early and are polled until they finish.
  const { data: polled, error: pollError } = useQuery({
    queryKey: ["admin", "deploys", jobId, install.variables?.organizationId],
    queryFn: () => fetchInstallJob(jobId!, install.variables!.organizationId),
    enabled: jobId !== null && install.data?.status === "running",
    refetchInterval: (query) =>
      query.state.data && query.state.data.status !== "running"
        ? false
        : POLL_MS,
  });
  const job: InstallJob | undefined = polled ?? install.data;
  const finished = polled !== undefined && polled.status !== "running";
  useEffect(() => {
    // The row's status and version changed with the deploy.
    if (finished) void adminAppsCollection.utils.refetch();
  }, [finished]);

  const busy = install.isPending || job?.status === "running";
  const releaseOnly = OSS_NEW_RELEASE_URL.test(sourceUrl);
  const installSchema = z.object({
    organizationId: z
      .string()
      .refine(
        (id) => workspaces.some((workspace) => workspace.id === id),
        "Choose a workspace you can administer.",
      ),
    sourceUrl: z
      .string()
      .trim()
      .max(2048)
      .refine(
        (url) =>
          releaseOnly ? OSS_NEW_RELEASE_URL.test(url) : isAppInstallUrl(url),
        releaseOnly
          ? "Paste a valid oss.new release URL."
          : "Paste a GitHub repository or oss.new release URL.",
      ),
  });
  const form = useAppForm({
    defaultValues: { sourceUrl, organizationId: "" },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: installSchema },
    listeners: {
      onChange: () => {
        if (!busy && (install.data || install.error)) install.reset();
        if (!busy) {
          review.reset();
          setValues({});
          setAuthorizedChanges({});
        }
      },
    },
    onSubmit: ({ value }) => {
      if (checking || !available || availabilityError || busy || job) return;
      const source = value.sourceUrl.trim();
      if (
        !review.data ||
        review.variables?.sourceUrl !== source ||
        review.variables.organizationId !== value.organizationId
      ) {
        return review.mutateAsync({
          sourceUrl: source,
          organizationId: value.organizationId,
        });
      }
      return install.mutateAsync({
        sourceUrl: source,
        organizationId: value.organizationId,
        sha256: review.data.sha256,
        configuration: {
          values: Object.fromEntries(
            Object.entries(values).filter(([, value]) => value !== ""),
          ),
          allowDeleteDurableObjectData:
            authorizedChanges.DURABLE_OBJECT_REMOVED,
          allowDeleteWorkflows: authorizedChanges.WORKFLOW_REMOVED,
          replaceChangedWorkers: authorizedChanges.WORKER_CHANGED,
          registerProviders: authorizedChanges.REGISTER_PROVIDERS,
          enableEmailRouting: authorizedChanges.EMAIL_ROUTING_DISABLED,
        },
      });
    },
  });
  useEffect(() => {
    // Set the initial destination once; later session switches cannot move it.
    if (context?.defaultOrganizationId && !form.state.values.organizationId)
      form.setFieldValue("organizationId", context.defaultOrganizationId);
  }, [context?.defaultOrganizationId, form]);
  useEffect(() => {
    // An external handoff reviews the release as the approval page opens.
    // Merely opening the page never registers an app or provisions a resource.
    if (
      sourceUrl &&
      available &&
      context?.defaultOrganizationId &&
      isAppInstallUrl(sourceUrl)
    ) {
      review.mutate({
        sourceUrl,
        organizationId: context.defaultOrganizationId,
      });
    }
  }, [sourceUrl, available, context?.defaultOrganizationId]);

  return (
    <AuthCard title={review.data?.installed ? "Update app" : "Install app"}>
      <form.AppForm>
        <form.Form className="flex flex-col gap-4">
          {workspaces.length === 1 ? (
            <Field>
              <FieldLabel htmlFor="install-workspace">Workspace</FieldLabel>
              <Input
                id="install-workspace"
                value={workspaces[0]!.name}
                readOnly
                disabled={busy}
                className={authInputClassName}
              />
            </Field>
          ) : (
            <form.AppField name="organizationId">
              {(field) => (
                <field.SelectField
                  label="Workspace"
                  items={workspaces.map((workspace) => ({
                    value: workspace.id,
                    label: workspace.name,
                  }))}
                  disabled={busy || checking || workspaces.length === 0}
                />
              )}
            </form.AppField>
          )}
          <form.AppField name="sourceUrl">
            {(field) => (
              <field.TextField
                label={
                  releaseOnly ? "Release URL" : "Repository or release URL"
                }
                placeholder={
                  releaseOnly
                    ? "Paste your oss.new release URL"
                    : "Repository or release URL"
                }
                autoComplete="off"
                required
                autoFocus
                className={authInputClassName}
                disabled={busy || (!checking && !available)}
              />
            )}
          </form.AppField>
          {review.data && (
            <>
              <p className="break-words text-sm font-medium">
                {review.data.name}{" "}
                <span className="text-muted-foreground">
                  ({review.data.appId}) · {review.data.version}
                </span>
              </p>
              {review.data.installed && (
                <p className="text-sm text-muted-foreground">
                  Updates the existing {review.data.installed.name} app.
                </p>
              )}
              {review.data.fields.map((field) => (
                <Field key={field.name}>
                  <FieldLabel htmlFor={`install-${field.name}`}>
                    {field.label}
                    {field.optional ? " (optional)" : ""}
                  </FieldLabel>
                  <Input
                    id={`install-${field.name}`}
                    type={field.secret ? "password" : "text"}
                    autoComplete="off"
                    value={values[field.name] ?? ""}
                    placeholder={field.default}
                    required={!field.optional}
                    disabled={busy}
                    onChange={(event) =>
                      setValues((previous) => ({
                        ...previous,
                        [field.name]: event.target.value,
                      }))
                    }
                  />
                </Field>
              ))}
              {review.data.providers.length > 0 && (
                <Field>
                  {review.data.providers.map((provider) => (
                    <p key={provider.id} className="text-sm">
                      {provider.name}: keys go to {provider.hosts.join(", ")}.
                      Settings: {provider.settings.join(", ")}.
                    </p>
                  ))}
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      disabled={busy}
                      checked={authorizedChanges.REGISTER_PROVIDERS ?? false}
                      onCheckedChange={(checked) =>
                        setAuthorizedChanges((previous) => ({
                          ...previous,
                          REGISTER_PROVIDERS: checked === true,
                        }))
                      }
                    />
                    Register these providers on this Gateway.
                  </label>
                </Field>
              )}
            </>
          )}
          <div aria-live="polite" className="space-y-3 empty:hidden">
            {job ? (
              <JobStatus job={job} />
            ) : install.isPending ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Downloading the release and deploying it…
              </p>
            ) : checking || review.isPending ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />{" "}
                {review.isPending
                  ? "Reviewing the release…"
                  : "Checking this Gateway…"}
              </p>
            ) : availabilityError ? (
              <p role="alert" className="text-sm text-destructive">
                {availabilityError.message}
              </p>
            ) : !available ? (
              <p className="text-sm text-muted-foreground">
                Browser installation is off on this Gateway. Its owner can
                enable it during EveryApp setup.
              </p>
            ) : workspaces.length === 0 ? (
              <p role="alert" className="text-sm text-destructive">
                Only workspace owners and admins can install apps.
              </p>
            ) : install.error ? (
              <Refusal error={install.error} />
            ) : review.error ? (
              <Refusal error={review.error} />
            ) : null}
            {pollError ? (
              <p role="alert" className="text-sm text-destructive">
                {pollError.message}
              </p>
            ) : null}
          </div>
          {job?.status === "failed" &&
            [
              "DURABLE_OBJECT_REMOVED",
              "WORKFLOW_REMOVED",
              "WORKER_CHANGED",
              "EMAIL_ROUTING_DISABLED",
            ].includes(job.error?.code ?? "") && (
              <>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={authorizedChanges[job.error?.code ?? ""] ?? false}
                    onCheckedChange={(checked) =>
                      setAuthorizedChanges((previous) => ({
                        ...previous,
                        [job.error!.code]: checked === true,
                      }))
                    }
                  />
                  {job.error?.code === "WORKER_CHANGED"
                    ? "Replace the deployment changed outside EveryApp."
                    : job.error?.code === "WORKFLOW_REMOVED"
                      ? "Delete the removed Workflows and their instances permanently."
                      : job.error?.code === "EMAIL_ROUTING_DISABLED"
                        ? "Enable Cloudflare Email Routing for these domains, changing their MX and SPF records."
                        : "Delete the removed Durable Object data permanently."}
                </label>
                <Button
                  type="button"
                  disabled={!authorizedChanges[job.error?.code ?? ""]}
                  onClick={() => install.reset()}
                >
                  Continue with this update
                </Button>
              </>
            )}
          {job ? (
            <Button onClick={onBack}>Back to apps</Button>
          ) : (
            <>
              <form.Subscribe
                selector={(state) =>
                  [state.isSubmitting, state.values.organizationId] as const
                }
              >
                {([isSubmitting, organizationId]) => (
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={
                      isSubmitting ||
                      busy ||
                      checking ||
                      review.isPending ||
                      Boolean(
                        review.data?.providers.length &&
                          !authorizedChanges.REGISTER_PROVIDERS,
                      ) ||
                      !available ||
                      !workspaces.some(
                        (workspace) => workspace.id === organizationId,
                      ) ||
                      Boolean(availabilityError)
                    }
                    aria-busy={isSubmitting}
                  >
                    {review.data
                      ? review.data.installed
                        ? "Update"
                        : "Install"
                      : "Review release"}
                  </Button>
                )}
              </form.Subscribe>
              <Button variant="ghost" className="w-full" onClick={onBack}>
                Back to apps
              </Button>
            </>
          )}
        </form.Form>
      </form.AppForm>
    </AuthCard>
  );
}

function Refusal({ error }: { error: Error }) {
  if (
    error instanceof AppInstallError &&
    error.code === "APP_INSTALL_REAUTH_REQUIRED"
  )
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertDescription className="flex flex-col gap-2">
          <span>{error.message}</span>
          <Button
            type="button"
            onClick={async () => {
              await authClient.signOut();
              window.location.assign(
                `/sign-in?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`,
              );
            }}
          >
            Sign in again
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (error instanceof AppInstallError && error.code === "NO_RELEASE") {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertDescription className="flex min-w-0 flex-col gap-2">
          <span>
            This repository publishes no EveryApp release. Clone it and deploy
            from its checkout with the EveryApp CLI:
          </span>
          <CodeBlock code="pnpm everyapp deploy" />
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription className="whitespace-pre-line">
        {error instanceof AppInstallError
          ? error.message
          : "The install failed."}
      </AlertDescription>
    </Alert>
  );
}

function JobStatus({ job }: { job: InstallJob }) {
  if (job.status === "running") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Deploying {job.app?.id ?? "the app"}…
      </p>
    );
  }
  if (job.status === "failed") {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertDescription className="whitespace-pre-line">
          {job.error?.message ?? "The deploy failed."}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert>
      <CircleCheck />
      <AlertDescription className="flex flex-col gap-1">
        <span>{job.app?.id ?? "The app"} is installed.</span>
        {job.app?.url ? (
          <a
            href={job.app.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-foreground underline underline-offset-4"
          >
            {job.app.hostname}
            <ExternalLink className="size-3.5" />
          </a>
        ) : (
          <span>
            It has no hostname yet: this gateway has no third-party domain.
          </span>
        )}
      </AlertDescription>
    </Alert>
  );
}
