import { cn } from "cn";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  Copy,
  Folder as FolderIcon,
  LayoutTemplate,
  Link2,
  MoreHorizontal,
  Pencil,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Markdown } from "../components/Markdown";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../components/ui/popover";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { shortDate, timeOfDay } from "../lib/dates";
import type {
  Folder,
  Levels,
  LiveRecording,
  MeetingDetail,
  PartialTranscript,
  Space,
  Template,
} from "../types";
import { Notepad } from "./Notepad";
import { ErrorState, SCREEN_GUTTER, ownerLabel } from "./parts";
import { Elapsed, RecordDot, RecorderBar } from "./recording";
import { Transcript } from "./Transcript";

/** "own_server_down": the person's own transcription server isn't answering. */
export type TranscriptionNote =
  | "reconnecting"
  | "catching_up"
  | "own_server_down";

/** What the live view says about transcription. */
export const transcriptionText: Record<TranscriptionNote, string> = {
  reconnecting: "Reconnecting to transcription…",
  catching_up: "Catching up on the transcript…",
  own_server_down:
    "Your transcription server isn't answering. Audio is kept for up to 5 minutes.",
};

/** While a Stop finishes saving (after an outage it can take minutes). */
export const FINISHING_TEXT = "Finishing the transcript…";

export type MeetingPhase = "before" | "during" | "after";
export type MeetingTab = "notes" | "jottings" | "transcript";

export interface LiveState {
  recording: LiveRecording;
  levels: Levels;
  partial: PartialTranscript;
  elapsedMs: number;
}

export interface MeetingScreenProps {
  meeting: MeetingDetail;
  /** before: not recording yet; during: this window is recording it; after: ended. */
  phase: MeetingPhase;
  /** The notepad text (controlled; the caller saves it). */
  jottings: string;
  onJottingsChange: (markdown: string) => void;
  live?: LiveState | null;
  /** A quiet note above the controls while recording (e.g. the connection fell behind). */
  warning?: string | null;
  /** The helper's own words for the warning, shown on hover. */
  warningDetail?: string | null;
  /**
   * Live transcription's state: "reconnecting" (it can't be reached; the audio is kept) or
   * "catching_up" (that audio is being transcribed and lands in place). Null when live.
   */
  transcription?: TranscriptionNote | null;
  /** Stop was pressed and the recording is finishing (a long outage's replay can take a while). */
  stopping?: boolean;
  /** How long it's been finishing; shown once it's more than a few seconds. */
  stoppingMs?: number;
  folders: Folder[];
  templates: Template[];
  orgName: string;
  onRetitle?: (title: string) => void;
  onStart?: () => void;
  onStop?: () => void;
  onSaveNotes?: (markdown: string) => void;
  onRetryNotes?: () => void;
  /**
   * The meeting says "recording" but this Mac isn't recording it (another device, or a recording
   * that stopped without finishing). Given for the owner: offers to finish it and write notes.
   */
  onFinish?: () => void;
  finishing?: boolean;
  onChangeTemplate?: (templateId: string) => void;
  onToggleFolder?: (folderId: string, filed: boolean) => void;
  onSetVisibility?: (visibility: Space) => void;
  onCreateShareLink?: () => void;
  onRevokeShareLink?: (linkId: string) => void;
  onCopyShareLink?: (linkId: string) => void;
  /** The public URL for a share link id. */
  shareUrl?: (linkId: string) => string;
  /**
   * The meeting's page in the web app: the link for teammates. It opens only for a signed-in
   * member, and only while the meeting is shared with the team, so it is offered only then.
   */
  teamUrl?: string;
  /** Copies `teamUrl`; resolves false when the clipboard refused. */
  onCopyTeamLink?: () => boolean | void | Promise<boolean | void>;
  /**
   * Deletes the meeting for good, after the owner confirms. Offered for the owner's meetings
   * unless this window is recording it (stop first). The caller leaves the page when it resolves;
   * when it rejects, the error's message is shown in the dialog, which stays open.
   */
  onDelete?: () => Promise<void>;
  /** Uncontrolled starting values, mostly for the playground. */
  defaultTab?: MeetingTab;
  /**
   * The open tab, when the caller keeps it (the app keeps it in the URL, so a link to
   * ?tab=jottings switches tabs even on the meeting already open). With `onTabChange`.
   */
  tab?: MeetingTab;
  onTabChange?: (tab: MeetingTab) => void;
  defaultTranscriptOpen?: boolean;
  defaultShareOpen?: boolean;
  defaultEditing?: boolean;
}

const chip =
  "inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-transparent px-2.5 text-[12px] text-foreground/75 transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:pointer-events-none data-popup-open:bg-foreground/[0.05] [&_svg]:size-3.5 [&_svg]:text-foreground/50";

export function MeetingScreen(props: MeetingScreenProps) {
  const { meeting, phase } = props;
  const [transcriptOpen, setTranscriptOpen] = useState(
    props.defaultTranscriptOpen ?? false,
  );
  const drawer = phase === "during" && transcriptOpen;
  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="@container min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto flex max-w-[720px] flex-col gap-5 pb-32 pt-4",
            SCREEN_GUTTER,
          )}
        >
          <Header {...props} />
          {phase === "after" ? (
            <AfterBody {...props} />
          ) : (
            <Notepad
              value={props.jottings}
              onChange={props.onJottingsChange}
              autoFocus={phase === "during"}
              label="Your notes"
              placeholder={
                phase === "before"
                  ? "Jot down an agenda or questions to ask…"
                  : "Write notes as you go. Scribe fills in the rest from the transcript."
              }
              className="min-h-[50vh] pt-1"
            />
          )}
        </div>
      </div>
      {drawer && props.live && (
        <TranscriptDrawer
          live={props.live}
          meeting={meeting}
          note={props.transcription ?? null}
          onClose={() => setTranscriptOpen(false)}
        />
      )}
      {phase !== "after" && (
        <ControlBar
          {...props}
          transcriptOpen={transcriptOpen}
          onToggleTranscript={() => setTranscriptOpen(!transcriptOpen)}
          drawerOpen={drawer}
        />
      )}
    </div>
  );
}

function Header(props: MeetingScreenProps) {
  const { meeting, phase } = props;
  return (
    <header className="flex flex-col gap-3 pt-4">
      <div className="flex items-start justify-between gap-4">
        <Title meeting={meeting} onRetitle={props.onRetitle} />
        {phase === "after" && (
          <div className="flex shrink-0 items-center gap-2 pt-1.5">
            {meeting.mine ? (
              <>
                <SharePopover {...props} />
                {props.onDelete && (
                  <MeetingMenu meeting={meeting} onDelete={props.onDelete} />
                )}
              </>
            ) : (
              <span className="text-[12px] text-muted-foreground">
                Shared by {ownerLabel(meeting)}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <DateChip meeting={meeting} />
        <FolderChip {...props} />
        <TemplateChip {...props} />
        {meeting.visibility === "team" && (
          <span className={cn(chip, "hover:bg-transparent")}>
            <Users />
            {props.orgName}
          </span>
        )}
      </div>
    </header>
  );
}

function Title({
  meeting,
  onRetitle,
}: {
  meeting: MeetingDetail;
  onRetitle?: (title: string) => void;
}) {
  const [title, setTitle] = useState(meeting.title);
  useEffect(() => setTitle(meeting.title), [meeting.title]);
  const className =
    "w-full min-w-0 truncate bg-transparent text-[26px] font-semibold tracking-[-0.02em] outline-none";
  if (!meeting.mine || !onRetitle) {
    return <h1 className={className}>{meeting.title}</h1>;
  }
  const save = () => {
    const next = title.trim();
    if (!next || next === meeting.title) return setTitle(meeting.title);
    onRetitle(next);
  };
  return (
    <input
      data-slot="title-input"
      aria-label="Title"
      className={cn(className, "rounded-md")}
      value={title}
      maxLength={255}
      onChange={(event) => setTitle(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setTitle(meeting.title);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function DateChip({ meeting }: { meeting: MeetingDetail }) {
  const guests = meeting.attendees;
  const when = (
    <>
      <CalendarDays />
      {shortDate(meeting.startsAt)}, {timeOfDay(meeting.startsAt)}
      {guests.length > 0 && (
        <>
          <span className="text-foreground/25">·</span>
          <Users />
          {guests.length}
        </>
      )}
    </>
  );
  if (guests.length === 0) return <span className={chip}>{when}</span>;
  return (
    <Popover>
      <PopoverTrigger className={chip}>{when}</PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <PopoverTitle>Guests</PopoverTitle>
        <ul className="mt-2 space-y-1.5 text-[13px]">
          {guests.map((guest, i) => (
            <li key={i} className="truncate">
              {guest.name ?? guest.email ?? "Guest"}
              {guest.name && guest.email && (
                <span className="text-muted-foreground"> · {guest.email}</span>
              )}
              {guest.self && (
                <span className="text-muted-foreground"> (you)</span>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function FolderChip({
  meeting,
  folders,
  orgName,
  onToggleFolder,
}: MeetingScreenProps) {
  const filed = new Set(meeting.folders.map((folder) => folder.id));
  const first = meeting.folders[0];
  const label = !first
    ? "Add to folder"
    : meeting.folders.length === 1
      ? first.name
      : `${first.name} +${meeting.folders.length - 1}`;
  if (!onToggleFolder) {
    return first ? (
      <span className={chip}>
        <FolderIcon />
        {label}
      </span>
    ) : null;
  }
  const groups = [
    { label: "My notes", items: folders.filter((f) => f.space === "private") },
    { label: orgName, items: folders.filter((f) => f.space === "team") },
  ].filter((group) => group.items.length > 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chip}>
        <FolderIcon />
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {groups.length === 0 && (
          <p className="px-2 py-1.5 text-[13px] text-muted-foreground">
            No folders yet. Make one with New folder in the sidebar.
          </p>
        )}
        {groups.map((group, i) => (
          <DropdownMenuGroup key={group.label}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
            {group.items.map((folder) => (
              <DropdownMenuCheckboxItem
                key={folder.id}
                checked={filed.has(folder.id)}
                onCheckedChange={(checked) =>
                  onToggleFolder(folder.id, checked)
                }
              >
                {folder.name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TemplateChip({
  meeting,
  phase,
  templates,
  onChangeTemplate,
}: MeetingScreenProps) {
  const content = (
    <>
      <LayoutTemplate />
      {meeting.template.name}
    </>
  );
  if (!meeting.mine || !onChangeTemplate || meeting.status === "processing") {
    return <span className={chip}>{content}</span>;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chip}>{content}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {phase === "after"
              ? "Rewrite the notes with"
              : "Write the notes with"}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={meeting.template.id}
            onValueChange={(id: string) => onChangeTemplate(id)}
          >
            {templates.map((template) => (
              <DropdownMenuRadioItem key={template.id} value={template.id}>
                {template.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SharePopover({
  meeting,
  orgName,
  onSetVisibility,
  onCreateShareLink,
  onRevokeShareLink,
  onCopyShareLink,
  shareUrl,
  teamUrl,
  onCopyTeamLink,
  defaultShareOpen,
}: MeetingScreenProps) {
  const link = meeting.shareLinks[0];
  const team = meeting.visibility === "team";
  const shared = team || Boolean(link);
  return (
    <Popover defaultOpen={defaultShareOpen}>
      <PopoverTrigger
        render={<Button variant={shared ? "outline" : "default"} size="sm" />}
      >
        {shared ? <Users /> : <Link2 />}
        {shared ? "Shared" : "Share"}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 p-0">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="flex size-8 items-center justify-center rounded-full bg-muted">
            <Users className="size-4 text-foreground/60" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">{orgName}</span>
            <span className="block text-[12px] text-muted-foreground">
              {team ? "Everyone on the team can read it" : "Only you"}
            </span>
          </span>
          <Switch
            aria-label="Share with the team"
            checked={team}
            onCheckedChange={(checked) =>
              onSetVisibility?.(checked ? "team" : "private")
            }
          />
        </div>
        {team && teamUrl && (
          <div className="px-4 pb-3">
            <div className="flex items-center gap-1.5">
              <input
                readOnly
                aria-label="Team link"
                data-slot="share-url"
                value={teamUrl}
                onFocus={(event) => event.currentTarget.select()}
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-muted/60 px-2 text-[12px] text-foreground/80 outline-none"
              />
              <CopyTeamLink onCopy={onCopyTeamLink} />
            </div>
            <p className="mt-1.5 text-[12px] text-muted-foreground">
              Only signed-in members of {orgName} can open this link. They see
              the notes and the transcript.
            </p>
          </div>
        )}
        <div className="border-t border-border px-4 py-3">
          <PopoverTitle className="text-[13px] font-medium">
            Public link
          </PopoverTitle>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Anyone with this link can read the notes and the transcript, without
            signing in.
          </p>
          {link ? (
            <div className="mt-2.5 flex items-center gap-1.5">
              <input
                readOnly
                aria-label="Public link"
                data-slot="share-url"
                value={shareUrl?.(link.id) ?? link.id}
                onFocus={(event) => event.currentTarget.select()}
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-muted/60 px-2 text-[12px] text-foreground/80 outline-none"
              />
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Copy link"
                onClick={() => onCopyShareLink?.(link.id)}
              >
                <Copy />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Turn off the link"
                onClick={() => onRevokeShareLink?.(link.id)}
              >
                <X />
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="mt-2.5"
              onClick={onCreateShareLink}
            >
              <Link2 />
              Create link
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The "…" menu beside Share: delete, behind a confirmation. Same words as Scribe's web app. */
function MeetingMenu({
  meeting,
  onDelete,
}: {
  meeting: MeetingDetail;
  onDelete: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="More actions" />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
          >
            Delete meeting
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!deleting) setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{meeting.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The notes, transcript and public links go too. This can't be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              pending={deleting}
              onClick={async () => {
                setDeleting(true);
                setError(null);
                try {
                  await onDelete();
                } catch (cause) {
                  setError(
                    cause instanceof Error && cause.message
                      ? cause.message
                      : "Couldn't delete it.",
                  );
                } finally {
                  setDeleting(false);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** "Copy link" for the team link; says "Copied" for a moment once the clipboard has it. */
function CopyTeamLink({ onCopy }: { onCopy: MeetingScreenProps["onCopyTeamLink"] }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 shrink-0"
      onClick={async () => {
        const ok = await onCopy?.();
        if (ok !== false) setCopied(true);
      }}
    >
      {copied ? <Check /> : <Copy />}
      <span aria-live="polite">{copied ? "Copied" : "Copy link"}</span>
    </Button>
  );
}

const tabs: { id: MeetingTab; label: string }[] = [
  { id: "notes", label: "Notes" },
  { id: "jottings", label: "Your jottings" },
  { id: "transcript", label: "Transcript" },
];

function AfterBody(props: MeetingScreenProps) {
  const { meeting } = props;
  const [ownTab, setOwnTab] = useState<MeetingTab>(props.defaultTab ?? "notes");
  const controlled = props.tab !== undefined && !!props.onTabChange;
  const setTab = (next: MeetingTab) =>
    controlled ? props.onTabChange!(next) : setOwnTab(next);
  const shown = meeting.mine ? tabs : tabs.filter((t) => t.id !== "jottings");
  const asked = controlled ? props.tab! : ownTab;
  // Someone else's meeting has no jottings tab: a link to it opens Notes.
  const tab = shown.some((t) => t.id === asked) ? asked : "notes";
  return (
    <div className="flex flex-col gap-5">
      <div
        role="tablist"
        aria-label="Meeting views"
        className="flex gap-4 border-b border-border"
      >
        {shown.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px border-b-[1.5px] pb-2 pt-1 text-[13px] transition-colors focus-visible:outline-none",
              tab === t.id
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={shown.find((t) => t.id === tab)?.label}>
        {tab === "notes" && <NotesPanel {...props} />}
        {tab === "jottings" && (
          <Notepad
            value={props.jottings}
            onChange={props.onJottingsChange}
            label="Your jottings"
            placeholder="You didn't jot anything down during this meeting."
          />
        )}
        {tab === "transcript" && (
          <Transcript segments={meeting.segments} speakers={meeting.speakers} />
        )}
      </div>
    </div>
  );
}

function NotesPanel({
  meeting,
  onSaveNotes,
  onRetryNotes,
  onFinish,
  finishing,
  defaultEditing,
}: MeetingScreenProps) {
  const [draft, setDraft] = useState<string | null>(
    defaultEditing ? (meeting.notes?.markdown ?? "") : null,
  );
  if (meeting.status === "recording") {
    return (
      <StillRecording
        meeting={meeting}
        onFinish={onFinish}
        finishing={finishing}
      />
    );
  }
  if (meeting.status === "processing") {
    return (
      <div aria-busy className="flex flex-col gap-3">
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <span className="record-pulse size-1.5 rounded-full bg-foreground/40" />
          {meeting.notes
            ? "Rewriting the notes…"
            : "Writing your notes from your jottings and the transcript…"}
        </p>
        <Skeleton className="mt-2 h-4 w-32" />
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="mt-3 h-4 w-28" />
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    );
  }
  if (!meeting.notes) {
    return meeting.status === "failed" ? (
      <ErrorState
        message="The notes couldn't be written."
        onRetry={onRetryNotes}
      />
    ) : (
      <p className="text-[13px] text-muted-foreground">No notes yet.</p>
    );
  }
  const notes = meeting.notes;
  return (
    <div className="flex flex-col gap-4">
      {meeting.status === "failed" && (
        <ErrorState
          message={`The notes couldn't be rewritten. These are the earlier ones, written with ${meeting.template.name}.`}
          onRetry={onRetryNotes}
        />
      )}
      {draft === null ? (
        <div className="group relative">
          {meeting.mine && onSaveNotes && (
            <Button
              variant="ghost"
              size="sm"
              className="reveal-on-hover absolute -top-1 right-0"
              onClick={() => setDraft(notes.markdown)}
            >
              <Pencil />
              Edit
            </Button>
          )}
          <article data-selectable className="text-[15px] leading-[1.7]">
            <Markdown text={notes.markdown} />
          </article>
          {notes.editedAt && (
            <p className="mt-6 text-[12px] text-muted-foreground">Edited</p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-border bg-card px-4 py-3 shadow-xs">
            <Notepad
              value={draft}
              onChange={setDraft}
              autoFocus
              label="Edit notes"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                onSaveNotes?.(draft);
                setDraft(null);
              }}
            >
              <Check />
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The bar before the recording's first snapshot arrives: no title, both channels fine. */
const NOT_LIVE: LiveRecording = {
  meetingId: "",
  title: "",
  startedAt: "",
  mode: "realtime",
  mic: "ok",
  system: "ok",
};

function ControlBar({
  phase,
  live,
  onStart,
  onStop,
  transcriptOpen,
  onToggleTranscript,
  drawerOpen,
  warning,
  warningDetail,
  transcription,
  stopping,
  stoppingMs,
}: MeetingScreenProps & {
  transcriptOpen: boolean;
  onToggleTranscript: () => void;
  drawerOpen: boolean;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-5 flex flex-col items-center gap-2",
        drawerOpen && "right-[340px]",
      )}
    >
      {phase === "during" && (stopping || (transcription && !drawerOpen)) && (
        <p
          role="status"
          className="animate-in fade-in-0 pointer-events-auto flex items-center gap-1.5 rounded-full bg-background/85 px-3 py-1 text-[12px] text-muted-foreground backdrop-blur"
        >
          <span className="record-pulse size-1.5 rounded-full bg-foreground/40" />
          {stopping ? (
            <>
              {transcription === "catching_up"
                ? transcriptionText.catching_up
                : FINISHING_TEXT}
              {stoppingMs !== undefined && stoppingMs >= 5_000 && (
                <span className="tabular-nums opacity-70">
                  {" "}
                  · <Elapsed ms={stoppingMs} />
                </span>
              )}
            </>
          ) : (
            transcriptionText[transcription!]
          )}
        </p>
      )}
      {phase === "during" && warning && (
        <p
          role="status"
          title={warningDetail ?? undefined}
          className="animate-in fade-in-0 pointer-events-auto flex items-center gap-1.5 rounded-full bg-background/85 px-3 py-1 text-[12px] text-muted-foreground backdrop-blur"
        >
          <AlertTriangle className="size-3.5 text-warning" />
          {warning}
        </p>
      )}
      {phase === "before" ? (
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-popover/90 p-1 shadow-[0_6px_24px_-8px_rgb(0_0_0/0.18),0_1px_2px_rgb(0_0_0/0.06)] backdrop-blur-xl">
          <span className="px-3 text-[12px] text-muted-foreground">
            Not recording
          </span>
          <Button
            size="sm"
            className="h-8 rounded-full px-3.5"
            onClick={onStart}
          >
            <span className="size-2 rounded-full bg-record" />
            Start recording
          </Button>
        </div>
      ) : (
        <RecorderBar
          recording={live?.recording ?? NOT_LIVE}
          levels={live?.levels ?? { mic: 0, system: 0 }}
          elapsedMs={live?.elapsedMs ?? 0}
          stopping={stopping}
          onStop={onStop}
          transcriptOpen={transcriptOpen}
          onTranscript={onToggleTranscript}
        />
      )}
    </div>
  );
}

function TranscriptDrawer({
  live,
  meeting,
  note,
  onClose,
}: {
  live: LiveState;
  meeting: MeetingDetail;
  note: TranscriptionNote | null;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Live transcript"
      className="animate-in slide-in-from-right-4 fade-in-0 flex w-[340px] shrink-0 flex-col border-l border-border bg-background duration-200"
    >
      <div className="flex h-11 shrink-0 items-center justify-between px-4">
        <h2 className="text-[13px] font-medium">Live transcript</h2>
        <span className="flex items-center gap-2">
          {live.recording.mode === "fallback" && (
            <span
              className="text-[11px] text-muted-foreground"
              title="Live transcription dropped; Scribe is transcribing in chunks."
            >
              Delayed
            </span>
          )}
          {live.recording.mode === "custom" && (
            <span
              className="text-[11px] text-muted-foreground"
              title="Your own server is transcribing this meeting, 20 to 30 seconds at a time. The audio goes nowhere else."
            >
              Your server
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close transcript"
            onClick={onClose}
          >
            <X />
          </Button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-1">
        <Transcript
          segments={meeting.segments}
          speakers={meeting.speakers}
          partial={live.partial}
          follow
          emptyText="Listening… what's said shows up here."
        />
        {note && (
          <p
            role="status"
            className="mt-4 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-[12px] text-muted-foreground"
          >
            <span className="record-pulse size-1.5 shrink-0 rounded-full bg-foreground/40" />
            {transcriptionText[note]}
          </p>
        )}
      </div>
    </aside>
  );
}

/** A meeting marked "recording" that this window isn't recording. */
function StillRecording({
  meeting,
  onFinish,
  finishing,
}: {
  meeting: MeetingDetail;
  onFinish?: () => void;
  finishing?: boolean;
}) {
  if (!meeting.mine || !onFinish) {
    return (
      <div
        role="status"
        className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3.5"
      >
        <RecordDot className="mt-1.5" />
        <div className="text-[13px]">
          <p className="font-medium">Recording in progress</p>
          <p className="mt-0.5 text-muted-foreground">
            {meeting.mine
              ? "Scribe is recording this meeting. The notes are written when it ends."
              : `${ownerLabel(meeting)} is recording this meeting. The notes are written when it ends.`}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="flex flex-wrap items-start gap-3 rounded-xl border border-border bg-card px-4 py-3.5"
    >
      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-foreground/25" />
      <div className="min-w-0 flex-1 text-[13px]">
        <p className="font-medium">
          This meeting was still recording when it stopped
        </p>
        <p className="mt-0.5 text-muted-foreground">
          Finish it to write notes from{" "}
          {meeting.segments.length > 0
            ? "what was transcribed"
            : "your jottings"}
          . If it's still recording on another Mac, stop it there instead.
        </p>
      </div>
      <Button size="sm" onClick={onFinish} pending={finishing}>
        Finish and write notes
      </Button>
    </div>
  );
}
