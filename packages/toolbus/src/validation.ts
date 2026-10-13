/**
 * JSON Schema validation that runs on Workers: `@cfworker/json-schema` (via
 * the MCP SDK's provider) interprets schemas instead of compiling them with
 * `eval`, which Workers forbid.
 *
 * The gateway checks a call's arguments against the tool's snapshotted
 * schema so a bad call costs no app invocation. That check runs on the
 * shared gateway with an app's schema and a client's arguments, so it has to
 * stay cheap whatever either sends:
 *  - the gateway's copy of the schema drops app-written regular expressions
 *    (`pattern`, `patternProperties`): a backtracking pattern like `^(a+)+$`
 *    takes seconds on a 30-character string;
 *  - schemas with references (`$ref`, usually recursive) aren't checked
 *    here: a union under a recursive reference is exponential in the
 *    argument's depth;
 *  - nor are arguments with more than {@link MAX_CHECKED_VALUES} values
 *    (`uniqueItems` and wide unions cost the product of the two sizes).
 * Leaving a check out only ever lets more through: the SDK validates every
 * call with the tool's own schema before its handler runs.
 */
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { isPlainObject } from "./io";
import type { JsonObject } from "./types";

export const jsonSchemaValidator = new CfWorkerJsonSchemaValidator();

/** Arguments with more values than this are left to the app to check. */
export const MAX_CHECKED_VALUES = 1_000;

type ArgumentsCheck = (input: unknown) => {
  valid: boolean;
  errorMessage?: string;
};

const MAX_CACHED_VALIDATORS = 256;
// null: this schema is left to the app.
const cachedValidators = new Map<string, ArgumentsCheck | null>();

/**
 * The gateway's validator for one tool's arguments, or null when only the
 * app checks them. Keyed by catalog hash + names, so a redeployed app never
 * reuses a stale schema.
 */
export function argumentsValidator(
  cacheKey: string,
  schema: JsonObject,
): ArgumentsCheck | null {
  let validate = cachedValidators.get(cacheKey);
  if (validate === undefined) {
    const checkable = gatewayCheckableSchema(schema);
    validate = checkable
      ? jsonSchemaValidator.getValidator(checkable as JsonSchemaType)
      : null;
    if (cachedValidators.size >= MAX_CACHED_VALIDATORS) {
      const oldest = cachedValidators.keys().next().value;
      if (oldest !== undefined) cachedValidators.delete(oldest);
    }
    cachedValidators.set(cacheKey, validate);
  }
  return validate;
}

/**
 * Why the validator cannot use a schema at all (a `$ref` that doesn't resolve
 * inside the schema, an unsupported dialect), or null when it can. References
 * resolve lazily during validation, so they are checked up front: nothing is
 * ever fetched from elsewhere.
 */
export function unusableSchemaReason(schema: JsonObject): string | null {
  const unresolved = findUnresolvedRef(schema);
  if (unresolved) return `$ref "${unresolved}" does not resolve in the schema`;
  try {
    jsonSchemaValidator.getValidator(schema as JsonSchemaType)({});
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const REGEX_KEYWORDS = new Set(["pattern", "patternProperties"]);
const REFERENCE_KEYWORDS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);
const UNEVALUATED_KEYWORDS = new Set([
  "unevaluatedProperties",
  "unevaluatedItems",
]);
// Where a subschema losing a constraint could make the whole schema reject
// arguments it accepts: a negation, a condition, an exactly-one, a count.
const EXACT_KEYWORDS = new Set(["not", "if", "oneOf", "contains"]);
// Keywords whose value is a subschema (or, for draft-07 `items`, a list).
const SUBSCHEMA_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const SUBSCHEMA_LIST_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);
const SUBSCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

/** Apply `visit` to each subschema a keyword's value holds; keep the rest. */
function mapSubschemas(
  keyword: string,
  value: unknown,
  visit: (subschema: unknown) => unknown,
): unknown {
  if (SUBSCHEMA_KEYWORDS.has(keyword)) {
    return Array.isArray(value) ? value.map(visit) : visit(value);
  }
  if (SUBSCHEMA_LIST_KEYWORDS.has(keyword)) {
    return Array.isArray(value) ? value.map(visit) : value;
  }
  if (SUBSCHEMA_MAP_KEYWORDS.has(keyword) && isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, member]) => [name, visit(member)]),
    );
  }
  return value;
}

/**
 * The copy of a tool's input schema the gateway validates against (see the
 * file comment), or null when the gateway leaves the check to the app.
 */
export function gatewayCheckableSchema(schema: JsonObject): JsonObject | null {
  const found = { regex: false, regexWhereExact: false, reference: false };
  let unevaluated = false;
  const scan = (node: unknown, exact: boolean): unknown => {
    if (!isPlainObject(node)) return node;
    for (const [keyword, value] of Object.entries(node)) {
      if (REFERENCE_KEYWORDS.has(keyword)) found.reference = true;
      if (UNEVALUATED_KEYWORDS.has(keyword)) unevaluated = true;
      if (REGEX_KEYWORDS.has(keyword)) {
        found.regex = true;
        if (exact) found.regexWhereExact = true;
      }
      mapSubschemas(keyword, value, (subschema) =>
        scan(subschema, exact || EXACT_KEYWORDS.has(keyword)),
      );
    }
    return node;
  };
  scan(schema, false);

  if (found.reference || found.regexWhereExact) return null;
  if (!found.regex) return schema;
  // Which properties count as "evaluated" depends on the dropped keywords.
  if (unevaluated) return null;
  const withoutRegexes = (node: unknown): unknown => {
    if (!isPlainObject(node)) return node;
    const copy: JsonObject = {};
    for (const [keyword, value] of Object.entries(node)) {
      if (REGEX_KEYWORDS.has(keyword)) continue;
      // Additional to `properties` *and* the dropped `patternProperties`.
      if (keyword === "additionalProperties" && "patternProperties" in node) {
        continue;
      }
      copy[keyword] = mapSubschemas(keyword, value, withoutRegexes);
    }
    return copy;
  };
  return withoutRegexes(schema) as JsonObject;
}

function findUnresolvedRef(root: JsonObject): string | null {
  const anchors = new Set<string>();
  const refs: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const record = node as JsonObject;
    if (typeof record["$anchor"] === "string") anchors.add(record["$anchor"]);
    if (typeof record["$ref"] === "string") refs.push(record["$ref"]);
    Object.values(record).forEach(walk);
  };
  walk(root);
  return (
    refs.find((ref) => {
      if (!ref.startsWith("#")) return true;
      const fragment = ref.slice(1);
      if (fragment === "") return false;
      if (!fragment.startsWith("/")) return !anchors.has(fragment);
      let node: unknown = root;
      for (const raw of fragment.slice(1).split("/")) {
        let key: string;
        try {
          key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
        } catch {
          return true;
        }
        if (!node || typeof node !== "object" || !(key in node)) return true;
        node = (node as JsonObject)[key];
      }
      return false;
    }) ?? null
  );
}

/**
 * How deep a JSON value nests (a scalar is 0) and how many values it holds,
 * walked without recursion and given up once deeper than `maxDepth`, so a
 * hostile argument can't exhaust the stack here.
 */
export function measureJson(
  value: unknown,
  maxDepth: number,
): { tooDeep: true } | { tooDeep: false; values: number } {
  let values = 0;
  const pending: [unknown, number][] = [[value, 0]];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [node, depth] = next;
    values += 1;
    if (node === null || typeof node !== "object") continue;
    if (depth + 1 > maxDepth) return { tooDeep: true };
    for (const member of Array.isArray(node) ? node : Object.values(node)) {
      pending.push([member, depth + 1]);
    }
  }
  return { tooDeep: false, values };
}
