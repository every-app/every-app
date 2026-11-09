import { createLazyRoute, getRouteApi } from "@tanstack/react-router";
import { MeetingPage, UpcomingPage } from "../pages/Meeting";

const meetingApi = getRouteApi("/meetings/$id");
const upcomingApi = getRouteApi("/upcoming/$eventId");

export const meetingRoute = createLazyRoute("/meetings/$id")({
  component: function Meeting() {
    return <MeetingPage id={meetingApi.useParams().id} tab={meetingApi.useSearch().tab} />;
  },
});

export const upcomingRoute = createLazyRoute("/upcoming/$eventId")({
  component: function Upcoming() {
    return <UpcomingPage eventId={upcomingApi.useParams().eventId} />;
  },
});
