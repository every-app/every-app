import { Folder as FolderIcon, MoreHorizontal, Users } from "lucide-react";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import type { Folder, Loadable, MeetingRow, Template } from "../types";
import {
  EmptyState,
  ErrorState,
  LoadingRows,
  MeetingList,
  ScreenBody,
  ScreenTitle,
} from "./parts";

export interface FolderScreenProps {
  folder: Loadable<Folder>;
  meetings: Loadable<MeetingRow[]>;
  orgName: string;
  templates?: Template[];
  onOpenMeeting: (id: string) => void;
  onRename?: () => void;
  onDelete?: () => void;
  onSetDefaultTemplate?: (templateId: string | null) => void;
  onRetry?: () => void;
  now?: Date;
}

export function FolderScreen(props: FolderScreenProps) {
  const { folder } = props;
  if (folder.status === "error") {
    return (
      <ScreenBody>
        <div className="pt-6">
          <ErrorState message={folder.message} onRetry={props.onRetry} />
        </div>
      </ScreenBody>
    );
  }
  const data = folder.status === "ready" ? folder.data : null;
  const template = props.templates?.find(
    (t) => t.id === data?.defaultTemplateId,
  );
  return (
    <ScreenBody>
      <ScreenTitle
        subtitle={
          data && (
            <span className="inline-flex items-center gap-1.5">
              {data.space === "team" ? (
                <>
                  <Users className="size-3.5" />
                  Everyone in {props.orgName} sees this folder
                </>
              ) : (
                <>
                  <FolderIcon className="size-3.5" />
                  Only you see this folder
                </>
              )}
              {template && <> · Notes written with {template.name}</>}
            </span>
          )
        }
        actions={data && <FolderMenu {...props} data={data} />}
      >
        {data ? data.name : <span className="text-muted-foreground">…</span>}
      </ScreenTitle>
      <MeetingsBody
        {...props}
        empty={
          <EmptyState icon={FolderIcon} title="Nothing in this folder yet">
            Add a meeting from its page with the folder chip under the title.
          </EmptyState>
        }
      />
    </ScreenBody>
  );
}

function FolderMenu(
  props: Omit<FolderScreenProps, "folder"> & { data: Folder },
) {
  const { data: folder, templates } = props;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Folder options" />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {props.onRename && (
          <DropdownMenuItem onClick={props.onRename}>Rename…</DropdownMenuItem>
        )}
        {templates && props.onSetDefaultTemplate && (
          <DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Write notes here with</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={folder.defaultTemplateId ?? ""}
              onValueChange={(id: string) =>
                props.onSetDefaultTemplate?.(id || null)
              }
            >
              <DropdownMenuRadioItem value="">
                My default template
              </DropdownMenuRadioItem>
              {templates.map((t) => (
                <DropdownMenuRadioItem key={t.id} value={t.id}>
                  {t.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        )}
        {props.onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={props.onDelete}>
              Delete folder…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MeetingsBody({
  meetings,
  onOpenMeeting,
  onRetry,
  now,
  empty,
  showOwner,
}: {
  meetings: Loadable<MeetingRow[]>;
  onOpenMeeting: (id: string) => void;
  onRetry?: () => void;
  now?: Date;
  empty: React.ReactNode;
  showOwner?: boolean;
}) {
  if (meetings.status === "loading") return <LoadingRows rows={6} />;
  if (meetings.status === "error") {
    return <ErrorState message={meetings.message} onRetry={onRetry} />;
  }
  if (meetings.data.length === 0) return empty;
  return (
    <div className="-mx-3">
      <MeetingList
        meetings={meetings.data}
        onOpen={onOpenMeeting}
        now={now}
        showOwner={showOwner}
        grouping="flat"
      />
    </div>
  );
}

export interface SharedScreenProps {
  meetings: Loadable<MeetingRow[]>;
  orgName: string;
  onOpenMeeting: (id: string) => void;
  onRetry?: () => void;
  now?: Date;
}

/** Team meetings other people own. */
export function SharedScreen(props: SharedScreenProps) {
  return (
    <ScreenBody>
      <ScreenTitle subtitle={`Notes your teammates in ${props.orgName} shared`}>
        Shared with me
      </ScreenTitle>
      <MeetingsBody
        {...props}
        showOwner
        empty={
          <EmptyState icon={Users} title="Nothing shared yet">
            When a teammate shares a meeting with the team or files it in a team
            folder, it shows up here.
          </EmptyState>
        }
      />
    </ScreenBody>
  );
}
