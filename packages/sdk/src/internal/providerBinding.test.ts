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
  id: "stripe",
  name: "Stripe",
  docs: "https://dashboard.stripe.com/apikeys",
  hosts: ["api.stripe.com"],
  auth: { kind: "bearer", secret: "STRIPE_API_KEY" },
};

function capability(input: unknown) {
  const parsed = parseProviderSpec(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  return parsed.capability;
}

describe("providerBindingKey", () => {
  it("is the row's hosts, host setting and auth, in a canonical order", () => {
    expect(providerBindingKey(capability(spec))).toBe(
      '{"auth":{"kind":"bearer","secret":"STRIPE_API_KEY"},"hostSetting":null,"hosts":["api.stripe.com"]}',
    );
    // Order and prose don't change it; hosts and auth do.
    expect(
      providerBindingKey(
        capability({
          ...spec,
          name: "Stripe (live)",
          hint: "x",
          hosts: ["api.stripe.com"],
        }),
      ),
    ).toBe(providerBindingKey(capability(spec)));
    expect(
      providerBindingKey(
        capability({
          ...spec,
          auth: { secret: "STRIPE_API_KEY", kind: "bearer" },
        }),
      ),
    ).toBe(providerBindingKey(capability(spec)));
    expect(
      providerBindingKey(
        capability({ ...spec, hosts: ["api.stripe.com", "files.stripe.com"] }),
      ),
    ).not.toBe(providerBindingKey(capability(spec)));
    expect(
      providerBindingKey(
        capability({
          ...spec,
          auth: { kind: "bearer", secret: "STRIPE_API_KEY", scheme: "Token" },
        }),
      ),
    ).not.toBe(providerBindingKey(capability(spec)));
    expect(
      providerBindingKey(
        capability({ ...spec, hosts: [], hostSetting: "STRIPE_HOST" }),
      ),
    ).not.toBe(providerBindingKey(capability(spec)));
    // A nested auth object (a Basic username setting) is canonical too.
    const twilio = {
      ...spec,
      id: "twilio",
      auth: {
        kind: "basic",
        secret: "TWILIO_AUTH_TOKEN",
        as: "password",
        user: { secret: "TWILIO_ACCOUNT_SID" },
      },
    };
    expect(providerBindingKey(capability(twilio))).toContain(
      '"user":{"secret":"TWILIO_ACCOUNT_SID"}',
    );
  });
});

describe("a registry's bound rows", () => {
  const key = providerBindingKey(capability(spec));
  const row = (
    boundTo: string | null,
    overrides: Partial<ProviderRow> = {},
  ): ProviderRow => ({
    id: "stripe",
    spec,
    boundTo,
    addedBy: "ben@example.com",
    addedAt: 1,
    ...overrides,
  });

  it("reports the catalog bound, a row bound only while its key matches, and an unknown id unbound", () => {
    const bound = providerRegistry([row(key)]);
    expect(bound.bound("dataforseo")).toBe(true);
    expect(bound.bound("stripe")).toBe(true);
    expect(bound.bound("square")).toBe(false);
    expect(bound.unboundSettings().size).toBe(0);
    expect(bound.rows()).toEqual([
      {
        id: "stripe",
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
      expect(unbound.bound("stripe")).toBe(false);
      expect(unbound.get("stripe")).toBeDefined();
      expect([...unbound.unboundSettings()]).toEqual(["STRIPE_API_KEY"]);
      expect(unbound.rows()[0]?.bound).toBe(false);
    }
  });
});
