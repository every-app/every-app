import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("installed Wrangler service-binding props support", () => {
  it("fails loudly when services[].props disappears from the config schema", async () => {
    const schemaPath = new URL(
      "../../node_modules/wrangler/config-schema.json",
      import.meta.url,
    );
    const schema = JSON.parse(await fs.readFile(schemaPath, "utf8")) as {
      definitions?: {
        RawConfig?: {
          properties?: {
            services?: {
              items?: { properties?: Record<string, unknown> };
            };
          };
        };
      };
    };

    const props =
      schema.definitions?.RawConfig?.properties?.services?.items?.properties?.[
        "props"
      ];
    expect(
      props,
      "Installed Wrangler no longer declares services[].props; rerun the named-entrypoint runtime spike before upgrading it.",
    ).toMatchObject({ type: "object" });
  });
});
