/**
 * `providers.value-bound-to-hosts`: a registered row's key counts only
 * while the row still has the hosts, host setting and auth the key was set
 * for, which `everyapp secret set` records as the row's binding key.
 */
import { describe, expect, it } from "vitest";
import { parseProviderSpec } from "./providerSpec";
import {
  providerBindingKey,
  providerRegistry,
  type ProviderRow,
} from "./providerRegistry";

const spec = {
  id: "northwind",
  name: "Northwind",
  docs: "https://developer.northwind.io/keys",
  hosts: ["api.northwind.io"],
  auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" },
};

function capability(input: unknown) {
  const parsed = parseProviderSpec(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  return parsed.capability;
}

describe("providerBindingKey", () => {
  it("is the row's hosts, host setting and auth, in a canonical order", () => {
    expect(providerBindingKey(capability(spec))).toBe(
      '{"auth":{"kind":"bearer","secret":"NORTHWIND_API_KEY"},"hostSetting":null,"hosts":["api.northwind.io"]}',
    );
    // Order and prose don't change it; hosts and auth do.
    expect(
      providerBindingKey(
        capability({
          ...spec,
          name: "Northwind (live)",
          hint: "x",
          hosts: ["api.northwind.io"],
        }),
      ),
    ).toBe(providerBindingKey(capability(spec)));
    expect(
      providerBindingKey(
        capability({
          ...spec,
          auth: { secret: "NORTHWIND_API_KEY", kind: "bearer" },
        }),
      ),
    ).toBe(providerBindingKey(capability(spec)));
    expect(
      providerBindingKey(
        capability({
          ...spec,
          hosts: ["api.northwind.io", "files.northwind.io"],
        }),
      ),
    ).not.toBe(providerBindingKey(capability(spec)));
    expect(
      providerBindingKey(
        capability({
          ...spec,
          auth: {
            kind: "bearer",
            secret: "NORTHWIND_API_KEY",
            scheme: "Token",
          },
        }),
      ),
    ).not.toBe(providerBindingKey(capability(spec)));
    expect(
      providerBindingKey(
        capability({ ...spec, hosts: [], hostSetting: "NORTHWIND_HOST" }),
      ),
    ).not.toBe(providerBindingKey(capability(spec)));
    // A nested auth object (a Basic username setting) is canonical too.
    const litware = {
      ...spec,
      id: "litware",
      auth: {
        kind: "basic",
        secret: "LITWARE_AUTH_TOKEN",
        as: "password",
        user: { secret: "LITWARE_ACCOUNT_SID" },
      },
    };
    expect(providerBindingKey(capability(litware))).toContain(
      '"user":{"secret":"LITWARE_ACCOUNT_SID"}',
    );
  });
});

describe("a registry's bound rows", () => {
  const key = providerBindingKey(capability(spec));
  const row = (
    boundTo: string | null,
    overrides: Partial<ProviderRow> = {},
  ): ProviderRow => ({
    id: "northwind",
    spec,
    boundTo,
    addedBy: "ben@example.com",
    addedAt: 1,
    ...overrides,
  });

  it("reports the catalog bound, a row bound only while its key matches, and an unknown id unbound", () => {
    const bound = providerRegistry([row(key)]);
    expect(bound.bound("dataforseo")).toBe(true);
    expect(bound.bound("northwind")).toBe(true);
    expect(bound.bound("nope")).toBe(false);
    expect(bound.unboundSettings().size).toBe(0);
    expect(bound.rows()).toEqual([
      {
        id: "northwind",
        capability: capability(spec),
        bound: true,
        addedBy: "ben@example.com",
        addedAt: 1,
      },
    ]);

    for (const unbound of [
      providerRegistry([row(null)]),
      providerRegistry([
        row(key, { spec: { ...spec, hosts: ["attacker.example"] } }),
      ]),
      providerRegistry([row("stale")]),
    ]) {
      expect(unbound.bound("northwind")).toBe(false);
      expect(unbound.get("northwind")).toBeDefined();
      expect([...unbound.unboundSettings()]).toEqual(["NORTHWIND_API_KEY"]);
      expect(unbound.rows()[0]?.bound).toBe(false);
    }
  });
});
