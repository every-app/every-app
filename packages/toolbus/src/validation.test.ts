import { describe, expect, it } from "vitest";
import {
  argumentsValidator,
  gatewayCheckableSchema,
  measureJson,
} from "./validation";

const object = (properties: Record<string, unknown>, extra = {}) => ({
  type: "object",
  properties,
  ...extra,
});

describe("gatewayCheckableSchema", () => {
  it("leaves a schema without regexes or references as it is", () => {
    const schema = object({ title: { type: "string", minLength: 1 } });
    expect(gatewayCheckableSchema(schema)).toBe(schema);
  });

  it("drops app-written regexes wherever dropping one only accepts more", () => {
    const schema = object(
      {
        id: { type: "string", format: "uuid", pattern: "^(a+)+$" },
        tags: { type: "array", items: { type: "string", pattern: "^x" } },
        either: {
          anyOf: [{ type: "string", pattern: "^y" }, { type: "number" }],
        },
        labels: {
          type: "object",
          patternProperties: { "^(a|a)+$": { type: "string" } },
          additionalProperties: false,
          propertyNames: { pattern: "^(b+)+$" },
        },
        // Instance data that happens to be shaped like a schema stays put.
        fixed: { const: { pattern: "kept" }, default: { pattern: "kept" } },
      },
      { required: ["id"] },
    );
    expect(gatewayCheckableSchema(schema)).toEqual(
      object(
        {
          id: { type: "string", format: "uuid" },
          tags: { type: "array", items: { type: "string" } },
          either: { anyOf: [{ type: "string" }, { type: "number" }] },
          labels: { type: "object", propertyNames: {} },
          fixed: { const: { pattern: "kept" }, default: { pattern: "kept" } },
        },
        { required: ["id"] },
      ),
    );
  });

  it("leaves to the app what it can't loosen safely or check in bounded time", () => {
    const regex = { type: "string", pattern: "^a" };
    for (const schema of [
      // References, often recursive: exponential under a union.
      object({ next: { $ref: "#" } }),
      object({ a: { $dynamicRef: "#node" } }),
      // A regex where dropping it could reject what the schema accepts.
      object({ a: { not: regex } }),
      object({ a: { if: regex, then: { minLength: 2 } } }),
      object({ a: { oneOf: [regex, { type: "string", pattern: "^b" }] } }),
      object({ a: { type: "array", contains: regex, maxContains: 1 } }),
      // What counts as evaluated depends on the dropped keywords.
      object({ a: regex }, { unevaluatedProperties: false }),
    ]) {
      expect(gatewayCheckableSchema(schema), JSON.stringify(schema)).toBe(null);
    }
  });

  it("checks a catastrophic pattern's arguments in bounded time", () => {
    const validate = argumentsValidator(
      "redos",
      object({ s: { type: "string", pattern: "^(a+)+$", maxLength: 100 } }),
    );
    const startedAt = performance.now();
    expect(validate?.({ s: `${"a".repeat(40)}!` })).toMatchObject({
      valid: true,
    });
    expect(validate?.({ s: "a".repeat(101) })).toMatchObject({ valid: false });
    expect(performance.now() - startedAt).toBeLessThan(50);
  });
});

describe("measureJson", () => {
  it("counts depth and values without recursion", () => {
    expect(measureJson({ a: [1, { b: null }], c: "x" }, 64)).toEqual({
      tooDeep: false,
      values: 6,
    });
    let deep: unknown = 1;
    for (let i = 0; i < 64; i += 1) deep = [deep];
    expect(measureJson(deep, 64)).toEqual({ tooDeep: false, values: 65 });
    expect(measureJson([deep], 64)).toEqual({ tooDeep: true });

    let hostile: unknown = [];
    for (let i = 0; i < 200_000; i += 1) hostile = [hostile];
    expect(measureJson({ hostile }, 64)).toEqual({ tooDeep: true });
  });
});
