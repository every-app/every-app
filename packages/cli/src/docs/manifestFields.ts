/**
 * Every field of everyapp.config.ts, as paths, and every value its enums
 * take, read from the strict manifest schema, so the manifest page of the
 * agent docs can be checked for each: `resources.d1`,
 * `resources.durableObjects[].className`, `capabilities.<id>.access`,
 * `migrations.engine` and its `drizzle`, `d1-sql`, `prisma`.
 *
 * The perimeter's schema is zod 3 (`_def.typeName`), walked structurally so
 * this file needs no zod import of its own.
 */
import {
  capabilityEntrySchema,
  ManifestSchemaStrict,
} from "@every-app/perimeter/manifest";

interface ZodNode {
  _def: { typeName: string } & Record<string, unknown>;
}

interface ManifestFields {
  paths: string[];
  values: string[];
}

function shapeOf(node: ZodNode): Record<string, ZodNode> {
  const shape = node._def["shape"];
  return (typeof shape === "function" ? shape() : shape) as Record<string, ZodNode>;
}

function walk(node: ZodNode, at: string, out: ManifestFields): void {
  const def = node._def;
  switch (def.typeName) {
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodCatch":
    case "ZodReadonly":
      walk(def["innerType"] as ZodNode, at, out);
      return;
    case "ZodBranded":
      walk(def["type"] as ZodNode, at, out);
      return;
    case "ZodEffects":
      walk(def["schema"] as ZodNode, at, out);
      return;
    case "ZodPipeline":
      walk(def["in"] as ZodNode, at, out);
      return;
    case "ZodLazy":
      walk((def["getter"] as () => ZodNode)(), at, out);
      return;
    case "ZodObject":
      for (const [key, child] of Object.entries(shapeOf(node))) {
        const here = at ? `${at}.${key}` : key;
        out.paths.push(here);
        walk(child, here, out);
      }
      return;
    case "ZodArray":
      walk(def["type"] as ZodNode, `${at}[]`, out);
      return;
    case "ZodRecord":
      walk(def["valueType"] as ZodNode, `${at}.<id>`, out);
      return;
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      for (const option of def["options"] as ZodNode[]) walk(option, at, out);
      return;
    case "ZodEnum":
      out.values.push(...(def["values"] as string[]));
      return;
    case "ZodLiteral":
      if (typeof def["value"] === "string") out.values.push(def["value"]);
      return;
    default:
      return;
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
