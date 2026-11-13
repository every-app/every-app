import { cn } from "cn";
import { CalendarDays, NotebookPen, Users, Video } from "lucide-react";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { dayLabel, groupByDay, timeOfDay } from "../lib/dates";
import type { CalendarEvent, ComingUp, Loadable, MeetingRow } from "../types";
import {
  EmptyState,
  ErrorState,
  LoadingRows,
  MeetingList,
  ScreenBody,
  SectionLabel,
} from "./parts";

/** "Join & take notes" from this long before a meeting until it ends. */
const SOON_MS = 10 * 60_000;
const DAYS_SHOWN = 3;

export interface HomeScreenProps {
  comingUp: Loadable<ComingUp>;
  recent: Loadable<MeetingRow[]>;
  onTakeNotes: (event: CalendarEvent, options: { join: boolean }) => void;
  onOpenMeeting: (id: string) => void;
  onConnectCalendar?: () => void;
  onNewNote?: () => void;
  onRetry?: () => void;
  /** Fixed "now" for stable rendering in tests and the playground. */
  now?: Date;
}

export function HomeScreen(props: HomeScreenProps) {
  return (
    <ScreenBody className="gap-10">
      <section>
        <SectionLabel>Coming up</SectionLabel>
        <ComingUpCard {...props} />
      </section>
      <section>
        <SectionLabel className="sr-only">Recent notes</SectionLabel>
        <Recent {...props} />
      </section>
    </ScreenBody>
  );
}

function ComingUpCard(props: HomeScreenProps) {
  const { comingUp } = props;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.03)]">
      {comingUp.status === "loading" ? (
        <div aria-busy aria-label="Loading" className="flex flex-col gap-4 p-4">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-8 w-0.5" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      ) : comingUp.status === "error" ? (
        <Message>{comingUp.message}</Message>
      ) : (
        <ComingUpBody data={comingUp.data} {...props} />
      )}
    </div>
  );
}

function ComingUpBody({
  data,
  ...props
}: HomeScreenProps & { data: ComingUp }) {
  if (data.state === "unavailable") {
    return (
      <Message>
        Google Calendar isn't set up on this workspace. An admin adds Google to
        the Every App Gateway.
      </Message>
    );
  }
  if (data.state === "disconnected") {
    return (
      <Message
        action={
          props.onConnectCalendar && (
            <Button size="sm" onClick={props.onConnectCalendar}>
              <CalendarDays />
              {data.reconnect ? "Reconnect" : "Connect"} Google Calendar
            </Button>
          )
        }
      >
        See upcoming meetings here and take notes in one click.
      </Message>
    );
  }
  if (data.state === "error") return <Message>{data.message}</Message>;
  const days = groupByDay(data.events, (event) => event.start).slice(
    0,
    DAYS_SHOWN,
  );
  if (days.length === 0) {
    return <Message>Nothing on your calendar for the next few days.</Message>;
  }
  return (
    <ol className="divide-y divide-border">
      {days.map((day) => (
        <li key={day.day} className="flex gap-4 px-4 py-3">
          <div className="w-20 shrink-0 pt-[3px] text-[12px] font-medium text-muted-foreground">
            {dayLabel(day.date, props.now)}
          </div>
          <ul className="flex min-w-0 flex-1 flex-col gap-1">
            {day.items.map((event) => (
              <EventRow key={event.id} event={event} {...props} />
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function Message({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 text-[13px] text-muted-foreground">
      <span>{children}</span>
      {action}
    </div>
  );
}

function EventRow({
  event,
  now = new Date(),
  onTakeNotes,
  onOpenMeeting,
}: HomeScreenProps & { event: CalendarEvent }) {
  const at = now.getTime();
  const start = new Date(event.start).getTime();
  const end = new Date(event.end).getTime();
  const live = at >= start && at < end;
  const soon = start - at <= SOON_MS && at < end;
  const guests = event.attendees.length;
  const join = soon && Boolean(event.conferenceUrl);
  return (
    <li className="group -mx-2 flex min-h-10 items-center gap-3 rounded-lg px-2 py-1 transition-colors hover:bg-foreground/[0.03]">
      <span
        className={cn(
          "h-7 w-[3px] shrink-0 rounded-full",
          live ? "bg-record/80" : "bg-foreground/15",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">
          {event.title}
        </span>
        <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
          {live && <span className="font-medium text-record">Now</span>}
          <span className="tabular-nums">
            {timeOfDay(event.start)} – {timeOfDay(event.end)}
          </span>
          {guests > 1 && (
            <span className="inline-flex items-center gap-1">
              <Users className="size-3" />
              {guests}
            </span>
          )}
          {event.conferenceUrl && <Video className="size-3" />}
        </span>
      </span>
      {event.meetingId ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onOpenMeeting(event.meetingId!)}
        >
          Open notes
        </Button>
      ) : (
        <Button
          variant={soon ? "default" : "outline"}
          size="sm"
          className={cn(!soon && "reveal-on-hover")}
          onClick={() => onTakeNotes(event, { join })}
        >
          {join ? "Join & take notes" : "Take notes"}
        </Button>
      )}
    </li>
  );
}

function Recent(props: HomeScreenProps) {
  const { recent } = props;
  if (recent.status === "loading") return <LoadingRows rows={5} />;
  if (recent.status === "error") {
    return <ErrorState message={recent.message} onRetry={props.onRetry} />;
  }
  if (recent.data.length === 0) {
    return (
      <EmptyState
        icon={NotebookPen}
        title="No notes yet"
        action={
          props.onNewNote && (
            <Button size="sm" variant="outline" onClick={props.onNewNote}>
              New note
            </Button>
          )
        }
      >
        Start a note from a calendar event above, or press ⌘N when a call
        begins. Every App writes the notes when it ends.
      </EmptyState>
    );
  }
  return (
    <div className="-mx-3">
      <MeetingList
        meetings={recent.data}
        onOpen={props.onOpenMeeting}
        now={props.now}
      />
    </div>
  );
}
