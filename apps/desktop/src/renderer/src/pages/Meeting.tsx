import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { MeetingDetail } from "@shared/contract";
import { EmptyState, ErrorState, MeetingScreen, ScreenBody, useElapsed, type LiveState, type MeetingTab } from "@every-app/desktop-ui";
import { Skeleton } from "@every-app/desktop-ui/components/skeleton";
import { copyLink, draftKey, useRun, useStartRecording, useStopRecording } from "../actions";
import { api, cleanError, keys } from "../api";
import { useJottings } from "../jottings";
import { useRecordingElapsed } from "../useRecordingElapsed";
import { meetingForView, recordingHereOf } from "../meeting-view";
import { SLOW_CONNECTION } from "../recording";
import { transcriptionNoteOf } from "../connection";
import { mergeSegments, partialOf, useLevels, useLiveTranscript } from "../live";
import { accountFrom } from "../map";
import { notify } from "../notice";
import { useAppState } from "../bridge";

const busy = (m: MeetingDetail | undefined) => m?.status === "recording" || m?.status === "processing";

export function MeetingPage({ id, tab }: { id: string; tab?: MeetingTab }) {
  const state = useAppState();
  const navigate = useNavigate();
  const run = useRun();
  const client = useQueryClient();
  const stop = useStopRecording();
  const query = useQuery({
    queryKey: keys.meeting(id),
    queryFn: () => api.meeting(id).then((r) => r.meeting),
    // While it records or its notes are written, look again every few seconds.
    refetchInterval: (q) => (busy(q.state.data) ? 4000 : false),
  });
  const folders = useQuery({ queryKey: keys.folders, queryFn: () => api.folders().then((r) => r.folders) });
  const templates = useQuery({ queryKey: keys.templates, queryFn: api.templates });
  const me = useQuery({ queryKey: keys.me, queryFn: api.me });
  const rec = state?.recording;
  const recordingHere = recordingHereOf(rec, id);
  // Cached data, or (recording here, nothing fetched yet) the recording snapshot: never an error
  // page over a notepad someone is typing in.
  const meeting = meetingForView(query.data, rec, id, state?.auth.email ?? null);
  const [jottings, setJottings] = useJottings(id, query.data?.jottings, !!query.data);
  const levels = useLevels();
  const transcript = useLiveTranscript();
  const elapsedMs = useRecordingElapsed(recordingHere ? rec : undefined);
  // Main sets `stopping`/`stoppingSince` from Stop until everything is saved; it doesn't tick.
  const stopping = recordingHere && (rec.stopping === true || rec.state === "stopping");
  const stoppingMs = useElapsed(stopping ? (rec.stoppingSince ?? null) : null);

  const [finishing, setFinishing] = useState(false);
  if (!meeting && query.isPending) return <Loading />;
  if (!meeting) {
    return (
      <ScreenBody>
        <div className="pt-6">
          <ErrorState message={cleanError(query.error)} onRetry={() => void query.refetch()} />
        </div>
      </ScreenBody>
    );
  }

  const live: LiveState | null = recordingHere
    ? {
        recording: {
          meetingId: id,
          title: meeting.title,
          startedAt: rec.startedAt ?? meeting.startsAt,
          mode: rec.mode ?? "realtime",
          mic: rec.mic ?? "ok",
          system: rec.system ?? "ok",
        },
        levels,
        partial: transcript.meetingId === id ? partialOf(transcript) : { me: "", them: "" },
        elapsedMs,
      }
    : null;
  const shown: MeetingDetail =
    recordingHere && transcript.meetingId === id
      ? { ...meeting, segments: mergeSegments(meeting.segments, transcript.segments) }
      : meeting;
  const touched = [keys.meeting(id), keys.allMeetings] as const;
  const appUrl = state?.auth.appUrl?.replace(/\/$/, "") ?? "";
  const shareUrl = (linkId: string) => `${appUrl}/s/${linkId}`;
  // The meeting's page in the web app, which signs the reader in and checks they may read it.
  const teamUrl = appUrl ? `${appUrl}/meetings/${id}` : undefined;

  return (
    <MeetingScreen
      key={id}
      // The tab lives in the URL, so ?tab=… (a search result) switches it on this page too.
      tab={tab ?? "notes"}
      onTabChange={(next) =>
        void navigate({ to: "/meetings/$id", params: { id }, search: next === "notes" ? {} : { tab: next }, replace: true })
      }
      meeting={shown}
      phase={recordingHere ? "during" : "after"}
      jottings={jottings}
      onJottingsChange={setJottings}
      live={live}
      warning={recordingHere && rec.warning ? SLOW_CONNECTION : null}
      warningDetail={recordingHere ? rec.warning : null}
      transcription={recordingHere ? transcriptionNoteOf(state) : null}
      stopping={stopping}
      stoppingMs={stopping ? stoppingMs : undefined}
      folders={folders.data ?? []}
      templates={templates.data?.templates ?? []}
      orgName={accountFrom(me.data, state?.auth)?.orgName ?? "Team"}
      onStop={() => void stop()}
      onRetitle={(title) => void run(() => api.patchMeeting(id, { title }), "Couldn't rename it.", touched)}
      onSaveNotes={(markdown) => void run(() => api.editNotes(id, markdown), "Couldn't save the notes.", touched)}
      onFinish={
        meeting.mine && meeting.status === "recording" && !recordingHere
          ? () => {
              setFinishing(true);
              void run(() => api.finishMeeting(id), "Couldn't finish it.", touched).finally(() => setFinishing(false));
            }
          : undefined
      }
      finishing={finishing}
      onRetryNotes={() =>
        void run(() => api.patchMeeting(id, { templateId: meeting.template.id || null }), "Couldn't start the notes again.", touched)
      }
      onChangeTemplate={(templateId) =>
        void run(async () => {
          const { rewriting } = await api.patchMeeting(id, { templateId });
          if (rewriting) notify("Rewriting the notes…");
        }, "Couldn't change the template.", touched)
      }
      onToggleFolder={(folderId, filed) =>
        void run(async () => {
          if (!filed) return api.unfileMeeting(folderId, id);
          const { shared } = await api.fileMeeting(folderId, id);
          if (shared) notify("Shared with the team.");
        }, "Couldn't change the folder.", [...touched, keys.folders])
      }
      onSetVisibility={(visibility) => void run(() => api.patchMeeting(id, { visibility }), "Couldn't change who sees it.", touched)}
      onCreateShareLink={() =>
        void run(async () => {
          const { link } = await api.createShareLink(id);
          const copied = await copyLink(link.url);
          notify(copied ? "Link made and copied." : "Link made. Copy it from the box above.");
        }, "Couldn't make a link.", touched)
      }
      onRevokeShareLink={(linkId) => void run(() => api.revokeShareLink(id, linkId), "Couldn't turn off the link.", touched)}
      onCopyShareLink={(linkId) =>
        void copyLink(shareUrl(linkId)).then((copied) =>
          copied ? notify("Link copied.") : notify("Couldn't copy the link.", "error"),
        )
      }
      onDelete={
        // Not while this Mac is recording it: stop first.
        meeting.mine && !recordingHere
          ? async () => {
              try {
                await api.deleteMeeting(id);
              } catch (error) {
                throw new Error(`Couldn't delete it. ${cleanError(error)}`.trim());
              }
              // Home first, so this page isn't still asking for a meeting that's gone.
              await navigate({ to: "/", replace: true });
              client.removeQueries({ queryKey: keys.meeting(id) });
              void client.invalidateQueries({ queryKey: keys.allMeetings });
              void client.invalidateQueries({ queryKey: keys.folders });
              notify("Meeting deleted.");
            }
          : undefined
      }
      shareUrl={shareUrl}
      teamUrl={teamUrl}
      onCopyTeamLink={async () => {
        const copied = teamUrl ? await copyLink(teamUrl) : false;
        if (!copied) notify("Couldn't copy the link.", "error");
        return copied;
      }}
    />
  );
}

function Loading() {
  return (
    <ScreenBody>
      <div aria-busy className="flex flex-col gap-4 pt-6">
        <Skeleton className="h-8 w-2/3" />
        <div className="flex gap-2">
          <Skeleton className="h-7 w-32 rounded-full" />
          <Skeleton className="h-7 w-28 rounded-full" />
        </div>
        <Skeleton className="mt-6 h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    </ScreenBody>
  );
}

/** A calendar event before its call: a notepad for the agenda, and Start recording. */
export function UpcomingPage({ eventId }: { eventId: string }) {
  const state = useAppState();
  const start = useStartRecording();
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey(eventId, state?.auth.appUrl)) ?? "");
  const event = state?.calendar.events.find((e) => e.id === eventId);
  if (!state) return <Loading />;
  if (!event) {
    return (
      <ScreenBody>
        <EmptyState title="This event isn't on your calendar anymore" className="mt-6">
          It may have moved or been cancelled.
        </EmptyState>
      </ScreenBody>
    );
  }
  const attendees = event.attendees.map((a) => ({ email: a.email ?? null, name: a.name ?? null, self: a.self ?? false }));
  const pseudo: MeetingDetail = {
    id: `event:${event.id}`,
    title: event.title,
    startsAt: event.start,
    endsAt: event.end ?? null,
    status: "recording",
    visibility: "private",
    ownerUserId: "",
    ownerEmail: state.auth.email ?? null,
    attendeeCount: attendees.length,
    mine: true,
    attendees,
    folders: [],
    template: { id: "", name: "Default template", chosen: false },
    segments: [],
    notes: null,
    jottings: null,
    shareLinks: [],
  };
  return (
    <MeetingScreen
      meeting={pseudo}
      phase="before"
      jottings={draft}
      onJottingsChange={(text) => {
        setDraft(text);
        localStorage.setItem(draftKey(eventId, state?.auth.appUrl), text);
      }}
      folders={[]}
      templates={[]}
      orgName={state.auth.orgName ?? "Team"}
      onStart={() =>
        void start({ calendarEventId: event.id, join: !!event.conferenceUrl }, draft).then((started) => {
          if (started) localStorage.removeItem(draftKey(eventId, state?.auth.appUrl));
        })
      }
    />
  );
}

