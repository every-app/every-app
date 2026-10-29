import {
  AppInstallError,
  fetchInstallJob,
  reviewAppInstall,
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
import { Checkbox } from "@/client/components/ui/checkbox";
import { Field, FieldLabel } from "@/client/components/ui/field";
import { Input } from "@/client/components/ui/input";
import { Spinner } from "@/client/components/ui/spinner";
import { useSession } from "@/client/hooks/useSession";
import { signOutAndForget } from "@/client/sign-out";
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
  // The install API needs this page load's session, which the session check
  // itself may create (Cloudflare Access signs a browser in on it): ask the
  // Gateway nothing, a cached answer included, before that check answers.
  const session = useSession();
  const sessionChecked =
    session.isFetchedAfterMount && Boolean(session.data?.user);
  const {
    data: context,
    isPending: contextPending,
    error: availabilityError,
  } = useAppInstallContext(sessionChecked);
  const checking = contextPending || !sessionChecked;
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
  // Installing or installed: the release and the values it took are settled.
  // A failed install leaves them editable, to fix a value and try again.
  const locked = busy || job?.status === "succeeded";
  // A failed job that a confirmation lets continue; any other failure gets
  // Try again, the only way back to the form when nothing else is editable.
  const needsConfirmation =
    job?.status === "failed" &&
    CONFIRMABLE_FAILURES.includes(job.error?.code ?? "");
  // The refusal shown below the fields; one only a new sign-in clears blocks
  // the button until the form changes (which resets it) or the person signs
  // in again.
  const signInRequired = needsSignIn(install.error ?? review.error);
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
      sessionChecked &&
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
  }, [sessionChecked, sourceUrl, available, context?.defaultOrganizationId]);

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
                disabled
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
                  disabled={locked || checking || workspaces.length === 0}
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
                // A link's release is what is being approved: shown, not edited.
                disabled={
                  Boolean(sourceUrl) || locked || (!checking && !available)
                }
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
              {!locked &&
                review.data.fields.map((field) => (
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
                      onChange={(event) =>
                        setValues((previous) => ({
                          ...previous,
                          [field.name]: event.target.value,
                        }))
                      }
                    />
                  </Field>
                ))}
              {!locked && review.data.providers.length > 0 && (
                <Field>
                  {review.data.providers.map((provider) => (
                    <p key={provider.id} className="text-sm">
                      {provider.name}: keys go to {provider.hosts.join(", ")}.
                      Settings: {provider.settings.join(", ")}.
                    </p>
                  ))}
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
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
            ) : availabilityError && needsSignIn(availabilityError) ? (
              <Refusal error={availabilityError} />
            ) : availabilityError ? (
              <p role="alert" className="text-sm text-destructive">
                {availabilityError.message}
              </p>
            ) : !available ? (
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  This Gateway doesn't have a deployment token configured. It
                  can be added with:
                </p>
                <CodeBlock
                  code="everyapp deploy-token add"
                  successMessage="Command copied"
                />
              </div>
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
          {needsConfirmation && (
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
                className="w-full"
                disabled={!authorizedChanges[job.error?.code ?? ""]}
                onClick={() => install.reset()}
              >
                Continue with this update
              </Button>
            </>
          )}
          {job ? (
            <>
              {job.status === "failed" && !needsConfirmation && (
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => install.reset()}
                >
                  Try again
                </Button>
              )}
              <Button
                variant={job.status === "failed" ? "ghost" : "default"}
                className="w-full"
                onClick={onBack}
              >
                Back to apps
              </Button>
            </>
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
                      signInRequired ||
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

/** Failed jobs the person may continue once they confirm the change. */
const CONFIRMABLE_FAILURES = [
  "DURABLE_OBJECT_REMOVED",
  "WORKFLOW_REMOVED",
  "WORKER_CHANGED",
  "EMAIL_ROUTING_DISABLED",
];

/** The install API's refusals that only a new sign-in clears. */
enum SignInRefusal {
  /** No session, or a banned user's. */
  Missing = "APP_INSTALL_SIGN_IN_REQUIRED",
  /** A session signed in more than 10 minutes ago. */
  Stale = "APP_INSTALL_REAUTH_REQUIRED",
}

function needsSignIn(error: Error | null): boolean {
  return (
    error instanceof AppInstallError &&
    Object.values<string>(SignInRefusal).includes(error.code)
  );
}

function Refusal({ error }: { error: Error }) {
  if (needsSignIn(error))
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertDescription className="flex flex-col gap-2">
          <span>{error.message}</span>
          <Button
            type="button"
            onClick={async () => {
              // Forget the cached session too, then load this page again:
              // behind Cloudflare Access its session check signs the browser
              // back in; otherwise the root route sends it to sign in and back.
              await signOutAndForget();
              window.location.reload();
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
