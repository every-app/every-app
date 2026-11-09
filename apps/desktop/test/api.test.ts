import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, ApiError, isAccessLogin } from "../src/main/api/client";
import { AccessTokenAuthProvider, OAuthAuthProvider } from "../src/main/auth/providers";
import { OAuthClient, type OAuthGrant } from "../src/main/auth/oauth";
import { AuthService } from "../src/main/auth/service";
import { decodeEvent, decodeMe, decodeMeetingList, decodeUpcoming, flexibleDate, isMeeting } from "@shared/api";
import { FakeServer } from "./fakeServer";
import { tempStore } from "./helpers";

let fake: FakeServer;
beforeEach(async () => {
  fake = await new FakeServer().start();
});
afterEach(async () => {
  await fake.stop();
});

function grantFor(accessToken: string, refreshToken?: string): OAuthGrant {
  fake.clients.add("c1");
  if (refreshToken) fake.refreshTokens.set(refreshToken, "c1");
  return { appUrl: fake.origin, issuer: fake.issuer, tokenEndpoint: `${fake.issuer}/token`, revocationEndpoint: `${fake.issuer}/revoke`, clientId: "c1", resource: fake.origin, accessToken, refreshToken };
}

describe("API client", () => {
  it("sends the bearer and reads /me, meetings CRUD", async () => {
    const api = new ApiClient(new AccessTokenAuthProvider(fake.origin, "epat_good"));
    expect(await api.me()).toMatchObject({ email: "ben@example.com", orgName: "Every", id: "7", googleConnected: true });
    const id = await api.createMeeting({ title: "Standup", startsAt: "2026-11-01T10:00:00Z", calendarEventId: "ev1" });
    expect((await api.meetings()).map((m) => m.id)).toEqual([id]);
    expect(await api.meeting(id)).toMatchObject({ id, title: "Standup", segments: [], shareLinks: [] });
    expect(await api.updateMeeting(id, { title: "Daily", visibility: "team" })).toMatchObject({ title: "Daily", visibility: "team" });
    await api.finish(id);
    await api.finish(id); // 404 for an already-finished meeting is done too
    expect(fake.finished).toEqual([id]);
    expect(fake.requests.find((r) => r.path === "/api/v1/me")!.headers.authorization).toBe("Bearer epat_good");
  });

  it("refreshes once on a 401 and retries with the new token", async () => {
    const grant = grantFor("expired_token", "rt_seed");
    let persisted: OAuthGrant | undefined;
    const api = new ApiClient(new OAuthAuthProvider(grant, new OAuthClient(), { persist: (g) => void (persisted = g) }));
    const me = await api.me();
    expect(me.email).toBe("ben@example.com");
    const calls = fake.requests.map((r) => r.path);
    expect(calls).toEqual(["/api/v1/me", "/gw/token", "/api/v1/me"]);
    expect(persisted?.refreshToken).not.toBe("rt_seed");
  });

  it("a refused personal access token is a sign-out", async () => {
    const api = new ApiClient(new AccessTokenAuthProvider(fake.origin, "epat_bad"));
    await expect(api.me()).rejects.toMatchObject({ kind: "signedOut" });
  });

  it("a refused refresh is a sign-out", async () => {
    const api = new ApiClient(new OAuthAuthProvider(grantFor("expired", "rt_gone_unknown_to_server"), new OAuthClient(), { persist: () => {} }));
    fake.refreshTokens.clear();
    await expect(api.me()).rejects.toMatchObject({ kind: "signedOut" });
  });

  it("spots Cloudflare Access: a redirect to its login", async () => {
    fake.accessMode = "redirect";
    const api = new ApiClient(new AccessTokenAuthProvider(fake.origin, "epat_good"));
    await expect(api.me()).rejects.toMatchObject({ kind: "accessLogin" });
  });

  it("spots Cloudflare Access: its page on a 401 is not a sign-out", async () => {
    fake.accessMode = "page401";
    const grant = grantFor("at", "rt_x");
    const api = new ApiClient(new OAuthAuthProvider(grant, new OAuthClient(), { persist: () => {} }));
    await expect(api.me()).rejects.toMatchObject({ kind: "accessLogin" });
    expect(fake.requests.some((r) => r.path === "/gw/token")).toBe(false);
  });

  it("isAccessLogin leaves ordinary responses alone", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(isAccessLogin({ status: 200, headers: h({ "content-type": "application/json" }), url: "https://talk.x" }, "{}")).toBe(false);
    expect(isAccessLogin({ status: 302, headers: h({ location: "https://talk.x/login" }), url: "https://talk.x" }, "")).toBe(false);
    expect(isAccessLogin({ status: 200, headers: h({}), url: "https://team.cloudflareaccess.com/x" }, "")).toBe(true);
    expect(isAccessLogin({ status: 302, headers: h({ location: "/cdn-cgi/access/login" }), url: "https://talk.x" }, "")).toBe(true);
  });

  it("token sign-in behind Access says Sign in with Every App is needed", async () => {
    fake.accessMode = "redirect";
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {} });
    await auth.signInWithToken(fake.origin, "epat_good");
    expect(auth.state.status).toBe("signedOut");
    expect(auth.state.needsEveryAppSignIn).toBe(true);
  });

  it("token sign-in checks the token with /me before keeping it", async () => {
    const { store } = tempStore();
    const auth = new AuthService({ store, openBrowser: () => {} });
    await auth.signInWithToken(fake.origin, "epat_bad");
    expect(auth.state.error).toBe("Scribe refused that token.");
    expect(store.credentials).toBeUndefined();
    await auth.signInWithToken(fake.origin, "epat_good");
    expect(auth.state).toMatchObject({ status: "signedIn", method: "token", email: "ben@example.com" });
    expect(store.credentials).toEqual({ kind: "token", appUrl: fake.origin, token: "epat_good" });
  });

  it("calendar not connected (409) reads as connected: false", async () => {
    fake.upcomingStatus = 409;
    const api = new ApiClient(new AccessTokenAuthProvider(fake.origin, "epat_good"));
    expect(await api.upcoming()).toEqual({ events: [], connected: false, connectUrl: undefined });
  });

  it("other server errors carry status and code", async () => {
    const api = new ApiClient(new AccessTokenAuthProvider(fake.origin, "epat_good"));
    const error = await api.meeting("nope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: "server", status: 404, code: "not_found" });
  });
});

describe("lenient decoders", () => {
  it("reads /me flat or nested", () => {
    expect(decodeMe({ email: "a@b", googleConnected: true })).toMatchObject({ email: "a@b", googleConnected: true });
    expect(decodeMe({ user: { id: "u" }, google: { connected: false, connectUrl: "https://c" } })).toMatchObject({ id: "u", connectUrl: "https://c" });
  });
  it("reads dates as ISO or epoch", () => {
    expect(flexibleDate("2026-11-01T10:00:00Z")?.toISOString()).toBe("2026-11-01T10:00:00.000Z");
    expect(flexibleDate(1_793_000_000)?.getTime()).toBe(1_793_000_000_000);
    expect(flexibleDate(1_793_000_000_000)?.getTime()).toBe(1_793_000_000_000);
    expect(flexibleDate("soon")).toBeUndefined();
  });
  it("reads events in Google's shape and the API's", () => {
    const e = decodeEvent({ id: 5, summary: "Sync", startsAt: "2026-11-01T10:00:00Z", attendees: ["a@x", { email: "b@x", self: true }], hangoutLink: "https://meet" });
    expect(e).toMatchObject({ id: "5", title: "Sync", conferenceUrl: "https://meet", attendees: [{ email: "a@x" }, { email: "b@x", self: true }] });
    expect(decodeEvent({ id: "x" })).toBeUndefined();
    expect(decodeUpcoming([{ id: "1", start: "2026-11-01T10:00:00Z" }])).toMatchObject({ connected: true, events: [{ id: "1" }] });
    expect(decodeUpcoming({ items: [], connectUrl: "https://c" })).toMatchObject({ connected: false });
    expect(decodeMeetingList([{ id: 1 }])).toEqual([{ id: "1", title: "Untitled meeting", startsAt: undefined, endsAt: undefined, status: undefined, visibility: undefined, url: undefined }]);
  });
  it("knows what's a meeting", () => {
    const base = { id: "1", title: "t", start: "2026-11-01T10:00:00Z" };
    expect(isMeeting({ ...base, attendees: [], conferenceUrl: "https://z" })).toBe(true);
    expect(isMeeting({ ...base, attendees: [{ email: "me", self: true }] })).toBe(false);
    expect(isMeeting({ ...base, attendees: [{ email: "me", self: true }, { email: "you", self: false }] })).toBe(true);
    expect(isMeeting({ ...base, attendees: [{ email: "a" }] })).toBe(false);
    expect(isMeeting({ ...base, attendees: [{ email: "a" }, { email: "b" }] })).toBe(true);
  });
});
