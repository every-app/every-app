import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeetingDetail } from "../types";
import { MeetingScreen } from "./MeetingScreen";
import { SettingsScreen } from "./SettingsScreen";
import { Transcript } from "./Transcript";

afterEach(cleanup);

const meeting: MeetingDetail = {
  id: "m-1",
  title: "Pricing call",
  startsAt: "2026-11-02T15:00:00.000Z",
  endsAt: null,
  status: "done",
  visibility: "private",
  ownerUserId: "u-1",
  ownerEmail: "ben@every.to",
  attendeeCount: 0,
  mine: true,
  attendees: [],
  folders: [],
  template: { id: "general", name: "General", chosen: false },
  segments: [
    {
      seq: 1,
      startedMs: 0,
      endedMs: 1000,
      speaker: "me",
      text: "Hello there.",
    },
    { seq: 2, startedMs: 1000, endedMs: 2000, speaker: "them", text: "Hi!" },
  ],
  notes: {
    markdown: "## Summary\nWe agreed on pricing.",
    model: "m",
    generatedAt: "",
    editedAt: null,
  },
  jottings: { markdown: "- pricing", updatedAt: "" },
  shareLinks: [],
};

describe("Transcript", () => {
  it("merges a speaker's consecutive segments and streams partial text last", () => {
    render(
      <Transcript
        segments={[
          { seq: 1, startedMs: 0, endedMs: 1, speaker: "them", text: "One." },
          { seq: 2, startedMs: 1, endedMs: 2, speaker: "them", text: "Two." },
        ]}
        partial={{ me: "still talk", them: "" }}
      />,
    );
    expect(screen.getByText("One. Two.")).toBeTruthy();
    const partial = screen.getByText("still talk");
    expect(partial.className).toContain("opacity-60");
  });
});

describe("MeetingScreen", () => {
  const base = {
    meeting,
    jottings: "- pricing",
    onJottingsChange: () => {},
    folders: [],
    templates: [],
    orgName: "Every",
  };

  it("after: switches between notes, jottings and transcript", () => {
    render(<MeetingScreen {...base} phase="after" />);
    expect(screen.getByText("We agreed on pricing.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Your jottings" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Your jottings",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("- pricing");
    fireEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(screen.getByText("Hello there.")).toBeTruthy();
  });

  it("share: a team link is offered only while the meeting is shared with the team", async () => {
    const teamUrl = "https://talk.example.com/meetings/m-1";
    const onCopyTeamLink = vi.fn(() => true);
    const shared = { ...meeting, visibility: "team" as const };
    const view = render(
      <MeetingScreen
        {...base}
        phase="after"
        defaultShareOpen
        teamUrl={teamUrl}
        onCopyTeamLink={onCopyTeamLink}
      />,
    );
    // Private: the switch says so and there is no link to hand out.
    expect(screen.getByText("Only you")).toBeTruthy();
    expect(screen.queryByLabelText("Team link")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();

    view.rerender(
      <MeetingScreen
        {...base}
        meeting={shared}
        phase="after"
        defaultShareOpen
        teamUrl={teamUrl}
        onCopyTeamLink={onCopyTeamLink}
      />,
    );
    expect(
      (screen.getByLabelText("Team link") as HTMLInputElement).value,
    ).toBe(teamUrl);
    expect(
      screen.getByText(/Only signed-in members of Every can open this link/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(onCopyTeamLink).toHaveBeenCalledTimes(1);
  });

  it("share: a refused clipboard doesn't say Copied", async () => {
    render(
      <MeetingScreen
        {...base}
        meeting={{ ...meeting, visibility: "team" }}
        phase="after"
        defaultShareOpen
        teamUrl="https://talk.example.com/meetings/m-1"
        onCopyTeamLink={async () => false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });

  it("during: Stop calls back and the transcript drawer opens", () => {
    const onStop = vi.fn();
    render(
      <MeetingScreen
        {...base}
        phase="during"
        onStop={onStop}
        live={{
          recording: {
            meetingId: "m-1",
            title: "Pricing call",
            startedAt: "",
            mode: "realtime",
            mic: "ok",
            system: "ok",
          },
          levels: { mic: 0.5, system: 0.5 },
          partial: { me: "", them: "Thinking out loud" },
          elapsedMs: 61_000,
        }}
      />,
    );
    expect(screen.getByText("1:01")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Transcript/ }));
    expect(screen.getByText("Thinking out loud")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  const live = {
    recording: {
      meetingId: "m-1",
      title: "Pricing call",
      startedAt: "",
      mode: "realtime" as const,
      mic: "ok" as const,
      system: "ok" as const,
    },
    levels: { mic: 0, system: 0 },
    partial: { me: "", them: "" },
    elapsedMs: 0,
  };

  it("during: says when transcription is reconnecting, then catching up", () => {
    const { rerender } = render(
      <MeetingScreen
        {...base}
        phase="during"
        transcription="reconnecting"
        live={live}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Reconnecting to transcription…",
    );
    rerender(
      <MeetingScreen
        {...base}
        phase="during"
        transcription="catching_up"
        live={live}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Catching up on the transcript…",
    );
    rerender(
      <MeetingScreen
        {...base}
        phase="during"
        transcription={null}
        live={live}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("during: a long Stop shows Finishing, and says it's catching up when it is", () => {
    const onStop = vi.fn();
    const { rerender } = render(
      <MeetingScreen
        {...base}
        phase="during"
        stopping
        transcription="catching_up"
        live={live}
        onStop={onStop}
      />,
    );
    expect(screen.getByText("Catching up on the transcript…")).toBeTruthy();
    const finishing = screen.getByRole("button", {
      name: /Finishing/,
    }) as HTMLButtonElement;
    expect(finishing.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^Stop$/ })).toBeNull();
    rerender(
      <MeetingScreen
        {...base}
        phase="during"
        stopping
        live={live}
        onStop={onStop}
      />,
    );
    expect(screen.getByText("Finishing the transcript…")).toBeTruthy();
    // The elapsed time shows once it's taking a while.
    rerender(
      <MeetingScreen
        {...base}
        phase="during"
        stopping
        stoppingMs={83_000}
        live={live}
        onStop={onStop}
      />,
    );
    expect(screen.getByText("1:23")).toBeTruthy();
    rerender(
      <MeetingScreen
        {...base}
        phase="during"
        stopping
        stoppingMs={2_000}
        live={live}
        onStop={onStop}
      />,
    );
    expect(screen.queryByText("0:02")).toBeNull();
  });

  it("during: shows a quiet warning above the controls", () => {
    render(
      <MeetingScreen
        {...base}
        phase="during"
        warning="Connection is slow, some audio may be skipped."
        warningDetail="Their side: 3 chunks waiting"
        live={{
          recording: {
            meetingId: "m-1",
            title: "Pricing call",
            startedAt: "",
            mode: "fallback",
            mic: "ok",
            system: "ok",
          },
          levels: { mic: 0, system: 0 },
          partial: { me: "", them: "" },
          elapsedMs: 0,
        }}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(
      "Connection is slow, some audio may be skipped.",
    );
    expect(status.getAttribute("title")).toBe("Their side: 3 chunks waiting");
  });

  it("after: a meeting left recording offers Finish to its owner", () => {
    const onFinish = vi.fn();
    render(
      <MeetingScreen
        {...base}
        phase="after"
        meeting={{ ...meeting, status: "recording", notes: null }}
        onFinish={onFinish}
      />,
    );
    expect(
      screen.getByText("This meeting was still recording when it stopped"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Finish and write notes" }),
    );
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it("after: someone else's recording reads as in progress, with no Finish", () => {
    render(
      <MeetingScreen
        {...base}
        phase="after"
        meeting={{
          ...meeting,
          status: "recording",
          notes: null,
          mine: false,
          ownerEmail: "ana@every.to",
        }}
      />,
    );
    expect(screen.getByText("Recording in progress")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Finish/ })).toBeNull();
  });
});

describe("SettingsScreen", () => {
  it("explains a permission that's still off and offers System Settings", () => {
    const onOpen = vi.fn();
    render(
      <SettingsScreen
        account={{ status: "loading" }}
        permissions={{
          status: "ready",
          data: {
            mic: "granted",
            systemAudio: "unknown",
            notifications: "unknown",
          },
        }}
        permissionHints={{
          notifications: "Allow notifications for Every App in System Settings.",
        }}
        onOpenSystemSettings={onOpen}
        calendar={{ status: "loading" }}
        launchAtLogin
        detectCalls
        theme="system"
      />,
    );
    expect(
      screen.getByText("Allow notifications for Every App in System Settings."),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Open System Settings" }),
    );
    expect(onOpen).toHaveBeenCalledWith("notifications");
    // macOS can't report system audio: no Grant, just its pane. No echo cancellation switch any more.
    fireEvent.click(screen.getByRole("button", { name: "View in Settings" }));
    expect(onOpen).toHaveBeenCalledWith("systemAudio");
    expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
    expect(screen.queryByLabelText("Echo cancellation")).toBeNull();
  });

  it("after: the tab follows the caller (a ?tab= link on the meeting already open)", () => {
    const base = {
      meeting,
      jottings: "- pricing",
      onJottingsChange: () => {},
      folders: [],
      templates: [],
      orgName: "Every",
    };
    const onTabChange = vi.fn();
    const { rerender } = render(
      <MeetingScreen
        {...base}
        phase="after"
        tab="notes"
        onTabChange={onTabChange}
      />,
    );
    expect(
      screen.getByRole("tab", { name: "Notes" }).getAttribute("aria-selected"),
    ).toBe("true");
    // The URL changes to ?tab=jottings: the same screen switches.
    rerender(
      <MeetingScreen
        {...base}
        phase="after"
        tab="jottings"
        onTabChange={onTabChange}
      />,
    );
    expect(
      screen
        .getByRole("tab", { name: "Your jottings" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    expect(onTabChange).toHaveBeenCalledWith("transcript");
    // Someone else's meeting has no jottings tab: it opens Notes.
    rerender(
      <MeetingScreen
        {...base}
        phase="after"
        meeting={{ ...meeting, mine: false }}
        tab="jottings"
        onTabChange={onTabChange}
      />,
    );
    expect(
      screen.getByRole("tab", { name: "Notes" }).getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("SettingsScreen record shortcut", () => {
  const settings = {
    account: { status: "loading" },
    permissions: { status: "loading" },
    calendar: { status: "loading" },
    launchAtLogin: false,
    detectCalls: true,
    theme: "system",
  } as const;

  it("toggles ⌃⌥⌘R, and says when another app holds it", () => {
    // Base UI's Switch dispatches a PointerEvent, which jsdom lacks.
    (window as unknown as { PointerEvent?: unknown }).PointerEvent ??= window.MouseEvent;
    const onChange = vi.fn();
    const { rerender } = render(
      <SettingsScreen
        {...settings}
        recordShortcut={false}
        recordShortcutStatus="off"
        onRecordShortcutChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Record shortcut" }));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(
      <SettingsScreen
        {...settings}
        recordShortcut
        recordShortcutStatus="conflict"
        onRecordShortcutChange={onChange}
      />,
    );
    expect(screen.getByText(/Another app is using ⌃⌥⌘R/)).toBeTruthy();
    rerender(<SettingsScreen {...settings} />);
    expect(
      screen.queryByRole("switch", { name: "Record shortcut" }),
    ).toBeNull();
  });
});
