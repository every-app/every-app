import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { HomeScreen } from "@every-app/desktop-ui";
import { useStartRecording } from "../actions";
import { api, keys } from "../api";
import { comingUpFrom, loadable } from "../map";
import { bridge, useAppState } from "../bridge";

/** Start right away from this long before an event; earlier, open its notepad first. */
const SOON_MS = 10 * 60_000;

export function HomePage() {
  const state = useAppState();
  const navigate = useNavigate();
  const client = useQueryClient();
  const start = useStartRecording();
  const recent = useQuery({ queryKey: keys.meetings({ limit: 40 }), queryFn: () => api.meetings({ limit: 40 }) });
  const rec = state?.recording;
  return (
    <HomeScreen
      comingUp={comingUpFrom(state?.calendar, rec?.calendarEventId, rec?.meetingId)}
      recent={loadable(recent, (r) => r.meetings)}
      onOpenMeeting={(id) => void navigate({ to: "/meetings/$id", params: { id } })}
      onTakeNotes={(event, { join }) => {
        const soon = new Date(event.start).getTime() - Date.now() <= SOON_MS;
        if (soon) void start({ calendarEventId: event.id, join });
        else void navigate({ to: "/upcoming/$eventId", params: { eventId: event.id } });
      }}
      onConnectCalendar={() => void bridge["calendar:connect"]()}
      onNewNote={() => void start({})}
      onRetry={() => {
        void bridge["calendar:refresh"]();
        void client.invalidateQueries({ queryKey: keys.allMeetings });
      }}
    />
  );
}
