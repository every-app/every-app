import { describe, expect, it } from "vitest";
import {
  appNames,
  appResources,
  deleteUpdate,
  markDeployedUpdate,
  orgKeyBaseFor,
  orgKeyCandidates,
  planRegistration,
  type AppRow,
  type RegistrationInput,
} from "./registration";

const MANIFEST = { id: "todo", resources: { d1: ["DB"], kv: ["KV", "CACHE"] } };

const input: RegistrationInput = {
  organizationId: "org-1",
  isInstallOrganization: false,
  appSlug: "todo",
  name: "Todo",
  description: "A todo app",
  manifest: MANIFEST,
  appBaseDomain: "apps.example.com",
  orgKey: "acme",
  existingApp: null,
  hostnameOwner: null,
  workerNameOwner: null,
  members: [],
  deployerUserId: null,
};

const registeredTodo: AppRow = {
  id: "app-row-1",
  organizationId: "org-1",
  appSlug: "todo",
  name: "Old name",
  description: "Old description",
  hostname: "todo-acme.apps.example.com",
  workerName: "every-acme-todo",
  tier: "service_binding",
  scope: "org",
  manifest: JSON.stringify({ id: "todo" }),
  status: "active",
  versionId: "version-1",
  deployedAt: 1_700_000_000_000,
  deployedByActor: "ops@example.com",
  isDefault: false,
};

/** What `fn` throws (it must throw). */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

/** The registration of `slug` in `input`'s org, with `manifest.id` to match. */
function forApp(slug: string, extra: Partial<RegistrationInput> = {}) {
  return { ...input, appSlug: slug, manifest: { id: slug }, ...extra };
}

describe("planRegistration", () => {
  it("registers a new app as pending, with the names the rules assign", () => {
    const plan = planRegistration(input);

    expect(plan).toMatchObject({
      kind: "new",
      app: {
        organizationId: "org-1",
        appSlug: "todo",
        name: "Todo",
        description: "A todo app",
        status: "pending",
        tier: "service_binding",
        workerName: "every-acme-todo",
        hostname: "todo-acme.apps.example.com",
        manifest: JSON.stringify(MANIFEST),
        versionId: null,
        deployedAt: null,
        deployedByActor: null,
        isDefault: false,
      },
      grants: [],
      resources: {
        d1: { DB: "every-acme-todo" },
        kv: { KV: "every-acme-todo", CACHE: "every-acme-todo--cache" },
        r2: {},
      },
      previousManifest: null,
      versionId: null,
    });
    expect(plan.app.id).toEqual(expect.any(String));
  });

  it("puts the install's own organization's apps one label below the base domain", () => {
    expect(
      planRegistration({ ...input, isInstallOrganization: true }).app,
    ).toMatchObject({
      workerName: "every-acme-todo",
      hostname: "todo.apps.example.com",
    });
  });

  it("makes a new app private: the deployer, owners and admins only", () => {
    const plan = planRegistration({
      ...input,
      members: [
        { id: "owner-1", role: "owner" },
        { id: "admin-1", role: "admin" },
        { id: "deployer-1", role: "member" },
        { id: "member-1", role: "member" },
        { id: "both-1", role: "member, admin" },
      ],
      deployerUserId: "deployer-1",
    });

    expect(plan.app.isDefault).toBe(false);
    expect(plan.grants).toEqual(
      ["owner-1", "admin-1", "deployer-1", "both-1"].map((userId) => ({
        id: expect.any(String),
        organizationId: "org-1",
        userId,
        appRowId: plan.app.id,
        grantedBy: null,
      })),
    );
  });

  it("grants nobody outside the organization, the deployer included", () => {
    const plan = planRegistration({
      ...input,
      members: [{ id: "owner-1", role: "owner" }],
      deployerUserId: "outsider-1",
    });
    expect(plan.grants.map((grant) => grant.userId)).toEqual(["owner-1"]);
  });

  it('grants every member and future members with access: "everyone"', () => {
    const plan = planRegistration({
      ...input,
      manifest: { id: "todo", access: "everyone" },
      members: [
        { id: "owner-1", role: "owner" },
        { id: "member-1", role: "member" },
      ],
    });

    expect(plan.app.isDefault).toBe(true);
    expect(plan.grants.map((grant) => grant.userId)).toEqual([
      "owner-1",
      "member-1",
    ]);
  });

  it("registers an app before the gateway has any member, granting nobody", () => {
    expect(planRegistration(input).grants).toEqual([]);
  });

  it("keeps a registered app's names, status and live manifest on redeploy", () => {
    const plan = planRegistration({
      ...input,
      // The org's base domain or install status changed since: the names
      // stay what they were.
      isInstallOrganization: true,
      appBaseDomain: "elsewhere.example.com",
      existingApp: registeredTodo,
      hostnameOwner: registeredTodo,
      workerNameOwner: registeredTodo,
      members: [{ id: "owner-1", role: "owner" }],
    });

    expect(plan).toEqual({
      kind: "existing",
      app: { ...registeredTodo, name: "Todo", description: "A todo app" },
      grants: [],
      resources: {
        d1: { DB: "every-acme-todo" },
        kv: { KV: "every-acme-todo", CACHE: "every-acme-todo--cache" },
        r2: {},
      },
      previousManifest: { id: "todo" },
      versionId: "version-1",
    });
  });

  it("restores a deleted app on redeploy by its own organization", () => {
    const tombstone = { ...registeredTodo, status: "deleted", isDefault: true };
    const plan = planRegistration({
      ...input,
      existingApp: tombstone,
      hostnameOwner: tombstone,
      workerNameOwner: tombstone,
      members: [{ id: "owner-1", role: "owner" }],
    });

    expect(plan).toMatchObject({
      kind: "revived",
      app: {
        id: "app-row-1",
        status: "pending",
        workerName: "every-acme-todo",
        hostname: "todo-acme.apps.example.com",
        manifest: JSON.stringify(MANIFEST),
        isDefault: false,
      },
      grants: [{ userId: "owner-1", appRowId: "app-row-1" }],
    });
  });

  it("refuses a new app id that holds the resource separator", () => {
    expect(
      thrown(() => planRegistration(forApp("notes--archive"))),
    ).toMatchObject({ status: 400, code: "INVALID_APP_ID" });
  });

  it("refuses bindings that would share a database", () => {
    expect(
      thrown(() =>
        planRegistration({
          ...input,
          manifest: { id: "todo", resources: { d1: ["ARCHIVE", "Archive"] } },
        }),
      ),
    ).toMatchObject({
      status: 400,
      code: "RESOURCE_NAME_CONFLICT",
    });
  });

  it("names the app's R2 buckets after its Worker", () => {
    expect(
      planRegistration({
        ...input,
        manifest: { id: "todo", resources: { r2: ["R2", "MEDIA_FILES"] } },
      }).resources,
    ).toEqual({
      d1: {},
      kv: {},
      r2: {
        R2: "every-acme-todo",
        MEDIA_FILES: "every-acme-todo--media-files",
      },
    });
  });

  it("refuses buckets that would share a name, or a name Cloudflare refuses", () => {
    expect(
      thrown(() =>
        planRegistration({
          ...input,
          manifest: { id: "todo", resources: { r2: ["MEDIA", "Media"] } },
        }),
      ),
    ).toMatchObject({
      status: 400,
      code: "RESOURCE_NAME_CONFLICT",
      message: expect.stringContaining(
        'share the R2 bucket "every-acme-todo--media"',
      ),
    });
    for (const binding of ["MEDIA_", "A".repeat(50)]) {
      expect(
        thrown(() =>
          planRegistration({
            ...input,
            manifest: { id: "todo", resources: { r2: [binding] } },
          }),
        ),
      ).toMatchObject({
        status: 400,
        code: "INVALID_MANIFEST",
        message: expect.stringContaining("which Cloudflare refuses"),
      });
    }
  });

  it("refuses a manifest that doesn't parse or names another app", () => {
    for (const manifest of [{ id: "other" }, { id: "todo", public: "/" }]) {
      expect(
        thrown(() => planRegistration({ ...input, manifest })),
      ).toMatchObject({ status: 400, code: "INVALID_MANIFEST" });
    }
  });

  it("never names an app Worker after the gateway's own resources", () => {
    for (const appSlug of ["gateway", "gateway-kv"]) {
      expect(
        thrown(() => planRegistration(forApp(appSlug, { orgKey: "app" }))),
      ).toMatchObject({
        status: 400,
        code: "INVALID_WORKER_NAME",
      });
    }
  });

  it("refuses an app id whose Worker name would be too long", () => {
    expect(
      thrown(() => planRegistration(forApp("a".repeat(57)))),
    ).toMatchObject({ status: 400, code: "INVALID_WORKER_NAME" });
  });

  it("refuses an app id too long for a DNS label", () => {
    const appSlug = `a${"b".repeat(63)}`;
    expect(
      thrown(() =>
        planRegistration(forApp(appSlug, { isInstallOrganization: true })),
      ),
    ).toMatchObject({
      status: 400,
      code: "INVALID_APP_HOSTNAME",
    });
  });

  it("keeps the everyapp id for the gateway's own MCP tools", () => {
    expect(thrown(() => planRegistration(forApp("everyapp")))).toMatchObject({
      status: 400,
      code: "RESERVED_APP_ID",
    });
  });

  it("rejects a worker name already registered to another app, tombstones included", () => {
    expect(
      thrown(() =>
        planRegistration({
          ...input,
          workerNameOwner: {
            organizationId: "org-2",
            appSlug: "acme-todo",
            hostname: "acme-todo-other.apps.example.com",
            workerName: "every-acme-todo",
          },
        }),
      ),
    ).toMatchObject({ status: 409, code: "WORKER_NAME_TAKEN" });
  });

  it("rejects a hostname another organization's app holds", () => {
    // `todo-globex` of the install's organization takes the host globex's
    // `todo` would get.
    expect(
      thrown(() =>
        planRegistration({
          ...input,
          orgKey: "globex",
          hostnameOwner: {
            organizationId: "org-install",
            appSlug: "todo-globex",
            hostname: "todo-globex.apps.example.com",
            workerName: "every-install-todo-globex",
          },
        }),
      ),
    ).toMatchObject({ status: 409, code: "HOSTNAME_TAKEN" });
  });

  it("refuses owners looked up for other names, and another org's row as its own", () => {
    expect(() =>
      planRegistration({
        ...input,
        hostnameOwner: { ...registeredTodo, hostname: "other.example.com" },
      }),
    ).toThrow("hostname owner");
    expect(() =>
      planRegistration({
        ...input,
        existingApp: { ...registeredTodo, organizationId: "org-2" },
      }),
    ).toThrow("existingApp");
  });
});

describe("shared apps", () => {
  const platform = forApp("openseo", {
    isInstallOrganization: true,
    scope: "shared",
    members: [
      { id: "owner", role: "owner" },
      { id: "member", role: "member" },
    ],
    deployerUserId: "owner",
  });

  it("registers a shared app in the platform organization, granting nobody", () => {
    const plan = planRegistration(platform);
    expect(plan.kind).toBe("new");
    expect(plan.app).toMatchObject({
      scope: "shared",
      hostname: "openseo.apps.example.com",
      workerName: "every-acme-openseo",
      tier: "service_binding",
      isDefault: false,
      status: "pending",
    });
    expect(plan.grants).toEqual([]);
  });

  it("registers an organization's own app with scope org by default", () => {
    expect(planRegistration(input).app.scope).toBe("org");
  });

  it("refuses a shared app from any organization but the platform's", () => {
    expect(
      thrown(() =>
        planRegistration({ ...platform, isInstallOrganization: false }),
      ),
    ).toMatchObject({ status: 403, code: "SHARED_APP_NOT_PLATFORM" });
  });

  it("never changes an app's scope, tombstones included", () => {
    const shared = { ...registeredTodo, scope: "shared" };
    expect(
      thrown(() =>
        planRegistration({
          ...input,
          isInstallOrganization: true,
          scope: "org",
          existingApp: shared,
        }),
      ),
    ).toMatchObject({ status: 409, code: "APP_SCOPE_MISMATCH" });
    for (const status of ["active", "deleted"]) {
      expect(
        thrown(() =>
          planRegistration({
            ...input,
            isInstallOrganization: true,
            scope: "shared",
            existingApp: { ...registeredTodo, status },
          }),
        ),
      ).toMatchObject({ status: 409, code: "APP_SCOPE_MISMATCH" });
    }
    expect(
      planRegistration({
        ...input,
        isInstallOrganization: true,
        scope: "shared",
        existingApp: shared,
      }).kind,
    ).toBe("existing");
  });

  it("keeps the row's scope when none is asked for, as a redeploy does", () => {
    const shared = { ...registeredTodo, scope: "shared" };
    const redeploy = planRegistration({
      ...input,
      isInstallOrganization: true,
      existingApp: shared,
    });
    expect(redeploy).toMatchObject({
      kind: "existing",
      app: { scope: "shared" },
    });

    // A deleted shared app comes back shared, granting nobody.
    const revived = planRegistration({
      ...input,
      isInstallOrganization: true,
      existingApp: { ...shared, status: "deleted" },
      members: [{ id: "owner", role: "owner" }],
      deployerUserId: "owner",
    });
    expect(revived).toMatchObject({
      kind: "revived",
      app: { scope: "shared", isDefault: false },
      grants: [],
    });

    // Only from the platform organization, still.
    expect(
      thrown(() => planRegistration({ ...input, existingApp: shared })),
    ).toMatchObject({ status: 403, code: "SHARED_APP_NOT_PLATFORM" });
  });
});

describe("dispatch apps", () => {
  it("registers a third-party app on the dispatch tier", () => {
    expect(planRegistration({ ...input, tier: "dispatch" }).app).toMatchObject({
      tier: "dispatch",
      scope: "org",
      status: "pending",
    });
  });

  it("never changes an app's tier, tombstones included", () => {
    for (const status of ["active", "deleted"]) {
      expect(
        thrown(() =>
          planRegistration({
            ...input,
            tier: "dispatch",
            existingApp: { ...registeredTodo, status },
          }),
        ),
      ).toMatchObject({ status: 409, code: "APP_TIER_MISMATCH" });
    }
    // The CLI's own deploys ask for no tier: a dispatch app isn't theirs.
    expect(
      thrown(() =>
        planRegistration({
          ...input,
          existingApp: { ...registeredTodo, tier: "dispatch" },
        }),
      ),
    ).toMatchObject({ status: 409, code: "APP_TIER_MISMATCH" });
    expect(
      planRegistration({
        ...input,
        tier: "dispatch",
        existingApp: { ...registeredTodo, tier: "dispatch" },
      }).kind,
    ).toBe("existing");
  });

  it("refuses a shared app on the dispatch tier", () => {
    expect(
      thrown(() =>
        planRegistration({
          ...forApp("openseo"),
          isInstallOrganization: true,
          scope: "shared",
          tier: "dispatch",
        }),
      ),
    ).toMatchObject({ status: 400, code: "APP_TIER_MISMATCH" });
  });
});

describe("appNames", () => {
  it("gives the names a new app gets, and keeps a registered app's", () => {
    const names = {
      appSlug: "todo",
      orgKey: "acme",
      isInstallOrganization: false,
      appBaseDomain: "Apps.Example.com.",
    };
    expect(appNames({ ...names, existingApp: null })).toEqual({
      workerName: "every-acme-todo",
      hostname: "todo-acme.apps.example.com",
    });
    expect(appNames({ ...names, existingApp: registeredTodo })).toEqual({
      workerName: "every-acme-todo",
      hostname: "todo-acme.apps.example.com",
    });
  });

  it("names Workers per organization, so two organizations can deploy the same app", () => {
    const names = (orgKey: string) =>
      appNames({
        appSlug: "todo",
        orgKey,
        isInstallOrganization: false,
        appBaseDomain: "apps.example.com",
        existingApp: null,
      });
    expect(names("acme").workerName).toBe("every-acme-todo");
    expect(names("globex")).toEqual({
      workerName: "every-globex-todo",
      hostname: "todo-globex.apps.example.com",
    });
  });
});

describe("organization keys", () => {
  it("keeps only up to 12 letters and digits of the slug", () => {
    expect(orgKeyBaseFor("acme-corporation")).toBe("acmecorporat");
    expect(orgKeyBaseFor("Default")).toBe("default");
    expect(orgKeyBaseFor("--")).toBe("org");
  });

  it("numbers the candidates after the first, within 12 characters", () => {
    const candidates = orgKeyCandidates("acme-corporation");
    expect(candidates.slice(0, 3)).toEqual([
      "acmecorporat",
      "acmecorpora2",
      "acmecorpora3",
    ]);
    expect(candidates).toHaveLength(50);
    expect(candidates.at(-1)).toBe("acmecorpor50");
    expect(new Set(candidates).size).toBe(50);
  });
});

describe("markDeployedUpdate", () => {
  const deployed = { versionId: "version-2", actor: "ben@example.com" };

  it("records the upload and moves a new app on to binding", () => {
    const manifest = { ...MANIFEST, public: [{ path: "/health" }] };
    expect(
      markDeployedUpdate(
        { ...registeredTodo, status: "pending" },
        { ...deployed, manifest, now: 42 },
      ),
    ).toEqual({
      manifest: JSON.stringify(manifest),
      versionId: "version-2",
      deployedAt: 42,
      deployedByActor: "ben@example.com",
      status: "binding",
    });
  });

  it("keeps an active, binding or disabled app's status", () => {
    for (const status of ["active", "binding", "disabled"]) {
      expect(
        markDeployedUpdate(
          { ...registeredTodo, status },
          { ...deployed, manifest: MANIFEST },
        ),
      ).toMatchObject({ status, deployedAt: expect.any(Number) });
    }
  });

  it("refuses a deleted app, one without names, and a manifest for another app", () => {
    expect(
      thrown(() =>
        markDeployedUpdate(
          { ...registeredTodo, status: "deleted" },
          { ...deployed, manifest: MANIFEST },
        ),
      ),
    ).toMatchObject({ status: 404, code: "APP_NOT_FOUND" });
    expect(
      thrown(() =>
        markDeployedUpdate(
          { ...registeredTodo, workerName: null },
          { ...deployed, manifest: MANIFEST },
        ),
      ),
    ).toMatchObject({ status: 409, code: "APP_NOT_REGISTERED" });
    expect(
      thrown(() =>
        markDeployedUpdate(registeredTodo, {
          ...deployed,
          manifest: { id: "other" },
        }),
      ),
    ).toMatchObject({ status: 400, code: "INVALID_MANIFEST" });
  });

  it("records a dispatch app's upload before it has a hostname", () => {
    const unnamed = { ...registeredTodo, hostname: null, status: "pending" };
    expect(
      markDeployedUpdate(
        { ...unnamed, tier: "dispatch" },
        { ...deployed, manifest: MANIFEST },
      ),
    ).toMatchObject({ status: "binding" });
    expect(
      thrown(() =>
        markDeployedUpdate(unnamed, { ...deployed, manifest: MANIFEST }),
      ),
    ).toMatchObject({ status: 409, code: "APP_NOT_REGISTERED" });
  });
});

describe("deleteUpdate", () => {
  it("tombstones an app once", () => {
    expect(deleteUpdate(registeredTodo)).toEqual({
      status: "deleted",
      isDefault: false,
    });
    expect(deleteUpdate({ status: "deleted" })).toBeNull();
  });
});

describe("appResources", () => {
  it("names a registered app's resources from its row", () => {
    expect(
      appResources({
        workerName: "every-acme-todo",
        manifest: JSON.stringify(MANIFEST),
      }),
    ).toEqual({
      d1: { DB: "every-acme-todo" },
      kv: { KV: "every-acme-todo", CACHE: "every-acme-todo--cache" },
      r2: {},
    });
    expect(appResources({ workerName: null, manifest: null })).toEqual({
      d1: {},
      kv: {},
      r2: {},
    });
  });
});
