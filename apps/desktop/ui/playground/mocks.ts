import type {
  Account,
  SearchResult,
  CalendarEvent,
  ComingUp,
  Folder,
  MeetingDetail,
  MeetingRow,
  Permissions,
  Segment,
  Template,
} from "../src/types";

/** Monday, November 2, 2026, 10:12 local: every mock is relative to this. */
export const NOW = new Date(2026, 10, 2, 10, 12, 0);

function at(dayOffset: number, hour: number, minute = 0): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

export const account: Account = {
  name: "Ben Senescu",
  email: "ben@every.to",
  orgName: "Every",
};

export const folders: Folder[] = [
  {
    id: "f-1",
    name: "Customer calls",
    space: "private",
    defaultTemplateId: "customer-call",
  },
  {
    id: "f-2",
    name: "1:1s",
    space: "private",
    defaultTemplateId: "one-on-one",
  },
  {
    id: "f-3",
    name: "Hiring",
    space: "private",
    defaultTemplateId: "interview",
  },
  { id: "f-4", name: "Product", space: "team", defaultTemplateId: null },
  {
    id: "f-5",
    name: "Weekly sync",
    space: "team",
    defaultTemplateId: "team-meeting",
  },
];

export const templates: Template[] = [
  {
    id: "general",
    name: "General",
    builtIn: true,
    visibility: "team",
    mine: false,
    instructions:
      'Sections, in order: "## Summary" (two or three sentences), "## Key points" (bullets), "## Decisions" (bullets, or "None."), "## Action items" (bullets as "- [ ] owner: task", or "None.").',
  },
  {
    id: "one-on-one",
    name: "1:1",
    builtIn: true,
    visibility: "team",
    mine: false,
    instructions:
      'A one-on-one. Sections, in order: "## Updates" (what each person reported), "## Discussion" (topics, with the gist of each), "## Feedback" (given either way, or "None."), "## Action items".',
  },
  {
    id: "customer-call",
    name: "Customer call",
    builtIn: true,
    visibility: "team",
    mine: false,
    instructions:
      'A call with a customer or prospect ("them" is the customer). Sections, in order: "## About them", "## Needs and pain points", "## Feedback and requests", "## Objections and concerns", "## Next steps".',
  },
  {
    id: "team-meeting",
    name: "Team meeting",
    builtIn: true,
    visibility: "team",
    mine: false,
    instructions:
      'An internal team meeting. Sections: "## Summary", "## Updates", "## Decisions", "## Open questions", "## Action items".',
  },
  {
    id: "interview",
    name: "Interview",
    builtIn: true,
    visibility: "team",
    mine: false,
    instructions:
      'A job interview. Sections: "## Candidate", "## Strengths", "## Concerns", "## Notable answers", "## Next steps".',
  },
  {
    id: "t-1",
    name: "Investor update",
    builtIn: false,
    visibility: "private",
    mine: true,
    instructions:
      'A call with an investor. Sections, in order: "## What they asked" (bullets), "## What we shared" (metrics and news, quoted exactly), "## Their read" (how they reacted, two sentences), "## Follow-ups" (bullets as "- [ ] owner: task").\n\nKeep numbers exactly as said. No adjectives about the company.',
  },
  {
    id: "t-2",
    name: "Design review",
    builtIn: false,
    visibility: "team",
    mine: false,
    instructions:
      'A design critique. Sections: "## What was shown", "## What works", "## What to change" (bullets with who raised it), "## Decisions".',
  },
];

const people = {
  ben: { name: "Ben Senescu", email: "ben@every.to", self: true },
  maya: { name: "Maya Chen", email: "maya@northwind.io", self: false },
  devon: { name: "Devon Park", email: "devon@northwind.io", self: false },
  ana: { name: "Ana Ruiz", email: "ana@every.to", self: false },
  kai: { name: "Kai Moreno", email: "kai@every.to", self: false },
};

export const events: CalendarEvent[] = [
  {
    id: "e-1",
    title: "Northwind onboarding call",
    start: at(0, 10, 15),
    end: at(0, 11, 0),
    attendees: [people.ben, people.maya, people.devon],
    conferenceUrl: "https://meet.google.com/abc-defg-hij",
    location: null,
    meetingId: null,
  },
  {
    id: "e-2",
    title: "Ana / Ben 1:1",
    start: at(0, 13, 30),
    end: at(0, 14, 0),
    attendees: [people.ben, people.ana],
    conferenceUrl: "https://zoom.us/j/123",
    location: null,
    meetingId: null,
  },
  {
    id: "e-3",
    title: "Scribe desktop design review",
    start: at(0, 16, 0),
    end: at(0, 16, 45),
    attendees: [people.ben, people.ana, people.kai],
    conferenceUrl: null,
    location: "Studio",
    meetingId: null,
  },
  {
    id: "e-4",
    title: "Weekly product sync",
    start: at(1, 9, 30),
    end: at(1, 10, 15),
    attendees: [
      people.ben,
      people.ana,
      people.kai,
      people.maya,
      people.devon,
      people.ana,
    ],
    conferenceUrl: "https://meet.google.com/xyz",
    location: null,
    meetingId: null,
  },
  {
    id: "e-5",
    title: "Candidate: senior engineer",
    start: at(1, 14, 0),
    end: at(1, 15, 0),
    attendees: [people.ben, people.kai],
    conferenceUrl: "https://meet.google.com/qrs",
    location: null,
    meetingId: null,
  },
];

export const comingUp: ComingUp = { state: "ok", events };

function row(
  id: string,
  title: string,
  startsAt: string,
  extra: Partial<MeetingRow> = {},
): MeetingRow {
  return {
    id,
    title,
    startsAt,
    endsAt: null,
    status: "done",
    visibility: "private",
    ownerUserId: "u-ben",
    ownerEmail: "ben@every.to",
    attendeeCount: 2,
    mine: true,
    ...extra,
  };
}

export const recent: MeetingRow[] = [
  row("m-1", "Northwind pricing follow-up", at(0, 8, 30), {
    attendeeCount: 3,
    status: "processing",
  }),
  row("m-2", "Ana / Ben 1:1", at(-3, 13, 30)),
  row("m-3", "Weekly product sync", at(-3, 9, 30), {
    attendeeCount: 6,
    visibility: "team",
  }),
  row("m-4", "Acme renewal", at(-4, 15, 0), { attendeeCount: 4 }),
  row("m-5", "Candidate: product designer", at(-4, 11, 0), {
    status: "failed",
  }),
  row("m-6", "Investor check-in: Basecase", at(-5, 16, 30)),
  row("m-7", "Scribe transcription spike review", at(-5, 10, 0), {
    attendeeCount: 3,
    visibility: "team",
  }),
];

export const sharedMeetings: MeetingRow[] = [
  row("s-1", "Q4 roadmap review", at(-1, 14, 0), {
    mine: false,
    ownerUserId: "u-ana",
    ownerEmail: "ana@every.to",
    visibility: "team",
    attendeeCount: 7,
  }),
  row("s-2", "Support themes, October", at(-3, 11, 30), {
    mine: false,
    ownerUserId: "u-kai",
    ownerEmail: "kai@every.to",
    visibility: "team",
    attendeeCount: 3,
  }),
  row("s-3", "Northwind kickoff", at(-6, 10, 0), {
    mine: false,
    ownerUserId: "u-ana",
    ownerEmail: "ana@every.to",
    visibility: "team",
    attendeeCount: 5,
  }),
];

export const folderMeetings: MeetingRow[] = [
  row("m-4", "Acme renewal", at(-4, 15, 0), { attendeeCount: 4 }),
  row("m-8", "Northwind discovery", at(-8, 11, 0), { attendeeCount: 3 }),
  row("m-9", "Globex pilot check-in", at(-10, 14, 30)),
  row("m-10", "Initech intro", at(-13, 9, 0)),
];

export const segments: Segment[] = [
  {
    seq: 1,
    startedMs: 4_000,
    endedMs: 9_000,
    speaker: "me",
    text: "Thanks for making time, Maya. I wanted to walk through where the pilot landed and what pricing looks like for the rollout.",
  },
  {
    seq: 2,
    startedMs: 10_000,
    endedMs: 19_000,
    speaker: "them",
    text: "Of course. Honestly the pilot went better than we expected. The team that used it daily stopped writing their own call notes after the first week.",
  },
  {
    seq: 3,
    startedMs: 20_000,
    endedMs: 26_000,
    speaker: "them",
    text: "The question we keep getting is whether the notes can go straight into Salesforce.",
  },
  {
    seq: 4,
    startedMs: 27_000,
    endedMs: 35_000,
    speaker: "me",
    text: "Not yet. It's on the list for this quarter. For now people copy the link into the opportunity, which is clunky, I know.",
  },
  {
    seq: 5,
    startedMs: 36_000,
    endedMs: 47_000,
    speaker: "them",
    text: "That's fine for now. On pricing, Devon needs a number per seat for forty people, and whether there's an annual discount.",
  },
  {
    seq: 6,
    startedMs: 48_000,
    endedMs: 54_000,
    speaker: "me",
    text: "Forty seats is in the team tier. I'll send the annual number by Wednesday.",
  },
  {
    seq: 7,
    startedMs: 55_000,
    endedMs: 63_000,
    speaker: "them",
    text: "Great. And security review: we need the SOC 2 report and a data processing agreement before legal signs off.",
  },
];

export const notesMarkdown = `## About them
- Northwind, 40-person sales team; Maya runs enablement, Devon owns budget
- Ran a three-week pilot with the inbound team

## Needs and pain points
- Reps stopped writing their own call notes after week one
- Notes need to land in **Salesforce** without copy-pasting a link

## Feedback and requests
- "Went better than we expected"
- Wants a CRM sync; today they paste the link into the opportunity

## Objections and concerns
- Legal needs the SOC 2 report and a DPA before signing

## Next steps
- [ ] Ben: send per-seat and annual pricing for 40 seats by Wednesday
- [ ] Ben: share the SOC 2 report and DPA with Devon
- [x] Maya: collect pilot feedback from the inbound team`;

export const jottingsMarkdown = `- pilot went well, inbound team daily
- SFDC sync?? ask eng about timeline
- 40 seats, annual discount
  - Devon owns budget
- legal: SOC2 + DPA`;

export const meeting: MeetingDetail = {
  ...row("m-1", "Northwind pricing follow-up", at(0, 8, 30), {
    attendeeCount: 3,
  }),
  endsAt: at(0, 9, 5),
  attendees: [people.ben, people.maya, people.devon],
  folders: [{ id: "f-1", name: "Customer calls", space: "private" }],
  template: { id: "customer-call", name: "Customer call", chosen: false },
  segments,
  notes: {
    markdown: notesMarkdown,
    model: "gpt-5",
    generatedAt: at(0, 9, 6),
    editedAt: null,
  },
  jottings: { markdown: jottingsMarkdown, updatedAt: at(0, 9, 4) },
  shareLinks: [],
};

export const liveSegments: Segment[] = segments.slice(0, 4);

export const livePartial = {
  me: "",
  them: "That's fine for now. On pricing, Devon needs a number per seat for forty",
};

export const permissionsFresh: Permissions = {
  mic: "undetermined",
  systemAudio: "undetermined",
  notifications: "undetermined",
};

export const permissionsMixed: Permissions = {
  mic: "granted",
  systemAudio: "denied",
  notifications: "undetermined",
};

export const permissionsGranted: Permissions = {
  mic: "granted",
  systemAudio: "granted",
  notifications: "granted",
};

export const liveStartedAt = new Date(
  NOW.getTime() - (12 * 60 + 41) * 1000,
).toISOString();

function snippet(text: string, words: string[]): SearchResult["snippet"] {
  const lower = text.toLowerCase();
  const ranges = words.flatMap((w) => {
    const at = lower.indexOf(w);
    return at === -1 ? [] : [{ start: at, end: at + w.length }];
  });
  return { text, ranges: ranges.sort((a, b) => a.start - b.start) };
}

export const searchResults: SearchResult[] = [
  {
    meeting: recent[0]!,
    field: "transcript",
    snippet: snippet(
      "…On pricing, Devon needs a number per seat for forty people, and whether there's an annual discount.",
      ["pricing", "seat"],
    ),
  },
  {
    meeting: recent[3]!,
    field: "notes",
    snippet: snippet(
      "…## Pricing - Renewal at the current per-seat price through June; they asked about volume tiers…",
      ["pricing", "seat"],
    ),
  },
  {
    meeting: recent[1]!,
    field: "jottings",
    snippet: snippet(
      "- ask Ana about pricing page copy - seat limits for the free plan?",
      ["pricing", "seat"],
    ),
  },
  {
    meeting: { ...recent[2]!, title: "Pricing and seat packaging review" },
    field: "title",
    snippet: snippet("Pricing and seat packaging review", ["pricing", "seat"]),
  },
  {
    meeting: sharedMeetings[0]!,
    field: "notes",
    snippet: snippet(
      "…Q4: ship usage-based pricing for teams over 50 seats; keep the per-seat plan for small teams…",
      ["pricing", "seat"],
    ),
  },
];
