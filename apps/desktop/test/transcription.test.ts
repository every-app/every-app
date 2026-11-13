import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type Settings } from "@shared/ipc";
import type { HelperEvent } from "@shared/protocol";
import { isLocalHost, parseTranscriptionBaseUrl } from "@shared/transcriptionServer";
import { AuthService } from "../src/main/auth/service";
import { SecretStore } from "../src/main/auth/store";
import { HelperSupervisor } from "../src/main/helper/supervisor";
import { validArgs } from "../src/main/ipcValidation";
import { RecordingController } from "../src/main/recording";
import { parseSettingsPatch, readSettings } from "../src/main/settings";
import { recordingTranscription, testTranscriptionServer, transcriptionServerParams } from "../src/main/transcription";
import { FakeServer } from "./fakeServer";
import { fakeCipher, tempStore } from "./helpers";

const FAKE_HELPER = join(import.meta.dirname, "..", "scripts", "fake-helper.mjs");

const own = (patch: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  ownTranscription: true,
  transcriptionBaseUrl: "http://localhost:50060/v1",
  transcriptionModel: "large-v3",
  ...patch,
});

describe("a transcription server's address", () => {
  it("takes https anywhere, and http only on this Mac or the local network", () => {
    expect(parseTranscriptionBaseUrl("http://localhost:50060/v1")).toBe("http://localhost:50060/v1");
    expect(parseTranscriptionBaseUrl("  localhost:8000/v1/ ")).toBe("http://localhost:8000/v1");
    expect(parseTranscriptionBaseUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(parseTranscriptionBaseUrl("http://192.168.1.20:8000/v1")).toBe("http://192.168.1.20:8000/v1");
    expect(parseTranscriptionBaseUrl("http://studio.local:9000/v1")).toBe("http://studio.local:9000/v1");
    expect(parseTranscriptionBaseUrl("whisper.example.com/v1")).toBe("https://whisper.example.com/v1");
    expect(parseTranscriptionBaseUrl("https://whisper.example.com/v1?x=1#y")).toBe("https://whisper.example.com/v1");
    for (const bad of ["http://whisper.example.com/v1", "http://8.8.8.8/v1", "http://172.32.0.1/v1", "ftp://localhost/v1", "https://user:pw@whisper.example.com/v1", "   ", "http://"]) {
      expect(parseTranscriptionBaseUrl(bad), bad).toBeNull();
    }
    // Saved as parsed: parsing it again changes nothing.
    for (const text of ["localhost:8000/v1/", "whisper.example.com", "http://10.0.0.5:9000"]) {
      const parsed = parseTranscriptionBaseUrl(text)!;
      expect(parseTranscriptionBaseUrl(parsed)).toBe(parsed);
    }
    expect(isLocalHost("100.101.102.103")).toBe(true); // Tailscale
    // A bare name can resolve anywhere through a DNS search domain: https only.
    expect(isLocalHost("nas")).toBe(false);
    expect(parseTranscriptionBaseUrl("http://nas:8000/v1")).toBeNull();
    expect(parseTranscriptionBaseUrl("nas:8000/v1")).toBe("https://nas:8000/v1");
    expect(isLocalHost("[::1]")).toBe(true);
    expect(isLocalHost("example.com")).toBe(false);
  });
});

describe("transcription settings", () => {
  it("are off by default, and a patch must hold a usable address", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ ownTranscription: false, transcriptionBaseUrl: "", transcriptionModel: "" });
    expect(parseSettingsPatch({ ownTranscription: true, transcriptionBaseUrl: "http://localhost:50060/v1", transcriptionModel: "large-v3" })).not.toBeNull();
    expect(parseSettingsPatch({ transcriptionBaseUrl: "" })).toEqual({ transcriptionBaseUrl: "" });
    for (const bad of [
      { transcriptionBaseUrl: "http://whisper.example.com/v1" }, // plain http across the internet
      { transcriptionBaseUrl: "localhost:50060/v1" }, // not parsed yet
      { transcriptionBaseUrl: 1 },
      { transcriptionModel: " padded " },
      { transcriptionModel: "x".repeat(201) },
      { ownTranscription: "yes" },
      { transcriptionKey: "sk-secret" }, // the key is never a setting
    ]) {
      expect(parseSettingsPatch(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(readSettings({ ownTranscription: true, transcriptionBaseUrl: "http://evil.example.com" })).toMatchObject({ ownTranscription: true, transcriptionBaseUrl: "" });
  });

  it("the key is kept encrypted with the sign-in, and outlives a sign-out", () => {
    const { store, path } = tempStore();
    expect(store.transcriptionKey).toBeUndefined();
    store.setTranscriptionKey("sk-local-secret");
    expect(readFileSync(path).includes("sk-local-secret")).toBe(false); // not plaintext on disk
    store.setCredentials({ kind: "token", appUrl: "https://talk.example.com", token: "epat_1" });
    store.setCredentials(undefined);
    const again = new SecretStore(path, fakeCipher);
    again.load();
    expect(again.transcriptionKey).toBe("sk-local-secret");
    again.setTranscriptionKey(undefined);
    expect(again.transcriptionKey).toBeUndefined();
    expect(existsSync(path)).toBe(false); // nothing left to keep
  });

  it("the window can set the key and run the test, nothing more", () => {
    expect(validArgs("transcription:setKey", ["sk-1"])).toBe(true);
    expect(validArgs("transcription:setKey", [""])).toBe(true);
    for (const bad of [[], [1], ["a", "b"], ["x".repeat(8193)]]) expect(validArgs("transcription:setKey", bad)).toBe(false);
    expect(validArgs("transcription:test", [])).toBe(true);
    expect(validArgs("transcription:test", [{ baseUrl: "http://localhost" }])).toBe(false);
  });
});

describe("what a recording hands the helper", () => {
  it("nothing while the setting is off, even with an address saved", () => {
    expect(recordingTranscription(own({ ownTranscription: false }), "sk-1")).toBeUndefined();
  });

  it("the server, with the key only when one is saved", () => {
    expect(recordingTranscription(own(), undefined)).toEqual({ baseUrl: "http://localhost:50060/v1", model: "large-v3" });
    expect(recordingTranscription(own(), "sk-1")).toEqual({ baseUrl: "http://localhost:50060/v1", model: "large-v3", apiKey: "sk-1" });
  });

  it("refuses when it's on but incomplete, rather than falling back to OpenAI", () => {
    expect(() => recordingTranscription(own({ transcriptionBaseUrl: "" }), undefined)).toThrow(
      "Your own transcription server is on, but isn't set up. Add your transcription server's address in Settings → Transcription.",
    );
    expect(() => recordingTranscription(own({ transcriptionModel: "" }), undefined)).toThrow(/model name in Settings → Transcription/);
    expect(() => transcriptionServerParams(own({ transcriptionBaseUrl: "" }), undefined)).toThrow(/address/);
  });
});

/** An OpenAI-compatible transcription server on 127.0.0.1. */
class FakeWhisper {
  server!: Server;
  baseUrl = "";
  status = 200;
  requests: { path: string; authorization?: string; contentType?: string; body: Buffer }[] = [];

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.requests.push({ path: req.url ?? "", authorization: req.headers.authorization, contentType: req.headers["content-type"], body: Buffer.concat(chunks) });
        res.writeHead(this.status, { "content-type": "application/json" });
        res.end(this.status === 200 ? JSON.stringify({ text: " Hello. " }) : JSON.stringify({ error: { message: "Invalid model" } }));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}

describe("with the fake helper and a local server", () => {
  let whisper: FakeWhisper;
  let scribe: FakeServer;
  let helper: HelperSupervisor;

  beforeEach(async () => {
    whisper = await new FakeWhisper().start();
    scribe = await new FakeServer().start();
    helper = new HelperSupervisor({ path: FAKE_HELPER, freshToken: async () => "epat_good", env: { ...process.env, FAKE_HELPER_LINE_MS: "30", FAKE_HELPER_WORD_MS: "1" } });
    helper.start();
    await until(() => helper.state.status === "ready" && helper.state.permissions);
  });

  afterEach(async () => {
    await helper.stop();
    await whisper.stop();
    await scribe.stop();
  });

  it("Test sends a transcription request to the saved address, with the saved key", async () => {
    const result = await testTranscriptionServer(helper, own({ transcriptionBaseUrl: whisper.baseUrl, ownTranscription: false }), "sk-local");
    expect(result).toMatchObject({ text: "Hello.", endpoint: `${whisper.baseUrl}/audio/transcriptions` });
    expect(whisper.requests).toHaveLength(1);
    const request = whisper.requests[0]!;
    expect(request.path).toBe("/v1/audio/transcriptions");
    expect(request.authorization).toBe("Bearer sk-local");
    expect(request.contentType).toMatch(/^multipart\/form-data/);
    expect(request.body.includes('name="model"')).toBe(true);
    expect(request.body.includes("large-v3")).toBe(true);
    expect(request.body.includes("RIFF")).toBe(true);
  });

  it("Test says why a server didn't answer", async () => {
    whisper.status = 404;
    await expect(testTranscriptionServer(helper, own({ transcriptionBaseUrl: whisper.baseUrl }), undefined)).rejects.toThrow(/HTTP 404: Invalid model/);
    expect(whisper.requests[0]!.authorization).toBeUndefined(); // no key saved, no header
    await whisper.stop();
    await expect(testTranscriptionServer(helper, own({ transcriptionBaseUrl: whisper.baseUrl }), undefined)).rejects.toThrow(/isn't answering/);
    whisper = await new FakeWhisper().start();
  });

  const signedIn = async () => {
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {} });
    await auth.signInWithToken(scribe.origin, "epat_good");
    return auth;
  };

  it("a recording hands the helper the server and runs in custom mode", async () => {
    const recording = new RecordingController(await signedIn(), helper);
    recording.transcription = () => recordingTranscription(own({ transcriptionBaseUrl: whisper.baseUrl }), undefined);
    const states: HelperEvent[] = [];
    helper.on("event", (e) => e.event === "state" && states.push(e));
    await recording.start({ title: "On my own server" });
    await until(() => recording.state.mode === "custom");
    expect(whisper.requests).toHaveLength(1); // the helper checked the server before recording
    await recording.stop();
    expect(states.every((s) => s.event === "state" && s.mode === "custom")).toBe(true);
  });

  it("a server that isn't there stops the start, and the meeting made for it is deleted", async () => {
    await whisper.stop();
    const recording = new RecordingController(await signedIn(), helper);
    recording.transcription = () => recordingTranscription(own({ transcriptionBaseUrl: whisper.baseUrl }), undefined);
    await expect(recording.start({ title: "No server" })).rejects.toThrow(/isn't answering\. Start it, or turn off your own server in Settings → Transcription\./);
    expect(recording.state).toMatchObject({ state: "idle" });
    await until(() => scribe.deleted.length === 1);
    whisper = await new FakeWhisper().start();
  });

  it("an incomplete setting stops the start before anything reaches Scribe", async () => {
    const recording = new RecordingController(await signedIn(), helper);
    recording.transcription = () => recordingTranscription(own({ transcriptionBaseUrl: "" }), undefined);
    await expect(recording.start({ title: "Not set up" })).rejects.toThrow(/isn't set up/);
    expect(scribe.meetings).toEqual([]);
    expect(recording.state.state).toBe("idle");
  });
});

async function until<T>(read: () => T | undefined | false, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
