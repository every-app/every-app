/**
 * The first fifty catalog providers beyond the ones today's apps use
 * (docs/design/2026-10-provider-registry.md, section 9), one file per
 * batch, merged into `CAPABILITIES` after the hand-written entries. A
 * provider here is a catalog entry like DataForSEO: every gateway has it,
 * its settings are settable, a row can't take its id.
 */
import { COMMERCE } from "./commerce.js";
import { COMMS } from "./comms.js";
import { INFRA } from "./infra.js";
import { INFERENCE } from "./inference.js";
import { SEARCH } from "./search.js";

export const CATALOG_ENTRIES = {
  ...COMMERCE,
  ...COMMS,
  ...INFRA,
  ...INFERENCE,
  ...SEARCH,
} as const;
