/**
 * Nothing the driver holds leaves it in the clear (design 4.14): every
 * subprocess line and the driver's own stdout go through `redact()` before
 * a file or a terminal sees them. It removes every exact value it was given
 * (the account token, the provider key, the owner password), their base64
 * and hex encodings, and the shapes a secret takes when the driver never
 * held it: an `est_` setup link, an `sk-ant-`/`sk-` key, a Bearer header,
 * `x-api-key`, `cf-aig-authorization`. Each hit is counted by name, so
 * run.json's `secret_exposure` says which value an agent echoed and the
 * report prints `ROTATE:` for it.
 */
import type { SecretExposure } from "./types";

export type SecretName = keyof SecretExposure;

export interface Secret {
  name: SecretName;
  value: string;
}

export interface Redactor {
  redact(text: string): string;
  /** Hits so far, by name. */
  exposure(): SecretExposure;
  /** Adds a value learnt after creation (the owner password minted per run). */
  add(secret: Secret): void;
}

/** A value shorter than this is never redacted as an exact value: it would hit everywhere. */
const MIN_VALUE_LENGTH = 8;

const emptyExposure = (): SecretExposure => ({
  cf_token: 0,
  provider_key: 0,
  est_link: 0,
  owner_password: 0,
  bearer: 0,
});

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The forms a value takes when something encodes it before printing. */
function encodings(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  return [
    value,
    base64,
    base64.replace(/=+$/, ""),
    bytes.toString("base64url"),
    bytes.toString("hex"),
  ].filter((form) => form.length >= MIN_VALUE_LENGTH);
}

interface Rule {
  name: SecretName;
  pattern: RegExp;
  replacement: string;
}

/** The shapes, applied after the exact values so a known key counts under its own name first. */
const SHAPES: Rule[] = [
  {
    name: "est_link",
    pattern: /est_[A-Za-z0-9_-]{20,}/g,
    replacement: "[REDACTED:est_link]",
  },
  {
    name: "provider_key",
    pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g,
    replacement: "[REDACTED:provider_key]",
  },
  {
    name: "provider_key",
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replacement: "[REDACTED:provider_key]",
  },
  {
    name: "bearer",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replacement: "Bearer [REDACTED:bearer]",
  },
  {
    name: "bearer",
    pattern:
      /\b(x-api-key|cf-aig-authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
    replacement: "$1$2[REDACTED:bearer]",
  },
];

export function createRedactor(secrets: Secret[] = []): Redactor {
  const counts = emptyExposure();
  const exact: Rule[] = [];

  const add = (secret: Secret): void => {
    for (const form of encodings(secret.value)) {
      exact.push({
        name: secret.name,
        pattern: new RegExp(escapeRegExp(form), "g"),
        replacement: `[REDACTED:${secret.name}]`,
      });
    }
  };
  for (const secret of secrets) add(secret);

  const apply = (text: string, rule: Rule): string =>
    text.replace(rule.pattern, (...match: unknown[]) => {
      counts[rule.name] += 1;
      // Expand $1/$2 from the replacement by hand: the callback form gets the groups.
      return rule.replacement.replace(/\$(\d)/g, (_, index: string) =>
        String(match[Number(index)] ?? ""),
      );
    });

  return {
    redact(text) {
      let out = text;
      for (const rule of exact) out = apply(out, rule);
      for (const rule of SHAPES) out = apply(out, rule);
      return out;
    },
    exposure: () => ({ ...counts }),
    add,
  };
}

/** True when any counter is non-zero: the report prints ROTATE: and preflight refuses the value. */
export const exposed = (exposure: SecretExposure): boolean =>
  Object.values(exposure).some((count) => count > 0);
