import { useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { revalidateLogic } from "@tanstack/react-form";
import { CircleAlert, CircleCheck, ExternalLink } from "lucide-react";
import { z } from "zod";
import {
  AppInstallError,
  fetchInstallJob,
  startAppInstall,
  useAppInstallContext,
  type InstallJob,
} from "@/client/app-install";
import { CodeBlock } from "@/client/components/CodeBlock";
import {
  AuthCard,
  authInputClassName,
} from "@/client/components/auth/AuthPageShell";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { Field, FieldLabel } from "@/client/components/ui/field";
import { Input } from "@/client/components/ui/input";
import { Spinner } from "@/client/components/ui/spinner";
import { adminAppsCollection } from "@/client/tanstack-db";
import { isAppInstallUrl, OSS_NEW_RELEASE_URL } from "@/schemas/app-install";

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

  const install = useMutation({
    mutationFn: startAppInstall,
    onSuccess: () => {
      void adminAppsCollection.utils.refetch();
    },
  });
  const jobId = install.data?.id ?? null;

  // The install answers once the deploy finished or 20 seconds passed;
  // a running job is polled until it finishes.
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
      },
    },
    onSubmit: ({ value }) => {
      if (checking || !available || availabilityError || busy || job) return;
      return install.mutateAsync({
        sourceUrl: value.sourceUrl.trim(),
        organizationId: value.organizationId,
      });
    },
  });
  useEffect(() => {
    // Set the initial destination once; later session switches cannot move it.
    if (context?.defaultOrganizationId && !form.state.values.organizationId)
      form.setFieldValue("organizationId", context.defaultOrganizationId);
  }, [context?.defaultOrganizationId, form]);

  return (
    <AuthCard title="Install app">
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
          <div aria-live="polite" className="space-y-3 empty:hidden">
            {job ? (
              <JobStatus job={job} />
            ) : install.isPending ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Downloading the release and deploying it…
              </p>
            ) : checking ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Checking this Gateway…
              </p>
            ) : availabilityError ? (
              <p role="alert" className="text-sm text-destructive">
                {availabilityError.message}
              </p>
            ) : !available ? (
              <p className="text-sm text-muted-foreground">
                Browser installation is off on this gateway. Deploy with the
                everyapp CLI instead.
              </p>
            ) : workspaces.length === 0 ? (
              <p role="alert" className="text-sm text-destructive">
                Only workspace owners and admins can install apps.
              </p>
            ) : install.error ? (
              <Refusal error={install.error} />
            ) : null}
            {pollError ? (
              <p role="alert" className="text-sm text-destructive">
                {pollError.message}
              </p>
            ) : null}
          </div>
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
                      !available ||
                      !workspaces.some(
                        (workspace) => workspace.id === organizationId,
                      ) ||
                      Boolean(availabilityError)
                    }
                    aria-busy={isSubmitting}
                  >
                    Install
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
