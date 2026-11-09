import { describe, expect, it } from "vitest";
import { isRegistryWorkerName } from "../manifest/manifest";
import {
  appNames,
  planRegistration,
  planRename,
  previousIdChanges,
  RegistrationError,
  type AppRow,
  type PreviousIdRow,
  type RenameInput,
} from "./registration";

const talk: AppRow = {
  id: "row-talk",
  organizationId: "org-1",
  appSlug: "talk",
  name: "Talk",
  description: "Talk",
  hostname: "talk.apps.example.com",
  workerName: "every-acme-talk",
  tier: "service_binding",
  scope: "org",
  manifest: JSON.stringify({
    id: "talk",
    resources: { d1: ["DB"], r2: ["UPDATES"] },
  }),
  status: "active",
  versionId: "v1",
  deployedAt: 1,
  deployedByActor: "ops@example.com",
  everyone: true,
};

const rename: RenameInput = {
  app: talk,
  toSlug: "scribe",
  manifest: {
    id: "scribe",
    previousIds: ["talk"],
    resources: { d1: ["DB"], r2: ["UPDATES"] },
  },
  isInstallOrganization: true,
  appBaseDomain: "apps.example.com",
  orgKey: "acme",
  previousIds: [],
  toSlugApp: null,
  toSlugPreviousId: null,
  hostnameOwner: null,
  hostnamePreviousOwner: null,
  now: 1_000,
};

function previousId(extra: Partial<PreviousIdRow> = {}): PreviousIdRow {
  return {
    organizationId: "org-1",
    appSlug: "talk",
    appRowId: "row-talk",
    hostname: "talk.apps.example.com",
    renamedAt: 1,
    movedAt: null,
    retiredAt: null,
    ...extra,
  };
}

function refusal(fn: () => unknown): RegistrationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof RegistrationError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("planRename", () => {
  it("moves the id and hostname and keeps the row, Worker and resources", () => {
    const plan = planRename(rename);

    expect(plan.app).toEqual({
      ...talk,
      appSlug: "scribe",
      hostname: "scribe.apps.example.com",
    });
    expect(plan.from).toEqual({
      appSlug: "talk",
      hostname: "talk.apps.example.com",
    });
    expect(plan.previousId).toEqual(previousId({ renamedAt: 1_000 }));
    expect(plan.reclaimed).toEqual([]);
    // Named after the Worker, as before the rename.
    expect(plan.resources).toEqual({
      d1: { DB: "every-acme-talk" },
      kv: {},
      r2: { UPDATES: "every-acme-talk--updates" },
    });
  });

  it("names another organization's app <id>-<orgKey>", () => {
    const plan = planRename({
      ...rename,
      app: { ...talk, hostname: "talk-acme.apps.example.com" },
      isInstallOrganization: false,
    });
    expect(plan.app.hostname).toBe("scribe-acme.apps.example.com");
  });

  it("refuses an id that is already an app, or a deleted one's", () => {
    expect(
      refusal(() =>
        planRename({
          ...rename,
          toSlugApp: { appSlug: "scribe", status: "active" },
        }),
      ).code,
    ).toBe("RENAME_TARGET_EXISTS");
    const deleted = refusal(() =>
      planRename({
        ...rename,
        toSlugApp: { appSlug: "scribe", status: "deleted" },
      }),
    );
    expect(deleted.code).toBe("RENAME_TARGET_EXISTS");
    expect(deleted.message).toContain("deleted");
  });

  it("refuses another app's previous id, and takes back its own", () => {
    const others = previousId({
      appSlug: "scribe",
      appRowId: "row-other",
      hostname: "scribe.apps.example.com",
    });
    expect(
      refusal(() => planRename({ ...rename, toSlugPreviousId: others })).code,
    ).toBe("RENAME_TARGET_EXISTS");

    // scribe → talk, then back to scribe.
    const own = previousId({
      appSlug: "scribe",
      hostname: "scribe.apps.example.com",
    });
    const back = planRename({
      ...rename,
      previousIds: [own],
      toSlugPreviousId: own,
      hostnamePreviousOwner: own,
    });
    expect(back.app.hostname).toBe("scribe.apps.example.com");
    expect(back.reclaimed).toEqual([own]);
  });

  it("refuses a hostname another app holds, as its own or a previous one", () => {
    const holder = {
      organizationId: "org-2",
      appSlug: "scribe",
      hostname: "scribe.apps.example.com",
      workerName: "every-other-scribe",
    };
    expect(
      refusal(() => planRename({ ...rename, hostnameOwner: holder })).code,
    ).toBe("HOSTNAME_TAKEN");
    const previous = previousId({
      appSlug: "x",
      appRowId: "row-x",
      hostname: "scribe.apps.example.com",
    });
    expect(
      refusal(() => planRename({ ...rename, hostnamePreviousOwner: previous }))
        .code,
    ).toBe("HOSTNAME_TAKEN");
  });

  it("refuses a deleted, unnamed or dispatch app, and a manifest for another id", () => {
    expect(
      refusal(() =>
        planRename({ ...rename, app: { ...talk, status: "deleted" } }),
      ).code,
    ).toBe("APP_NOT_FOUND");
    expect(
      refusal(() => planRename({ ...rename, app: { ...talk, hostname: null } }))
        .code,
    ).toBe("APP_NOT_REGISTERED");
    expect(
      refusal(() =>
        planRename({ ...rename, app: { ...talk, tier: "dispatch" } }),
      ).code,
    ).toBe("RENAME_UNSUPPORTED");
    expect(
      refusal(() => planRename({ ...rename, manifest: { id: "talk" } })).code,
    ).toBe("INVALID_MANIFEST");
  });

  it("refuses an id the platform keeps or that can't be a hostname", () => {
    expect(
      refusal(() =>
        planRename({
          ...rename,
          toSlug: "everyapp",
          manifest: { id: "everyapp" },
        }),
      ).code,
    ).toBe("RESERVED_APP_ID");
    expect(
      refusal(() =>
        planRename({ ...rename, toSlug: "a--b", manifest: { id: "a--b" } }),
      ).code,
    ).toBe("INVALID_APP_ID");
  });

  it("keeps a twice-renamed app's first Worker", () => {
    const chat = { ...talk, workerName: "every-acme-chat" };
    const plan = planRename({
      ...rename,
      app: chat,
      previousIds: [
        previousId({ appSlug: "chat", hostname: "chat.apps.example.com" }),
      ],
    });
    expect(plan.app.workerName).toBe("every-acme-chat");
    expect(() => planRename({ ...rename, app: chat })).toThrow(
      /reserved for the gateway or isn't the app's own/,
    );
  });
});

describe("previousIdChanges", () => {
  const served = previousId();
  const retired = previousId({
    appSlug: "chat",
    hostname: "chat.apps.example.com",
    retiredAt: 5,
  });

  it("retires what the manifest dropped, serves again what it lists, and names what it can't place", () => {
    expect(previousIdChanges([served, retired], ["chat", "nope"])).toEqual({
      retire: ["talk"],
      restore: ["chat"],
      unknown: ["nope"],
    });
    expect(previousIdChanges([served, retired], ["talk"])).toEqual({
      retire: [],
      restore: [],
      unknown: [],
    });
    expect(previousIdChanges([served], undefined)).toEqual({
      retire: ["talk"],
      restore: [],
      unknown: [],
    });
  });
});

describe("registration after a rename", () => {
  it("accepts the Worker a previous id named", () => {
    expect(
      isRegistryWorkerName({
        appId: "scribe",
        orgKey: "acme",
        workerName: "every-acme-talk",
      }),
    ).toBe(false);
    expect(
      isRegistryWorkerName({
        appId: "scribe",
        orgKey: "acme",
        workerName: "every-acme-talk",
        previousAppIds: ["talk"],
      }),
    ).toBe(true);
    // Never a Worker none of the ids names, nor an id that can't be one.
    expect(
      isRegistryWorkerName({
        appId: "scribe",
        orgKey: "acme",
        workerName: "every-acme-other",
        previousAppIds: ["talk"],
      }),
    ).toBe(false);
    expect(
      isRegistryWorkerName({
        appId: "scribe",
        orgKey: "acme",
        workerName: "every-acme-a--b",
        previousAppIds: ["a--b"],
      }),
    ).toBe(false);
    expect(
      appNames({
        appSlug: "scribe",
        orgKey: "acme",
        isInstallOrganization: true,
        appBaseDomain: "apps.example.com",
        existingApp: {
          workerName: "every-acme-talk",
          hostname: "scribe.apps.example.com",
        },
        previousAppIds: ["talk"],
      }),
    ).toEqual({
      workerName: "every-acme-talk",
      hostname: "scribe.apps.example.com",
    });
  });

  it("redeploys the renamed app as existing", () => {
    const scribe = {
      ...talk,
      appSlug: "scribe",
      hostname: "scribe.apps.example.com",
    };
    const plan = planRegistration({
      organizationId: "org-1",
      isInstallOrganization: true,
      appSlug: "scribe",
      name: "Scribe",
      description: "Scribe",
      manifest: rename.manifest,
      appBaseDomain: "apps.example.com",
      orgKey: "acme",
      existingApp: scribe,
      hostnameOwner: { ...scribe },
      workerNameOwner: { ...scribe },
      previousAppIds: ["talk"],
      previousIdOwner: null,
    });
    expect(plan.kind).toBe("existing");
    expect(plan.app.workerName).toBe("every-acme-talk");
  });

  it("refuses a new app under another app's previous id", () => {
    const error = refusal(() =>
      planRegistration({
        organizationId: "org-1",
        isInstallOrganization: true,
        appSlug: "talk",
        name: "Talk",
        description: "Talk",
        manifest: { id: "talk" },
        appBaseDomain: "apps.example.com",
        orgKey: "acme",
        existingApp: null,
        hostnameOwner: null,
        workerNameOwner: null,
        previousIdOwner: previousId(),
      }),
    );
    expect(error.code).toBe("APP_ID_RENAMED");
  });
});
