/**
 * Every field of everyapp.config.ts, as paths, and every value its enums
 * take, read from the strict manifest schema, so the manifest page of the
 * agent docs can be checked for each: `resources.d1`,
 * `resources.durableObjects[].className`, `capabilities.<id>.access`,
 * `migrations.engine` and its `drizzle`, `d1-sql`, `prisma`.
 *
 * The perimeter's schema is zod 4 (`_zod.def.type`), walked structurally so
 * this file needs no zod import of its own.
 */
import {
  capabilityEntrySchema,
  ManifestSchemaStrict,
} from "@every-app/perimeter/manifest";

interface ZodNode {
  _zod: { def: { type: string } & Record<string, unknown> };
}

interface ManifestFields {
  paths: string[];
  values: string[];
}

function walk(node: ZodNode, at: string, out: ManifestFields): void {
  const def = node._zod.def;
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
      walk(def["innerType"] as ZodNode, at, out);
      return;
    // `.transform()` and `.pipe()`: the input side is what an author writes.
    case "pipe":
      walk(def["in"] as ZodNode, at, out);
      return;
    case "lazy":
      walk((def["getter"] as () => ZodNode)(), at, out);
      return;
    case "object":
      for (const [key, child] of Object.entries(
        def["shape"] as Record<string, ZodNode>,
      )) {
        const here = at ? `${at}.${key}` : key;
        out.paths.push(here);
        walk(child, here, out);
      }
      return;
    case "array":
      walk(def["element"] as ZodNode, `${at}[]`, out);
      return;
    case "record":
      walk(def["valueType"] as ZodNode, `${at}.<id>`, out);
      return;
    case "union":
      for (const option of def["options"] as ZodNode[]) walk(option, at, out);
      return;
    case "enum":
      for (const value of Object.values(
        def["entries"] as Record<string, unknown>,
      )) {
        if (typeof value === "string") out.values.push(value);
      }
      return;
    case "literal":
      for (const value of def["values"] as unknown[]) {
        if (typeof value === "string") out.values.push(value);
      }
      return;
    // The leaves the manifest has today. Anything else throws rather than
    // reads as "no fields here": a walk that quietly returns nothing lets
    // "documents every field" pass with nothing to document, which is how
    // the zod 3 to 4 move went unseen until the built CLI failed.
    case "string":
    case "number":
    case "boolean":
    case "undefined":
    case "null":
    case "never":
    case "unknown":
    case "any":
      return;
    default:
      throw new Error(
        `manifestFields: unhandled zod def type "${def.type}" at ${at || "(root)"}`,
      );
  }
}

export function manifestFields(): ManifestFields {
  const out: ManifestFields = { paths: [], values: [] };
  walk(ManifestSchemaStrict as unknown as ZodNode, "", out);
  // A capability's entry is validated per capability inside the record's
  // refinement, not as its value type: walk one to get `access` and `why`.
  walk(capabilityEntrySchema("email") as unknown as ZodNode, "capabilities.<id>", out);
  return {
    paths: [...new Set(out.paths)],
    values: [...new Set(out.values)],
  };
}
