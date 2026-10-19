import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { revalidateLogic } from "@tanstack/react-form";
import { CircleAlert, CircleCheck, ExternalLink } from "lucide-react";
import { z } from "zod";
import {
  AppInstallError,
  fetchInstallJob,
  startAppInstall,
  type InstallJob,
} from "@/client/app-install";
import { CodeBlock } from "@/client/components/CodeBlock";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import { Spinner } from "@/client/components/ui/spinner";
import { adminAppsCollection } from "@/client/tanstack-db";

const POLL_MS = 2_000;

const installSchema = z.object({
  repoUrl: z
    .string()
    .trim()
    .regex(
      /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/,
      "Paste a repository URL: https://github.com/<owner>/<repo>.",
    ),
});

interface InstallFromGitHubModalProps {
  onClose: () => void;
}

/**
 * Install an app from a GitHub repository's latest everyapp release:
 * the URL, then the deploy job until it finishes. Render it only while it
 * is open.
 */
export function InstallFromGitHubModal({
  onClose,
}: InstallFromGitHubModalProps) {
  const [refusal, setRefusal] = useState<AppInstallError | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const install = useMutation({
    mutationFn: (repoUrl: string) => startAppInstall(repoUrl),
    onSuccess: (job) => {
      setJobId(job.id);
      void adminAppsCollection.utils.refetch();
    },
    onError: (error) => {
      setRefusal(
        error instanceof AppInstallError
          ? error
          : new AppInstallError("INTERNAL_ERROR", "The install failed."),
      );
    },
  });

  // The install answers once the deploy finished or 20 seconds passed;
  // a running job is polled until it finishes.
  const { data: polled } = useQuery({
    queryKey: ["admin", "deploys", jobId],
    queryFn: () => fetchInstallJob(jobId!),
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

  const form = useAppForm({
    defaultValues: { repoUrl: "" },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: installSchema },
    // The mutation's onError shows a failure, so the rejection is not handled
    // here.
    onSubmit: ({ value }) => {
      setRefusal(null);
      return install.mutateAsync(value.repoUrl.trim());
    },
  });

  const busy = install.isPending || job?.status === "running";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !install.isPending) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="grid-cols-1 sm:max-w-md"
      >
        {job ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Install from GitHub</DialogTitle>
              <DialogDescription>
                {job.source
                  ? `${job.source.repoUrl.replace("https://github.com/", "")}, release ${job.source.tag ?? job.source.version}`
                  : "The deploy"}
              </DialogDescription>
            </DialogHeader>
            <JobStatus job={job} />
            <DialogFooter>
              <Button onClick={onClose}>
                {job.status === "running" ? "Close (it keeps going)" : "Done"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form.AppForm>
            <form.Form className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle>Install from GitHub</DialogTitle>
                <DialogDescription>
                  Deploys the latest release of a repository that publishes an
                  everyapp release, as an app of this organization.
                </DialogDescription>
              </DialogHeader>
              <form.AppField name="repoUrl">
                {(field) => (
                  <field.TextField
                    label="Repository URL"
                    placeholder="https://github.com/owner/repo"
                    autoComplete="off"
                    required
                    autoFocus
                    disabled={busy}
                  />
                )}
              </form.AppField>
              {install.isPending ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner /> Downloading the release and deploying it…
                </p>
              ) : null}
              {refusal ? <Refusal error={refusal} /> : null}
              <DialogFooter>
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <form.SubmitButton>Install</form.SubmitButton>
              </DialogFooter>
            </form.Form>
          </form.AppForm>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Refusal({ error }: { error: AppInstallError }) {
  if (error.code === "NO_RELEASE") {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertDescription className="flex min-w-0 flex-col gap-2">
          <span>
            This repository publishes no everyapp release. Clone it and deploy
            it with a deploy key (Admin → Tokens → Deploy key):
          </span>
          <CodeBlock code="EVERYAPP_DEPLOY_TOKEN=<deploy key> EVERYAPP_GATEWAY_URL=<this gateway> pnpm everyapp deploy" />
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription className="whitespace-pre-line">
        {error.message}
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
