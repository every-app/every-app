import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeetingDetail } from "../types";
import { AppFrame, type FrameRecorder, type SidebarProps } from "./AppFrame";
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

  it("after: the owner deletes the meeting from the More actions menu, after confirming", async () => {
    let fail: ((error: Error) => void) | undefined;
    const onDelete = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () => new Promise<void>((_, reject) => (fail = reject)),
      )
      .mockResolvedValue(undefined);
    render(<MeetingScreen {...base} phase="after" onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete meeting" }),
    );
    // Nothing is deleted until the dialog's own button.
    expect(await screen.findByText("Delete “Pricing call”?")).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    // It failed: the dialog stays, says why, and Delete tries again.
    await act(async () => fail!(new Error("Couldn't delete it. Offline.")));
    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't delete it. Offline.",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect(onDelete).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers no delete on someone else's meeting, or while this Mac records it", () => {
    const { rerender } = render(
      <MeetingScreen
        {...base}
        phase="after"
        meeting={{ ...meeting, mine: false }}
        onDelete={async () => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    rerender(
      <MeetingScreen {...base} phase="during" onDelete={async () => {}} />,
    );
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

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

describe("AppFrame while recording", () => {
  const sidebar: SidebarProps = {
    current: { to: "home" },
    onNavigate: () => {},
    folders: { status: "ready", data: [] },
    orgName: "Every",
    onNewNote: () => {},
  };
  const recorder = (patch: Partial<FrameRecorder> = {}): FrameRecorder => ({
    recording: {
      meetingId: "m-1",
      title: "Pricing call",
      startedAt: "",
      mode: "realtime",
      mic: "ok",
      system: "ok",
    },
    levels: { mic: 0.4, system: 0.2 },
    elapsedMs: 61_000,
    here: false,
    onOpen: () => {},
    onTranscript: () => {},
    onStop: () => {},
    ...patch,
  });

  it("another page: the bar names the meeting, with the timer, both levels, Transcript and Stop", () => {
    const onOpen = vi.fn();
    const onTranscript = vi.fn();
    const onStop = vi.fn();
    render(
      <AppFrame
        sidebar={sidebar}
        recorder={recorder({ onOpen, onTranscript, onStop })}
      >
        <p>Home</p>
      </AppFrame>,
    );
    const bar = screen.getByRole("group", { name: "Recording" });
    expect(bar.textContent).toContain("Pricing call");
    expect(bar.textContent).toContain("1:01");
    expect(bar.textContent).toContain("Mic level 40%");
    expect(bar.textContent).toContain("Call audio level 20%");

    // Its buttons do their own thing and don't also open the meeting.
    fireEvent.click(screen.getByRole("button", { name: /Transcript/ }));
    expect(onTranscript).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();

    // Anywhere else on the bar goes back to the recording meeting: once per click.
    fireEvent.click(bar);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Pricing call/ }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("says above the bar when the person's own transcription server is in trouble", () => {
    const { rerender } = render(
      <AppFrame
        sidebar={sidebar}
        recorder={recorder({
          status: "Your transcription server isn't answering. Audio is kept for up to 5 minutes.",
        })}
      >
        <p>Home</p>
      </AppFrame>,
    );
    expect(
      screen.getByText("Your transcription server isn't answering. Audio is kept for up to 5 minutes."),
    ).toBeTruthy();
    rerender(
      <AppFrame
        sidebar={sidebar}
        recorder={recorder({ warning: "60 s of audio couldn't be transcribed." })}
      >
        <p>Home</p>
      </AppFrame>,
    );
    expect(screen.getByText("60 s of audio couldn't be transcribed.")).toBeTruthy();
    // On the meeting's own page the page says it, not the frame.
    rerender(
      <AppFrame
        sidebar={sidebar}
        recorder={recorder({ here: true, status: "Your transcription server isn't answering." })}
      >
        <p>Meeting</p>
      </AppFrame>,
    );
    expect(screen.queryByText("Your transcription server isn't answering.")).toBeNull();
    rerender(
      <AppFrame sidebar={sidebar} recorder={recorder()}>
        <p>Home</p>
      </AppFrame>,
    );
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });

  it("the sidebar has nothing about the recording, and New note is away", () => {
    render(
      <AppFrame sidebar={sidebar} recorder={recorder()}>
        <p>Home</p>
      </AppFrame>,
    );
    const side = screen.getByRole("complementary", { name: "Sidebar" });
    expect(side.textContent).not.toContain("Pricing call");
    expect(side.textContent).not.toContain("1:01");
    expect(side.querySelector(".record-pulse")).toBeNull();
    expect(screen.queryByRole("button", { name: /New note/ })).toBeNull();
    expect(screen.getAllByRole("group", { name: "Recording" })).toHaveLength(1);
  });

  it("the recording meeting's own page draws the bar: the frame adds none", () => {
    render(
      <AppFrame sidebar={sidebar} recorder={recorder({ here: true })}>
        <p>The meeting</p>
      </AppFrame>,
    );
    expect(screen.queryByRole("group", { name: "Recording" })).toBeNull();
    expect(screen.queryByRole("button", { name: /New note/ })).toBeNull();
  });

  it("finishing: no Stop to press twice", () => {
    render(
      <AppFrame sidebar={sidebar} recorder={recorder({ stopping: true })}>
        <p>Home</p>
      </AppFrame>,
    );
    expect(screen.getByRole("button", { name: /Finishing/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });

  it("not recording: no bar, and New note is there", () => {
    render(
      <AppFrame sidebar={sidebar}>
        <p>Home</p>
      </AppFrame>,
    );
    expect(screen.queryByRole("group", { name: "Recording" })).toBeNull();
    expect(screen.getByRole("button", { name: /New note/ })).toBeTruthy();
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

describe("SettingsScreen transcription", () => {
  const settings = {
    account: { status: "loading" },
    permissions: { status: "loading" },
    calendar: { status: "loading" },
    launchAtLogin: false,
    detectCalls: true,
    theme: "system",
  } as const;
  const server = {
    enabled: true,
    baseUrl: "http://localhost:50060/v1",
    model: "large-v3",
    keySaved: false,
    test: { kind: "idle" },
  } as const;

  it("is off by default, and says where audio and text go", () => {
    (window as unknown as { PointerEvent?: unknown }).PointerEvent ??= window.MouseEvent;
    const onEnabledChange = vi.fn();
    const { rerender } = render(
      <SettingsScreen
        {...settings}
        transcription={{ ...server, enabled: false, baseUrl: "", model: "", onEnabledChange }}
      />,
    );
    expect(
      screen.getByText(
        "With your own server, meeting audio goes only to it, never to OpenAI or to Scribe. The transcript text still goes to Scribe, and Scribe's AI model writes the notes from it. The transcript arrives every 20 to 30 seconds instead of word by word.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Server address")).toBeNull();
    fireEvent.click(
      screen.getByRole("switch", { name: "Use my own transcription server" }),
    );
    expect(onEnabledChange).toHaveBeenCalledWith(true);
    // On, but nothing filled in: Test is off and the person is told a recording won't start.
    rerender(
      <SettingsScreen
        {...settings}
        transcription={{ ...server, baseUrl: "", model: "" }}
      />,
    );
    expect(
      screen.getByText(/Until then a recording\s+won't start\./),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Test" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    rerender(<SettingsScreen {...settings} />);
    expect(screen.queryByText("Transcription")).toBeNull();
  });

  it("saves a field when it's left, never shows the key, and reports the test", () => {
    const onBaseUrlChange = vi.fn();
    const onModelChange = vi.fn();
    const onKeyChange = vi.fn();
    const onTest = vi.fn();
    const props = { ...server, onBaseUrlChange, onModelChange, onKeyChange, onTest };
    const { rerender } = render(
      <SettingsScreen {...settings} transcription={props} />,
    );
    const address = screen.getByLabelText("Server address") as HTMLInputElement;
    expect(address.value).toBe("http://localhost:50060/v1");
    fireEvent.change(address, { target: { value: " localhost:8000/v1 " } });
    expect(onBaseUrlChange).not.toHaveBeenCalled();
    fireEvent.blur(address);
    expect(onBaseUrlChange).toHaveBeenCalledWith("localhost:8000/v1");
    fireEvent.blur(screen.getByLabelText("Model")); // unchanged: nothing to save
    expect(onModelChange).not.toHaveBeenCalled();

    const key = screen.getByLabelText("API key") as HTMLInputElement;
    expect(key.type).toBe("password");
    fireEvent.change(key, { target: { value: "sk-local" } });
    fireEvent.blur(key);
    expect(onKeyChange).toHaveBeenCalledWith("sk-local");
    expect(key.value).toBe("");
    expect(screen.queryByRole("button", { name: "Remove API key" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(onTest).toHaveBeenCalledTimes(1);
    rerender(
      <SettingsScreen
        {...settings}
        transcription={{ ...props, keySaved: true, test: { kind: "ok", ms: 420 } }}
      />,
    );
    expect(screen.getByText("Your server answered in 0.4 s.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove API key" }));
    expect(onKeyChange).toHaveBeenLastCalledWith("");
    rerender(
      <SettingsScreen
        {...settings}
        transcription={{
          ...props,
          baseUrlError: "Use an https address, or http for a server on this Mac or your local network.",
          test: { kind: "error", message: "Your transcription server at localhost:50060 isn't answering." },
        }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/Use an https address/);
    expect(
      screen.getByText("Your transcription server at localhost:50060 isn't answering."),
    ).toBeTruthy();
  });
});
