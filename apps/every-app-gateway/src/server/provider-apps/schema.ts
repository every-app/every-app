/**
 * Plain tool schemas for provider tools (`{ jsonSchema, validate }`, the
 * SDK's dependency-free form): an object of named fields, each a string,
 * an integer or a list of strings (the kinds the provider tools take), with
 * the bounds the JSON Schema states. The gateway's ToolBus checks arguments against the same
 * JSON Schema before a call; this is the SDK's own check, which also fills
 * defaults, so a handler reads what the schema promises.
 */
import type { PlainToolSchema } from "@every-app/sdk/server";

type Field =
  | {
      type: "string";
      description: string;
      default?: string;
      enum?: readonly string[];
      maxLength?: number;
    }
  | {
      type: "integer";
      description: string;
      default?: number;
      minimum?: number;
      maximum?: number;
    }
  | {
      type: "array";
      description: string;
      items: { type: "string"; maxLength?: number };
      minItems?: number;
      maxItems: number;
    };

export type Fields = Record<string, Field>;

type Issue = { message: string; path?: string[] };

function check(name: string, field: Field, value: unknown): Issue | null {
  const issue = (message: string): Issue => ({ message, path: [name] });
  switch (field.type) {
    case "string":
      if (typeof value !== "string") return issue("must be a string");
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return issue(`must be at most ${field.maxLength} characters`);
      }
      if (field.enum && !field.enum.includes(value)) {
        return issue(`must be one of ${field.enum.join(", ")}`);
      }
      return null;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return issue("must be a whole number");
      }
      if (field.minimum !== undefined && value < field.minimum) {
        return issue(`must be at least ${field.minimum}`);
      }
      if (field.maximum !== undefined && value > field.maximum) {
        return issue(`must be at most ${field.maximum}`);
      }
      return null;
    case "array": {
      if (!Array.isArray(value)) return issue("must be a list");
      if (field.minItems !== undefined && value.length < field.minItems) {
        return issue(
          `needs at least ${field.minItems} ${field.minItems === 1 ? "entry" : "entries"}`,
        );
      }
      if (value.length > field.maxItems) {
        return issue(`takes at most ${field.maxItems} entries`);
      }
      for (const [index, item] of value.entries()) {
        if (typeof item !== "string") {
          return { message: "must be a string", path: [name, String(index)] };
        }
        if (
          field.items.maxLength !== undefined &&
          item.length > field.items.maxLength
        ) {
          return {
            message: `must be at most ${field.items.maxLength} characters`,
            path: [name, String(index)],
          };
        }
      }
      return null;
    }
  }
}

/**
 * The schema for an object of `fields`, `required` ones named; every other
 * field is optional and takes its `default` when absent.
 */
export function objectOf<T>(
  fields: Fields,
  required: readonly string[] = [],
): PlainToolSchema<T> {
  const properties: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const { type, description } = field;
    properties[name] = {
      type,
      description,
      ...("default" in field && field.default !== undefined
        ? { default: field.default }
        : {}),
      ...("enum" in field && field.enum ? { enum: [...field.enum] } : {}),
      ...("maxLength" in field && field.maxLength !== undefined
        ? { maxLength: field.maxLength }
        : {}),
      ...("minimum" in field && field.minimum !== undefined
        ? { minimum: field.minimum }
        : {}),
      ...("maximum" in field && field.maximum !== undefined
        ? { maximum: field.maximum }
        : {}),
      ...(field.type === "array"
        ? {
            items: {
              type: "string",
              ...(field.items.maxLength !== undefined
                ? { maxLength: field.items.maxLength }
                : {}),
            },
            ...(field.minItems !== undefined
              ? { minItems: field.minItems }
              : {}),
            maxItems: field.maxItems,
          }
        : {}),
    };
  }
  return {
    jsonSchema: {
      type: "object",
      properties,
      required: [...required],
      additionalProperties: false,
    },
    validate: (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { issues: [{ message: "arguments must be an object" }] };
      }
      const input = value as Record<string, unknown>;
      const issues: Issue[] = [];
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(fields, key)) {
          issues.push({ message: "unknown field", path: [key] });
        }
      }
      for (const [name, field] of Object.entries(fields)) {
        const given = input[name];
        if (given === undefined || given === null) {
          if (required.includes(name)) {
            issues.push({ message: "is required", path: [name] });
          } else if ("default" in field && field.default !== undefined) {
            out[name] = field.default;
          }
          continue;
        }
        const problem = check(name, field, given);
        if (problem) issues.push(problem);
        else out[name] = given;
      }
      return issues.length ? { issues } : { value: out as T };
    },
  };
}
